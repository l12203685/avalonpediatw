/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 71 回合（紅方）：第 5 局（2:2）紅方不在隊上、隊上沒有看得到的隊友（奧伯倫：隊上沒有他自己）的非強制提議。真人局每一個這種決策點，
 * 機器人用持續的 agent 在同一個座位、同一個時間點（只看當時的資訊；亂數同 `agreement.replaySeat`）用每一組設定各投一次，
 * 並記下紅方自己視角（自己的紅方資訊＋公開紀錄，`bayesTeamClean`）的 P(隊上至少一紅)。輸出一行一點的 JSONL（沒有名字、沒有局號，
 * 只有資料集裡的序號），給 `redR5Study71.py` 彙總。輸出放在 repo 外。
 *
 *   cd packages/server && USE_FORWARD_REASONING=true npx tsx scripts/redR5Study71.ts --out rows.jsonl \
 *     --variant A: --variant R60:redR5Red71=0.6 [--variant H:@profile] [--shard k/n]
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { parseTuningFlag, resolveAgentTuning, type AgentTuning } from '../src/ai/AgentTuning';
import { PROFILE_OVERRIDES, opponentTypeOfTable } from '../src/ai/humanProfile';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { replaySeat, type BenchmarkAgent } from '../src/ai/benchmark/agreement';
import type { AgentAction, PlayerObservation } from '../src/ai/types';
import { EVIL_ROLES, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { bayesOptionsOf, bayesTeamClean } from '../src/ai/belief/BayesBelief';
import { certaintyFor } from '../src/ai/LogicGates';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));

interface Variant { label: string; profile: boolean; extra: Partial<AgentTuning> }
interface VoteOut { vote: boolean; pRed: number | null; minReds: number | null; minReds0: number | null }

/** 這個座位的格內決策點（第 5 局、2:2、非強制、票可靠、不在隊上、隊上沒有看得到的隊友）。 */
function cellProposals(game: ReplayGame, seat: number, known: (s: number) => boolean): number[] {
  return game.proposals.flatMap((p, i) => (p.round === 5 && !p.forced && p.votesReliable && !p.teamSeats.includes(seat)
    && !p.teamSeats.some((s) => s !== seat && known(s)) ? [i] : []));
}

function replay(game: ReplayGame, seat: number, tuning: AgentTuning, cell: ReadonlySet<number>, first: boolean): Map<number, VoteOut> {
  const out = new Map<number, VoteOut>();
  const idxOf = new Map(game.proposals.map((p, i) => [`${p.round}|${p.attempt}`, i] as const));
  const makeAgent = (pid: string): BenchmarkAgent => {
    const inner = new HeuristicAgent(pid, undefined, undefined, tuning);
    return {
      onGameStart: (obs) => inner.onGameStart(obs),
      pickLakeTarget: (obs, valid) => inner.pickLakeTarget(obs, valid),
      declareLake: (obs, target, truth) => inner.declareLake(obs, target, truth),
      act: (obs: PlayerObservation): AgentAction => {
        const a = inner.act(obs);
        const i = obs.gamePhase === 'team_vote' ? idxOf.get(`${obs.currentRound ?? 1}|${(obs.failCount ?? 0) + 1}`) : undefined;
        if (i !== undefined && cell.has(i)) {
          const clean = first ? bayesTeamClean({ ...obs, seatTeam: obs.myTeam }, obs.proposedTeam ?? [], bayesOptionsOf(tuning)) : null;
          let minReds: number | null = null;
          let minReds0: number | null = null;
          if (first) {
            try { minReds = certaintyFor(obs).minReds(obs.proposedTeam ?? []); } catch { minReds = null; }
            try { minReds0 = certaintyFor(obs).minReds(obs.proposedTeam ?? [], 'L0'); } catch { minReds0 = null; }
          }
          out.set(i, { vote: a.type === 'team_vote' ? a.vote : true, pRed: clean === null ? null : Math.round((1 - clean) * 1000) / 1000, minReds, minReds0 });
        }
        return a;
      },
    };
  };
  replaySeat(game, seat, { makeAgent });
  return out;
}

function main(): void {
  const outPath = arg('--out');
  if (!outPath) throw new Error('--out PATH');
  const variants: Variant[] = args('--variant').map((v) => {
    const k = v.indexOf(':');
    const label = k >= 0 ? v.slice(0, k) : v;
    const parts = k >= 0 ? v.slice(k + 1).split(',').filter((x) => x.length > 0) : [];
    return { label, profile: parts.includes('@profile'), extra: Object.assign({}, ...parts.filter((x) => x !== '@profile').map(parseTuningFlag)) };
  });
  if (variants.length === 0) throw new Error('--variant LABEL:flags (at least one)');
  const root = path.resolve(__dirname, '..');
  const { games } = replayGamesFromDataset(JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8')));
  const [shardK, shardN] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const lines: string[] = [];
  for (let gi = shardK; gi < games.length; gi += shardN) {
    const d = games[gi];
    const g = d.game;
    if (g.playerCount !== 10) continue;
    const opp = opponentTypeOfTable({ humans: 9, tableS: d.s });
    const roleOf = (s: number): string => g.seatRoles[s - 1];
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1]);
    const fails = g.quests.filter((q) => q.failed).length;
    const outcome = fails >= 3 ? 'R' : g.assassinTargetSeat === g.seatRoles.indexOf('merlin') + 1 ? 'K' : 'B';
    for (let seat = 1; seat <= 10; seat++) {
      const role = roleOf(seat);
      if (!red(seat)) continue;
      const known = (s: number): boolean => s === seat || (role !== 'oberon' && red(s) && roleOf(s) !== 'oberon');
      const cell = cellProposals(g, seat, known);
      if (cell.length === 0) continue;
      const cellSet = new Set(cell);
      const bots = variants.map((v, k) => replay(g, seat, resolveAgentTuning({ ...(v.profile ? PROFILE_OVERRIDES[opp] : {}), ...v.extra }), cellSet, k === 0));
      for (const i of cell) {
        const p = g.proposals[i];
        const row: Record<string, unknown> = {
          gi, s: d.s, tier: d.s === null ? 'unknown' : opp, role, seat, attempt: p.attempt, outcome,
          reds: p.teamSeats.filter(red).length, yesOthers: p.votes.filter((v, k) => v && k !== seat - 1).length,
          passed: p.approveCount > 5 ? 1 : 0, human: p.votes[seat - 1] ? 1 : 0,
        };
        variants.forEach((v, k) => {
          const b = bots[k].get(i);
          row[v.label] = b ? (b.vote ? 1 : 0) : null;
          if (k === 0 && b) { row.pRed = b.pRed; row.minReds = b.minReds; row.minReds0 = b.minReds0; }
        });
        lines.push(JSON.stringify(row));
      }
    }
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} rows → ${outPath}`);
}

main();
