/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 66 回合（藍方）：真人局每個藍方座位（忠臣、派西、梅林）的投票與派隊，機器人在同一個決策點（同一個座位、只看當時的資訊；
 * 持續的 agent，亂數照「局號|座位|vote-提議號／team-提議號」，同 `agreement.replaySeat`）用每一組設定各做一次。
 * 輸出一行一點的 JSONL（沒有名字、沒有局號，只有資料集裡的序號），給 `blueSideStudy66.py` 彙總。輸出放在 repo 外。
 *
 *   cd packages/server && npx tsx scripts/blueSideStudy66.ts --out rows.jsonl \
 *     --variant A: --variant H:@profile --variant X:someFlag=1 [--shard k/n] [--roles loyal,percival,merlin]
 * （`--variant 標籤:開關1,開關2`；開關 = `--flag` 的 name=v；空的 = 現行預設（基準線）；`@profile` = 照桌上 S 的真人桌策略層）
 *
 * kind = vote：局面（第幾局、第幾次、比分、在不在隊上、是不是隊長、隊伍人數、要幾張失敗、隊上實際紅數、隊上出過失敗任務的人數、
 *   隊上最近一次失敗任務的人數、派西看到的拇指數、梅林看得到的紅數、隊長是不是紅、這隊有沒有過、贊成數）、真人的票、每一組設定的票。
 * kind = lead：藍方隊長的提議，真人與每一組設定的隊：人數、自己在不在、實際紅數、會不會失敗（紅數 ≥ 要的失敗張數）、
 *   出過失敗任務的人數、最近一次失敗任務的人數、最近一次成功任務的人數、拇指數（派西）、看得到的紅數（梅林）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AVALON_CONFIG } from '@avalon/shared';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
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
interface BotOut { votes: Map<number, boolean>; teams: Map<number, number[]> }

function replay(game: ReplayGame, seat: number, tuning: AgentTuning): BotOut {
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
      out.votes.set(i, a.type === 'team_vote' ? a.vote : true);
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
  const roles = (arg('--roles') ?? 'loyal,percival,merlin').split(',').filter(Boolean);
  const maxGames = Number(arg('--max-games') ?? Infinity);
  const root = path.resolve(__dirname, '..');
  const { games } = replayGamesFromDataset(JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8')));
  const [shardK, shardN] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const lines: string[] = [];
  let done = 0;
  for (let gi = shardK; gi < games.length && done < maxGames; gi += shardN) {
    const d = games[gi];
    const g = d.game;
    if (g.playerCount !== 10) continue;
    done++;
    const opp = opponentTypeOfTable({ humans: 9, tableS: d.s });
    const roleOf = (s: number): string => g.seatRoles[s - 1];
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1]);
    const fails = g.quests.filter((q) => q.failed).length;
    const outcome = fails >= 3 ? 'R' : g.assassinTargetSeat === g.seatRoles.indexOf('merlin') + 1 ? 'K' : 'B';
    for (let seat = 1; seat <= 10; seat++) {
      const role = roleOf(seat);
      if (!roles.includes(role)) continue;
      const thumb = (s: number): boolean => role === 'percival' && (roleOf(s) === 'merlin' || roleOf(s) === 'morgana');
      const merlinSees = (s: number): boolean => role === 'merlin' && red(s) && roleOf(s) !== 'mordred';
      const bots = variants.map((v) => replay(g, seat, resolveAgentTuning({ ...(v.profile ? PROFILE_OVERRIDES[opp] : {}), ...v.extra })));
      g.proposals.forEach((p, i) => {
        const prior = g.quests.filter((q) => q.round < p.round);
        const failedSet = new Set(prior.filter((q) => q.failed).flatMap((q) => q.teamSeats));
        const lastFail = [...prior].reverse().find((q) => q.failed);
        const lastOk = [...prior].reverse().find((q) => !q.failed);
        const req = AVALON_CONFIG[10].questFailsRequired?.[p.round - 1] ?? 1;
        const desc = (team: readonly number[]): Record<string, unknown> => {
          const reds = team.filter(red).length;
          return {
            n: team.length, self: team.includes(seat) ? 1 : 0, reds, dirty: reds >= req ? 1 : 0,
            fm: team.filter((s) => s !== seat && failedSet.has(s)).length,
            lf: lastFail ? team.filter((s) => s !== seat && lastFail.teamSeats.includes(s)).length : null,
            lo: lastOk ? team.filter((s) => lastOk.teamSeats.includes(s)).length : null,
            th: team.filter(thumb).length, kr: team.filter(merlinSees).length,
          };
        };
        const base = {
          gi, pi: i, s: d.s, tier: d.s === null ? 'unknown' : opp, pr: d.prs?.[seat - 1] ?? null, role, seat, round: p.round, attempt: p.attempt,
          bw: prior.filter((q) => !q.failed).length, rw: prior.filter((q) => q.failed).length, outcome, req,
          lastFailN: lastFail ? lastFail.teamSeats.length : 0, selfInFail: failedSet.has(seat) ? 1 : 0,
        };
        if (p.leaderSeat === seat) {
          const row: Record<string, unknown> = {
            kind: 'lead', ...base, forced: p.forced ? 1 : 0, went: p.wentOnMission ? 1 : 0,
            passed: p.forced || p.approveCount > 5 ? 1 : 0, human: desc(p.teamSeats),
          };
          variants.forEach((v, k) => { const t = bots[k].teams.get(i); row[v.label] = t && t.length ? desc(t) : null; });
          lines.push(JSON.stringify(row));
        }
        if (!p.forced && p.votesReliable) {
          const t = desc(p.teamSeats);
          const row: Record<string, unknown> = {
            kind: 'vote', ...base, on: p.teamSeats.includes(seat) ? 1 : 0, leaderSelf: p.leaderSeat === seat ? 1 : 0,
            leaderRed: red(p.leaderSeat) ? 1 : 0, leaderThumb: thumb(p.leaderSeat) ? 1 : 0, leaderSeen: merlinSees(p.leaderSeat) ? 1 : 0,
            size: p.teamSeats.length, reds: t.reds, dirty: t.dirty, fm: t.fm, lf: t.lf, th: t.th, kr: t.kr,
            passed: p.approveCount > 5 ? 1 : 0, yes: p.approveCount, human: p.votes[seat - 1] ? 1 : 0,
          };
          variants.forEach((v, k) => { const b = bots[k].votes.get(i); row[v.label] = b === undefined ? null : (b ? 1 : 0); });
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
