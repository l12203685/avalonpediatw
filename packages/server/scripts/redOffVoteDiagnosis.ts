/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 紅方不在隊上的票（優化迴圈第 16 回合・紅方，2026-10-31）：全機器人自我對打 N 局，第 3 局起非強制提議，紅方（依角色）不在隊上時
 * 對「隊上有紅／乾淨」的隊贊成的比例，再依「紅方已兩紅（關鍵）」拆，並看贊成票是不是決定性的（少這一票就不過）。
 * 另列藍方同格子作對照。只輸出彙總數字。
 *
 *   USE_FORWARD_REASONING=true npx tsx scripts/redOffVoteDiagnosis.ts 300 default= alt=redNormalVote=1
 */
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { seededRandom } from '../src/ai/benchmark/agreement';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import type { PlayerObservation, Role } from '../src/ai/types';

class Rec extends HeuristicAgent {
  last?: PlayerObservation; role = '';
  onGameStart(o: PlayerObservation): void { this.role = o.myRole; super.onGameStart(o); }
  onGameEnd(o: PlayerObservation, w: boolean): void { this.last = o; super.onGameEnd(o, w); }
}
const EVIL = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);
type Acc = Map<string, [number, number]>;
const add = (m: Acc, k: string, x: number, n = 1): void => { const c = m.get(k) ?? [0, 0]; c[0] += x; c[1] += n; m.set(k, c); };

async function runArm(name: string, tuning: AgentTuning, N: number): Promise<Acc> {
  const acc: Acc = new Map();
  const engine = new SelfPlayEngine();
  const log = console.log; const orig = Math.random;
  for (let i = 0; i < N; i++) {
    const agents = Array.from({ length: 10 }, (_, k) => new Rec(`P${k + 1}`, undefined, undefined, tuning));
    Math.random = seededRandom(`r16redoff|${i}`);
    console.log = () => undefined;
    let res;
    try { res = await engine.runGame(agents, false); } finally { console.log = log; Math.random = orig; }
    const roles: Record<string, Role> = Object.fromEntries(agents.map((a) => [a.agentId, a.role as Role]));
    const evil = (id: string): boolean => EVIL.has(roles[id]);
    const o = agents[0].last; if (!o) continue;
    add(acc, 'games', 1); add(acc, 'threeBlue', res.threeBlue ? 1 : 0);
    if (res.threeBlue) add(acc, 'hit', res.merlinKilled ? 1 : 0);
    for (const v of o.voteHistory) {
      if (v.attempt >= 5) continue;
      const seg = v.round <= 2 ? 'r12' : 'r3';
      const fails = o.questHistory.filter((q) => q.round < v.round && q.result === 'fail').length;
      const wins = o.questHistory.filter((q) => q.round < v.round && q.result === 'success').length;
      const hasRed = v.team.some(evil);
      const yes = Object.values(v.votes).filter(Boolean).length;
      for (const id of Object.keys(v.votes)) {
        if (v.team.includes(id)) continue;
        const r = roles[id];
        const cls = evil(id) ? (r === 'oberon' ? 'oberon' : 'red') : 'blue';
        const ap = v.votes[id] ? 1 : 0;
        add(acc, `${cls}|off|${hasRed ? 'red' : 'clean'}|${seg}`, ap);
        if (seg !== 'r3') continue;
        const key = fails >= 2 ? 'key2fail' : wins >= 2 ? 'blue2win' : 'n';
        add(acc, `${cls}|off|${hasRed ? 'red' : 'clean'}|r3|${key}`, ap);
        if (cls === 'red' && hasRed && ap) add(acc, `red approve red-team r3|${key}|pivotal`, yes === 6 ? 1 : 0);
        if (cls === 'red' && hasRed) add(acc, `red off red-team r3|${key}|teamPassed`, yes >= 6 ? 1 : 0);
      }
    }
  }
  console.error(`[${name}] done ${N}`);
  return acc;
}

(async () => {
  const N = Number(process.argv[2] ?? 200);
  const arms = process.argv.slice(3).map((s) => {
    const k = s.indexOf('=');
    const name = k < 0 ? s : s.slice(0, k); const flags = k < 0 ? '' : s.slice(k + 1);
    const t = { ...DEFAULT_AGENT_TUNING } as AgentTuning;
    for (const f of flags.split(',').filter(Boolean)) Object.assign(t, parseTuningFlag(f));
    return { name, t };
  });
  const results: [string, Acc][] = [];
  for (const a of arms) results.push([a.name, await runArm(a.name, a.t, N)]);
  const keys = [...new Set(results.flatMap(([, m]) => [...m.keys()]))].sort();
  console.log(['cell'.padEnd(44), ...results.map(([n]) => n.padStart(18))].join(''));
  for (const k of keys) {
    console.log([k.padEnd(44), ...results.map(([, m]) => { const c = m.get(k); return (c ? `${((100 * c[0]) / c[1]).toFixed(1)}% (${c[1]})` : '—').padStart(18); })].join(''));
  }
  process.exit(0); // the engine leaves timers behind
})();
