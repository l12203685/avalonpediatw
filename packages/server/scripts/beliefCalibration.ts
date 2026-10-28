/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 信念校準（優化迴圈，2026-10-28；第三階段「用熵評分」）：藍方座位在第 R 局（預設 3）每一次決定時，對其他每個人
 * 「是紅的機率」有三種估計，拿真實身分算對數損失（越低越準）與分箱校準：
 *   - pyr：金字塔嫌疑分數（現行派隊、投票用的）；
 *   - uni：確定性層 L1* 的所有世界平均（只用規則與約定）；
 *   - mix：L1* 世界依金字塔加權（goodLeaderWorldPick 用的）；
 *   - bayes：L1* 世界依真人牌譜的動作概似加權（`belief/BayesBelief.ts`）。
 *
 *   USE_FORWARD_REASONING=true npx tsx scripts/beliefCalibration.ts [games=300] [round=3]
 */
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { seededRandom } from '../src/ai/benchmark/agreement';
import { computePyramidScores } from '../src/ai/baseline/pyramidScorer';
import { beliefOptionsFrom } from '../src/ai/belief/BeliefOptions';
import { buildCertainty } from '../src/ai/belief/Certainty';
import { bayesRedShare } from '../src/ai/belief/BayesBelief';
import { DEFAULT_AGENT_TUNING } from '../src/ai/AgentTuning';
import type { AgentAction, PlayerObservation } from '../src/ai/types';

const EVIL = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);

class Rec extends HeuristicAgent {
  role = '';
  seen: PlayerObservation[] = [];
  onGameStart(o: PlayerObservation): void { this.role = o.myRole; super.onGameStart(o); }
  act(o: PlayerObservation): AgentAction { if (o.myTeam === 'good') this.seen.push(JSON.parse(JSON.stringify(o))); return super.act(o); }
}

(async () => {
  const N = Number(process.argv[2] ?? 300);
  const R = Number(process.argv[3] ?? 3);
  const engine = new SelfPlayEngine();
  const belief = beliefOptionsFrom(DEFAULT_AGENT_TUNING);
  const loss = { pyr: 0, uni: 0, mix: 0, bayes: 0 };
  let n = 0;
  const mk = () => new Array(10).fill(0).map(() => [0, 0]);
  const bins = { pyr: mk(), uni: mk(), mix: mk(), bayes: mk() };
  const log = console.log; const orig = Math.random;
  const clamp = (x: number) => Math.min(0.98, Math.max(0.02, x));
  for (let g = 0; g < N; g++) {
    const agents = Array.from({ length: 10 }, (_, k) => new Rec(`P${k + 1}`));
    Math.random = seededRandom(`calib|${g}`);
    console.log = () => undefined;
    try { await engine.runGame(agents, false); } finally { console.log = log; Math.random = orig; }
    const evil = new Set(agents.filter((a) => EVIL.has(a.role)).map((a) => a.agentId));
    for (const a of agents) {
      for (const o of a.seen) {
        if (o.currentRound !== R || (o.gamePhase !== 'team_select' && o.gamePhase !== 'team_vote')) continue;
        const pyr = computePyramidScores(o, belief);
        const view = buildCertainty(o);
        const ws = view.worlds('L1*');
        const ids = o.allPlayerIds;
        const p = ids.map((id) => clamp(pyr.scores.get(id) ?? 0.5));
        const w = ws.map((m) => ids.reduce((acc, _id, i) => acc * ((m >> i) & 1 ? p[i] : 1 - p[i]), 1));
        const tot = w.reduce((x, y) => x + y, 0);
        const bayes = bayesRedShare(o);
        ids.forEach((id, i) => {
          if (id === o.myPlayerId) return;
          const y = evil.has(id) ? 1 : 0;
          const est = {
            pyr: p[i],
            uni: clamp(view.uniformRedShare(id)),
            mix: clamp(tot > 0 ? ws.reduce((acc, m, k) => acc + ((m >> i) & 1 ? w[k] : 0), 0) / tot : 0.5),
            bayes: clamp(bayes.get(id) ?? 0.5),
          };
          for (const k of ['pyr', 'uni', 'mix', 'bayes'] as const) {
            loss[k] += -(y * Math.log(est[k]) + (1 - y) * Math.log(1 - est[k]));
            const b = Math.min(9, Math.floor(est[k] * 10)); bins[k][b][0]++; bins[k][b][1] += y;
          }
          n++;
        });
      }
    }
  }
  console.log(`第 ${R} 局藍方決定，${n} 個（座位, 對象）估計；對數損失（bits/估計，越低越準；全部猜 0.44 約 0.99）`);
  for (const k of ['pyr', 'uni', 'mix', 'bayes'] as const) console.log(`  ${k}: ${(loss[k] / n / Math.LN2).toFixed(4)}`);
  for (const k of ['pyr', 'uni', 'mix', 'bayes'] as const) {
    console.log(`  ${k} 校準（估計分箱 → 實際紅的比例, n）: ` + bins[k].map((b, i) => (b[0] ? `${i / 10}-${(i + 1) / 10}:${(b[1] / b[0]).toFixed(2)}(${b[0]})` : '')).filter(Boolean).join(' '));
  }
})();
