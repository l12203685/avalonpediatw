/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 1 局藏牌為什麼抬高刺中率（優化迴圈第 15 回合・藍方，2026-10-31）：同一組種子、兩個以上的設定（例如正式預設 vs 關掉藏牌），
 * 全機器人自我對打 N 局，在三藍的局裡把刺客的分數拆成三塊——條件邏輯回歸模型（`AssassinModel`）、讀票（`MerlinVoteRead`，
 * 第 12 回合的 normalFit × 0.5）、讀派隊（`MerlinLeadRead` × 1）——看梅林比其他藍方平均高多少、單用那一塊會不會刺中。
 * 另外統計「第 1 局出成功藏身的紅」（藏牌者）之後被誰帶進隊伍、被誰在被擋的格子（梅林不會贊成的格子）贊成。只輸出彙總數字。
 *
 *   USE_FORWARD_REASONING=true npx tsx scripts/hideExposureDiagnosis.ts 400 default= nohide=redHideR1=0,mordredHideR1=false
 */
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { seededRandom } from '../src/ai/benchmark/agreement';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { assassinCandidateFeatures, scoreAssassinCandidates } from '../src/ai/assassin/AssassinModel';
import { ASSASSIN_MODEL_WEIGHTS } from '../src/ai/assassin/assassinModelWeights';
import { merlinVoteLogRatio } from '../src/ai/assassin/MerlinVoteRead';
import { merlinLeadLogRatio } from '../src/ai/assassin/MerlinLeadRead';
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
    Math.random = seededRandom(`r15hide|${i}`);
    console.log = () => undefined;
    let res;
    try { res = await engine.runGame(agents, false); } finally { console.log = log; Math.random = orig; }
    const roles: Record<string, Role> = Object.fromEntries(agents.map((a) => [a.agentId, a.role as Role]));
    const evil = (id: string): boolean => EVIL.has(roles[id]);
    const vis = (id: string): boolean => evil(id) && roles[id] !== 'mordred';
    const o = agents[0].last; if (!o) continue;
    add(acc, 'games', 1);
    add(acc, 'threeBlue', res.threeBlue ? 1 : 0);
    // Hiders: reds on a successful R1 mission.
    const r1 = o.questHistory.find((q) => q.round === 1);
    const hiders = r1 && r1.result === 'success' ? r1.team.filter(evil) : [];
    const visHiders = hiders.filter(vis);
    add(acc, 'game has visible hider', visHiders.length > 0 ? 1 : 0);
    if (res.threeBlue) {
      add(acc, `hit|${visHiders.length > 0 ? 'visHider' : 'noVisHider'}`, res.merlinKilled ? 1 : 0);
      add(acc, 'hit|all', res.merlinKilled ? 1 : 0);
    }
    // Who brings a visible hider onto R2+ teams (non-forced), and who approves him in a barred cell.
    for (const v of o.voteHistory) {
      if (v.round < 2 || v.attempt >= 5) continue;
      const lr = roles[v.leader];
      if (!evil(v.leader) && visHiders.length > 0) {
        const cls = lr === 'merlin' ? 'merlin' : lr === 'percival' ? 'percival' : 'loyal';
        add(acc, `lead with visHider|${cls}`, v.team.some((id) => visHiders.includes(id)) ? 1 : 0);
      }
      if (!evil(v.leader)) {
        const cls = lr === 'merlin' ? 'merlin' : lr === 'percival' ? 'percival' : 'loyal';
        add(acc, `lead with any vis red|${cls}`, v.team.some(vis) ? 1 : 0);
      }
      if (v.round < 3) continue;
      const fails = o.questHistory.filter((q) => q.round < v.round && q.result === 'fail').length;
      const nSeen = v.team.filter(vis).length;
      if (nSeen === 0) continue;
      const withHider = v.team.some((id) => visHiders.includes(id));
      for (const id of Object.keys(v.votes)) {
        if (evil(id)) continue;
        const r = roles[id];
        const cls = r === 'merlin' ? 'merlin' : r === 'percival' ? 'percival' : 'loyal';
        const on = v.team.includes(id);
        const fatal = fails >= 2 || (v.round === 4 && nSeen >= 2);
        const cell = on ? (fatal ? 'onFatal' : null) : 'offSeen';
        if (!cell) continue;
        add(acc, `approve ${cell}|${withHider ? 'hiderTeam' : 'otherSeenTeam'}|${cls}`, v.votes[id] ? 1 : 0);
      }
    }
    if (!res.threeBlue) continue;
    // Score decomposition from the assassin's view.
    const assassin = agents.find((a) => a.role === 'assassin');
    const ao = assassin?.last; if (!ao) continue;
    const reds = agents.filter((a) => evil(a.agentId)).map((a) => a.agentId);
    const obs: PlayerObservation = { ...ao, allEvilIds: reds, allEvilRoles: Object.fromEntries(reds.map((id) => [id, roles[id]])) };
    const goods = agents.filter((a) => !evil(a.agentId)).map((a) => a.agentId);
    const merlin = goods.find((id) => roles[id] === 'merlin');
    if (!merlin) continue;
    const model = scoreAssassinCandidates(obs, goods);
    const comps: Record<string, Map<string, number>> = {
      model,
      vote: new Map(goods.map((id) => [id, 0.5 * merlinVoteLogRatio(obs, id, reds, 'normalFit')])),
      lead: new Map(goods.map((id) => [id, merlinLeadLogRatio(obs, id, reds, {})])),
    };
    comps.total = new Map(goods.map((id) => [id, comps.model.get(id)! + comps.vote.get(id)! + comps.lead.get(id)!]));
    const tag = visHiders.length > 0 ? 'visHider' : 'noVisHider';
    // Which model features set Merlin apart: w_i × (x_Merlin − mean x of the other blues).
    const feats = new Map(goods.map((id) => [id, assassinCandidateFeatures(obs, id)]));
    ASSASSIN_MODEL_WEIGHTS.weights.forEach((w, i) => {
      const name = ASSASSIN_MODEL_WEIGHTS.features[i] ?? `f${i}`;
      if (name.startsWith('seat')) return;
      const others = goods.filter((id) => id !== merlin);
      const mean = others.reduce((s, id) => s + feats.get(id)![i], 0) / others.length;
      add(acc, `margin feat ${name}|${tag}`, w * (feats.get(merlin)![i] - mean));
    });
    for (const [k, m] of Object.entries(comps)) {
      const others = goods.filter((id) => id !== merlin);
      const mean = others.reduce((s, id) => s + m.get(id)!, 0) / others.length;
      const margin = m.get(merlin)! - mean;
      const top = goods.every((id) => id === merlin || m.get(id)! < m.get(merlin)!);
      for (const t of [tag, 'all']) {
        add(acc, `margin ${k}|${t}`, margin);
        add(acc, `top1 ${k}|${t}`, top ? 1 : 0);
      }
    }
  }
  console.error(`[${name}] done ${N}`);
  return acc;
}

(async () => {
  const N = Number(process.argv[2] ?? 200);
  const arms = process.argv.slice(3).map((s) => {
    const [name, flags] = s.split('=', 2).length === 2 ? [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)] : [s, ''];
    const t = { ...DEFAULT_AGENT_TUNING } as AgentTuning;
    for (const f of flags.split(',').filter(Boolean)) Object.assign(t, parseTuningFlag(f));
    return { name, t };
  });
  const results: [string, Acc][] = [];
  for (const a of arms) results.push([a.name, await runArm(a.name, a.t, N)]);
  const keys = [...new Set(results.flatMap(([, m]) => [...m.keys()]))].sort();
  console.log(['cell'.padEnd(52), ...results.map(([n]) => n.padStart(18))].join(''));
  for (const k of keys) {
    const row = results.map(([, m]) => {
      const c = m.get(k); if (!c) return '—'.padStart(18);
      const isMean = k.startsWith('margin');
      const v = isMean ? (c[0] / c[1]).toFixed(3) : `${((100 * c[0]) / c[1]).toFixed(1)}%`;
      return `${v} (${c[1]})`.padStart(18);
    });
    console.log([k.padEnd(52), ...row].join(''));
  }
  process.exit(0); // the engine leaves timers behind
})();
