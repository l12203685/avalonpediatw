/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 56 回合：第 53 回合的驗收案例 Q1／Q2（`acceptRound53.ts`）在本回合三個開關下的結果——信念（每人的紅機率、準則過不過）與機器人實際派的隊。
 * Q2 正好是站長「合起來看」的例子：第 1 局 250 一張失敗、第 2 局 3790 一張失敗，兩隊只重疊 0 家。
 *
 *   cd packages/server && npx tsx scripts/acceptRound56.ts
 */
import { Q1, Q2, q1Pass, q2Pass } from './acceptRound53';

async function main(): Promise<void> {
  const { DEFAULT_AGENT_TUNING } = await import('../src/ai/AgentTuning');
  const { bayesOptionsOf, bayesRedShare } = await import('../src/ai/belief/BayesBelief');
  const { HeuristicAgent } = await import('../src/ai/HeuristicAgent');
  const { withSeededRandom } = await import('../src/ai/benchmark/agreement');
  const { missionOnlyObs, missionJointScores56 } = await import('../src/ai/Round56');
  const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
  const seatOf = (id: string): string => { const n = Number(id.slice(1)); return n === 10 ? '0' : String(n); };
  const teamStr = (t: readonly string[]): string => t.map(seatOf).sort((a, b) => (a === '0' ? 10 : +a) - (b === '0' ? 10 : +b)).join('');
  const fmt = (m: Map<string, number>, me: string): string => IDS.filter((id) => seatOf(id) !== me).map((id) => `${seatOf(id)}:${m.get(id)!.toFixed(2)}`).join(' ');
  type T = typeof DEFAULT_AGENT_TUNING;
  const variants: [string, Partial<T>][] = [['現行預設', {}], ['missionRole56=1', { missionRole56: 1 }], ['missionJoint56=0.5', { missionJoint56: 0.5 }],
    ['missionJoint56=0.8', { missionJoint56: 0.8 }], ['goLike56=15', { goLike56: 15 }]];
  console.log('| 開關 | Q1 P(紅)（5 家忠臣） | Q1 | Q1 機器人的隊 | Q2 P(紅)（4 家派西） | Q2 | Q2 機器人的隊（M／F） |');
  console.log('|---|---|---|---|---|---|---|');
  for (const [name, flags] of variants) {
    const t = { ...DEFAULT_AGENT_TUNING, ...flags } as T;
    const o = bayesOptionsOf(t);
    const m1 = bayesRedShare(Q1(), o);
    const m2 = bayesRedShare(Q2(), o);
    const pick = (obs: ReturnType<typeof Q1>, key: string): string[] => {
      const a = new HeuristicAgent(obs.myPlayerId, undefined, undefined, t);
      a.onGameStart(obs);
      const act = withSeededRandom(`accept56|${key}`, () => a.act(obs));
      return act.type === 'team_select' ? act.teamIds : [];
    };
    const t1 = pick(Q1(), 'q1');
    const t2 = pick(Q2(), 'q2');
    const sc = missionJointScores56(t, Q2(), 4) ?? [];
    const s2 = sc.find((s) => teamStr(s.team) === teamStr(t2));
    console.log(`| ${name} | ${fmt(m1, '5')} | ${q1Pass(m1) ? '過' : '不過'} | ${teamStr(t1)} | ${fmt(m2, '4')} | ${q2Pass(m2) ? '過' : '不過'} | ${teamStr(t2)}${s2 ? `（${s2.m.toFixed(2)}／${s2.f.toFixed(2)}）` : ''} |`);
  }
  // 只用規則＋任務結果＋湖的後驗（Q2）：0 家在兩次失敗的任務上
  const mo = bayesRedShare(missionOnlyObs(Q2()), bayesOptionsOf(DEFAULT_AGENT_TUNING));
  const moR = bayesRedShare(missionOnlyObs(Q2()), bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, missionRole56: 1 }));
  console.log(`\nQ2 只用規則＋任務＋湖：${fmt(mo, '4')}`);
  console.log(`Q2 只用規則＋任務＋湖（missionRole56=1）：${fmt(moR, '4')}`);
  const sc = (missionJointScores56(DEFAULT_AGENT_TUNING, Q2(), 4) ?? []).sort((a, b) => b.m - a.m);
  console.log(`Q2 M 最高的 5 隊：${sc.slice(0, 5).map((s) => `${teamStr(s.team)} M ${s.m.toFixed(2)} F ${s.f.toFixed(2)}`).join('、')}`);
  const sf = [...sc].sort((a, b) => b.f - a.f);
  console.log(`Q2 F 最高的 5 隊：${sf.slice(0, 5).map((s) => `${teamStr(s.team)} M ${s.m.toFixed(2)} F ${s.f.toFixed(2)}`).join('、')}`);
}
if (require.main === module) void main();
