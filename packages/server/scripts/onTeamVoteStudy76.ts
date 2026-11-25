/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 76 回合：忠臣／派西第 3–5 局的票，全部真人局逐點重播（第 59 回合 `onTeamVoteStudy59.ts` 的延伸）。
 *
 *   cd packages/server && npx tsx scripts/onTeamVoteStudy76.ts --out rows.jsonl [--shard k/n] [--h-flag 開關=值 …] [--variant 標籤[@局,局]:開關=值,開關=值 …]
 *
 * 真人局 `games_cache.json` 十人局，每個忠臣／派西座位在下面的投票點，用第 1 關的同一套重播（同 `agreement.replaySeat`：
 * 只給那個座位當時知道的東西、亂數照「局號|座位|vote-提議號」）讓機器人投一次：
 *   - 在隊上（不是隊長）：第 3–5 局、第 1–4 次提議（非強制、票數對得上結果）。
 *   - 不在隊上：第 3–5 局的第 4 次提議（再否決就是強制局）。
 * 每點記：
 *   - 機器人的票：H = 真人桌策略層（照開打前的 S 分弱／一般／強；S 不明 = 一般）、A = 基準線；H 另記理由（`ForwardAgent` 推理紀錄的那一條規則）。
 *     `--h-flag` 疊在 H 上面（候選也跟著）：第 76 回合的表是在採用之前量的，要重現就加 `--h-flag onTeamVote59=0.8`。
 *   - `--variant` 的開關疊在 H 上面再投一次（只在標籤指定的局、而且在隊上的點重投，其他點照 H；`@3,4` = 第 3、4 局，不寫 = 第 4 局）。
 *   - 這個座位的後驗（H 與 A 各一份）：P(隊上自己以外有紅)、P(隊上的紅 ≥ 2)；隊上實際的紅數、要幾張失敗。
 *   - 局面：第幾局、第幾次提議、比分、隊伍人數、這一局之後自己還會不會當隊長；座位 PR、桌上 S 與強度層。
 * 輸出一行一點的 JSONL（沒有名字、沒有局號，只有資料集裡的序號、座位、提議序號），另外每個忠臣／派西座位一行 `k:"seat"`
 * （量尺換算的分母用）。給 `onTeamVoteStudy76.py` 彙總。輸出放在 repo 外。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AVALON_CONFIG } from '@avalon/shared';
import { getDefaultAgentTuning, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { ForwardAgent } from '../src/ai/forward/ForwardAgent';
import { PROFILE_OVERRIDES, opponentTypeOfTable } from '../src/ai/humanProfile';
import { withSeededRandom } from '../src/ai/benchmark/agreement';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf } from '../src/ai/benchmark/sheetsReplay';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { bayesOptionsOf, bayesTeamRedsBelow } from '../src/ai/belief/BayesBelief';
import { leadsLaterThisRound } from '../src/ai/BlueRound38';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((x, i) => (x === name ? [argv[i + 1]] : []));

function flags(spec: string): Partial<AgentTuning> {
  const t: Partial<AgentTuning> = {};
  for (const f of spec.split(',').filter(Boolean)) Object.assign(t, parseTuningFlag(f));
  return t;
}

interface Variant { label: string; rounds: number[]; tuning: Partial<AgentTuning> }

const hFlags: Partial<AgentTuning> = flags(args('--h-flag').join(','));

const variants: Variant[] = args('--variant').map((v) => {
  const i = v.indexOf(':');
  const [label, rs] = v.slice(0, i).split('@');
  return { label, rounds: rs ? rs.split(',').map(Number) : [4], tuning: flags(v.slice(i + 1)) };
});

function main(): void {
  const file = arg('--dataset') ?? path.resolve(__dirname, '..', 'games_cache.json');
  const out = arg('--out');
  if (!out) throw new Error('--out required');
  const [k, n] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const games = replayGamesFromDataset(JSON.parse(fs.readFileSync(file, 'utf8'))).games;
  const lines: string[] = [];
  let ti = -1;
  let points = 0;
  games.forEach((g, gi) => {
    const game = g.game;
    if (game.playerCount !== 10) return;
    ti += 1;
    if (ti % n !== k) return;
    const opp = opponentTypeOfTable({ humans: 9, tableS: g.s });
    const tier = g.s === null ? 'unknown' : opp;
    const red = (s: number): boolean => campOf(game.seatRoles[s - 1]) === 'evil';
    for (let seat = 1; seat <= 10; seat++) {
      const role = game.seatRoles[seat - 1];
      if (role !== 'loyal' && role !== 'percival') continue;
      lines.push(JSON.stringify({ k: 'seat', gi, ti, seat, role, tier, s: g.s }));
      const id = seatId(seat);
      const vote = (tuning: Partial<AgentTuning>, idx: number, why: boolean): { vote: boolean; why: string } => {
        const obs = buildReplayObservation(game, seat, { kind: 'team_vote', proposal: idx });
        const seed = `${game.id}|${seat}|vote-${idx}`;
        const agent = new HeuristicAgent(id, undefined, undefined, tuning);
        agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
        const act = withSeededRandom(seed, () => agent.act(obs));
        let reason = '';
        if (why) {
          try {
            const shadow = new HeuristicAgent(id, undefined, undefined, tuning);
            shadow.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
            const d = withSeededRandom(seed, () => new ForwardAgent(id, shadow).decide(obs));
            reason = d.reasoningTrace.chosen.description.slice(0, 60);
          } catch { reason = 'err'; }
        }
        return { vote: act.type === 'team_vote' ? act.vote : true, why: reason };
      };
      game.proposals.forEach((p, idx) => {
        if (p.forced || !p.votesReliable || p.round < 3 || p.attempt > 4 || p.leaderSeat === seat) return;
        const on = p.teamSeats.includes(seat);
        if (!on && p.attempt !== 4) return;
        const obs = buildReplayObservation(game, seat, { kind: 'team_vote', proposal: idx });
        const req = AVALON_CONFIG[10].questFailsRequired?.[p.round - 1] ?? 1;
        const prior = game.quests.filter((q) => q.round < p.round);
        const row: Record<string, unknown> = {
          gi, ti, seat, pi: idx, tier, s: g.s, pr: g.prs?.[seat - 1] ?? null, prov: g.prov?.[seat - 1] ?? null,
          role, round: p.round, attempt: p.attempt, bw: prior.filter((q) => !q.failed).length, rw: prior.filter((q) => q.failed).length,
          size: p.teamSeats.length, req, reds: p.teamSeats.filter(red).length, on: on ? 1 : 0,
          human: p.votes[seat - 1] ? 1 : 0, later: leadsLaterThisRound(obs) ? 1 : 0,
        };
        const team = p.teamSeats.map(seatId);
        const hOver: Partial<AgentTuning> = { ...PROFILE_OVERRIDES[opp], ...hFlags };
        for (const [col, over] of [['H', hOver], ['A', {}]] as const) {
          const v = vote(over, idx, col === 'H');
          row[col] = v.vote ? 1 : 0;
          if (col === 'H') row.H_why = v.why;
          const opts = bayesOptionsOf({ ...getDefaultAgentTuning(), ...over } as AgentTuning);
          const b1 = bayesTeamRedsBelow(obs, team, 1, opts);
          const b2 = bayesTeamRedsBelow(obs, team, 2, opts);
          row[`${col}_p1`] = b1 === null ? null : +(1 - b1).toFixed(4);
          row[`${col}_p2`] = b2 === null ? null : +(1 - b2).toFixed(4);
        }
        for (const v of variants) {
          row[`H${v.label}`] = on && v.rounds.includes(p.round) ? (vote({ ...hOver, ...v.tuning }, idx, false).vote ? 1 : 0) : row.H;
        }
        lines.push(JSON.stringify(row));
        points += 1;
      });
    }
  });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`shard ${k}/${n}: ${points} points`);
}

if (require.main === module) main();
