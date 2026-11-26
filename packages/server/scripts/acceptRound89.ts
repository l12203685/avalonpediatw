/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 89 回合：第 53 回合的驗收案例 Q1／Q2（`acceptRound53.ts`）在 `worldDM89`（`(W, D, M)` 聯合層）下的結果——每人的紅機率、準則過不過、機器人實際派的隊。
 * 基準線與真人桌（一般真人桌的讀法）各一組；額外的開關照 `--cand 名字=開關,開關` 加。
 *
 *   cd packages/server && npx tsx scripts/acceptRound89.ts [--cand 名字=worldDM89=1,worldDM89Scope=9 ...]
 */
import { Q1, Q2, q1Pass, q2Pass } from './acceptRound53';

async function main(): Promise<void> {
  const { DEFAULT_AGENT_TUNING, parseTuningFlag } = await import('../src/ai/AgentTuning');
  const { bayesOptionsOf, bayesRedShare } = await import('../src/ai/belief/BayesBelief');
  const { HeuristicAgent } = await import('../src/ai/HeuristicAgent');
  const { withSeededRandom } = await import('../src/ai/benchmark/agreement');
  const { tuningForOpponent } = await import('../src/ai/humanProfile');
  const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
  const seatOf = (id: string): string => { const n = Number(id.slice(1)); return n === 10 ? '0' : String(n); };
  const teamStr = (t: readonly string[]): string => t.map(seatOf).sort((a, b) => (a === '0' ? 10 : +a) - (b === '0' ? 10 : +b)).join('');
  const fmt = (m: Map<string, number>, me: string): string => IDS.filter((id) => seatOf(id) !== me).map((id) => `${m.get(id)!.toFixed(2)}`).join('／');
  type T = typeof DEFAULT_AGENT_TUNING;
  const argv = process.argv.slice(2);
  const extra: [string, Partial<T>][] = [];
  argv.forEach((a, i) => {
    if (a !== '--cand') return;
    const s = argv[i + 1];
    const at = s.indexOf('=');
    const flags: Partial<T> = {};
    for (const f of s.slice(at + 1).split(',').filter(Boolean)) Object.assign(flags, parseTuningFlag(f));
    extra.push([s.slice(0, at), flags]);
  });
  const variants: [string, Partial<T>][] = [['關', {}], ['worldDM89=1', { worldDM89: 1 }], ['worldDM89=1、派西', { worldDM89: 1, worldDM89Scope: 1 }],
    ['worldDM89=1、派西、票真人比例', { worldDM89: 1, worldDM89Scope: 9 }], ['worldDM89=1、派西、湖', { worldDM89: 1, worldDM89Scope: 3 }],
    ['worldDM89=1、派西、不打折', { worldDM89: 1, worldDM89Scope: 17 }], ['worldDM89=0.5、派西', { worldDM89: 0.5, worldDM89Scope: 1 }], ...extra];
  for (const [table, base] of [['基準線', DEFAULT_AGENT_TUNING], ['真人桌（一般）', tuningForOpponent('avgHuman', DEFAULT_AGENT_TUNING)]] as const) {
    console.log(`\n### ${table}\n`);
    console.log('| 開關 | Q1 P(紅) 1／2／3／4／6／7／8／9／0（5 家忠臣） | Q1 | Q1 機器人的隊 | Q2 P(紅) 1／2／3／5／6／7／8／9／0（4 家派西） | Q2 | Q2 機器人的隊 |');
    console.log('|---|---|---|---|---|---|---|');
    for (const [name, flags] of variants) {
      const t = { ...base, ...flags } as T;
      const o = bayesOptionsOf(t);
      const m1 = bayesRedShare(Q1(), o);
      const m2 = bayesRedShare(Q2(), o);
      const pick = (obs: ReturnType<typeof Q1>, key: string): string[] => {
        const a = new HeuristicAgent(obs.myPlayerId, undefined, undefined, t);
        a.onGameStart(obs);
        const act = withSeededRandom(`accept89|${key}`, () => a.act(obs));
        return act.type === 'team_select' ? act.teamIds : [];
      };
      console.log(`| ${name} | ${fmt(m1, '5')} | ${q1Pass(m1) ? '過' : '不過'} | ${teamStr(pick(Q1(), 'q1'))} | ${fmt(m2, '4')} | ${q2Pass(m2) ? '過' : '不過'} | ${teamStr(pick(Q2(), 'q2'))} |`);
    }
  }
}

void main();
