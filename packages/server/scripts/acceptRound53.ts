/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 53 回合的驗收案例（站長 11/19 標註的兩個決策點；只用牌譜紀錄，沒有玩家名字）。座位 1..9、0，隊長照 1→0 輪；
 * 票：隊上贊成、隊外反對，除非標 X-（隊上反對）、X+（隊外贊成）。
 *
 *   Q1（第 1 局，5 家忠臣挑 1-5）：149 / 270 / 346 / 459 全部否決。
 *      站長的讀法：1、4、9 偏好人；紅集中在 236 裡兩個、78 裡一個、0；3 家的 346 最可疑。
 *      準則：max P(紅)(1, 4, 9) ＋ 0.02 < min P(紅)(2, 3)（要分得開，不是平手），而且 3 在 9 人裡 P(紅) 前 3 高。
 *   Q2（第 3 局，4 家派西挑 3-4，拇指 1、8）：見 `diagRound53Game.ts`。真實：梅林 1、莫甘娜 8，紅 2、6、8、0。
 *      準則：P(8 紅) > P(1 紅)（1 讀成梅林那一邊），而且 0 在 9 人裡 P(紅) 前 4 高。
 *
 *   cd packages/server && USE_FORWARD_REASONING=true npx tsx scripts/acceptRound53.ts [--grid]
 */
import type { PlayerObservation, VoteRecord, QuestRecord, LakePublicRecord } from '../src/ai/types';

const S = (c: string): string => `P${c === '0' ? 10 : Number(c)}`;
const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const seatOf = (id: string): string => { const n = Number(id.slice(1)); return n === 10 ? '0' : String(n); };

function prop(round: number, attempt: number, leader: string, team: string, mods = ''): VoteRecord {
  const t = team.split('').map(S);
  const votes: Record<string, boolean> = {};
  for (const id of IDS) votes[id] = t.includes(id);
  for (const m of mods.split(' ').filter(Boolean)) for (const c of m.slice(0, -1)) votes[S(c)] = m.slice(-1) === '+';
  if (attempt >= 5) for (const id of IDS) votes[id] = true;
  const yes = Object.values(votes).filter(Boolean).length;
  return { round, attempt, leader: S(leader), team: t, approved: attempt >= 5 || yes > 5, votes };
}
const quest = (round: number, team: string, fails: number): QuestRecord => ({ round, team: team.split('').map(S), result: fails > 0 ? 'fail' : 'success', failCount: fails });

function base(me: string, role: PlayerObservation['myRole'], votes: VoteRecord[], quests: QuestRecord[], lakes: LakePublicRecord[], extra: Partial<PlayerObservation> = {}): PlayerObservation {
  const round = quests.length + 1;
  return {
    myPlayerId: S(me), myRole: role, myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: round, currentLeader: IDS[votes.length % 10], failCount: votes.filter((v) => v.round === round).length,
    questResults: quests.map((q) => q.result), gamePhase: 'team_select', voteHistory: votes, questHistory: quests, proposedTeam: [],
    lakeHistory: lakes, myLakeResults: [], evilCount: 4, ...extra,
  } as PlayerObservation;
}

export const Q1 = (): PlayerObservation => base('5', 'loyal', [prop(1, 1, '1', '149'), prop(1, 2, '2', '270'), prop(1, 3, '3', '346'), prop(1, 4, '4', '459')], [], []);
export const Q2 = (): PlayerObservation => base('4', 'percival', [
  prop(1, 1, '1', '149'), prop(1, 2, '2', '270'), prop(1, 3, '3', '346'), prop(1, 4, '4', '459'), prop(1, 5, '5', '250'),
  prop(2, 1, '6', '1679'), prop(2, 2, '7', '3780'), prop(2, 3, '8', '3780', '2+'), prop(2, 4, '9', '3790'), prop(2, 5, '0', '3790'),
  prop(3, 1, '1', '1347', '47-'), prop(3, 2, '2', '3478', '2+'), prop(3, 3, '3', '2347', '4-'),
], [quest(1, '250', 1), quest(2, '3790', 1)], [{ round: 2, holderId: S('0'), targetId: S('4'), declaredClaim: 'good' }], { knownWizards: [S('1'), S('8')] });

export function q1Pass(m: Map<string, number>): boolean {
  const p = (c: string): number => m.get(S(c))!;
  const ranked = IDS.filter((id) => id !== S('5')).sort((a, b) => m.get(b)! - m.get(a)!);
  return Math.max(p('1'), p('4'), p('9')) + 0.02 < Math.min(p('2'), p('3')) && ranked.slice(0, 3).includes(S('3'));
}
export function q2Pass(m: Map<string, number>): boolean {
  const ranked = IDS.filter((id) => id !== S('4')).sort((a, b) => m.get(b)! - m.get(a)!);
  return m.get(S('8'))! > m.get(S('1'))! && ranked.slice(0, 4).includes(S('0'));
}

async function main(): Promise<void> {
  const { DEFAULT_AGENT_TUNING } = await import('../src/ai/AgentTuning');
  const { bayesOptionsOf, bayesRedShare, bayesTeamClean } = await import('../src/ai/belief/BayesBelief');
  const { cleanScores53 } = await import('../src/ai/Round53');
  const T = { ...DEFAULT_AGENT_TUNING };
  const fmt = (m: Map<string, number>, me: string): string => IDS.filter((id) => id !== S(me)).map((id) => `${seatOf(id)}:${m.get(id)!.toFixed(2)}`).join(' ');
  const teamStr = (t: readonly string[]): string => t.map(seatOf).sort((a, b) => (a === '0' ? 10 : +a) - (b === '0' ? 10 : +b)).join('');
  type Opts = ReturnType<typeof bayesOptionsOf>;
  const row = (name: string, o: Opts): void => {
    const m1 = bayesRedShare(Q1(), o);
    const m2 = bayesRedShare(Q2(), o);
    const best = (obs: PlayerObservation, k: number): string => {
      const sc = cleanScores53(obs, k, 'posterior', T) ?? [];
      // posterior scores under these options
      const scored = sc.map((x) => ({ team: x.team, p: bayesTeamClean(obs, x.team, o) ?? 0 })).sort((a, b) => b.p - a.p);
      return scored.slice(0, 2).map((x) => `${teamStr(x.team)} ${x.p.toFixed(2)}`).join('、');
    };
    console.log(`| ${name} | ${fmt(m1, '5')} | ${q1Pass(m1) ? '過' : '不過'} | ${best(Q1(), 3)} | ${fmt(m2, '4')} | ${q2Pass(m2) ? '過' : '不過'} | ${best(Q2(), 4)} |`);
  };
  console.log('| 讀法 | Q1 P(紅)（5 家忠臣） | Q1 | Q1 最乾淨 | Q2 P(紅)（4 家派西） | Q2 | Q2 最乾淨 |');
  console.log('|---|---|---|---|---|---|---|');
  const d = bayesOptionsOf(T);
  row('預設', d);
  for (const v of [1, 3, 5, 7, 9, 11]) row(`viewpoint53=${v}`, bayesOptionsOf({ ...T, viewpoint53: v }));
  if (process.argv.includes('--grid')) {
    for (const sc of [0.25, 0.5, 1, 1.5, 2]) {
      row(`倍數 ${sc}`, { ...d, viewpoint53: { scale: sc, skipForced: false } });
      row(`倍數 ${sc}（取代表）`, { ...d, viewpoint53: { scale: sc, skipForced: false }, proposalTemper: 1e-9, ...(d.leadProposalTemper !== undefined ? { leadProposalTemper: 1e-9 } : {}) });
    }
  }
}
if (require.main === module) void main();
