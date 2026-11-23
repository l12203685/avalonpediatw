/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 69 回合（紅方）：第 67 回合量到的最大紅方落差那一格——**相認紅（刺客、莫甘娜、莫德雷德）第 3 局、紅方已兩勝（第 1、2 局都失敗）、
 * 不在隊上、隊上有看得到的隊友**的票。真人局每一個這種決策點，機器人用持續的 agent 在同一個座位、同一個時間點（只看當時的資訊；
 * 亂數同 `agreement.replaySeat`：「局號|座位|vote-提議號」）用每一組設定各投一次。輸出一行一點的 JSONL（沒有名字、沒有局號，
 * 只有資料集裡的序號），給 `redSideStudy69.py` 彙總。輸出放在 repo 外。
 *
 *   cd packages/server && USE_FORWARD_REASONING=true npx tsx scripts/redSideStudy69.ts --out rows.jsonl \
 *     --variant A: --variant C5:redKeyCrowd69=0.5 [--variant H:@profile] [--shard k/n]
 * （`--variant 標籤:開關1,開關2`；空的 = 現行預設（基準線）；`@profile` = 照桌上 S 的真人桌策略層）
 *
 * 每列：局面（第幾次、隊長是不是看得到的隊友、隊上看得到的隊友數、隊上實際紅數、尾家（第 5 次的隊長）是不是看得到的紅／自己）、
 * 第一組設定的公開估計（隊上的藍方照 `goodKeyVote` 門檻算贊成的人數、不在隊上的紅數、不在隊上的藍方各自的公開視角 P(乾淨) 排序），
 * 真人的票、真人桌上其他人的贊成數與這隊有沒有過（只在彙總時當結果用，機器人決策不讀）、每一組設定的票與第一組的規則說明。
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { ForwardAgent } from '../src/ai/forward/ForwardAgent';
import { parseTuningFlag, resolveAgentTuning, type AgentTuning } from '../src/ai/AgentTuning';
import { PROFILE_OVERRIDES, opponentTypeOfTable } from '../src/ai/humanProfile';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { replaySeat, type BenchmarkAgent } from '../src/ai/benchmark/agreement';
import { seatId } from '../src/ai/benchmark/replayObservation';
import type { AgentAction, PlayerObservation } from '../src/ai/types';
import { EVIL_ROLES, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { tailLeaderSeat } from '../src/ai/infl/abnormalVotes';
import { keyCrowdEstimate69 } from '../src/ai/Round69';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));

interface Variant { label: string; profile: boolean; extra: Partial<AgentTuning> }
interface VoteOut { vote: boolean; why: string; est: Record<string, unknown> | null }

const KNOWN = new Set(['assassin', 'morgana', 'mordred']);

/** 這個座位在這一局的格內決策點（第 3 局、第 1、2 局都失敗、非強制、票可靠、不在隊上、隊上有看得到的隊友）。 */
function cellProposals(game: ReplayGame, seat: number, known: (s: number) => boolean): number[] {
  const q1 = game.quests.find((q) => q.round === 1);
  const q2 = game.quests.find((q) => q.round === 2);
  if (!q1?.failed || !q2?.failed) return [];
  return game.proposals.flatMap((p, i) => (p.round === 3 && !p.forced && p.votesReliable && !p.teamSeats.includes(seat)
    && p.teamSeats.some((s) => s !== seat && known(s)) ? [i] : []));
}

function replay(game: ReplayGame, seat: number, tuning: AgentTuning, cell: ReadonlySet<number>, first: boolean): Map<number, VoteOut> {
  const id = seatId(seat);
  const out = new Map<number, VoteOut>();
  const idxOf = new Map(game.proposals.map((p, i) => [`${p.round}|${p.attempt}`, i] as const));
  // Same persistent agent and seeds as the human PR benchmark (`agreement.replaySeat`); the wrapper only records the cell votes.
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
          const vote = a.type === 'team_vote' ? a.vote : true;
          let why = '';
          let est: Record<string, unknown> | null = null;
          if (first) {
            try {
              const d = new ForwardAgent(id, inner).decide({ ...obs, seatTeam: obs.myTeam });
              why = d.reasoningTrace.chosen.description.slice(0, 70);
              if (d.action.type === 'team_vote' && d.action.vote !== vote) why = `MISMATCH ${why}`;
            } catch { why = 'err'; }
            const e = keyCrowdEstimate69(tuning, obs);
            est = { onYes: e.onYes, onBlue: e.onBlue, offReds: e.offReds, offBlueP: e.offBlueP.map((x) => Math.round(x * 1000) / 1000) };
          }
          out.set(i, { vote, why, est });
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
      if (!KNOWN.has(role)) continue;
      const known = (s: number): boolean => s === seat || (red(s) && roleOf(s) !== 'oberon');
      const cell = cellProposals(g, seat, known);
      if (cell.length === 0) continue;
      const cellSet = new Set(cell);
      const bots = variants.map((v, k) => replay(g, seat, resolveAgentTuning({ ...(v.profile ? PROFILE_OVERRIDES[opp] : {}), ...v.extra }), cellSet, k === 0));
      for (const i of cell) {
        const p = g.proposals[i];
        const tail = tailLeaderSeat(p.leaderSeat, p.attempt);
        const later = Array.from({ length: 5 - p.attempt }, (_, k) => ((p.leaderSeat - 1 + k + 1) % 10) + 1);
        const row: Record<string, unknown> = {
          gi, s: d.s, tier: d.s === null ? 'unknown' : opp, role, seat, attempt: p.attempt, outcome,
          leaderMate: known(p.leaderSeat) ? 1 : 0, mates: p.teamSeats.filter((s) => s !== seat && known(s)).length,
          reds: p.teamSeats.filter(red).length, size: p.teamSeats.length,
          tailRed: known(tail) ? 1 : 0, tailSelf: tail === seat ? 1 : 0, laterRed: later.filter((s) => s !== tail && known(s)).length,
          yesOthers: p.votes.filter((v, k) => v && k !== seat - 1).length,
          blueOffYes: p.votes.filter((v, k) => v && !red(k + 1) && !p.teamSeats.includes(k + 1)).length,
          passed: p.approveCount > 5 ? 1 : 0, human: p.votes[seat - 1] ? 1 : 0,
        };
        variants.forEach((v, k) => {
          const b = bots[k].get(i);
          row[v.label] = b ? (b.vote ? 1 : 0) : null;
          if (k === 0 && b) { row.why = b.why; row.est = b.est; }
        });
        lines.push(JSON.stringify(row));
      }
    }
    if (gi % 200 === shardK) console.error(`game ${gi}: ${lines.length} rows`);
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} rows → ${outPath}`);
}

main();
