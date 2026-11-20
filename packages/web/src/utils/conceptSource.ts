/**
 * 觀念卡 ↔ 百科文章的來源追蹤（2026-11-18，站長：「全部的觀念卡應該要放主控台啊 並且跟百科網站的文章完全連動
 * 這樣才是真的整套系統完整整合」）。說明見 docs/CONCEPTS.md。
 *
 *  - 來源 = packages/server/wiki_data.json（網站打包的 '@wiki-bundle' 與伺服器 /api/wiki 都讀這一份）。
 *  - 每張卡的 article.sectionHash = 那一節 Markdown（wikiSections.ts 的 wikiSectionMarkdown：標題那一行到下一個同級或
 *    更高級標題之前，含子章節；沒有章節就是整篇，去掉 front matter）正規化後的 sha256 前 12 碼。
 *    正規化：換行統一成 \n、每行去掉行尾空白、拿掉空行、頭尾空白去掉。只改空白或空行不會讓卡變成待複查。
 *  - article.sourceQuote = 那一節裡卡片依據的一句（去掉 Markdown 的純文字，最多 CONCEPT_QUOTE_MAX 字）；比對時忽略空白。
 *  - checkConceptBank：文章不見、章節不見（有改名對照時附新錨點）、標題改了、雜湊對不上（再分「依據的那句還在」與
 *    「那句也不見了」）、還沒蓋章，都列為待複查（stale）。
 *
 * 純函式。雜湊函式由呼叫的一方給（伺服器腳本用 node 的 crypto，packages/server/scripts/conceptsWiki.ts），所以放在 web
 * 這邊也能被伺服器的腳本與測試共用（web 沒有測試執行器，packages/server/src/__tests__/ConceptsSource.test.ts 測）。
 */

import { resolveWikiRedirect, resolveWikiSectionAlias } from '../data/wikiRedirects';
import { wikiHeadingText, wikiHeadings, wikiSectionMarkdown } from './wikiSections';

/** sourceQuote 的字數上限（Array.from 的長度；同 server concepts.ts 的 CONCEPT_QUOTE_MAX）。 */
export const CONCEPT_QUOTE_MAX = 60;

/** 卡片裡來源追蹤用得到的欄位（server concepts.ts 的 Concept 結構相同）。 */
export interface ConceptSourceCard {
  id: string;
  article: {
    slug: string;
    title: string;
    section?: string;
    sectionHash?: string;
    sourceQuote?: string;
  };
  情境: string;
  觀念: string;
  應用: string;
}

export interface WikiSourceArticle {
  id: string;
  title: string;
  content: string;
}

export type WikiSource = ReadonlyMap<string, WikiSourceArticle>;

/** 正規化後的 Markdown → 12 個十六進位字（sha256 的前 12 碼）。 */
export type SectionHasher = (normalized: string) => string;

export function wikiSourceOf(articles: readonly WikiSourceArticle[]): WikiSource {
  return new Map(articles.map((a) => [a.id, a]));
}

// ─── 雜湊 ─────────────────────────────────────────────────────────────────

/**
 * 牌譜數字的標記 `<!-- stat:KEY -->…<!-- /stat -->`（packages/server/wiki_stats.py 每晚從逐局資料重寫，站長 2026-11-20
 * 「所有跟數字統計有關的 都應該跟資料庫連動」）：雜湊只看標記名稱、不看裡面的數字，數字每晚變動不算改了內容。
 */
const WIKI_STAT_SPAN_RE = /<!-- stat:([A-Za-z0-9_.-]+) -->[\s\S]*?<!-- \/stat -->/g;

/** 只改空白（行尾空白、空行、CRLF）不算改了內容；牌譜數字標記裡的內容也不算（見 WIKI_STAT_SPAN_RE）。 */
export function normalizeSectionMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(WIKI_STAT_SPAN_RE, '<!-- stat:$1 -->')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l !== '')
    .join('\n')
    .trim();
}

/** hasher(正規化後的 Markdown)。 */
export function sectionHashOf(markdown: string, hasher: SectionHasher): string {
  return hasher(normalizeSectionMarkdown(markdown));
}

/** 卡片指的那一節（沒有章節就是整篇）；文章或章節不存在時 null。 */
export function conceptSectionMarkdown(card: Pick<ConceptSourceCard, 'article'>, wiki: WikiSource): string | null {
  const a = wiki.get(card.article.slug);
  if (!a) return null;
  return wikiSectionMarkdown(a.content, card.article.section);
}

// ─── 依據的那一句 ─────────────────────────────────────────────────────────

/** 一行 Markdown → 讀者看到的字（標題井號、清單／引用記號、表格直線、連結、強調、論點標記都拿掉）。 */
function plainLine(line: string): string {
  const stripped = line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/, '')
    .replace(/\|/g, ' ');
  return wikiHeadingText(stripped).replace(/\s+/g, ' ').trim();
}

/** 一節的純文字（每行一段）。 */
export function sectionPlainText(markdown: string): string {
  let fence = false;
  const out: string[] = [];
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    const t = fence ? line.trim() : plainLine(line);
    if (t) out.push(t);
  }
  return out.join('\n');
}

const squashSpace = (s: string): string => s.replace(/\s+/g, '');

/** 依據的那一句還在不在這一節（忽略空白）。 */
export function quoteInSection(quote: string | undefined, markdown: string): boolean {
  if (!quote) return false;
  const q = squashSpace(quote);
  return q !== '' && squashSpace(sectionPlainText(markdown)).includes(q);
}

function bigrams(text: string): Set<string> {
  const chars = Array.from(squashSpace(text));
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

/**
 * 從這一節挑出跟卡片最像的一句當 sourceQuote：把純文字切成句子（。！？；與換行），每句跟卡片三句比相同的二字組，
 * 「觀念」那句算兩倍；太短（少於 6 字）的句子與標題那一行不選。超過 CONCEPT_QUOTE_MAX 字時取最像的那一段。
 * 這一節沒有可選的句子時退回標題。
 */
export function pickSourceQuote(markdown: string, card: Pick<ConceptSourceCard, '情境' | '觀念' | '應用'>): string {
  const plain = sectionPlainText(markdown);
  const [heading, ...body] = plain.split('\n');
  const sentences = body
    .join('\n')
    .split(/(?<=[。！？；!?;])|\n/)
    .map((s) => s.trim())
    .filter((s) => Array.from(s).length >= 6);
  const core = bigrams(card.觀念);
  const all = bigrams(`${card.情境}${card.觀念}${card.應用}`);
  const score = (s: string): number => {
    let n = 0;
    for (const g of bigrams(s)) n += (core.has(g) ? 2 : 0) + (all.has(g) ? 1 : 0);
    return n;
  };
  let best = '';
  let bestScore = -1;
  const consider = (text: string): void => {
    const t = text.trim().replace(/[，,：:、（(]+$/, '');
    if (Array.from(t).length < 6) return;
    const v = score(t);
    if (v > bestScore) [best, bestScore] = [t, v];
  };
  for (const s of sentences) {
    const chars = Array.from(s);
    if (chars.length <= CONCEPT_QUOTE_MAX) {
      consider(s);
      continue;
    }
    // 長句：取連續的幾個子句（逗號、冒號切開），不超過 CONCEPT_QUOTE_MAX 字；單一子句就太長時在裡面滑動一個窗
    const clauses = s.split(/(?<=[，,：:])/);
    for (let i = 0; i < clauses.length; i++) {
      let text = '';
      for (let j = i; j < clauses.length && Array.from(text + clauses[j]).length <= CONCEPT_QUOTE_MAX; j++) {
        text += clauses[j];
        consider(text);
      }
      const c = Array.from(clauses[i]);
      if (c.length > CONCEPT_QUOTE_MAX) {
        for (let k = 0; k + CONCEPT_QUOTE_MAX <= c.length; k += 4) consider(c.slice(k, k + CONCEPT_QUOTE_MAX).join(''));
      }
    }
  }
  const quote = best || heading || '';
  return Array.from(quote).slice(0, CONCEPT_QUOTE_MAX).join('').trim();
}

// ─── 蓋章（寫卡或確認後） ─────────────────────────────────────────────────

export interface StampOptions {
  /** 一律重新挑 sourceQuote（卡片內容或章節改了時）；否則原本那句還在這一節就留著。 */
  repickQuote?: boolean;
}

/** 依目前的文章更新 sectionHash／sourceQuote；文章或章節不存在時丟錯。 */
export function stampConcept<C extends ConceptSourceCard>(card: C, wiki: WikiSource, hasher: SectionHasher, opts: StampOptions = {}): C {
  const md = conceptSectionMarkdown(card, wiki);
  if (md === null) throw new Error(`${card.id}: ${card.article.slug}${card.article.section ? `#${card.article.section}` : ''} not found in wiki_data.json`);
  const keep = !opts.repickQuote && quoteInSection(card.article.sourceQuote, md);
  return {
    ...card,
    article: {
      ...card.article,
      sectionHash: sectionHashOf(md, hasher),
      sourceQuote: keep ? card.article.sourceQuote : pickSourceQuote(md, card),
    },
  };
}

// ─── 檢查 ─────────────────────────────────────────────────────────────────

/** 由重到輕：第一個成立的就是這張卡的 status。 */
export const CONCEPT_STATUSES = ['article-missing', 'section-missing', 'quote-missing', 'changed', 'unstamped', 'title-changed', 'ok'] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

export interface ConceptCheck {
  id: string;
  slug: string;
  section: string | null;
  status: ConceptStatus;
  stale: boolean;
  /** 每一項不對的地方（給人看的，繁中）。 */
  reasons: string[];
  recordedHash: string | null;
  currentHash: string | null;
  /** 依據的那一句還在不在這一節。 */
  quoteFound: boolean;
  /** 章節改名（WIKI_SECTION_ALIASES）或文章併入別篇（WIKI_REDIRECTS）時，建議改指的位置。 */
  suggested?: { slug: string; section?: string };
}

export function checkConcept(card: ConceptSourceCard, wiki: WikiSource, hasher: SectionHasher): ConceptCheck {
  const { slug, section } = card.article;
  const base = { id: card.id, slug, section: section ?? null, recordedHash: card.article.sectionHash ?? null };
  const statuses = new Set<ConceptStatus>();
  const reasons: string[] = [];
  const a = wiki.get(slug);
  if (!a) {
    const moved = resolveWikiRedirect(slug);
    return {
      ...base,
      status: 'article-missing',
      stale: true,
      reasons: [`文章 ${slug} 不在 wiki_data.json${moved ? `（已併入 ${moved.id}）` : ''}`],
      currentHash: null,
      quoteFound: false,
      ...(moved ? { suggested: moved.section ? { slug: moved.id, section: moved.section } : { slug: moved.id } } : {}),
    };
  }
  const md = wikiSectionMarkdown(a.content, section);
  if (md === null) {
    const renamed = resolveWikiSectionAlias(slug, section);
    const target = renamed && renamed !== section && wikiSectionMarkdown(a.content, renamed) !== null ? renamed : undefined;
    return {
      ...base,
      status: 'section-missing',
      stale: true,
      reasons: [`章節「${section}」不在〈${a.title}〉${target ? `（改名成「${target}」）` : ''}`],
      currentHash: null,
      quoteFound: false,
      ...(target ? { suggested: { slug, section: target } } : {}),
    };
  }
  const currentHash = sectionHashOf(md, hasher);
  const quoteFound = quoteInSection(card.article.sourceQuote, md);
  if (!card.article.sectionHash) {
    statuses.add('unstamped');
    reasons.push('還沒有 sectionHash（concepts:stamp 蓋章）');
  } else if (card.article.sectionHash !== currentHash) {
    if (quoteFound) {
      statuses.add('changed');
      reasons.push('這一節改過了，依據的那句還在：確認卡片是否仍成立');
    } else {
      statuses.add('quote-missing');
      reasons.push(card.article.sourceQuote ? '這一節改過了，依據的那句也不見了：卡片要重看' : '這一節改過了（沒有 sourceQuote）：卡片要重看');
    }
  }
  if (a.title !== card.article.title) {
    statuses.add('title-changed');
    reasons.push(`文章標題改成〈${a.title}〉`);
  }
  const status = CONCEPT_STATUSES.find((s) => statuses.has(s)) ?? 'ok';
  return { ...base, status, stale: status !== 'ok', reasons, currentHash, quoteFound };
}

export interface ConceptCheckReport {
  /** 檢查的時間（ISO）。 */
  checkedAt: string;
  total: number;
  stale: number;
  byStatus: Partial<Record<ConceptStatus, number>>;
  /** 待複查的卡（status !== ok），順序同 concepts.json。 */
  needsReview: ConceptCheck[];
  /** 每一張卡的結果（順序同 concepts.json）。 */
  cards: ConceptCheck[];
}

export function checkConceptBank(
  bank: { concepts: readonly ConceptSourceCard[] },
  wiki: WikiSource,
  hasher: SectionHasher,
  now: Date = new Date(),
): ConceptCheckReport {
  const cards = bank.concepts.map((c) => checkConcept(c, wiki, hasher));
  const byStatus: Partial<Record<ConceptStatus, number>> = {};
  for (const c of cards) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  const needsReview = cards.filter((c) => c.stale);
  return { checkedAt: now.toISOString(), total: cards.length, stale: needsReview.length, byStatus, needsReview, cards };
}

/** 給人看的報告（CI 的 log、終端機）。 */
export function formatCheckReport(report: ConceptCheckReport): string {
  const head = `觀念卡來源檢查：${report.total} 張，待複查 ${report.stale} 張`;
  if (!report.stale) return `${head}。`;
  const lines = report.needsReview.map(
    (c) => `- ${c.id}（${c.slug}${c.section ? `#${c.section}` : ''}）[${c.status}] ${c.reasons.join('；')}${c.suggested ? ` → 建議改指 ${c.suggested.slug}${c.suggested.section ? `#${c.suggested.section}` : ''}` : ''}`,
  );
  return [`${head}：`, ...lines].join('\n');
}

// ─── 給主控台的目錄 ───────────────────────────────────────────────────────

export interface WikiOutlineArticle {
  slug: string;
  title: string;
  sections: { slug: string; title: string; level: number }[];
}

/** 每篇文章的章節目錄（主控台新增卡片時選章節用）。 */
export function wikiOutline(articles: readonly WikiSourceArticle[]): WikiOutlineArticle[] {
  return articles.map((a) => ({
    slug: a.id,
    title: a.title,
    sections: wikiHeadings(a.content).map((h) => ({ slug: h.slug, title: wikiHeadingText(h.text), level: h.level })),
  }));
}
