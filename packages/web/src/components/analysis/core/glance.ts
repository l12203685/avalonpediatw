import { outcomeRow, type OutcomeCountsInput } from '../outcomeTest';

/**
 * 「一眼看懂」的數字與一句話（站長 2026-11-25：「關於數據分析…希望能更直觀讓看到的人一目瞭然」）。
 *
 * 純函式（packages/server/src/__tests__/WebGlance.test.ts 測），不碰 React、不 import services/api：
 * 每個 helper 從跟圖表同一份資料算出「圖上要畫的比例」和「那一句話要用哪個句型、填哪些數字」，
 * 元件把同一個結果同時交給句子和長條，所以句子裡的數字一定跟圖一樣（跟著上方篩選變）。
 * 句型由資料決定：例如失敗後藍方勝率比成功後低才寫「只贏」，篩選後反過來就換成「反而贏」，不會說錯。
 * 算法沒有改：比例都是原本那些表格用的同一組計數（三種結局、票數），這裡只決定怎麼說、怎麼畫。
 */

/** 一個比例與它的分母（pct 是 0–100、沒有四捨五入；n = 局數或票數）。 */
export interface Share {
  pct: number;
  n: number;
}

/** 一句話：i18n 鍵（接在 analytics.glance. 後面）與要填的數字（百分比已經是「24%」這樣的字）。 */
export interface Sentence {
  key: string;
  params: Record<string, string | number>;
}

export type Relation = 'lower' | 'higher' | 'same';

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 畫面上顯示的整數百分比（跟 ui/tokens.ts formatRate 的整數顯示同一種進位）。 */
export function shownPct(pct: number): number {
  return Number(pct.toFixed(0));
}

export function pctText(pct: number): string {
  return `${shownPct(pct)}%`;
}

/** 「佔幾成」用：有、但四捨五入後是 0 的寫「<1%」，不寫成 0%（0% 會被讀成沒有）。 */
export function shareText(pct: number): string {
  return pct > 0 && shownPct(pct) === 0 ? '<1%' : pctText(pct);
}

/**
 * 兩段比例條的另一段：100 − 顯示出來的那個整數。兩段各自四捨五入的話 43.5%／56.5% 會變成「44% ＋ 57%」，
 * 加起來不是 100；所以只有主要的那一段（藍方贏、成功、刺中…）照原本的數字進位，另一段用減的。
 */
export function restPct(pct: number): number {
  return 100 - shownPct(pct);
}

export function restText(pct: number): string {
  return `${restPct(pct)}%`;
}

/** a 比 b 低、高、還是一樣——用顯示出來的整數比，讀者看到「24% 跟 24%」就不會被說成「只贏」。 */
export function relation(a: number, b: number): Relation {
  const x = shownPct(a);
  const y = shownPct(b);
  return x < y ? 'lower' : x > y ? 'higher' : 'same';
}

/** 這組局裡藍方最後贏的比例 = 三藍活 ÷ 局數（紅方最後贏 = 三紅 + 三藍死，是剩下的那一段）；0 局時 null。 */
export function blueWinShare(outcomes: OutcomeCountsInput | null | undefined): Share | null {
  if (!outcomes) return null;
  const [red, dead, alive] = outcomeRow(outcomes);
  const n = red + dead + alive;
  return n > 0 ? { pct: (alive / n) * 100, n } : null;
}

/** 有沒有哪一組的樣本不到門檻（快取的少樣本門檻 theoryMinCellGames）：有的話畫面標「樣本少」，句子照寫但提醒先當參考。 */
export function anyThin(min: number, ...shares: Array<Share | null | undefined>): boolean {
  return shares.some(s => !!s && s.n < min);
}

// ── 總覽：誰比較常贏 ─────────────────────────────────────────────

export interface OverallInput {
  final: { games: number; bluePct: number };
  /** 任務結算：redPct = 三紅 ÷ 全部局。 */
  mission: { redPct: number };
  /** 刺殺結算：merlinKilled = 三藍死的局數。 */
  assassination: { merlinKilled: number };
}

export interface OverallGlance {
  games: number;
  /** 藍方最後贏（三藍活 ÷ 全部局）；紅方最後贏是剩下的那一段（顯示時用 restText(blue)，兩個數字加起來才會是 100%）。 */
  blue: number;
  /** 紅方贏的兩種方式（都佔全部局）：三個任務失敗、藍方做完三個任務但梅林被刺中。 */
  threeRed: number;
  killed: number;
  /** 大數字用哪一方（比較常贏的那一方；一樣時紅方）。 */
  lead: 'red' | 'blue';
  sentence: Sentence;
}

/** 紅藍相差不到這麼多個百分點（顯示的整數）就說「差不多」。 */
export const EVEN_GAP = 4;

export function overallGlance(stages: OverallInput | null | undefined): OverallGlance | null {
  if (!stages || !finite(stages.final?.games) || stages.final.games <= 0) return null;
  const { games, bluePct: blue } = stages.final;
  if (!finite(blue)) return null;
  const gap = restPct(blue) - shownPct(blue);
  const lead: 'red' | 'blue' = gap >= 0 ? 'red' : 'blue';
  const key = Math.abs(gap) < EVEN_GAP ? 'overall.even' : lead === 'red' ? 'overall.redAhead' : 'overall.blueAhead';
  const threeRed = finite(stages.mission?.redPct) ? stages.mission.redPct : 0;
  const killed = finite(stages.assassination?.merlinKilled) ? (stages.assassination.merlinKilled / games) * 100 : 0;
  return {
    games, blue, threeRed, killed, lead,
    sentence: { key, params: { red: restText(blue), blue: pctText(blue) } },
  };
}

// ── 任務結果：第 1 個任務成功／失敗之後藍方贏多少 ──────────────────────

export interface BranchInput {
  passed: boolean;
  games?: number;
  outcomes?: OutcomeCountsInput;
}

export interface PassFailGlance {
  passed: Share;
  failed: Share;
  sentence: Sentence;
}

function passFail(passed: Share | null, failed: Share | null, prefix: string, extra: Record<string, string | number> = {}): PassFailGlance | null {
  if (!passed || !failed) return null;
  const rel = relation(failed.pct, passed.pct);
  const key = `${prefix}.${rel === 'lower' ? 'failLower' : rel === 'higher' ? 'failHigher' : 'same'}`;
  return { passed, failed, sentence: { key, params: { ...extra, passed: pctText(passed.pct), failed: pctText(failed.pct) } } };
}

/** 第 1 個任務成功的局、失敗的局，藍方各贏多少（/rounds 的 mission1Branch）。 */
export function missionOneGlance(branches: readonly BranchInput[] | null | undefined): PassFailGlance | null {
  const passed = blueWinShare(branches?.find(b => b.passed)?.outcomes);
  const failed = blueWinShare(branches?.find(b => !b.passed)?.outcomes);
  return passFail(passed, failed, 'missions.m1');
}

export interface KillGlance {
  /** 藍方做完三個任務的局裡，梅林被刺中的比例；n = 那些局數。 */
  hit: Share;
  sentence: Sentence;
}

export function killGlance(a: { games: number; killPct: number } | null | undefined): KillGlance | null {
  if (!a || !finite(a.games) || a.games <= 0 || !finite(a.killPct)) return null;
  return { hit: { pct: a.killPct, n: a.games }, sentence: { key: 'missions.kill', params: { rate: pctText(a.killPct) } } };
}

// ── 任務結果：各任務的成功率 ────────────────────────────────────────

export interface MissionRateInput {
  round: number;
  /** 打到這個任務的局數。 */
  n: number;
  /** 照規則的成功率（0–100）；沒有時 null。 */
  successRate: number | null;
}

export interface MissionRatesGlance {
  rows: Array<{ round: number; success: Share }>;
  hardest: number | null;
  easiest: number | null;
  sentence: Sentence | null;
}

export function missionRatesGlance(input: readonly MissionRateInput[] | null | undefined): MissionRatesGlance {
  const rows = (input ?? [])
    .filter((r): r is MissionRateInput & { successRate: number } => finite(r.successRate) && finite(r.n) && r.n > 0)
    .map(r => ({ round: r.round, success: { pct: r.successRate, n: r.n } }));
  if (rows.length < 2) return { rows, hardest: null, easiest: null, sentence: null };
  const hard = rows.reduce((a, b) => (b.success.pct < a.success.pct ? b : a));
  const easy = rows.reduce((a, b) => (b.success.pct > a.success.pct ? b : a));
  if (relation(hard.success.pct, easy.success.pct) === 'same') return { rows, hardest: null, easiest: null, sentence: null };
  return {
    rows, hardest: hard.round, easiest: easy.round,
    sentence: { key: 'missions.rates', params: { hard: hard.round, hardRate: pctText(hard.success.pct), easy: easy.round, easyRate: pctText(easy.success.pct) } },
  };
}

// ── 任務結果：每個任務成功／失敗之後藍方贏多少 ───────────────────────────

export interface RoundOutcomeInput {
  round: number;
  passedOutcomes?: OutcomeCountsInput;
  failedOutcomes?: OutcomeCountsInput;
}

export interface MissionSwingGlance {
  rows: Array<{ round: number; passed: Share; failed: Share }>;
  /** 成功與失敗差最多的那個任務（不算任務 4：7 人以上 1 張失敗票任務仍成功，這份分組只分有沒有失敗票）。 */
  widest: number | null;
  sentence: Sentence | null;
}

export function missionSwingGlance(input: readonly RoundOutcomeInput[] | null | undefined): MissionSwingGlance {
  const rows = (input ?? []).flatMap(c => {
    const passed = blueWinShare(c.passedOutcomes);
    const failed = blueWinShare(c.failedOutcomes);
    return passed && failed ? [{ round: c.round, passed, failed }] : [];
  });
  const gapOf = (r: { passed: Share; failed: Share }): number => Math.abs(shownPct(r.passed.pct) - shownPct(r.failed.pct));
  const eligible = rows.filter(r => r.round !== 4);
  if (eligible.length === 0) return { rows, widest: null, sentence: null };
  const top = eligible.reduce((a, b) => (gapOf(b) > gapOf(a) ? b : a));
  const made = passFail(top.passed, top.failed, 'missions.swing', { round: top.round, gap: gapOf(top) });
  return { rows, widest: gapOf(top) > 0 ? top.round : null, sentence: made?.sentence ?? null };
}

// ── 湖中女神：湖在藍方／紅方手上時藍方贏多少 ────────────────────────────

export interface HolderInput {
  faction: string;
  outcomes?: OutcomeCountsInput;
}

export interface LakeGlance {
  blueHolder: Share;
  redHolder: Share;
  sentence: Sentence;
}

const RED_FACTION = '紅方';

/** who = 這次湖的叫法（例：「首位接湖者」），原樣放進句子。 */
export function lakeHolderGlance(holders: readonly HolderInput[] | null | undefined, who: string): LakeGlance | null {
  const blueHolder = blueWinShare(holders?.find(h => h.faction !== RED_FACTION)?.outcomes);
  const redHolder = blueWinShare(holders?.find(h => h.faction === RED_FACTION)?.outcomes);
  if (!blueHolder || !redHolder) return null;
  const rel = relation(redHolder.pct, blueHolder.pct);
  const key = `lake.${rel === 'lower' ? 'redLower' : rel === 'higher' ? 'redHigher' : 'same'}`;
  return { blueHolder, redHolder, sentence: { key, params: { who, blue: pctText(blueHolder.pct), red: pctText(redHolder.pct) } } };
}

// ── 派隊與投票：有紅方的隊、全藍的隊各有多少票反對 ──────────────────────────

export interface VoteCell {
  votes: number;
  /** 命中的比例（0–100）：evil* = 有紅方的隊被投反對；good* = 全藍的隊被投贊成。 */
  rate: number | null;
}

export interface VotesGlance {
  /** 隊上有紅方：反對票的比例；n = 票數。 */
  withRed: Share;
  /** 隊上全是藍方：贊成票的比例（原本表格上的那個數字）；反對 = 剩下的那一段（restText）。 */
  allBlueApprove: Share;
  sentence: Sentence;
}

export function votesGlance(
  pooled: Record<string, VoteCell | undefined> | null | undefined, evilKey = 'evilAll', goodKey = 'goodAll',
  /** 句型放在哪一組字底下：'votes'（全部任務）或 'votesR3'（第 3 個任務起）。 */
  scope: 'votes' | 'votesR3' = 'votes',
): VotesGlance | null {
  const evil = pooled?.[evilKey];
  const good = pooled?.[goodKey];
  if (!evil || !good || !finite(evil.rate) || !finite(good.rate) || !(evil.votes > 0) || !(good.votes > 0)) return null;
  const withRed: Share = { pct: evil.rate, n: evil.votes };
  const allBlueApprove: Share = { pct: good.rate, n: good.votes };
  // 全藍的隊：每一票不是贊成就是反對，反對 = 100 − 贊成（用顯示的整數減，跟長條上的數字一樣）
  const redReject = shownPct(withRed.pct);
  const blueReject = restPct(allBlueApprove.pct);
  const kind = blueReject === redReject ? 'same' : blueReject > redReject ? 'blueHigher' : blueReject >= 50 ? 'blueAlsoHalf' : 'blueLower';
  const key = `${scope}.${kind}`;
  return { withRed, allBlueApprove, sentence: { key, params: { withRed: `${redReject}%`, allBlue: `${blueReject}%` } } };
}

// ══ 第二批（2026-11-25）：刺殺、任務路徑、湖中女神的角色與宣告、派隊與投票的內頁 ══════════════════

/** 一組裡最高、最低的兩個：只比樣本夠（n ≥ min）的；夠的不到兩個才全部一起比。顯示出來一樣就不比（null）。 */
export function extremes<T extends { share: Share }>(rows: readonly T[], min: number): { hi: T; lo: T } | null {
  const pool = rows.filter(r => r.share.n >= min);
  const list = pool.length >= 2 ? pool : rows;
  if (list.length < 2) return null;
  const hi = list.reduce((a, b) => (b.share.pct > a.share.pct ? b : a));
  const lo = list.reduce((a, b) => (b.share.pct < a.share.pct ? b : a));
  return relation(lo.share.pct, hi.share.pct) === 'same' ? null : { hi, lo };
}

// ── 刺殺：藍方做完三個任務之後 ────────────────────────────────────────

export interface KillDetailGlance {
  /** 梅林被刺中（紅方贏）的比例；n = 打到刺殺的局數。沒刺中（藍方贏）是剩下的那一段。 */
  hit: Share;
  killed: number;
  survived: number;
  sentence: Sentence;
}

export function killDetailGlance(a: { games: number; killPct: number; merlinKilled?: number; merlinSurvived?: number } | null | undefined): KillDetailGlance | null {
  if (!a || !finite(a.games) || a.games <= 0 || !finite(a.killPct)) return null;
  const killed = finite(a.merlinKilled) ? a.merlinKilled : Math.round((a.killPct / 100) * a.games);
  const survived = finite(a.merlinSurvived) ? a.merlinSurvived : a.games - killed;
  const hit: Share = { pct: a.killPct, n: a.games };
  const key = shownPct(hit.pct) === 0 ? 'kill.none' : shownPct(hit.pct) === 100 ? 'kill.all' : 'kill.flip';
  return { hit, killed, survived, sentence: { key, params: { hit: pctText(hit.pct), miss: restText(hit.pct) } } };
}

export interface SeatKillInput {
  /** 畫面上的座位號（第十個座位是 0）。 */
  seat: string;
  /** 梅林被刺中的局數。 */
  dead: number;
  /** 打到刺殺的局數。 */
  n: number;
}

export interface SeatKillGlance {
  rows: Array<{ seat: string; share: Share }>;
  hi: string | null;
  lo: string | null;
  sentence: Sentence | null;
}

/** who = 誰坐在這個位置（'merlin'：梅林坐這裡時被刺中；'assassin'：刺客坐這裡時刺中）。 */
export function seatKillGlance(input: readonly SeatKillInput[] | null | undefined, who: 'merlin' | 'assassin', min: number): SeatKillGlance {
  const rows = (input ?? [])
    .filter(r => finite(r.n) && r.n > 0 && finite(r.dead))
    .map(r => ({ seat: r.seat, share: { pct: (r.dead / r.n) * 100, n: r.n } }));
  const ex = extremes(rows, min);
  if (!ex) return { rows, hi: null, lo: null, sentence: null };
  return {
    rows, hi: ex.hi.seat, lo: ex.lo.seat,
    sentence: { key: `seatKill.${who}`, params: { hiSeat: ex.hi.seat, hi: pctText(ex.hi.share.pct), loSeat: ex.lo.seat, lo: pctText(ex.lo.share.pct) } },
  };
}

/** 梅林坐前半（1～5 家）、後半（6～0 家）各被刺中多少。 */
export function seatHalvesSentence(front: Share | null | undefined, back: Share | null | undefined): Sentence | null {
  if (!front || !back) return null;
  const rel = relation(back.pct, front.pct);
  const key = `seatKill.${rel === 'lower' ? 'backLower' : rel === 'higher' ? 'backHigher' : 'halvesSame'}`;
  return { key, params: { front: pctText(front.pct), back: pctText(back.pct) } };
}

// ── 任務路徑：五個任務依序成功／失敗的走法 ────────────────────────────────

export interface PathInput {
  /** 例「紅紅藍藍藍」：紅 = 任務失敗、藍 = 任務成功。 */
  state: string;
  games: number;
  outcomes?: OutcomeCountsInput | null;
}

export interface PathRow {
  path: string;
  games: number;
  /** 佔全部局的比例（0–100）。 */
  ofAll: number;
  /** 藍方做完三個任務的走法：藍方最後贏（梅林沒被刺中）的比例；三個任務失敗的走法沒有（紅方直接贏）。 */
  blue: Share | null;
}

export interface PathsGlance {
  total: number;
  /** 三個任務失敗、紅方直接贏的走法（照局數多到少）。 */
  redPaths: PathRow[];
  /** 藍方做完三個任務的走法（照局數多到少）。 */
  bluePaths: PathRow[];
  top: PathRow | null;
  /** 藍方做完三個任務的走法裡，藍方最後贏最多／最少的（只比樣本夠的）。 */
  best: string | null;
  worst: string | null;
  sentence: Sentence | null;
  killSentence: Sentence | null;
}

function countChar(s: string, c: string): number {
  return Array.from(s).filter(x => x === c).length;
}

/** total = 全部有路徑的局（不是列出來的幾條加總；roundsPaths.ts topPathShare 的分母）。 */
export function pathsGlance(states: readonly PathInput[] | null | undefined, total: number, min: number): PathsGlance {
  const empty: PathsGlance = { total: 0, redPaths: [], bluePaths: [], top: null, best: null, worst: null, sentence: null, killSentence: null };
  if (!finite(total) || total <= 0) return empty;
  const rows = (states ?? []).filter(s => finite(s.games) && s.games > 0 && s.games <= total);
  const row = (s: PathInput, blue: Share | null): PathRow => ({ path: s.state, games: s.games, ofAll: (s.games / total) * 100, blue });
  const byGames = (a: PathRow, b: PathRow): number => b.games - a.games;
  const redPaths = rows.filter(s => countChar(s.state, '紅') >= 3).map(s => row(s, null)).sort(byGames);
  const bluePaths = rows.filter(s => countChar(s.state, '藍') >= 3 && countChar(s.state, '紅') < 3).map(s => row(s, blueWinShare(s.outcomes))).sort(byGames);
  const all = [...redPaths, ...bluePaths].sort(byGames);
  const top = all[0] ?? null;
  const ex = extremes(bluePaths.flatMap(p => (p.blue ? [{ path: p.path, share: p.blue }] : [])), min);
  return {
    total, redPaths, bluePaths, top,
    best: ex?.hi.path ?? null, worst: ex?.lo.path ?? null,
    sentence: top ? { key: 'paths.top', params: { path: top.path, share: shareText(top.ofAll) } } : null,
    killSentence: ex
      ? { key: 'paths.kill', params: { best: ex.hi.path, bestRate: pctText(ex.hi.share.pct), worst: ex.lo.path, worstRate: pctText(ex.lo.share.pct) } }
      : null,
  };
}

// ── 湖中女神：持湖／被湖的是哪個角色時，藍方贏多少 ─────────────────────────────

export interface RoleOutcomeInput {
  role: string;
  outcomes?: OutcomeCountsInput | null;
}

export interface RoleRankGlance {
  /** 照藍方最後贏的比例高到低排。 */
  rows: Array<{ role: string; share: Share }>;
  hi: string | null;
  lo: string | null;
  /** params 的 hi／lo 是角色的資料鍵，畫面換成角色名稱再填。 */
  sentence: Sentence | null;
}

/** kind = 'holderRole'（持湖的人）或 'targetRole'（被湖的人）；who = 這次湖的叫法。 */
export function roleRankGlance(stats: readonly RoleOutcomeInput[] | null | undefined, kind: 'holderRole' | 'targetRole', who: string, min: number): RoleRankGlance {
  const rows = (stats ?? [])
    .flatMap(r => { const share = blueWinShare(r.outcomes); return share ? [{ role: r.role, share }] : []; })
    .sort((a, b) => b.share.pct - a.share.pct);
  const ex = extremes(rows, min);
  if (!ex) return { rows, hi: null, lo: null, sentence: null };
  return {
    rows, hi: ex.hi.role, lo: ex.lo.role,
    sentence: { key: `lake.${kind}`, params: { who, hi: ex.hi.role, hiRate: pctText(ex.hi.share.pct), lo: ex.lo.role, loRate: pctText(ex.lo.share.pct) } },
  };
}

// ── 湖中女神：宣告可不可信 ──────────────────────────────────────────

export interface ClaimCellInput {
  /** 第幾次湖（依湖分的那幾列）。 */
  lake?: string;
  /** 持湖的人的陣營（依持湖者分的那幾列）：'evil'／'紅' = 紅方。 */
  holder?: string;
  holderEn?: string;
  /** 宣告：'evil'／'紅' = 說對方是紅方。 */
  declared: string;
  declaredEn?: string;
  n: number;
  /** 宣告屬實的比例（0–100）。 */
  hitRate: number;
}

export interface ClaimPair {
  key: string;
  /** 說「紅」時屬實的比例；n = 說「紅」的次數。 */
  saidRed: Share | null;
  /** 說「藍」時屬實的比例。 */
  saidBlue: Share | null;
}

export interface LakeClaimGlance {
  /** 依第幾次湖（key = 資料上的叫法，例「首湖」）。 */
  byLake: ClaimPair[];
  /** 依持湖的人的陣營（key = 'blue'／'red'，藍方在前）。 */
  byHolder: ClaimPair[];
  /** 紅方拿湖說「紅」屬實的比例（大數字）。 */
  redHolderSaidRed: Share | null;
  /** 藍方、紅方拿湖說「紅」各有多少是真的。 */
  sentence: Sentence | null;
  /** 第一次湖（不分誰拿湖）說「紅」、說「藍」各有多少是真的。 */
  lakeSentence: Sentence | null;
}

const isRedWord = (zh: string | undefined, en: string | undefined): boolean => en === 'evil' || zh === '紅';

function claimPairs(cells: readonly ClaimCellInput[], keyOf: (c: ClaimCellInput) => string): ClaimPair[] {
  const pairs: ClaimPair[] = [];
  for (const c of cells) {
    if (!finite(c.n) || c.n <= 0 || !finite(c.hitRate)) continue;
    const key = keyOf(c);
    let pair = pairs.find(p => p.key === key);
    if (!pair) { pair = { key, saidRed: null, saidBlue: null }; pairs.push(pair); }
    const share: Share = { pct: c.hitRate, n: c.n };
    if (isRedWord(c.declared, c.declaredEn)) pair.saidRed = share;
    else pair.saidBlue = share;
  }
  return pairs;
}

export function lakeClaimGlance(rows: readonly ClaimCellInput[] | null | undefined, holderRows: readonly ClaimCellInput[] | null | undefined): LakeClaimGlance {
  const byLake = claimPairs(rows ?? [], c => c.lake ?? '');
  const byHolder = claimPairs(holderRows ?? [], c => (isRedWord(c.holder, c.holderEn) ? 'red' : 'blue'))
    .sort((a, b) => (a.key === 'blue' ? 0 : 1) - (b.key === 'blue' ? 0 : 1));
  const blue = byHolder.find(p => p.key === 'blue')?.saidRed ?? null;
  const red = byHolder.find(p => p.key === 'red')?.saidRed ?? null;
  let sentence: Sentence | null = null;
  if (blue && red) {
    const rel = relation(red.pct, blue.pct);
    const key = `claim.${rel === 'lower' ? 'redLower' : rel === 'higher' ? 'redHigher' : 'same'}`;
    sentence = { key, params: { blue: pctText(blue.pct), red: pctText(red.pct) } };
  }
  const first = byLake.find(p => p.saidRed && p.saidBlue);
  const lakeSentence: Sentence | null = first?.saidRed && first.saidBlue
    ? { key: 'claim.byLake', params: { lake: first.key, saidRed: pctText(first.saidRed.pct), saidBlue: pctText(first.saidBlue.pct) } }
    : null;
  return { byLake, byHolder, redHolderSaidRed: red, sentence, lakeSentence };
}

// ── 派隊與投票的內頁 ─────────────────────────────────────────────

/** 兩組比一比：b 比 a 低／高／一樣 → `${prefix}.lower|higher|same`，params 是 a、b 兩個百分比的字。 */
export function twoWay(a: Share | null | undefined, b: Share | null | undefined, prefix: string, extra: Record<string, string | number> = {}): Sentence | null {
  if (!a || !b) return null;
  return { key: `${prefix}.${relation(b.pct, a.pct)}`, params: { ...extra, a: pctText(a.pct), b: pctText(b.pct) } };
}

export interface VotersGlance {
  /** 第 3 個任務起，忠臣、紅方投反對的比例；n = 票數。 */
  loyal: Share;
  red: Share;
  sentence: Sentence;
}

export function votersGlance(pooled: Record<string, VoteCell | undefined> | null | undefined): VotersGlance | null {
  const cell = (key: string): Share | null => {
    const c = pooled?.[key];
    return c && finite(c.rate) && c.votes > 0 ? { pct: c.rate, n: c.votes } : null;
  };
  const loyal = cell('loyalR3');
  const red = cell('redR3');
  const sentence = twoWay(loyal, red, 'voters');
  return loyal && red && sentence ? { loyal, red, sentence } : null;
}

export interface CaptainGlance {
  /** 紅方、藍方當隊長帶出去的任務，失敗的比例；n = 任務數。成功是剩下的那一段。 */
  redFail: Share;
  blueFail: Share;
  /** 每個任務由紅方當隊長的比例；n = 打到這個任務的局數。藍方隊長是剩下的那一段。 */
  perMission: Array<{ mission: number; red: Share }>;
  sentence: Sentence;
  trend: Sentence | null;
}

export function captainGlance(
  fails: { red?: { failPct: number | null; missions: number } | null; blue?: { failPct: number | null; missions: number } | null } | null | undefined,
  missions: ReadonlyArray<{ mission: number; redCaptainRate: number; games: number }> | null | undefined,
): CaptainGlance | null {
  const share = (c: { failPct: number | null; missions: number } | null | undefined): Share | null =>
    (c && finite(c.failPct) && c.missions > 0 ? { pct: c.failPct, n: c.missions } : null);
  const redFail = share(fails?.red);
  const blueFail = share(fails?.blue);
  const sentence = twoWay(blueFail, redFail, 'captain');
  if (!redFail || !blueFail || !sentence) return null;
  const perMission = (missions ?? [])
    .filter(m => finite(m.redCaptainRate) && finite(m.games) && m.games > 0)
    .map(m => ({ mission: m.mission, red: { pct: m.redCaptainRate, n: m.games } }));
  const first = perMission[0];
  const last = perMission[perMission.length - 1];
  const trend = first && last && first !== last
    ? twoWay(first.red, last.red, 'captain.trend', { first: first.mission, last: last.mission })
    : null;
  return { redFail, blueFail, perMission, sentence, trend };
}

export interface FirstTeamGlance {
  /** 第一支隊伍裡有／沒有梅林、派西維爾的局，藍方最後贏的比例。 */
  merlinIn: Share | null;
  merlinOut: Share | null;
  percivalIn: Share | null;
  percivalOut: Share | null;
  /** 第一支隊伍裡有幾個紅方 → 藍方最後贏的比例。 */
  redCounts: Array<{ count: number; share: Share }>;
  merlinSentence: Sentence | null;
  redSentence: Sentence | null;
}

export function firstTeamGlance(
  vision: Partial<Record<'merlinInTeam' | 'merlinNotInTeam' | 'percivalInTeam' | 'percivalNotInTeam', { outcomes?: OutcomeCountsInput | null } | null>> | null | undefined,
  redInTeam: ReadonlyArray<{ redCount: number; outcomes?: OutcomeCountsInput | null }> | null | undefined,
  min: number,
): FirstTeamGlance {
  const merlinIn = blueWinShare(vision?.merlinInTeam?.outcomes);
  const merlinOut = blueWinShare(vision?.merlinNotInTeam?.outcomes);
  const redCounts = (redInTeam ?? []).flatMap(r => { const share = blueWinShare(r.outcomes); return share ? [{ count: r.redCount, share }] : []; });
  const ex = extremes(redCounts, min);
  return {
    merlinIn, merlinOut,
    percivalIn: blueWinShare(vision?.percivalInTeam?.outcomes),
    percivalOut: blueWinShare(vision?.percivalNotInTeam?.outcomes),
    redCounts,
    merlinSentence: twoWay(merlinIn, merlinOut, 'firstTeam.merlin'),
    redSentence: ex
      ? { key: 'firstTeam.reds', params: { hi: ex.hi.count, hiRate: pctText(ex.hi.share.pct), lo: ex.lo.count, loRate: pctText(ex.lo.share.pct) } }
      : null,
  };
}

export interface TwoRedCell {
  /** 派隊的次數。 */
  n: number;
  /** 其中隊上沒有任何紅方的次數。 */
  allGood: number;
}

export interface TwoRedGlance {
  /** 每個任務一張卡；每張卡每個隊長角色一列：派出全是藍方的隊的比例（n = 派隊次數）。 */
  rounds: Array<{ round: number; rows: Array<{ role: string; clean: Share }> }>;
  /** 句子講的那個任務（第一個比得出高低的）。params 的 hi／lo 是角色的資料鍵，畫面換成角色名稱再填。 */
  sentence: Sentence | null;
}

export function twoRedGlance(cells: ReadonlyArray<{ round: number; role: string; cell: TwoRedCell | null | undefined }> | null | undefined, min: number): TwoRedGlance {
  const rounds: TwoRedGlance['rounds'] = [];
  for (const c of cells ?? []) {
    if (!c.cell || !finite(c.cell.n) || c.cell.n <= 0 || !finite(c.cell.allGood)) continue;
    let round = rounds.find(r => r.round === c.round);
    if (!round) { round = { round: c.round, rows: [] }; rounds.push(round); }
    round.rows.push({ role: c.role, clean: { pct: (c.cell.allGood / c.cell.n) * 100, n: c.cell.n } });
  }
  rounds.sort((a, b) => a.round - b.round);
  let sentence: Sentence | null = null;
  for (const r of rounds) {
    const ex = extremes(r.rows.map(x => ({ role: x.role, share: x.clean })), min);
    if (!ex) continue;
    sentence = { key: 'twoRed.best', params: { round: r.round, hi: ex.hi.role, hiRate: pctText(ex.hi.share.pct), lo: ex.lo.role, loRate: pctText(ex.lo.share.pct) } };
    break;
  }
  return { rounds, sentence };
}

// ══ 第三批（2026-11-25）：戰績排行、局勢樹、個人分析 ════════════════════════════════

// ── 戰績排行：前三名一句話、上榜條件一句話 ─────────────────────────────────

export interface BoardRowInput {
  name: string;
  value: number | null | undefined;
}

export interface BoardGlance {
  /** 前幾名（照傳進來的順序，最多三位；沒有數字的不算）。 */
  top: Array<{ name: string; value: number }>;
  sentence: Sentence | null;
  /** 對照（不含散客的全體）的那一句；沒有對照時 null。 */
  baseSentence: Sentence | null;
}

/**
 * rows = 已經照這個數字排好的榜（第一列＝第一名）；metric = 這個數字叫什麼（原樣放進句子）；
 * fmt = 數字怎麼寫（勝率寫整數百分比、進步寫「+16 個百分點」、Elo 寫整數）；base = 全體（不含散客）的同一個數字；
 * word = 'top'（勝率、Elo：「最高」）或 'most'（場數、進步幾個百分點：「最多」）。
 */
export function boardGlance(
  rows: readonly BoardRowInput[] | null | undefined, metric: string, fmt: (v: number) => string = pctText, base?: number | null,
  word: 'top' | 'most' = 'top',
): BoardGlance {
  const top = (rows ?? []).flatMap(r => (finite(r.value) ? [{ name: r.name, value: r.value }] : [])).slice(0, 3);
  if (top.length === 0) return { top, sentence: null, baseSentence: null };
  const params: Record<string, string | number> = { metric, first: top[0].name, firstValue: fmt(top[0].value) };
  if (top[1]) { params.second = top[1].name; params.secondValue = fmt(top[1].value); }
  if (top[2]) { params.third = top[2].name; params.thirdValue = fmt(top[2].value); }
  return {
    top,
    sentence: { key: `board.${word}${top.length}`, params },
    baseSentence: finite(base) ? { key: 'board.base', params: { metric, base: fmt(base) } } : null,
  };
}

export interface BoardRulesInput {
  /** 最近幾天要有出賽（0 = 不限）。 */
  activeDays: number;
  /** 數字看最近幾場（0 = 生涯全部）。 */
  mainGames: number;
  /** 生涯至少幾場（0 = 不限）。 */
  theoryMinGames: number;
  /** 每個角色的場數要不要打滿才列（0／1）。 */
  requireRoleWindows: number;
  /** 六個特殊角色各幾場、忠臣幾場。 */
  roleWindowGames: number;
  loyalWindowGames: number;
}

export interface BoardRulesGlance {
  /** 上榜要符合的條件，一條一個短句（全部都要符合）；空的 = 打過的人都列。 */
  who: Sentence[];
  /** 數字看哪一段場次。 */
  window: Sentence;
}

/** 上榜條件寫成白話：誰會上榜（幾個條件用頓號接起來）＋數字看哪幾場。 */
export function boardRulesGlance(r: BoardRulesInput): BoardRulesGlance {
  const who: Sentence[] = [];
  if (r.activeDays > 0) who.push({ key: 'rules.active', params: { days: r.activeDays } });
  if (r.theoryMinGames > 0) who.push({ key: 'rules.minGames', params: { n: r.theoryMinGames } });
  if (r.requireRoleWindows) who.push({ key: 'rules.roles', params: { k: r.roleWindowGames, kl: r.loyalWindowGames } });
  return {
    who,
    window: r.mainGames > 0 ? { key: 'rules.window', params: { n: r.mainGames } } : { key: 'rules.career', params: {} },
  };
}

// ── 局勢樹：同樣的比分，順序不同差多少 ────────────────────────────────────

export interface TreeSeqInput {
  /** 任務的順序，例「紅紅藍」。 */
  seq: string;
  n: number;
  /** 藍方最後贏的比例（0–1）；算不出來 null。 */
  blueWin: number | null;
}

export interface StateTreeGlance {
  /** 同樣比分裡藍方最後贏最多、最少的兩種順序（差最多的那一組）；沒有可比的 null。 */
  high: { seq: string; blue: Share } | null;
  low: { seq: string; blue: Share } | null;
  sentence: Sentence | null;
}

/**
 * contrasts = stateTreeFindings 的同比分對照（已照差距大到小排）；baseline = 全部局藍方最後贏的比例（0–1）。
 * 有對照：講差最多的那一組；沒有（局太少）：只講全部局藍方贏多少。
 */
export function stateTreeGlance(
  f: { total: number; baseline: { blueWin: number | null }; contrasts: ReadonlyArray<{ score: string; high: TreeSeqInput; low: TreeSeqInput }> } | null | undefined,
): StateTreeGlance {
  const none: StateTreeGlance = { high: null, low: null, sentence: null };
  if (!f || !finite(f.total) || f.total <= 0) return none;
  const c = f.contrasts.find(x => finite(x.high.blueWin) && finite(x.low.blueWin) && x.high.n > 0 && x.low.n > 0);
  if (!c || !finite(c.high.blueWin) || !finite(c.low.blueWin)) {
    return finite(f.baseline.blueWin)
      ? { ...none, sentence: { key: 'tree.overall', params: { n: f.total, blue: pctText(f.baseline.blueWin * 100) } } }
      : none;
  }
  const high = { seq: c.high.seq, blue: { pct: c.high.blueWin * 100, n: c.high.n } };
  const low = { seq: c.low.seq, blue: { pct: c.low.blueWin * 100, n: c.low.n } };
  const [blues, reds] = c.score.split(':');
  const key = relation(low.blue.pct, high.blue.pct) === 'same' ? 'tree.orderSame' : 'tree.order';
  return {
    high, low,
    sentence: { key, params: { blues, reds, high: high.seq, highRate: pctText(high.blue.pct), low: low.seq, lowRate: pctText(low.blue.pct) } },
  };
}

// ── 個人分析：跟全體比，哪一項最強、哪一項最弱 ──────────────────────────────

export interface RadarAxisInput {
  key: string;
  /** 這位玩家的數字（0–100）；算不出來 null。 */
  value: number | null;
  /** 這個數字用到的場數；不知道 null。 */
  n: number | null;
  /** 全體（不含散客）的同一個數字；沒有可比的（例：經驗不是勝率）null。 */
  field: number | null;
}

export interface RadarGlanceRow {
  key: string;
  value: number;
  n: number | null;
  field: number | null;
  /** 比全體高幾個百分點（顯示的整數相減）；沒有可比的 null。 */
  diff: number | null;
}

export interface RadarGlance {
  /** 算得出來的那幾項（照傳進來的順序）。 */
  rows: RadarGlanceRow[];
  best: string | null;
  worst: string | null;
  /** params 的 best／worst 是指標的資料鍵，畫面換成指標名稱再填。 */
  sentence: Sentence | null;
}

/**
 * 最強＝比全體高最多的那一項，最弱＝比全體低最多（或領先最少）的那一項；只比場數夠（n ≥ min）的，夠的不到兩項才全部一起比。
 * 句型跟著資料：有高有低寫「最強…最弱…」；全部不輸全體寫「領先最多…最少…」；全部沒贏寫「最接近…差最多…」。
 * 沒有全體的數字時（還沒算好）只比這位玩家自己的各項。
 */
export function radarGlance(axes: readonly RadarAxisInput[] | null | undefined, name: string, min: number): RadarGlance {
  const rows: RadarGlanceRow[] = (axes ?? []).flatMap(a => (finite(a.value)
    ? [{ key: a.key, value: a.value, n: a.n, field: finite(a.field) ? a.field : null, diff: finite(a.field) ? shownPct(a.value) - shownPct(a.field) : null }]
    : []));
  const none: RadarGlance = { rows, best: null, worst: null, sentence: null };
  const enough = (list: RadarGlanceRow[]): RadarGlanceRow[] => {
    const pool = list.filter(r => r.n === null || r.n >= min);
    return pool.length >= 2 ? pool : list;
  };
  const compared = enough(rows.filter((r): r is RadarGlanceRow & { field: number; diff: number } => r.diff !== null));
  if (compared.length >= 2) {
    const diffOf = (r: RadarGlanceRow): number => r.diff ?? 0;
    const best = compared.reduce((a, b) => (diffOf(b) > diffOf(a) ? b : a));
    const worst = compared.reduce((a, b) => (diffOf(b) < diffOf(a) ? b : a));
    if (best.key === worst.key || diffOf(best) === diffOf(worst)) return none;
    const kind = diffOf(best) > 0 && diffOf(worst) < 0 ? 'mixed' : diffOf(worst) >= 0 ? 'allAbove' : 'allBelow';
    return {
      rows, best: best.key, worst: worst.key,
      sentence: {
        key: `radar.${kind}`,
        params: {
          name,
          best: best.key, bestValue: pctText(best.value), bestField: pctText(best.field ?? 0),
          worst: worst.key, worstValue: pctText(worst.value), worstField: pctText(worst.field ?? 0),
        },
      },
    };
  }
  // 沒有全體可比：只講自己的各項（經驗不是勝率，不比）
  const own = enough(rows.filter(r => r.key !== 'experience'));
  if (own.length < 2) return none;
  const hi = own.reduce((a, b) => (b.value > a.value ? b : a));
  const lo = own.reduce((a, b) => (b.value < a.value ? b : a));
  if (relation(lo.value, hi.value) === 'same') return none;
  return {
    rows, best: hi.key, worst: lo.key,
    sentence: { key: 'radar.own', params: { name, best: hi.key, bestValue: pctText(hi.value), worst: lo.key, worstValue: pctText(lo.value) } },
  };
}
