/**
 * 百科觀念卡的公開頁（2026-11-18，站長：「百科觀念卡 我希望能公開出去」）。
 *
 *   #concepts            → 百科攻略的「觀念卡」檢視
 *   #concepts=<卡片 id>   → 同上，捲到那一張並標出來（每日小觀念的「觀念卡:」連結）
 *
 * 卡庫是伺服器的 packages/server/src/bots/threads/concepts.json（vite.config.ts 的 '@concepts-bundle'，打包成獨立的 chunk）。
 * 每張卡三句（情境／觀念／應用）、證據標籤（文章在那句命題上標的，卡片不比文章更肯定）、文章那一節的連結。
 * 純函式放這裡，packages/server/src/__tests__/WebConcepts.test.ts 測（web 沒有測試執行器）。
 */

export type ConceptDecision = '派隊' | '投票' | '湖中' | '刺殺' | '出任務';
export const CONCEPT_DECISIONS: readonly ConceptDecision[] = ['派隊', '投票', '湖中', '刺殺', '出任務'];

export interface ConceptCard {
  id: string;
  article: { slug: string; title: string; section?: string; url: string; shareUrl: string };
  情境: string;
  觀念: string;
  應用: string;
  tags: { decision: string[]; round: string[]; roles?: string[]; seats?: number[]; score?: string[] };
  evidence: '邏輯' | '經驗' | '判斷／待驗證' | null;
}

export interface ConceptBankFile {
  version: number;
  site: string;
  concepts: ConceptCard[];
}

const CARD_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** #concepts → { id: null }；#concepts=<id> → { id }（id 不像卡片 id 時當成 #concepts）；其他 hash → null。 */
export function parseConceptsHash(hash: string | null | undefined): { id: string | null } | null {
  const raw = (hash ?? '').replace(/^#/, '').trim();
  if (/^concepts\/?$/i.test(raw)) return { id: null };
  const m = /^concepts[=/](.*)$/i.exec(raw);
  if (!m) return null;
  let id = m[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    return { id: null };
  }
  id = id.trim().toLowerCase();
  return { id: CARD_ID_RE.test(id) ? id : null };
}

export function conceptsHash(id?: string | null): string {
  return id ? `#concepts=${encodeURIComponent(id)}` : '#concepts';
}

/** 卡片在頁面上的錨點 id。 */
export function conceptAnchorId(id: string): string {
  return `concept-${id}`;
}

/** 局的篩選：第 1～5 局、刺殺（A）、通用（any）。 */
export type ConceptRoundFilter = '' | '1' | '2' | '3' | '4' | '5' | 'A' | 'any';

export const CONCEPT_ROUND_FILTERS: readonly { id: ConceptRoundFilter; label: string }[] = [
  { id: '', label: '全部' },
  { id: '1', label: '第 1 局' },
  { id: '2', label: '第 2 局' },
  { id: '3', label: '第 3 局' },
  { id: '4', label: '第 4 局' },
  { id: '5', label: '第 5 局' },
  { id: 'A', label: '刺殺' },
  { id: 'any', label: '通用' },
];

export interface ConceptFilter {
  query: string;
  decision: ConceptDecision | '';
  round: ConceptRoundFilter;
}

export const EMPTY_CONCEPT_FILTER: ConceptFilter = { query: '', decision: '', round: '' };

/** 一張卡的局標籤看起來（「1-5」→「1-5」、「2-*」→「第 2 局」、A → 刺殺、any → 通用）。 */
export function roundLabel(tag: string): string {
  if (tag === 'any') return '通用';
  if (tag === 'A') return '刺殺';
  const m = /^([1-5])-\*$/.exec(tag);
  return m ? `第 ${m[1]} 局` : tag;
}

function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** 搜尋（三句、文章標題、章節、卡片 id）＋決策＋局。 */
export function filterConcepts(cards: readonly ConceptCard[], f: ConceptFilter): ConceptCard[] {
  const q = normalize(f.query);
  return cards.filter((c) => {
    if (f.decision && !c.tags.decision.includes(f.decision)) return false;
    if (f.round) {
      const ok = f.round === 'any' || f.round === 'A'
        ? c.tags.round.includes(f.round)
        : c.tags.round.some((r) => r.startsWith(`${f.round}-`));
      if (!ok) return false;
    }
    if (!q) return true;
    return normalize([c.情境, c.觀念, c.應用, c.article.title, c.article.section ?? '', c.id].join('\n')).includes(q);
  });
}

/** 證據標籤的說明（docs/ai/WIKI_EVIDENCE_STANDARD.md）。 */
export function evidenceLabel(e: ConceptCard['evidence']): { label: string; hint: string } {
  switch (e) {
    case '邏輯':
      return { label: '邏輯', hint: '從規則與資訊推得出來' };
    case '經驗':
      return { label: '經驗', hint: '實戰經驗，多數時候成立' };
    case '判斷／待驗證':
      return { label: '判斷／待驗證', hint: '作者的判斷，還沒有資料驗證' };
    default:
      return { label: '未標', hint: '文章在這句沒有標證據類型' };
  }
}
