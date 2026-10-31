/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 梅林的票型與湖破綻（優化迴圈第 12 回合・紅方，2026-10-31）：全機器人自我對打 N 局（正式預設；第 12 回合的數字是第 11 回合預設、300 局；第 14 回合加上刺客讀票模型用的兩格 `model|…`），第 3 局起非強制提議，
 * 梅林與其他藍方的贊成率，依「在不在隊上 × 隊上有沒有梅林看得到的紅（seen）／只有莫德雷德（mord）／乾淨 × 紅方是否已兩紅（key）」
 * 分格；另列藍方持湖者湖到紅、湖到梅林看得到的紅的比例。只輸出彙總數字。
 *
 *   USE_FORWARD_REASONING=true npx tsx scripts/merlinTellDiagnosis.ts 300
 */
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { seededRandom } from '../src/ai/benchmark/agreement';
import type { PlayerObservation } from '../src/ai/types';
class Rec extends HeuristicAgent {
  last?: PlayerObservation; role = '';
  onGameStart(o: PlayerObservation): void { this.role = o.myRole; super.onGameStart(o); }
  onGameEnd(o: PlayerObservation, w: boolean): void { this.last = o; super.onGameEnd(o, w); }
}
const cells = new Map<string, [number, number]>();
const add = (k: string, y: boolean): void => { const c = cells.get(k) ?? [0, 0]; c[0] += y ? 1 : 0; c[1]++; cells.set(k, c); };
(async () => {
  const N = Number(process.argv[2] ?? 300);
  const engine = new SelfPlayEngine();
  const log = console.log; const orig = Math.random;
  let three = 0, killed = 0, threeRed = 0;
  for (let i = 0; i < N; i++) {
    const agents = Array.from({ length: 10 }, (_, k) => new Rec(`P${k + 1}`));
    Math.random = seededRandom(`r12diag|${i}`);
    console.log = () => undefined;
    try { await engine.runGame(agents, false); } finally { console.log = log; Math.random = orig; }
    const roles = Object.fromEntries(agents.map((a) => [a.agentId, a.role]));
    const o = agents[0].last; if (!o) continue;
    const evil = (id: string): boolean => ['assassin', 'morgana', 'mordred', 'oberon', 'minion'].includes(roles[id]);
    const vis = (id: string): boolean => evil(id) && roles[id] !== 'mordred';
    for (const v of o.voteHistory) {
      if (v.round < 3 || v.attempt >= 5) continue;
      const fails = o.questHistory.filter((q) => q.round < v.round && q.result === 'fail').length;
      const seen = v.team.some(vis), has = v.team.some(evil);
      for (const id of Object.keys(v.votes)) {
        const r = roles[id]; if (evil(id)) continue;
        const cls = r === 'merlin' ? 'merlin' : 'blue';
        const on = v.team.includes(id);
        add(`${cls}|${on ? 'on' : 'off'}|${seen ? 'seen' : has ? 'mord' : 'clean'}|${fails >= 2 ? 'key' : 'n'}`, v.votes[id]);
        // The two cells `assassin/MerlinVoteRead.ts` reads (第 14 回合): off-team with a seen red; on-team when the seen reds are fatal.
        const nSeen = v.team.filter(vis).length;
        const fatal = nSeen > 0 && (fails >= 2 || (v.round === 4 && nSeen >= 2));
        if (!on && nSeen > 0) add(`model|${cls}|offSeen|${fails >= 2 ? 'key' : 'n'}`, v.votes[id]);
        if (on && fatal) add(`model|${cls}|onFatal`, v.votes[id]);
      }
    }
    const succ = o.questHistory.filter((q) => q.result === 'success').length;
    if (succ >= 3) three++; else threeRed++;
    // lake
    for (const l of o.lakeHistory ?? []) {
      const r = roles[l.holderId]; if (evil(l.holderId)) continue;
      add(`lake|${r === 'merlin' ? 'merlin' : 'blue'}|targetRed`, evil(l.targetId));
      add(`lake|${r === 'merlin' ? 'merlin' : 'blue'}|targetVisRed`, vis(l.targetId));
    }
  }
  for (const k of [...cells.keys()].sort()) { const [y, n] = cells.get(k)!; console.log(k.padEnd(32), (100 * y / n).toFixed(1).padStart(6), n); }
  console.log('threeRed', threeRed, 'three', three);
  process.exit(0); // the engine leaves timers behind
})();
