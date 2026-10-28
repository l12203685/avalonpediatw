/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 3 局提議的診斷（優化迴圈用，2026-10-28）：全機器人自我對打 N 局，依隊長陣營／角色統計第 3 局的提議、
 * 隊上有沒有紅、通過與否、有紅的隊被放行時有幾個藍方贊成。開關用環境變數（AVALON_TUNING_*）。
 *
 *   USE_FORWARD_REASONING=true npx tsx scripts/r3Diagnosis.ts 400
 */
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { seededRandom } from '../src/ai/benchmark/agreement';
import type { PlayerObservation } from '../src/ai/types';
class Rec extends HeuristicAgent { last?: PlayerObservation; role = ''; onGameStart(o: PlayerObservation) { this.role = o.myRole; super.onGameStart(o); } onGameEnd(o: PlayerObservation, w: boolean) { this.last = o; super.onGameEnd(o, w); } }
(async () => {
  const engine = new SelfPlayEngine();
  const N = Number(process.argv[2] ?? 600);
  const st: Record<string, number> = {};
  const inc = (k: string, n = 1) => { st[k] = (st[k] ?? 0) + n; };
  const log = console.log; const orig = Math.random;
  for (let i = 0; i < N; i++) {
    const agents = Array.from({ length: 10 }, (_, k) => new Rec(`P${k + 1}`));
    let roles: Record<string, string> = {};
    Math.random = seededRandom(`r3diag|${i}`);
    console.log = (s: string) => { try { const e = JSON.parse(s); if (e.event === 'game_final_stats') roles = e.roles; } catch { /* */ } };
    try { await engine.runGame(agents, false); } finally { console.log = log; Math.random = orig; }
    roles = Object.fromEntries(agents.map((a) => [a.agentId, a.role]));
    const o = agents[0].last!;
    const evil = new Set(Object.entries(roles).filter(([, r]) => ['assassin', 'morgana', 'mordred', 'oberon', 'minion'].includes(r)).map(([id]) => id));
    for (const v of o.voteHistory.filter((x) => x.round === 3)) {
      const reds = v.team.filter((id) => evil.has(id)).length;
      const lr = evil.has(v.leader) ? 'redLeader' : `blueLeader(${roles[v.leader]})`;
      inc(`R3 proposals ${lr}`); if (reds > 0) inc(`R3 proposals ${lr} withRed`);
      if (v.approved) { inc(`R3 approved ${lr}`); if (reds > 0) inc(`R3 approved ${lr} withRed`); }
      if (v.approved && v.attempt < 5) {
        const goodYes = Object.entries(v.votes).filter(([id, y]) => y && !evil.has(id)).length;
        if (reds > 0) inc('R3 approved-with-red: blue yes votes', goodYes); if (reds > 0) inc('R3 approved-with-red count(non-forced)');
      }
      if (v.attempt === 5) inc(`R3 forced ${lr}${reds > 0 ? ' withRed' : ''}`);
    }
  }
  console.log(JSON.stringify(st, null, 1));
})();
