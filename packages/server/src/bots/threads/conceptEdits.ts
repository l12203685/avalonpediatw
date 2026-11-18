/**
 * 觀念卡的主控台同步格式（2026-11-18，站長：「全部的觀念卡應該要放主控台啊 並且跟百科網站的文章完全連動」）。
 * 說明見 docs/CONCEPTS.md。
 *
 *  - applyConceptEdits：把主控台送來的修改（edits.json）套到 concepts.json：改三句／tags／evidence／章節、確認沒問題
 *    （reviewed）、退役（retire）、新增（new）。全部驗證過才寫，有一筆不對就整批不寫。動到的卡依目前的文章重新蓋章
 *    （sectionHash／sourceQuote），標題與網址也照 wiki_data.json 重算。
 *  - buildConceptExport：主控台讀的 JSON（每張卡＋是否待複查＋原因，加上字數上限、可選的值與每篇文章的章節目錄）。
 *
 * 純函式：讀文章、算雜湊由呼叫的一方給（ConceptWiki；packages/server/scripts/conceptsWiki.ts 用 wiki_data.json 與
 * web/src/utils/conceptSource.ts 組出來），伺服器 src 不 import web。
 */

import {
  CONCEPT_DECISIONS,
  CONCEPT_EVIDENCE,
  CONCEPT_ID_RE,
  CONCEPT_PARTS,
  CONCEPT_PHASES,
  CONCEPT_QUOTE_MAX,
  CONCEPT_ROLE_TAGS,
  CONCEPT_ROLES,
  CONCEPT_SENTENCE_MAX,
  conceptPhaseOf,
  conceptProblems,
  type Concept,
  type ConceptBank,
  type ConceptEvidence,
  type ConceptTags,
} from './concepts';

/** 文章與雜湊（呼叫的一方提供）。 */
export interface ConceptWiki {
  /** 文章標題；文章不存在時 undefined。 */
  title(slug: string): string | undefined;
  hasSection(slug: string, section: string): boolean;
  /** 這句（忽略空白）在不在卡片指的那一節。 */
  quoteInSection(card: Concept, quote: string): boolean;
  /** 依目前的文章更新 sectionHash／sourceQuote（repickQuote：重新挑依據的那一句）。 */
  stamp(card: Concept, opts: { repickQuote: boolean }): Concept;
}

/** 網站深連結（同 web/src/utils/wikiHash.ts 的 wikiHash，測試對過）。 */
export function conceptArticleUrl(site: string, slug: string, section?: string): string {
  return `${site.replace(/\/+$/, '')}/#wiki=${encodeURIComponent(slug)}${section ? `&sec=${encodeURIComponent(section)}` : ''}`;
}

/** 分享頁（同 wikiShareUrl）。 */
export function conceptShareUrl(site: string, slug: string): string {
  return `${site.replace(/\/+$/, '')}/w/${encodeURIComponent(slug)}/`;
}

// ─── edits.json ──────────────────────────────────────────────────────────

/** 新卡（cardId 就是新卡的 id）。 */
export interface ConceptNewCard {
  article: { slug: string; section?: string };
  情境: string;
  觀念: string;
  應用: string;
  tags: ConceptTags;
  evidence?: ConceptEvidence | null;
}

/**
 * 主控台的一筆修改。cardId 必填；其他欄位有給的才改：
 *  - 情境／觀念／應用：整句換掉；tags：整個換掉（不是合併；沒給 phase 就照 decision／round 補）；evidence：可以給 null；
 *    section：改指同一篇的另一節（null＝整篇）；
 *  - sourceQuote：指定依據的那一句（必須在那一節裡）；
 *  - reviewed: true：文章改過、卡片仍成立，只重新蓋章；
 *  - retire: true：退役（從卡庫拿掉，id 記進 retired，之後不能再用）；不能跟其他欄位一起給；
 *  - new：新增一張 id 為 cardId 的卡。
 */
export interface ConceptEdit {
  cardId: string;
  情境?: string;
  觀念?: string;
  應用?: string;
  tags?: ConceptTags;
  evidence?: ConceptEvidence | null;
  section?: string | null;
  sourceQuote?: string;
  reviewed?: true;
  retire?: true;
  new?: ConceptNewCard;
}

/** unchanged：給的值都跟現在一樣（不重新蓋章）。 */
export type ConceptEditAction = 'updated' | 'reviewed' | 'retired' | 'created' | 'unchanged';

export interface ConceptEditResult {
  cardId: string;
  action: ConceptEditAction;
  /** 改了哪些欄位（created／retired 是空的）。 */
  changed: string[];
}

export interface ApplyConceptEditsResult {
  ok: boolean;
  /** 套用後的卡庫（ok 為 false 時是原本的卡庫）。 */
  bank: ConceptBank;
  results: ConceptEditResult[];
  errors: string[];
}

const EDIT_KEYS = new Set(['cardId', ...CONCEPT_PARTS, 'tags', 'evidence', 'section', 'sourceQuote', 'reviewed', 'retire', 'new']);
const NEW_KEYS = new Set(['id', 'article', ...CONCEPT_PARTS, 'tags', 'evidence', 'sourceQuote']);
/** 改了這些就重新挑依據的那一句（tags／evidence 不影響）。 */
const QUOTE_FIELDS: readonly string[] = [...CONCEPT_PARTS, 'section'];

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** edits.json 可以是 { edits: [...] } 或直接一個陣列。 */
export function conceptEditsOf(input: unknown): unknown[] | null {
  if (Array.isArray(input)) return input;
  if (isObject(input) && Array.isArray(input.edits)) return input.edits;
  return null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * tags 沒給 phase 時照 decision／round 補上（conceptPhaseOf），排在 round 後面；主控台舊版的表單沒有這一欄也能存。
 * decision／round 本身不對時原樣傳回，交給 conceptProblems 報錯。
 */
export function withConceptPhase(tags: unknown): unknown {
  if (!isObject(tags) || tags.phase !== undefined) return tags;
  const { decision, round } = tags;
  if (!Array.isArray(decision) || !Array.isArray(round) || !decision.every((d) => typeof d === 'string') || !round.every((r) => typeof r === 'string')) return tags;
  const phase = conceptPhaseOf({ decision: decision as ConceptTags['decision'], round: round as string[] });
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tags)) {
    out[k] = v;
    if (k === 'round') out.phase = phase;
  }
  return out;
}

/** 標題與網址照目前的文章重算。 */
function relink(card: Concept, site: string, wiki: ConceptWiki): Concept {
  const { slug, section } = card.article;
  const article: Concept['article'] = {
    slug,
    title: wiki.title(slug) ?? card.article.title,
    ...(section ? { section } : {}),
    url: conceptArticleUrl(site, slug, section),
    shareUrl: conceptShareUrl(site, slug),
    ...(card.article.sourceQuote ? { sourceQuote: card.article.sourceQuote } : {}),
  };
  return { ...card, article };
}

/** 卡片的欄位照固定順序（寫回 concepts.json 時 diff 乾淨）。 */
function ordered(card: Concept): Concept {
  const a = card.article;
  return {
    id: card.id,
    article: {
      slug: a.slug,
      title: a.title,
      ...(a.section ? { section: a.section } : {}),
      url: a.url,
      shareUrl: a.shareUrl,
      ...(a.sectionHash ? { sectionHash: a.sectionHash } : {}),
      ...(a.sourceQuote ? { sourceQuote: a.sourceQuote } : {}),
    },
    情境: card.情境,
    觀念: card.觀念,
    應用: card.應用,
    tags: card.tags,
    evidence: card.evidence,
  };
}

function quoteProblem(q: unknown): string {
  if (typeof q !== 'string' || q.trim() === '' || q !== q.trim()) return 'sourceQuote must be a non-empty trimmed string';
  if (Array.from(q).length > CONCEPT_QUOTE_MAX) return `sourceQuote longer than ${CONCEPT_QUOTE_MAX}`;
  return '';
}

/**
 * 套用主控台的修改。全部驗證通過才回傳新的卡庫（ok: true）；任何一筆不對就 ok: false、卡庫不變、errors 列出每個問題。
 */
export function applyConceptEdits(bank: ConceptBank, input: unknown, wiki: ConceptWiki): ApplyConceptEditsResult {
  const fail = (errors: string[]): ApplyConceptEditsResult => ({ ok: false, bank, results: [], errors });
  const edits = conceptEditsOf(input);
  if (!edits) return fail(['edits.json must be an array of edits or { "edits": [...] }']);
  if (edits.length === 0) return fail(['no edits']);

  const errors: string[] = [];
  const results: ConceptEditResult[] = [];
  const cards: Concept[] = bank.concepts.map((c) => ({ ...c, article: { ...c.article } }));
  const index = (id: string): number => cards.findIndex((c) => c.id === id);
  const retired = new Set(bank.retired ?? []);
  const seen = new Set<string>();
  /** 動到的卡：是否要重新挑 sourceQuote。 */
  const touched = new Map<string, boolean>();

  edits.forEach((raw, i) => {
    const at = `edit #${i}`;
    if (!isObject(raw)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const e = raw as Partial<ConceptEdit> & Record<string, unknown>;
    const id = e.cardId;
    if (typeof id !== 'string' || !CONCEPT_ID_RE.test(id)) {
      errors.push(`${at}: cardId must match ${CONCEPT_ID_RE}`);
      return;
    }
    const where = `${at} (${id})`;
    const unknown = Object.keys(e).filter((k) => !EDIT_KEYS.has(k));
    if (unknown.length) {
      errors.push(`${where}: unknown field ${unknown.join(', ')}`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`${where}: more than one edit for this card in one batch`);
      return;
    }
    seen.add(id);
    if (e.reviewed !== undefined && e.reviewed !== true) errors.push(`${where}: reviewed must be true when present`);
    if (e.retire !== undefined && e.retire !== true) errors.push(`${where}: retire must be true when present`);
    if (e.sourceQuote !== undefined) {
      const p = quoteProblem(e.sourceQuote);
      if (p) errors.push(`${where}: ${p}`);
    }

    // ── 新增 ──
    if (e.new !== undefined) {
      const n = e.new as unknown;
      const others = Object.keys(e).filter((k) => k !== 'cardId' && k !== 'new');
      if (others.length) {
        errors.push(`${where}: new cannot be combined with ${others.join(', ')} (put fields inside new)`);
        return;
      }
      if (!isObject(n)) {
        errors.push(`${where}: new must be an object`);
        return;
      }
      const extra = Object.keys(n).filter((k) => !NEW_KEYS.has(k));
      if (extra.length) errors.push(`${where}: unknown field new.${extra.join(', new.')}`);
      if (n.id !== undefined && n.id !== id) errors.push(`${where}: new.id must equal cardId`);
      if (index(id) >= 0) errors.push(`${where}: id already exists`);
      if (retired.has(id)) errors.push(`${where}: id was retired and cannot be reused`);
      const art = n.article;
      if (!isObject(art) || typeof art.slug !== 'string') {
        errors.push(`${where}: new.article.slug is required`);
        return;
      }
      const artExtra = Object.keys(art).filter((k) => k !== 'slug' && k !== 'section');
      if (artExtra.length) errors.push(`${where}: new.article only takes slug and section (title and urls are derived), got ${artExtra.join(', ')}`);
      if (wiki.title(art.slug) === undefined) {
        errors.push(`${where}: no article ${art.slug} in wiki_data.json`);
        return;
      }
      if (art.section !== undefined && (typeof art.section !== 'string' || !wiki.hasSection(art.slug, art.section))) {
        errors.push(`${where}: no section ${String(art.section)} in ${art.slug}`);
        return;
      }
      for (const p of CONCEPT_PARTS) if (typeof n[p] !== 'string') errors.push(`${where}: new.${p} is required`);
      if (!isObject(n.tags)) errors.push(`${where}: new.tags is required`);
      if (n.sourceQuote !== undefined) {
        const p = quoteProblem(n.sourceQuote);
        if (p) errors.push(`${where}: new.${p}`);
      }
      if (errors.length) return;
      const card = relink(
        {
          id,
          article: {
            slug: art.slug,
            title: '',
            ...(art.section ? { section: art.section as string } : {}),
            url: '',
            shareUrl: '',
            ...(typeof n.sourceQuote === 'string' ? { sourceQuote: n.sourceQuote } : {}),
          },
          情境: n.情境 as string,
          觀念: n.觀念 as string,
          應用: n.應用 as string,
          tags: withConceptPhase(n.tags) as ConceptTags,
          evidence: (n.evidence ?? null) as ConceptEvidence | null,
        },
        bank.site,
        wiki,
      );
      // 接在同一篇文章的最後一張卡後面（同一篇的卡排在一起）
      let pos = -1;
      cards.forEach((c, j) => {
        if (c.article.slug === art.slug) pos = j;
      });
      cards.splice(pos >= 0 ? pos + 1 : cards.length, 0, card);
      touched.set(id, typeof n.sourceQuote !== 'string');
      results.push({ cardId: id, action: 'created', changed: [] });
      return;
    }

    const j = index(id);
    if (j < 0) {
      errors.push(`${where}: no card with this id${retired.has(id) ? ' (retired)' : ''}`);
      return;
    }

    // ── 退役 ──
    if (e.retire === true) {
      const others = Object.keys(e).filter((k) => k !== 'cardId' && k !== 'retire');
      if (others.length) {
        errors.push(`${where}: retire cannot be combined with ${others.join(', ')}`);
        return;
      }
      cards.splice(j, 1);
      retired.add(id);
      results.push({ cardId: id, action: 'retired', changed: [] });
      return;
    }

    // ── 修改／確認 ──
    const before = cards[j];
    const next: Concept = { ...before, article: { ...before.article } };
    const changed: string[] = [];
    for (const p of CONCEPT_PARTS) {
      if (e[p] === undefined) continue;
      if (typeof e[p] !== 'string') {
        errors.push(`${where}: ${p} must be a string`);
        continue;
      }
      if (e[p] !== before[p]) {
        next[p] = e[p] as string;
        changed.push(p);
      }
    }
    if (e.tags !== undefined) {
      const tags = withConceptPhase(e.tags);
      if (!isObject(tags)) errors.push(`${where}: tags must be an object (it replaces the card's tags)`);
      else if (!sameJson(tags, before.tags)) {
        next.tags = tags as unknown as ConceptTags;
        changed.push('tags');
      }
    }
    if (e.evidence !== undefined && e.evidence !== before.evidence) {
      next.evidence = e.evidence as ConceptEvidence | null;
      changed.push('evidence');
    }
    if (e.section !== undefined) {
      if (e.section !== null && (typeof e.section !== 'string' || !wiki.hasSection(before.article.slug, e.section))) {
        errors.push(`${where}: no section ${String(e.section)} in ${before.article.slug}`);
      } else if ((e.section ?? undefined) !== before.article.section) {
        if (e.section === null) delete next.article.section;
        else next.article.section = e.section;
        changed.push('section');
      }
    }
    if (typeof e.sourceQuote === 'string' && e.sourceQuote !== before.article.sourceQuote) {
      next.article.sourceQuote = e.sourceQuote;
      changed.push('sourceQuote');
    }
    if (!changed.length && e.reviewed !== true) {
      const asked = Object.keys(e).filter((k) => k !== 'cardId');
      if (!asked.length) errors.push(`${where}: nothing to change (give fields, reviewed: true, retire: true or new)`);
      // 給的值都跟現在一樣：不算錯，也不重新蓋章（不是 reviewed）
      else results.push({ cardId: id, action: 'unchanged', changed: [] });
      return;
    }
    cards[j] = relink(next, bank.site, wiki);
    touched.set(id, changed.some((k) => QUOTE_FIELDS.includes(k)) && !changed.includes('sourceQuote'));
    results.push({ cardId: id, action: changed.length ? 'updated' : 'reviewed', changed });
  });

  if (errors.length) return fail(errors);

  // 指定的 sourceQuote 必須在那一節裡；動到的卡重新蓋章
  for (const [id, repickQuote] of touched) {
    const j = index(id);
    const c = cards[j];
    if (!repickQuote && c.article.sourceQuote && !wiki.quoteInSection(c, c.article.sourceQuote)) {
      // reviewed／只改 tags 時原本那句不在了：重新挑；明確指定的那句不在：錯
      const explicit = edits.some((x) => isObject(x) && x.cardId === id && (typeof x.sourceQuote === 'string' || (isObject(x.new) && typeof x.new.sourceQuote === 'string')));
      if (explicit) {
        errors.push(`${id}: sourceQuote is not in ${c.article.slug}${c.article.section ? `#${c.article.section}` : ''}`);
        continue;
      }
    }
    try {
      cards[j] = ordered(wiki.stamp(c, { repickQuote }));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length) return fail(errors);

  const out: ConceptBank = { version: bank.version, site: bank.site, concepts: cards, ...(retired.size ? { retired: [...retired] } : {}) };
  const problems = conceptProblems(out);
  for (const c of out.concepts) {
    if (!touched.has(c.id)) continue;
    if (c.article.url !== conceptArticleUrl(out.site, c.article.slug, c.article.section)) problems.push(`${c.id}: url is not the site deep link`);
    if (c.article.shareUrl !== conceptShareUrl(out.site, c.article.slug)) problems.push(`${c.id}: shareUrl is not /w/<id>/`);
  }
  if (problems.length) return fail(problems);
  return { ok: true, bank: out, results, errors: [] };
}

// ─── 主控台讀的 JSON ─────────────────────────────────────────────────────

/** web/src/utils/conceptSource.ts 的 ConceptCheck（只列這裡用到的欄位）。 */
export interface ConceptCheckLike {
  id: string;
  status: string;
  stale: boolean;
  reasons: string[];
  recordedHash: string | null;
  currentHash: string | null;
  quoteFound: boolean;
  suggested?: { slug: string; section?: string };
}

export interface ConceptOutlineLike {
  slug: string;
  title: string;
  sections: { slug: string; title: string; level: number }[];
}

export type ExportedConcept = Concept & {
  stale: boolean;
  status: string;
  reasons: string[];
  currentHash: string | null;
  quoteFound: boolean;
  suggested?: { slug: string; section?: string };
};

export interface ConceptExport {
  format: 'avalon-concepts-export';
  version: 1;
  exportedAt: string;
  site: string;
  summary: { total: number; stale: number; byStatus: Record<string, number> };
  /** 主控台表單的檢查規則（跟 concepts:apply 一樣）。 */
  limits: {
    sentenceMax: number;
    quoteMax: number;
    idPattern: string;
    parts: readonly string[];
    decisions: readonly string[];
    evidence: readonly string[];
    roles: readonly string[];
    /** tags.phase 可選的值（沒給時 apply 照 decision／round 補）。 */
    phases: readonly string[];
    /** tags.role 可選的值。 */
    roleTags: readonly string[];
  };
  cards: ExportedConcept[];
  retired: string[];
  /** 每篇文章與章節（新增卡片、改章節時選）。 */
  articles: ConceptOutlineLike[];
}

export function buildConceptExport(
  bank: ConceptBank,
  checks: readonly ConceptCheckLike[],
  articles: readonly ConceptOutlineLike[],
  now: Date = new Date(),
): ConceptExport {
  const byId = new Map(checks.map((c) => [c.id, c]));
  const byStatus: Record<string, number> = {};
  const cards = bank.concepts.map((c): ExportedConcept => {
    const k = byId.get(c.id);
    const status = k?.status ?? 'unchecked';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    return {
      ...c,
      stale: k ? k.stale : true,
      status,
      reasons: k?.reasons ?? ['not checked'],
      currentHash: k?.currentHash ?? null,
      quoteFound: k?.quoteFound ?? false,
      ...(k?.suggested ? { suggested: k.suggested } : {}),
    };
  });
  return {
    format: 'avalon-concepts-export',
    version: 1,
    exportedAt: now.toISOString(),
    site: bank.site,
    summary: { total: cards.length, stale: cards.filter((c) => c.stale).length, byStatus },
    limits: {
      sentenceMax: CONCEPT_SENTENCE_MAX,
      quoteMax: CONCEPT_QUOTE_MAX,
      idPattern: CONCEPT_ID_RE.source,
      parts: CONCEPT_PARTS,
      decisions: CONCEPT_DECISIONS,
      evidence: CONCEPT_EVIDENCE,
      roles: CONCEPT_ROLES,
      phases: CONCEPT_PHASES,
      roleTags: CONCEPT_ROLE_TAGS,
    },
    cards,
    retired: [...(bank.retired ?? [])],
    articles: [...articles],
  };
}
