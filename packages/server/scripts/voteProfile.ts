/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 機器人黑白球的分布（優化迴圈第 2 回合・紅方，2026-10-28）：全機器人自我對打 N 局，依
 * `陣營|在不在隊上|隊上有沒有紅|回合段` 統計贊成率，和真人牌譜的概似表（`belief/likelihoods.json`）並排。
 * 紅藍差越多的格子，貝氏藍方從那格讀到的越多。開關用環境變數（AVALON_TUNING_*）。
 *
 *   USE_FORWARD_REASONING=true npx tsx scripts/voteProfile.ts [games=300]
 */
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { seededRandom } from '../src/ai/benchmark/agreement';
import TABLE from '../src/ai/belief/likelihoods.json';
import type { PlayerObservation } from '../src/ai/types';

const EVIL = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);
class Rec extends HeuristicAgent {
  role = ''; last?: PlayerObservation;
  onGameStart(o: PlayerObservation): void { this.role = o.myRole; super.onGameStart(o); }
  onGameEnd(o: PlayerObservation, w: boolean): void { this.last = o; super.onGameEnd(o, w); }
}
(async () => {
  const N = Number(process.argv[2] ?? 300);
  const engine = new SelfPlayEngine();
  const cells: Record<string, [number, number]> = {};
  const log = console.log; const orig = Math.random;
  for (let g = 0; g < N; g++) {
    const agents = Array.from({ length: 10 }, (_, k) => new Rec(`P${k + 1}`));
    Math.random = seededRandom(`vprof|${g}`);
    console.log = () => undefined;
    try { await engine.runGame(agents, false); } finally { console.log = log; Math.random = orig; }
    const evil = new Set(agents.filter((a) => EVIL.has(a.role)).map((a) => a.agentId));
    for (const v of agents[0].last!.voteHistory) {
      if (v.attempt >= 5) continue;
      const hasRed = v.team.some((id) => evil.has(id));
      for (const [id, yes] of Object.entries(v.votes)) {
        const k = `${evil.has(id) ? 'evil' : 'good'}|${v.team.includes(id) ? 'on' : 'off'}|${hasRed ? 'red' : 'clean'}|${v.round <= 2 ? 'r12' : 'r3'}`;
        const c = (cells[k] ??= [0, 0]); if (yes) c[0]++; c[1]++;
      }
    }
  }
  const human = (TABLE as unknown as { vote: Record<string, [number, number]> }).vote;
  console.log('格子                     機器人贊成率(n)        真人');
  for (const k of Object.keys(cells).sort()) {
    const [a, n] = cells[k]; const h = human[k];
    console.log(`${k.padEnd(24)} ${(100 * a / n).toFixed(1).padStart(5)}% (${n})`.padEnd(48) + (h ? `${(100 * h[0] / h[1]).toFixed(1)}%` : '—'));
  }
})();
