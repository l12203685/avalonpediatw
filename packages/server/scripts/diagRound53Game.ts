/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 53 回合：一局真人局的派西決策點（只用牌譜紀錄，沒有玩家名字）。10 人局，座位 1..9、0，隊長照 1→0 輪；
 * 票：隊上贊成、隊外反對，除非標 X-（隊上反對）、X+（隊外贊成）。
 *   R1: 149 / 270 / 346 / 459 / 250(強制) → oox
 *   R2: 1679 / 3780 / 3780 2+ / 3790 / 3790(強制) → ooox
 *   湖 0>4 說好
 *   R3: 1347 47- / 3478 2+ / 2347 4-  → 決策點 3-4：4 家派西（拇指 1、8）當隊長
 * 真實角色：刺客 6、莫甘娜 8、莫德雷德 0、奧伯倫 2、派西 4、梅林 1；3、5、7、9 忠臣。紅 = 2、6、8、0。
 *
 *   cd packages/server && USE_FORWARD_REASONING=true npx tsx scripts/diagRound53Game.ts
 *
 * 印：預設後驗的每人紅機率與最重的世界、機器人實際挑的隊、精確挑隊（後驗／L1* 均勻）、拿掉各層讀法的後驗、
 * 依時間逐步加上每個動作時「0 是紅」「1 是紅（拇指反過來）」的對數勝算變化，以及把每一類動作單獨拿掉（留一）的變化。
 */
import type { PlayerObservation, VoteRecord, QuestRecord, LakePublicRecord } from '../src/ai/types';

const S = (c: string): string => `P${c === '0' ? 10 : Number(c)}`;
const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const seatOf = (id: string): string => { const n = Number(id.slice(1)); return n === 10 ? '0' : String(n); };
const REDS = new Set(['2', '6', '8', '0'].map(S));

type Ev = { kind: 'prop'; rec: VoteRecord; label: string } | { kind: 'quest'; rec: QuestRecord; label: string } | { kind: 'lake'; rec: LakePublicRecord; label: string };

function prop(round: number, attempt: number, leader: string, team: string, mods = ''): Ev {
  const t = team.split('').map(S);
  const votes: Record<string, boolean> = {};
  for (const id of IDS) votes[id] = t.includes(id);
  for (const m of mods.split(' ').filter(Boolean)) {
    const sign = m.slice(-1);
    for (const c of m.slice(0, -1)) votes[S(c)] = sign === '+';
  }
  const forced = attempt >= 5;
  if (forced) for (const id of IDS) votes[id] = true;
  const yes = Object.values(votes).filter(Boolean).length;
  return { kind: 'prop', label: `${round}-${attempt} ${leader}:${team}${mods ? ' ' + mods : ''}${forced ? '（強制）' : ''}`, rec: { round, attempt, leader: S(leader), team: t, approved: forced || yes > 5, votes } };
}
const quest = (round: number, team: string, fails: number): Ev => ({ kind: 'quest', label: `第 ${round} 局任務 ${team} ${fails} 張失敗`, rec: { round, team: team.split('').map(S), result: fails > 0 ? 'fail' : 'success', failCount: fails } });

const EVENTS: Ev[] = [
  prop(1, 1, '1', '149'), prop(1, 2, '2', '270'), prop(1, 3, '3', '346'), prop(1, 4, '4', '459'), prop(1, 5, '5', '250'), quest(1, '250', 1),
  prop(2, 1, '6', '1679'), prop(2, 2, '7', '3780'), prop(2, 3, '8', '3780', '2+'), prop(2, 4, '9', '3790'), prop(2, 5, '0', '3790'), quest(2, '3790', 1),
  { kind: 'lake', label: '湖 0>4 說好', rec: { round: 2, holderId: S('0'), targetId: S('4'), declaredClaim: 'good' } },
  prop(3, 1, '1', '1347', '47-'), prop(3, 2, '2', '3478', '2+'), prop(3, 3, '3', '2347', '4-'),
];

function obsFrom(events: Ev[], over: Partial<PlayerObservation> = {}): PlayerObservation {
  const voteHistory = events.filter((e) => e.kind === 'prop').map((e) => e.rec as VoteRecord);
  const questHistory = events.filter((e) => e.kind === 'quest').map((e) => e.rec as QuestRecord);
  const lakeHistory = events.filter((e) => e.kind === 'lake').map((e) => e.rec as LakePublicRecord);
  const last = voteHistory[voteHistory.length - 1];
  const round = questHistory.length + 1;
  const attemptsThisRound = voteHistory.filter((v) => v.round === round).length;
  const leaderIdx = voteHistory.length % 10;
  return {
    myPlayerId: S('4'), myRole: 'percival', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [], knownWizards: [S('1'), S('8')],
    currentRound: round, currentLeader: IDS[leaderIdx], failCount: attemptsThisRound, questResults: questHistory.map((q) => q.result),
    gamePhase: 'team_select', voteHistory, questHistory, proposedTeam: [], lakeHistory, myLakeResults: [], evilCount: 4,
    ...over,
  } as PlayerObservation;
  void last;
}

async function main(): Promise<void> {
  const { DEFAULT_AGENT_TUNING } = await import('../src/ai/AgentTuning');
  const { bayesOptionsOf, bayesRedShare, bayesWorlds, bayesTeamClean } = await import('../src/ai/belief/BayesBelief');
  const { cleanScores53 } = await import('../src/ai/Round53');
  const { HeuristicAgent } = await import('../src/ai/HeuristicAgent');
  const { withSeededRandom } = await import('../src/ai/benchmark/agreement');
  const T = { ...DEFAULT_AGENT_TUNING };
  const obs = obsFrom(EVENTS);
  const fmt = (m: Map<string, number>): string => IDS.map((id) => `${seatOf(id)}:${m.get(id)!.toFixed(2)}`).join(' ');
  const lo = (p: number): number => Math.log(Math.max(p, 1e-9) / Math.max(1 - p, 1e-9));
  const teamStr = (t: readonly string[]): string => t.map(seatOf).sort((a, b) => (a === '0' ? 10 : +a) - (b === '0' ? 10 : +b)).join('');
  const clean = (t: readonly string[]): string => (t.some((id) => REDS.has(id)) ? `含紅 ${t.filter((id) => REDS.has(id)).map(seatOf).join('')}` : '全好');

  const opts = bayesOptionsOf(T);
  console.log('## 預設後驗（派西 4 家，3-4 挑隊）');
  console.log(fmt(bayesRedShare(obs, opts)));
  console.log('投票階段的後驗（gamePhase team_vote，不走挑隊專用的讀法）：', fmt(bayesRedShare({ ...obs, gamePhase: 'team_vote' }, opts)));
  const ww = bayesWorlds(obs, opts);
  const order = ww.worlds.map((w, i) => ({ w, p: ww.wts[i] })).sort((a, b) => b.p - a.p).slice(0, 6);
  console.log('最重的世界：', order.map((x) => `${IDS.filter((id) => (x.w & ww.bitOf(id)) !== 0).map(seatOf).join('')} ${(100 * x.p).toFixed(1)}%`).join('、'));
  const truthMask = [...REDS].reduce((m, id) => m | ww.bitOf(id), 0);
  const ti = ww.worlds.indexOf(truthMask);
  console.log(`真實世界 2680 的後驗：${ti >= 0 ? (100 * ww.wts[ti]).toFixed(2) + '%' : '不在 L1*'}；L1* 世界數 ${ww.worlds.length}`);

  console.log('\n## 挑隊');
  for (const [name, over] of [['預設', {}], ['exactPick53=1（後驗）', { exactPick53: 1 }], ['exactPick53=2（L1* 均勻）', { exactPick53: 2 }]] as const) {
    const ag = new HeuristicAgent(S('4'), undefined, undefined, { ...T, ...over });
    ag.onGameStart({ ...obs, voteHistory: [], questHistory: [], lakeHistory: [], questResults: [], currentRound: 1, failCount: 0 });
    const a = withSeededRandom('r53-diag', () => ag.act(obs));
    const t = a.type === 'team_select' ? a.teamIds : [];
    console.log(`${name}：${teamStr(t)}（後驗 P(全好) ${(bayesTeamClean(obs, t, opts) ?? NaN).toFixed(3)}；${clean(t)}）`);
  }
  for (const w of ['posterior', 'uniform'] as const) {
    const sc = cleanScores53(obs, 4, w, T)!.sort((a, b) => b.p - a.p);
    const best = sc[0].p;
    const top = sc.filter((x) => x.p >= best - 1e-9);
    console.log(`精確挑隊（${w}）：最高 ${best.toFixed(3)}，${top.length} 隊同分：${top.slice(0, 8).map((x) => `${teamStr(x.team)}（${clean(x.team)}）`).join('、')}`);
    console.log(`  前 6 隊：${sc.slice(0, 6).map((x) => `${teamStr(x.team)} ${x.p.toFixed(3)}`).join('、')}`);
  }
  const unifShare = (o: PlayerObservation): Map<string, number> => {
    const { buildCertainty } = require('../src/ai/belief/Certainty') as typeof import('../src/ai/belief/Certainty');
    const v = buildCertainty(o); const ws = v.worlds('L1*');
    return new Map(IDS.map((id) => [id, ws.filter((w) => (w & v.bitOf(id)) !== 0).length / ws.length]));
  };
  console.log('L1* 均勻（只用硬規則＋拇指）：', fmt(unifShare(obs)));

  console.log('\n## 拿掉各層讀法（P(紅)；0 = 真紅、1 = 梅林、8 = 莫甘娜）');
  const variants: [string, Partial<typeof T>, ((o: ReturnType<typeof bayesOptionsOf>) => ReturnType<typeof bayesOptionsOf>)?][] = [
    ['預設', {}],
    ['不讀投票（vote temper → 0）', {}, (o) => ({ ...o, voteTemper: 1e-6, leadVoteTemper: o.leadVoteTemper !== undefined ? 1e-6 : undefined })],
    ['不讀派隊（proposal temper → 0）', {}, (o) => ({ ...o, proposalTemper: 1e-6, leadProposalTemper: o.leadProposalTemper !== undefined ? 1e-6 : undefined })],
    ['都不讀（只剩世界＋任務＋湖）', {}, (o) => ({ ...o, voteTemper: 1e-6, proposalTemper: 1e-6, leadVoteTemper: o.leadVoteTemper !== undefined ? 1e-6 : undefined, leadProposalTemper: o.leadProposalTemper !== undefined ? 1e-6 : undefined })],
    ['loyalRationality50=0（不讀「公開視角的忠臣評分」）', { loyalRationality50: 0 }],
    ['loyalRationality50=1', { loyalRationality50: 1 }],
    ['不用遞迴挑隊讀法（beliefLeadRecursive=0）', { beliefLeadRecursive: 0 }],
    ['ownView=0', { ownView: 0, ownViewKeep: 0 }],
    ['強者表關（beliefStrongTables=false）', { beliefStrongTables: false, beliefLeadStrong: false }],
    ['拇指角色讀法關（percivalThumbLogic=false）', { percivalThumbLogic: false }],
    ['percivalRead39=1（後驗用擬合的拇指讀法）', { percivalRead39: 1 }],
  ];
  for (const [name, over, f] of variants) {
    let o = bayesOptionsOf({ ...T, ...over });
    if (f) o = f(o);
    const m = bayesRedShare(obs, o);
    console.log(`${name}：${fmt(m)}`);
  }

  console.log('\n## 逐步加上每個動作（預設後驗；對數勝算的變化）');
  console.log('| 動作 | P(0 紅) | Δlogit(0 紅) | P(1 紅) | Δlogit(1 紅) | P(8 紅) |');
  console.log('|---|---|---|---|---|---|');
  let prev: Map<string, number> | null = null;
  for (let k = 0; k <= EVENTS.length; k++) {
    const o = obsFrom(EVENTS.slice(0, k));
    const m = bayesRedShare(o, opts);
    const p0 = m.get(S('0'))!; const p1 = m.get(S('1'))!; const p8 = m.get(S('8'))!;
    const d0 = prev ? lo(p0) - lo(prev.get(S('0'))!) : 0;
    const d1 = prev ? lo(p1) - lo(prev.get(S('1'))!) : 0;
    console.log(`| ${k === 0 ? '（開局）' : EVENTS[k - 1].label} | ${p0.toFixed(3)} | ${k === 0 ? '' : (d0 >= 0 ? '+' : '') + d0.toFixed(2)} | ${p1.toFixed(3)} | ${k === 0 ? '' : (d1 >= 0 ? '+' : '') + d1.toFixed(2)} | ${p8.toFixed(3)} |`);
    prev = m;
  }

  console.log('\n## 留一：只拿掉某一個動作的票（改成照標準：隊上贊成、隊外反對）或某一個提議（連票整筆拿掉），其他照舊');
  const base = bayesRedShare(obs, opts);
  console.log('| 拿掉 | P(0 紅) | Δlogit | P(1 紅) | Δlogit |');
  console.log('|---|---|---|---|---|');
  EVENTS.forEach((e, k) => {
    if (e.kind !== 'prop') return;
    const v = e.rec as VoteRecord;
    const plain: VoteRecord = { ...v, votes: Object.fromEntries(IDS.map((id) => [id, v.attempt >= 5 ? true : v.team.includes(id)])) };
    const odd = IDS.some((id) => plain.votes[id] !== v.votes[id]);
    const rows: [string, Ev[]][] = [];
    if (odd) rows.push([`${e.label} 的特殊票`, EVENTS.map((x, j) => (j === k ? { ...x, rec: plain } as Ev : x))]);
    if (v.attempt < 5) rows.push([`${e.label} 整筆`, EVENTS.filter((_, j) => j !== k)]);
    for (const [name, evs] of rows) {
      // dropping a whole non-forced proposal shifts later attempts: renumber attempts within the round
      const props = evs.filter((x) => x.kind === 'prop').map((x) => x.rec as VoteRecord);
      const re: Ev[] = []; const cnt = new Map<number, number>();
      for (const x of evs) {
        if (x.kind !== 'prop') { re.push(x); continue; }
        const r = x.rec as VoteRecord; const n = (cnt.get(r.round) ?? 0) + 1; cnt.set(r.round, n);
        re.push({ ...x, rec: { ...r, attempt: r.attempt >= 5 ? 5 : n } } as Ev);
      }
      void props;
      const m = bayesRedShare(obsFrom(re, { currentLeader: S('4') }), opts);
      const p0 = m.get(S('0'))!; const p1 = m.get(S('1'))!;
      const d0 = lo(p0) - lo(base.get(S('0'))!); const d1 = lo(p1) - lo(base.get(S('1'))!);
      console.log(`| ${name} | ${p0.toFixed(3)} | ${(d0 >= 0 ? '+' : '') + d0.toFixed(2)} | ${p1.toFixed(3)} | ${(d1 >= 0 ? '+' : '') + d1.toFixed(2)} |`);
    }
  });
  // 派西自己的票：他知道自己為什麼這樣投，自己的票不是證據。把 4 家的特殊票改回標準（3-1 的 4-、3-3 的 4-）。
  const ownStd = EVENTS.map((e) => {
    if (e.kind !== 'prop') return e;
    const v = e.rec as VoteRecord;
    return { ...e, rec: { ...v, votes: { ...v.votes, [S('4')]: v.attempt >= 5 ? true : v.team.includes(S('4')) } } } as Ev;
  });
  console.log('\n## 候選修正（P(紅)、後驗最乾淨的隊與真實結果）');
  const cand: [string, PlayerObservation, Partial<typeof T>][] = [
    ['預設', obs, {}],
    ['自己的票不當證據', obsFrom(ownStd), {}],
    ['percivalRead39=1（拇指讀法進後驗）', obs, { percivalRead39: 1 }],
    ['兩者', obsFrom(ownStd), { percivalRead39: 1 }],
  ];
  for (const [name, o, over] of cand) {
    const oo = bayesOptionsOf({ ...T, ...over });
    const sc = cleanScores53(o, 4, 'posterior', { ...T, ...over })!.sort((x, y) => y.p - x.p);
    console.log(`${name}：${fmt(bayesRedShare(o, oo))}；最乾淨 ${sc.slice(0, 3).map((x) => `${teamStr(x.team)} ${x.p.toFixed(3)}（${clean(x.team)}）`).join('、')}`);
  }
  const noLake = bayesRedShare(obsFrom(EVENTS.filter((e) => e.kind !== 'lake')), opts);
  console.log(`| 湖整筆 | ${noLake.get(S('0'))!.toFixed(3)} | ${(lo(noLake.get(S('0'))!) - lo(base.get(S('0'))!)).toFixed(2)} | ${noLake.get(S('1'))!.toFixed(3)} | ${(lo(noLake.get(S('1'))!) - lo(base.get(S('1'))!)).toFixed(2)} |`);
}
void main();
