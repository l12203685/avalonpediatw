/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 59 回合：藍方在隊上的投票（第 3 局起、第 1–4 次提議、自己不是隊長）——機器人為什麼內黑、真人怎麼投。
 *
 *   cd packages/server && npx tsx scripts/onTeamVoteStudy59.ts --out rows.jsonl [--shard k/n] [--variant 標籤:開關=值,開關=值 …]
 *
 * 真人局 `games_cache.json` 十人局，每個藍方座位（忠臣／派西／梅林）在上面那些投票點，用第 1 關的同一套重播（同 `agreement.replaySeat`：
 * 只給那個座位當時知道的東西、亂數照「局號|座位|vote-提議號」）讓機器人投一次，記：
 *   - 機器人的票與理由（`ForwardAgent` 推理紀錄的那一條規則），兩個策略層：H = 真人桌（照開打前的 S 分層）、A = 基準線；
 *     `--variant` 的開關疊在兩層上面各再投一次；
 *   - 公開視角（這個座位的後驗）的 P(隊上自己以外有紅)、P(隊上的紅夠讓任務失敗)；隊上實際的紅數；
 *   - 局面：第幾局、第幾次提議、比分、隊伍人數、這一局之後自己還會不會當隊長；座位 PR、桌上 S。
 * 輸出一行一點的 JSONL（沒有名字、沒有局號，只有資料集裡的序號），給 `onTeamVoteStudy59.py` 彙總。輸出放在 repo 外。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AVALON_CONFIG } from '@avalon/shared';
import { parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { ForwardAgent } from '../src/ai/forward/ForwardAgent';
import { PROFILE_OVERRIDES, opponentTypeOfTable } from '../src/ai/humanProfile';
import { withSeededRandom } from '../src/ai/benchmark/agreement';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf } from '../src/ai/benchmark/sheetsReplay';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { bayesOptionsOf, bayesRedShare, bayesTeamRedsBelow } from '../src/ai/belief/BayesBelief';
import { getDefaultAgentTuning } from '../src/ai/AgentTuning';
import { leadsLaterThisRound } from "../src/ai/BlueRound38";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((x, i) => (x === name ? [argv[i + 1]] : []));

function flags(spec: string): Partial<AgentTuning> {
  const t: Partial<AgentTuning> = {};
  for (const f of spec.split(',').filter(Boolean)) Object.assign(t, parseTuningFlag(f));
  return t;
}

const variants: Array<[string, Partial<AgentTuning>]> = [['', {}], ...args('--variant').map((v): [string, Partial<AgentTuning>] => {
  const i = v.indexOf(':');
  return [v.slice(0, i), flags(v.slice(i + 1))];
})];

function main(): void {
  const file = arg('--dataset') ?? path.resolve(__dirname, '..', 'games_cache.json');
  const out = arg('--out');
  if (!out) throw new Error('--out required');
  const [k, n] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const games = replayGamesFromDataset(JSON.parse(fs.readFileSync(file, 'utf8'))).games.filter((g) => g.game.playerCount === 10);
  const lines: string[] = [];
  let mism = 0;
  games.forEach((g, gi) => {
    if (gi % n !== k) return;
    const game = g.game;
    const opp = opponentTypeOfTable({ humans: 9, tableS: g.s });
    const red = (s: number): boolean => campOf(game.seatRoles[s - 1]) === 'evil';
    for (let seat = 1; seat <= 10; seat++) {
      const role = game.seatRoles[seat - 1];
      if (campOf(role) !== 'good') continue;
      const id = seatId(seat);
      game.proposals.forEach((p, idx) => {
        if (p.forced || !p.votesReliable || p.round < 3 || p.attempt > 4 || p.leaderSeat === seat || !p.teamSeats.includes(seat)) return;
        const obs = buildReplayObservation(game, seat, { kind: 'team_vote', proposal: idx });
        const req = AVALON_CONFIG[10].questFailsRequired?.[p.round - 1] ?? 1;
        const reds = p.teamSeats.filter(red).length;
        const prior = game.quests.filter((q) => q.round < p.round);
        const bw = prior.filter((q) => !q.failed).length;
        const rw = prior.filter((q) => q.failed).length;
        const row: Record<string, unknown> = {
          gi, tier: g.s === null ? 'unknown' : opp, s: g.s, pr: g.prs?.[seat - 1] ?? null, prov: g.prov?.[seat - 1] ?? null,
          role, round: p.round, attempt: p.attempt, bw, rw, size: p.teamSeats.length, req, reds,
          human: p.votes[seat - 1] ? 1 : 0, later: leadsLaterThisRound(obs) ? 1 : 0,
        };
        for (const [label, extra] of variants) {
          for (const [col, over] of [['H', PROFILE_OVERRIDES[opp]], ['A', {}]] as const) {
            const tuning = { ...over, ...extra };
            const seed = `${game.id}|${seat}|vote-${idx}`;
            const agent = new HeuristicAgent(id, undefined, undefined, tuning);
            agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
            const act = withSeededRandom(seed, () => agent.act(obs));
            const vote = act.type === 'team_vote' ? act.vote : true;
            let why = '';
            try {
              const shadow = new HeuristicAgent(id, undefined, undefined, tuning);
              shadow.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
              const d = withSeededRandom(seed, () => new ForwardAgent(id, shadow).decide(obs));
              why = d.reasoningTrace.chosen.description.slice(0, 90);
              if (d.action.type === 'team_vote' && d.action.vote !== vote) mism += 1;
            } catch { why = 'err'; }
            row[`${col}${label}`] = vote ? 1 : 0;
            row[`${col}${label}_why`] = why;
            if (label === '') {
              const t = { ...getDefaultAgentTuning(), ...tuning } as AgentTuning;
              const opts = bayesOptionsOf(t);
              const b1 = bayesTeamRedsBelow(obs, p.teamSeats.map(seatId), 1, opts);
              const b2 = req >= 2 ? bayesTeamRedsBelow(obs, p.teamSeats.map(seatId), 2, opts) : b1;
              row[`${col}_p1`] = b1 === null ? null : +(1 - b1).toFixed(4);
              row[`${col}_preq`] = b2 === null ? null : +(1 - b2).toFixed(4);
              const share = bayesRedShare(obs, opts);
              row[`${col}_max`] = +Math.max(0, ...p.teamSeats.filter((x) => x !== seat).map((x) => share.get(seatId(x)) ?? 0)).toFixed(4);
            }
          }
        }
        lines.push(JSON.stringify(row));
      });
    }
  });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`shard ${k}/${n}: ${lines.length} points, reason/vote mismatches ${mism}`);
}

if (require.main === module) main();
