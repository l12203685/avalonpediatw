/**
 * 每日小觀念（2026-11-18）— 哪一天發哪一張卡、附哪一個連結、訊息長什麼樣子，純函式。
 *
 * 選卡（站長 11/18：「牌局: 優先以當日 threads/IG 發文的題目 所以這樣可以整個跟發文串在一起」）：
 *   1. 當天有 Threads／IG 題目（跟每日草稿同一套 ThreadsGenerator.pickFor）：conceptMatches(那一題) 由貼近到不貼近，
 *      取第一張最近 RECENT_DAYS 天沒發過的；牌局連到那一題的牌譜，只到出題的那一刻（#records=<id>&upto=<派票>&seat=<座位>）。
 *   2. 沒有題目、或沒有能用的卡：輪替。整副卡照雜湊排好、一輪裡不重複，用完才開下一輪；
 *      情境寫了前提（角色、座位、比分、湖、上一局…）的卡要題庫裡有對得上的實戰牌譜才用（連到那一局只到那一刻），
 *      沒寫前提的卡沒有牌譜時連文章那一節，標「文章:」。
 * 同一天 LINE 和 Discord 一定同一張：一天的結果算一次就存起來（service.ts），兩邊都讀它。
 */

import { createHash } from 'crypto';
import type { SimBank } from '../simulation/bank';
import { recordUrl } from '../simulation/recordsIndex';
import { assassinSeat, type SimGame } from '../simulation/scenario';
import { dayNumber } from '../threads/plan';
import { conceptMatches, exerciseOf, matchConcept, type Concept, type ConceptExercise } from '../threads/concepts';

/** 同一張卡多少天內不重複（站長要的「大約兩週」）。 */
export const RECENT_DAYS = 14;

export const CONCEPT_MESSAGE_TITLE = '[阿瓦隆百科小觀念]';
export const CONCEPT_FEEDBACK_HINT = '覺得不合理或不清楚？直接回覆這則訊息，或打「觀念回饋 內容」';

export type DayLink = { kind: 'record'; url: string } | { kind: 'article'; url: string };

/** 一天的小觀念（算一次、存起來，LINE 和 Discord 共用）。 */
export interface DayPlan {
  date: string;
  cardId: string;
  source: 'threads' | 'rotation';
  link: DayLink;
  /** 當天 Threads 的題號（source = threads）。 */
  exerciseId?: string;
  /** 當天 Threads 貼文已經發出去、網址知道時。 */
  threadsUrl?: string;
}

export interface HistoryEntry {
  date: string;
  cardId: string;
}

/** 當天的 Threads 題目（threadsToday.ts）。 */
export interface ThreadsToday {
  exerciseId: string;
  exercise: ConceptExercise;
  /** 那一題的牌譜（只到出題的那一刻）；網站上沒有那一局就 null。 */
  recordUrl: string | null;
  threadsUrl?: string;
}

function hash32(text: string): number {
  return parseInt(createHash('sha1').update(text).digest('hex').slice(0, 8), 16);
}

const seatChar = (seat: number): string => (seat === 10 ? '0' : String(seat));

/**
 * 牌譜連結，只到出題的那一刻：`#records=<id>&upto=<派票的索引，刺殺題是 A>&seat=<座位，0 家寫 0>`。
 * 網站（web/src/utils/records.ts cutRecordGame）藏起那一次派票（含）之後的一切、結果與角色，只留那一家自己看得到的資訊。
 */
export function cutoffRecordUrl(postId: string, proposal: number | null, seat: number): string {
  return `${recordUrl(postId)}&upto=${proposal === null ? 'A' : proposal}&seat=${seatChar(seat)}`;
}

/** 觀念卡的公開頁：`<網站>/#concepts=<卡片 id>`（web/src/utils/concepts.ts）。 */
export function conceptPageUrl(site: string, id: string): string {
  return `${site.replace(/\/+$/, '')}/#concepts=${encodeURIComponent(id)}`;
}

/** 情境寫了前提（誰、坐哪、比分、湖、上一局、拇指）：沒有對得上的牌譜就不在輪替裡用。 */
export function needsRecord(c: Concept): boolean {
  const t = c.tags;
  return !!(t.roles || t.seats || t.score || t.lakeHolder !== undefined || t.lastQuestMember !== undefined || t.lastQuestFails !== undefined || t.thumbsLed !== undefined);
}

/** 牌譜乾淨：湖的接力對得上、每一次派票的票都記全了。 */
export function isCleanGame(g: SimGame): boolean {
  return g.lakeChainValid && g.proposals.every((p) => p.votesReliable || p.attempt === 5);
}

export interface RecordCandidate {
  url: string;
  /** 越大越好：對到「局-次」、乾淨、配對分數。 */
  rank: number;
  key: string;
}

/** 卡片 id → 題庫裡對得上、網站上有牌譜頁的題目（最好的在前，最多 20 個）。 */
export type RecordIndex = Map<string, RecordCandidate[]>;

type IndexBank = Pick<SimBank, 'games' | 'pool' | 'midPool' | 'assassinPool' | 'records'>;

/** 題庫裡要配的題目：模擬瓦的題目池（每一家第一個決定、尾派、第 5 局、派西）＋刺殺題，只取網站上有牌譜頁的局。 */
function indexRefs(bank: IndexBank): { gi: number; proposal: number | null; seat: number }[] {
  const out: { gi: number; proposal: number | null; seat: number }[] = [];
  const seen = new Set<string>();
  const add = (gi: number, proposal: number | null, seat: number): void => {
    const game = bank.games[gi];
    if (!game || !bank.records.has(gi)) return;
    const key = `${gi}/${proposal ?? 'A'}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ gi, proposal, seat });
  };
  for (const refs of [...bank.pool.values(), ...bank.midPool.values()]) {
    for (const r of refs) {
      const g = bank.games[r.game];
      if (g) add(r.game, r.proposal, g.proposals[r.proposal].leaderSeat);
    }
  }
  for (const gi of bank.assassinPool) {
    const seat = bank.games[gi] ? assassinSeat(bank.games[gi]) : null;
    if (seat !== null) add(gi, null, seat);
  }
  return out;
}

function indexOne(out: RecordIndex, bank: IndexBank, concepts: readonly Concept[], ref: { gi: number; proposal: number | null; seat: number }): void {
  const game = bank.games[ref.gi];
  const postId = bank.records.get(ref.gi) as string;
  const ex = exerciseOf(game, ref.proposal, ref.seat);
  const clean = isCleanGame(game);
  const key = `${game.id}/${ref.proposal ?? 'A'}`;
  for (const m of conceptMatches(ex, concepts)) {
    const rank = m.score + (m.roundMatch === 'exact' ? 10 : m.roundMatch === 'round' ? 5 : 0) + (clean ? 20 : 0);
    const list = out.get(m.concept.id) ?? [];
    list.push({ url: cutoffRecordUrl(postId, ref.proposal, ref.seat), rank, key });
    out.set(m.concept.id, list);
  }
}

function finishIndex(out: RecordIndex): RecordIndex {
  for (const [id, list] of out) {
    list.sort((a, b) => b.rank - a.rank || (a.key < b.key ? -1 : 1));
    out.set(id, list.slice(0, 20));
  }
  return out;
}

/**
 * 反過來用 conceptsFor：題庫的每一題配一次卡，記下每張卡配得到的題目（網站上有牌譜頁的局；乾淨、對到「局-次」的在前）。
 */
export function buildRecordIndex(bank: IndexBank, concepts: readonly Concept[]): RecordIndex {
  const out: RecordIndex = new Map();
  for (const ref of indexRefs(bank)) indexOne(out, bank, concepts, ref);
  return finishIndex(out);
}

/**
 * 同 buildRecordIndex，但每 `chunk` 題讓出一次 CPU：整個要 0.7 秒左右的 CPU，Render 免費方案（0.1 CPU）上會卡住好幾秒，
 * 剛好擋住叫醒伺服器的那個 LINE webhook（同 simulation/bank.ts buildSimBankAsync 的理由）。
 */
export async function buildRecordIndexAsync(
  bank: IndexBank,
  concepts: readonly Concept[],
  chunk = 100,
  pause: () => Promise<void> = (): Promise<void> => new Promise((r) => setImmediate(r)),
): Promise<RecordIndex> {
  const out: RecordIndex = new Map();
  const refs = indexRefs(bank);
  for (let i = 0; i < refs.length; i++) {
    indexOne(out, bank, concepts, refs[i]);
    if ((i + 1) % chunk === 0) await pause();
  }
  return finishIndex(out);
}

/** 這一天這張卡用哪一局（同分的幾局照日期輪）；沒有就 null。 */
export function recordFor(index: RecordIndex, cardId: string, date: string): string | null {
  const list = index.get(cardId);
  if (!list || list.length === 0) return null;
  const top = list.filter((c) => c.rank === list[0].rank);
  return top[hash32(`${date}:${cardId}`) % top.length].url;
}

/** 輪替用得到的卡：沒寫前提的，或寫了前提但有對得上的牌譜的。 */
export function rotationEligible(concepts: readonly Concept[], index: RecordIndex): Concept[] {
  return concepts.filter((c) => !needsRecord(c) || (index.get(c.id)?.length ?? 0) > 0);
}

/** 最近 days 天（不含今天）發過的卡。 */
export function recentCards(history: readonly HistoryEntry[], date: string, days = RECENT_DAYS): Set<string> {
  const today = dayNumber(date);
  return new Set(history.filter((h) => {
    const d = dayNumber(h.date);
    return d < today && d >= today - days;
  }).map((h) => h.cardId));
}

/** 輪替：第幾輪、這一輪已經用過哪些（照日期把歷史走一次；一輪 = 能用的卡都用過一次）。 */
export function rotationCycle(history: readonly HistoryEntry[], date: string, eligible: readonly Concept[]): { cycle: number; used: Set<string> } {
  const ids = new Set(eligible.map((c) => c.id));
  let cycle = 0;
  let used = new Set<string>();
  for (const h of [...history].filter((x) => x.date < date).sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (!ids.has(h.cardId)) continue;
    used.add(h.cardId);
    if (used.size >= ids.size) {
      cycle += 1;
      used = new Set();
    }
  }
  return { cycle, used };
}

/** 這一輪的順序（每一輪換一次）。 */
export function rotationOrder(eligible: readonly Concept[], cycle: number): Concept[] {
  return [...eligible].sort((a, b) => hash32(`concept-daily:${cycle}:${a.id}`) - hash32(`concept-daily:${cycle}:${b.id}`) || (a.id < b.id ? -1 : 1));
}

function articleLink(c: Concept): DayLink {
  return { kind: 'article', url: c.article.url };
}

export interface ChooseInput {
  date: string;
  concepts: readonly Concept[];
  /** 之前每一天發的卡（存下來的）。 */
  history: readonly HistoryEntry[];
  threads: ThreadsToday | null;
  index: RecordIndex;
}

/** 這一天的小觀念。卡庫是空的才會是 null。 */
export function chooseDay(input: ChooseInput): DayPlan | null {
  const { date, concepts, history, threads, index } = input;
  if (concepts.length === 0) return null;
  const recent = recentCards(history, date);
  if (threads) {
    const card = conceptMatches(threads.exercise, concepts).map((m) => m.concept).find((c) => !recent.has(c.id));
    if (card) {
      return {
        date,
        cardId: card.id,
        source: 'threads',
        link: threads.recordUrl ? { kind: 'record', url: threads.recordUrl } : articleLink(card),
        exerciseId: threads.exerciseId,
        ...(threads.threadsUrl ? { threadsUrl: threads.threadsUrl } : {}),
      };
    }
  }
  const eligible = rotationEligible(concepts, index);
  const pool = eligible.length > 0 ? eligible : [...concepts];
  const { cycle, used } = rotationCycle(history, date, pool);
  const order = rotationOrder(pool, cycle);
  const card = order.find((c) => !used.has(c.id) && !recent.has(c.id)) ?? order.find((c) => !used.has(c.id)) ?? order[0];
  const rec = recordFor(index, card.id, date);
  return { date, cardId: card.id, source: 'rotation', link: rec ? { kind: 'record', url: rec } : articleLink(card) };
}

/** 卡片在這一天配到的題目真的對得上（測試與檢查用）。 */
export function cardMatchesExercise(card: Concept, ex: ConceptExercise): boolean {
  return matchConcept(card, ex) !== null;
}

/**
 * 群組裡的那一則（站長給的格式，半形冒號）：
 *   [阿瓦隆百科小觀念]
 *   情境: …
 *   觀念: …
 *   應用: …
 *   牌局: <只到出題那一刻的牌譜>（沒有牌譜就「文章: <文章那一節>」）
 *   Threads: <當天的貼文>（已經發出去才有）
 *   觀念卡: <公開頁上這一張>
 *   覺得不合理或不清楚？…
 */
export function formatConceptMessage(plan: DayPlan, card: Concept, site: string, opts: { feedbackHint?: boolean } = {}): string {
  const lines = [
    CONCEPT_MESSAGE_TITLE,
    `情境: ${card.情境}`,
    `觀念: ${card.觀念}`,
    `應用: ${card.應用}`,
    plan.link.kind === 'record' ? `牌局: ${plan.link.url}` : `文章: ${plan.link.url}`,
  ];
  if (plan.threadsUrl) lines.push(`Threads: ${plan.threadsUrl}`);
  lines.push(`觀念卡: ${conceptPageUrl(site, card.id)}`);
  if (opts.feedbackHint ?? true) lines.push(CONCEPT_FEEDBACK_HINT);
  return lines.join('\n');
}
