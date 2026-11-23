/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 70 回合（藍方第 5 局的提議）：真人局第 5 局（2:2）每一次忠臣／派西當隊長的非強制提議，機器人在同一個座位、同一個時間點
 * （持續的 agent 重播到那一手，只看當時的資訊；亂數同 `merlinPublicThumbStudy`）派一次，輸出一行 JSON（`--out`，JSONL；沒有名字、沒有局號，
 * 只有資料集裡的序號）。交給 `r5LeadStudy70.py` 彙總（會失敗的隊、和真人完全相同、Jaccard，對照 vs 候選以局為集群）。
 *
 *   cd packages/server && npx tsx scripts/r5LeadStudy70.ts --out r5_k.jsonl --shard k/4 [--flag name=v ...]
 *
 * 每列：gi、role、att（第幾次）、pfc（第 4 局的失敗張數）、s（桌上強度）、ht／bt（真人／機器人的隊，座位號）、hDirty／bDirty（隊上有紅）、
 * pH／pB／pBest（機器人自己的後驗：真人的隊、機器人的隊、最乾淨的隊「沒有紅」的機率）、bR4（機器人照派第 4 局的隊）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { parseTuningFlag, resolveAgentTuning } from '../src/ai/AgentTuning';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { withSeededRandom } from '../src/ai/benchmark/agreement';
import { buildReplayObservation, seatId, seatOfId } from '../src/ai/benchmark/replayObservation';
import { EVIL_ROLES } from '../src/ai/benchmark/sheetsReplay';
import { bayesOptionsOf, bayesTeamClean } from '../src/ai/belief/BayesBelief';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function combos(items: readonly number[], k: number): number[][] {
  const out: number[][] = [];
  const pick = (start: number, acc: number[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < items.length; i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

function main(): void {
  const out = arg('--out');
  if (!out) throw new Error('--out PATH');
  const flags = argv.filter((_, i) => argv[i - 1] === '--flag');
  const tuning = resolveAgentTuning(Object.assign({}, ...flags.map(parseTuningFlag)));
  const opts = bayesOptionsOf(tuning);
  const [sk, sn] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const dataset = arg('--dataset') ?? path.resolve(__dirname, '..', 'games_cache.json');
  const { games } = replayGamesFromDataset(JSON.parse(fs.readFileSync(dataset, 'utf8')));
  const lines: string[] = [];
  const key = (t: readonly number[]): string => [...t].sort((a, b) => a - b).join(',');
  for (let gi = sk; gi < games.length; gi += sn) {
    const g = games[gi].game;
    if (g.playerCount !== 10) continue;
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1]);
    const r4 = g.quests.find((q) => q.round === 4);
    g.proposals.forEach((p, idx) => {
      if (p.round !== 5 || p.forced || !['loyal', 'percival'].includes(g.seatRoles[p.leaderSeat - 1])) return;
      const seat = p.leaderSeat;
      const agent = new HeuristicAgent(seatId(seat), undefined, undefined, tuning);
      agent.onGameStart(buildReplayObservation(g, seat, { kind: 'team_select', proposal: 0 }));
      const act = <T>(k: string, fn: () => T): T => withSeededRandom(`${g.id}|${seat}|${k}`, fn);
      for (let i = 0; i <= idx; i++) {
        const q = g.proposals[i];
        if (q.leaderSeat === seat) {
          const obs = buildReplayObservation(g, seat, { kind: 'team_select', proposal: i });
          const a = act(`team-${i}`, () => agent.act(obs));
          if (i !== idx) continue;
          const team = a.type === 'team_select' ? a.teamIds.map(seatOfId) : [];
          const pc = (t: readonly number[]): number => bayesTeamClean(obs, t.map(seatId), opts) ?? Number.NaN;
          const others = Array.from({ length: 10 }, (_, k) => k + 1).filter((s) => s !== seat);
          const pBest = Math.max(...combos(others, team.length - 1).map((c) => pc([seat, ...c])));
          lines.push(JSON.stringify({
            gi, role: g.seatRoles[seat - 1], att: p.attempt, pfc: r4?.failCount ?? -1, s: games[gi].s,
            ht: key(p.teamSeats), bt: key(team), hDirty: p.teamSeats.some(red) ? 1 : 0, bDirty: team.some(red) ? 1 : 0,
            pH: pc(p.teamSeats), pB: pc(team), pBest, bR4: r4 && key(team) === key(r4.teamSeats) ? 1 : 0,
          }));
        }
        if (i < idx && !q.forced && q.votesReliable) act(`vote-${i}`, () => agent.act(buildReplayObservation(g, seat, { kind: 'team_vote', proposal: i })));
      }
    });
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} decision points → ${out}`);
}

main();
