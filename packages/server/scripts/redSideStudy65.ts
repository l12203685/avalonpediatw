/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 65 回合（紅方）：真人局每個紅方座位的投票與派隊，機器人在同一個決策點（同一個座位、只看當時的資訊；持續的 agent，
 * 亂數照「局號|座位|vote-提議號／team-提議號」，同 `agreement.replaySeat`）用每一組設定各做一次。輸出一行一點的 JSONL
 * （沒有名字、沒有局號，只有資料集裡的序號），給 `redSideStudy65.py` 彙總。輸出放在 repo 外。
 *
 *   cd packages/server && USE_FORWARD_REASONING=true npx tsx scripts/redSideStudy65.ts --out rows.jsonl \
 *     --variant A: --variant H:@profile --variant W:redOffWhite65=1 [--shard k/n] [--roles assassin,morgana,mordred,oberon]
 * （`--variant 標籤:開關1,開關2`；開關 = `--flag` 的 name=v；空的 = 現行預設（基準線）；`@profile` = 照桌上 S 的真人桌策略層）
 *
 * 每列 kind = vote：局面（第幾局、第幾次、比分、在不在隊上、隊長是不是看得到的隊友、隊上看得到的隊友數、隊上實際紅數、
 * 隊伍人數、要幾張失敗、這隊有沒有過）、真人的票、每一組設定的票（第一組另記規則說明）。
 * kind = lead：紅方隊長的提議，真人與每一組設定的隊：人數、自己在不在、看得到的紅數（含自己）、實際紅數、莫德雷德在不在；
 * 真人那一隊的藍方隊外贊成數、有沒有過。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AVALON_CONFIG } from '@avalon/shared';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { ForwardAgent } from '../src/ai/forward/ForwardAgent';
import { parseTuningFlag, resolveAgentTuning, type AgentTuning } from '../src/ai/AgentTuning';
import { PROFILE_OVERRIDES, opponentTypeOfTable } from '../src/ai/humanProfile';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { withSeededRandom } from '../src/ai/benchmark/agreement';
import { buildReplayObservation, seatId, seatOfId } from '../src/ai/benchmark/replayObservation';
import { EVIL_ROLES, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));

interface Variant { label: string; profile: boolean; extra: Partial<AgentTuning> }
interface BotOut { votes: Map<number, { vote: boolean; why: string }>; teams: Map<number, number[]> }

function replay(game: ReplayGame, seat: number, tuning: AgentTuning, why: boolean): BotOut {
  const id = seatId(seat);
  const agent = new HeuristicAgent(id, undefined, undefined, tuning);
  agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
  const seedOf = (key: string): string => `${game.id}|${seat}|${key}`;
  const out: BotOut = { votes: new Map(), teams: new Map() };
  game.proposals.forEach((p, i) => {
    if (p.leaderSeat === seat) {
      const obs = buildReplayObservation(game, seat, { kind: 'team_select', proposal: i });
      const a = withSeededRandom(seedOf(`team-${i}`), () => agent.act(obs));
      out.teams.set(i, a.type === 'team_select' ? a.teamIds.map(seatOfId) : []);
    }
    if (!p.forced && p.votesReliable) {
      const obs = buildReplayObservation(game, seat, { kind: 'team_vote', proposal: i });
      const a = withSeededRandom(seedOf(`vote-${i}`), () => agent.act(obs));
      const vote = a.type === 'team_vote' ? a.vote : true;
      let w = '';
      if (why && p.round >= 3) {
        try {
          const d = withSeededRandom(seedOf(`vote-${i}`), () => new ForwardAgent(id, agent).decide({ ...obs, seatTeam: obs.myTeam }));
          w = d.reasoningTrace.chosen.description.slice(0, 70);
          if (d.action.type === 'team_vote' && d.action.vote !== vote) w = `MISMATCH ${w}`;
        } catch { w = 'err'; }
      }
      out.votes.set(i, { vote, why: w });
    }
  });
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
  const roles = (arg('--roles') ?? 'assassin,morgana,mordred,oberon').split(',').filter(Boolean);
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
      if (!roles.includes(role)) continue;
      // Reds this seat sees (itself included): Oberon sees only himself; the others see every red except Oberon.
      const known = (s: number): boolean => s === seat || (role !== 'oberon' && red(s) && roleOf(s) !== 'oberon');
      const bots = variants.map((v) => replay(g, seat, resolveAgentTuning({ ...(v.profile ? PROFILE_OVERRIDES[opp] : {}), ...v.extra }), v === variants[0]));
      const desc = (team: readonly number[]): Record<string, unknown> => ({
        n: team.length, self: team.includes(seat) ? 1 : 0, known: team.filter(known).length, reds: team.filter(red).length,
        mord: team.some((s) => roleOf(s) === 'mordred') ? 1 : 0, ober: team.some((s) => roleOf(s) === 'oberon') ? 1 : 0,
      });
      g.proposals.forEach((p, i) => {
        const prior = g.quests.filter((q) => q.round < p.round);
        const base = {
          gi, s: d.s, tier: d.s === null ? 'unknown' : opp, pr: d.prs?.[seat - 1] ?? null, role, seat, round: p.round, attempt: p.attempt,
          bw: prior.filter((q) => !q.failed).length, rw: prior.filter((q) => q.failed).length, outcome,
          req: AVALON_CONFIG[10].questFailsRequired?.[p.round - 1] ?? 1,
        };
        if (p.leaderSeat === seat) {
          const row: Record<string, unknown> = {
            kind: 'lead', ...base, forced: p.forced ? 1 : 0, went: p.wentOnMission ? 1 : 0,
            passed: p.forced || p.approveCount > 5 ? 1 : 0, human: desc(p.teamSeats),
            blueOffYes: p.votesReliable ? p.votes.filter((v, k) => v && !red(k + 1) && !p.teamSeats.includes(k + 1)).length : null,
            blueOff: p.votesReliable ? Array.from({ length: 10 }, (_, k) => k + 1).filter((s) => !red(s) && !p.teamSeats.includes(s)).length : null,
          };
          variants.forEach((v, k) => { const t = bots[k].teams.get(i); row[v.label] = t && t.length ? desc(t) : null; });
          lines.push(JSON.stringify(row));
        }
        if (!p.forced && p.votesReliable) {
          const row: Record<string, unknown> = {
            kind: 'vote', ...base, on: p.teamSeats.includes(seat) ? 1 : 0, leaderMate: p.leaderSeat !== seat && known(p.leaderSeat) ? 1 : 0,
            leaderSelf: p.leaderSeat === seat ? 1 : 0, mates: p.teamSeats.filter((s) => s !== seat && known(s)).length,
            reds: p.teamSeats.filter(red).length, size: p.teamSeats.length, passed: p.approveCount > 5 ? 1 : 0,
            yes: p.approveCount, human: p.votes[seat - 1] ? 1 : 0,
          };
          variants.forEach((v, k) => {
            const b = bots[k].votes.get(i);
            row[v.label] = b ? (b.vote ? 1 : 0) : null;
            if (k === 0 && b?.why) row.why = b.why;
          });
          lines.push(JSON.stringify(row));
        }
      });
    }
    if (gi % 100 === shardK) console.error(`game ${gi}: ${lines.length} rows`);
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} rows → ${outPath}`);
}

main();
