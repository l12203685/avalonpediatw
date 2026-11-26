/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 90 回合：第 89 回合留下的「第 1、2 局一張失敗之後，信念把『那一隊有兩個紅以上』高估約 5pp」——第 1 號模型接上信念之後還高估多少。
 *
 * 真人局（time-test = 照日期排序後 1/3；--split all 全部），第 1／2 局任務出了剛好一張失敗之後，下一局第一次投票，
 * 不在那一隊上的忠臣／派西：信念說「那一隊有兩個紅以上」的機率（世界權重加總）對真的比例（以觀察點加權，同第 89 回合 3c）。
 *
 *   cd packages/server && npx tsx scripts/ml/twoRedCheck90.ts [--split time-test] --cand NAME=flag,flag ...
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, type AgentTuning } from '../../src/ai/AgentTuning';
import { bayesOptionsOf, bayesWorlds, type BayesOptions } from '../../src/ai/belief/BayesBelief';
import { buildReplayObservation, seatId } from '../../src/ai/benchmark/replayObservation';
import { campOf } from '../../src/ai/benchmark/sheetsReplay';
import { replayGamesFromDataset, type DatasetHeader, type DatasetTuple } from '../../src/ai/benchmark/datasetReplay';
import { hideLobbyOrder } from '../../src/bots/simulation/aiRead';
import { timeSplit } from './exportBelief90';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function main(): void {
  const root = path.resolve(__dirname, '..', '..');
  const dataset = JSON.parse(fs.readFileSync(path.join(root, 'games_cache.json'), 'utf8')) as DatasetHeader & { games: readonly DatasetTuple[] };
  const games = replayGamesFromDataset(dataset).games.filter((g) => g.game.playerCount === 10);
  const late = timeSplit(games.map((g) => g.date));
  const split = arg('--split') ?? 'time-test';
  const vs: { name: string; opts: BayesOptions }[] = [{ name: '現行', opts: bayesOptionsOf({ ...DEFAULT_AGENT_TUNING }) }];
  argv.forEach((a, i) => {
    if (a !== '--cand') return;
    const s = argv[i + 1];
    const eq = s.indexOf('=');
    const t: AgentTuning = { ...DEFAULT_AGENT_TUNING };
    for (const f of s.slice(eq + 1).split(',').filter(Boolean)) Object.assign(t, parseTuningFlag(f));
    vs.push({ name: s.slice(0, eq), opts: bayesOptionsOf(t) });
  });
  const acc = new Map<string, { n: number; sp: number[]; sy: number }>();
  games.forEach((g, gi) => {
    if (split === 'time-test' && !late[gi]) return;
    const game = g.game;
    for (const q of game.quests) {
      if (q.round > 2 || q.failCount !== 1) continue;
      const pi = game.proposals.findIndex((p) => p.round === q.round + 1 && !p.forced);
      if (pi < 0) continue;
      const reds = q.teamSeats.filter((s) => campOf(game.seatRoles[s - 1]) === 'evil').length;
      const y = reds >= 2 ? 1 : 0;
      for (let seat = 1; seat <= 10; seat++) {
        const role = game.seatRoles[seat - 1];
        if ((role !== 'loyal' && role !== 'percival') || q.teamSeats.includes(seat)) continue;
        const obs = hideLobbyOrder(buildReplayObservation(game, seat, { kind: 'team_vote', proposal: pi }));
        const team = q.teamSeats.map(seatId);
        const key = `R${q.round}`;
        const a = acc.get(key) ?? { n: 0, sp: vs.map(() => 0), sy: 0 };
        a.n++;
        a.sy += y;
        vs.forEach((v, k) => {
          const w = bayesWorlds(obs, v.opts);
          let mask = 0;
          for (const id of team) mask |= w.bitOf(id);
          let p = 0;
          w.worlds.forEach((x, i) => { let c = 0; let m = x & mask; while (m) { m &= m - 1; c++; } if (c >= 2) p += w.wts[i]; });
          a.sp[k] += p;
        });
        acc.set(key, a);
      }
    }
  });
  console.log(`| 第幾局一張失敗 | 點數 | 真的 % | ${vs.map((v) => `${v.name} 說 %`).join(' | ')} |`);
  console.log(`|---|---|---|${vs.map(() => '---').join('|')}|`);
  for (const [k, a] of [...acc].sort()) console.log(`| ${k} | ${a.n} | ${(100 * a.sy / a.n).toFixed(1)} | ${a.sp.map((s) => (100 * s / a.n).toFixed(1)).join(' | ')} |`);
}

if (require.main === module) main();
