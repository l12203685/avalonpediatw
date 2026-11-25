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

export function votesGlance(pooled: Record<string, VoteCell | undefined> | null | undefined, evilKey = 'evilAll', goodKey = 'goodAll'): VotesGlance | null {
  const evil = pooled?.[evilKey];
  const good = pooled?.[goodKey];
  if (!evil || !good || !finite(evil.rate) || !finite(good.rate) || !(evil.votes > 0) || !(good.votes > 0)) return null;
  const withRed: Share = { pct: evil.rate, n: evil.votes };
  const allBlueApprove: Share = { pct: good.rate, n: good.votes };
  // 全藍的隊：每一票不是贊成就是反對，反對 = 100 − 贊成（用顯示的整數減，跟長條上的數字一樣）
  const redReject = shownPct(withRed.pct);
  const blueReject = restPct(allBlueApprove.pct);
  const key = blueReject === redReject ? 'votes.same' : blueReject > redReject ? 'votes.blueHigher' : blueReject >= 50 ? 'votes.blueAlsoHalf' : 'votes.blueLower';
  return { withRed, allBlueApprove, sentence: { key, params: { withRed: `${redReject}%`, allBlue: `${blueReject}%` } } };
}
