/**
 * Threads 知識卡（2026-11-18）— 百科觀念卡庫（concepts.json）的載入、檢查與配對，純函式。
 *
 * 站長 11/18：「不一定要週一~週日只固定發某一種 其實只要文章有延續性 (1-5=>3-5 or 2-5=>4-5) 或是能跟阿瓦隆百科的文章觀念做連結
 * (文章觀念最好三句話之內可以清楚表達? 情境 觀念 應用?) 再配上完整文章的連結 (一篇文章可能有多個觀念, threads 跟 IG 答案文是以類似知識卡片的形態出現?)」
 * → 第一步：從百科文章整理出觀念卡，每張三句（情境／觀念／應用），附文章與章節的連結；一篇文章可以有好幾張。
 * 這一步只建卡庫和配對（conceptsFor），還沒有接到每日選題、草稿或圖（之後的步驟）。
 *
 * 每張卡：
 *  - 情境／觀念／應用各一句（含句尾的「。」不超過 CONCEPT_SENTENCE_MAX 個字，句中不再有句號），座位寫「N家」、10 號位寫「0家」。
 *  - article：百科文章 id（wiki_data.json）、標題、章節錨點（網站標題的 slug，見 web/src/utils/wikiSections.ts）、
 *    網址（`<網站>/#wiki=<id>&sec=<章節>`，打開就捲到那一節）與分享網址（`/w/<id>/`，有 Open Graph 預覽，沒有章節）。
 *  - evidence：文章在「觀念」那句命題上標的證據類型（docs/ai/WIKI_EVIDENCE_STANDARD.md）；那句含好幾個命題時取最弱的
 *    （判斷／待驗證 < 經驗 < 邏輯）；文章沒標就是 null。卡片不能比文章說得更肯定。
 *  - tags：配對用。decision＝決策種類；round＝「局-次」（1-5）、「局-*」（那一局每一次）、A（刺殺，同題號的 -A）或 any；其他條件（角色、座位、
 *    比分、持湖、上一局在不在隊上、上一局幾張失敗、派西的拇指已經有幾根當過隊長）有寫才要符合。
 *    phase（階段，必填）與 role（在講哪個角色）只給網站分組、篩選，不影響配對。
 */

import type { Role } from '@avalon/shared';
import CONCEPTS_FILE from './concepts.json';
import { sightFor, type SimGame } from '../simulation/scenario';
import type { ThreadsPick } from './plan';

export const CONCEPT_DECISIONS = ['派隊', '投票', '湖中', '刺殺', '出任務'] as const;
export type ConceptDecision = (typeof CONCEPT_DECISIONS)[number];

export const CONCEPT_EVIDENCE = ['邏輯', '經驗', '判斷／待驗證'] as const;
export type ConceptEvidence = (typeof CONCEPT_EVIDENCE)[number];

/** 每一句的字數上限（Array.from 的長度，數字與標點都算）。 */
export const CONCEPT_SENTENCE_MAX = 40;

export const CONCEPT_PARTS = ['情境', '觀念', '應用'] as const;

/** sourceQuote 的字數上限（Array.from 的長度）。 */
export const CONCEPT_QUOTE_MAX = 60;

/** sectionHash：sha256 的前 12 個十六進位字。 */
export const SECTION_HASH_RE = /^[0-9a-f]{12}$/;

export const CONCEPT_ROLES: readonly Role[] = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];

/**
 * 階段（2026-11-18 站長：「派票總共80張 好像有點太多了 … 或是直接區分成 [第一局派隊] [第二局派隊] [第三~五局派隊] 這樣呢?」）。
 * 每張卡一個，網站觀念卡頁照這個分組；由 decision／round 推（conceptPhaseOf），跨局的卡歸到它主要講的最早那一局，
 * 真的通用就是「通用」，可以手動改。
 */
export const CONCEPT_PHASES = ['第一局派隊', '第二局派隊', '第三～五局派隊', '刺殺', '投票・湖中・出任務', '通用'] as const;
export type ConceptPhase = (typeof CONCEPT_PHASES)[number];

/**
 * 角色標籤（2026-11-18 站長：「能力者的文章跟觀念好像完全沒看到?」）：這張卡是在講哪個角色（或哪一方）怎麼玩，網站的「角色」篩選用。
 * 跟 tags.roles（配對用：出題的那一家是什麼角色）不同，沒有就是不針對角色的通則。
 */
export const CONCEPT_ROLE_TAGS = ['梅林', '派西維爾', '忠臣', '藍方', '刺客', '莫甘娜', '莫德雷德', '奧伯倫', '紅方'] as const;
export type ConceptRoleTag = (typeof CONCEPT_ROLE_TAGS)[number];

export interface ConceptTags {
  decision: ConceptDecision[];
  /** 「1-5」「2-*」「A」（刺殺）「any」。 */
  round: string[];
  /** 階段（網站分組用，不影響配對）。 */
  phase: ConceptPhase;
  /** 這張卡在講哪個角色／哪一方（網站「角色」篩選用，不影響配對）。 */
  role?: ConceptRoleTag[];
  /** 出題的那一家的角色。 */
  roles?: Role[];
  /** 出題的那一家的座位（1～10，10 = 0家）。 */
  seats?: number[];
  /** 這一局開始前的比分「藍:紅」。 */
  score?: string[];
  /** 這一局結束後由他用湖中。 */
  lakeHolder?: boolean;
  /** 他在上一局出任務的隊上。 */
  lastQuestMember?: boolean;
  /** 上一局的失敗張數。 */
  lastQuestFails?: number[];
  /** 派西維爾的兩根拇指在這一題之前已經有幾根當過隊長（0～2）；寫了就只配派西的題。 */
  thumbsLed?: number[];
}

export interface ConceptArticle {
  /** wiki_data.json 的文章 id。 */
  slug: string;
  title: string;
  /** 章節錨點（標題的 slug）；沒有就是整篇。 */
  section?: string;
  /** 網站深連結（含章節）。 */
  url: string;
  /** 分享頁（Threads 會顯示文章卡片，不含章節）。 */
  shareUrl: string;
  /**
   * 來源追蹤（docs/CONCEPTS.md）：寫卡或最後一次確認時，那一節 Markdown 的 sha256 前 12 碼（conceptSource.ts 的 sectionHashOf）。
   * 文章改了、這個值對不上 → concepts:check 列為待複查。
   */
  sectionHash?: string;
  /** 那一節裡卡片依據的一句（去掉 Markdown 的原文，不超過 CONCEPT_QUOTE_MAX 字），用來找回段落、判斷段落還在不在。 */
  sourceQuote?: string;
}

export interface Concept {
  id: string;
  article: ConceptArticle;
  情境: string;
  觀念: string;
  應用: string;
  tags: ConceptTags;
  evidence: ConceptEvidence | null;
}

export interface ConceptBank {
  version: number;
  site: string;
  concepts: Concept[];
  /** 退役的卡 id（主控台 retire；不再重複使用，免得外部的 #concepts=<id> 連到別張卡）。 */
  retired?: string[];
}

// ─── 載入與檢查 ───────────────────────────────────────────────────────────

const ROUND_RE = /^(?:[1-5]-(?:[1-5]|\*)|A|any)$/;
const SCORE_RE = /^[0-3]:[0-3]$/;
export const CONCEPT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === 'string');
}

/** 一句話的問題（空字串 = 沒問題）。 */
export function sentenceProblem(text: unknown): string {
  if (typeof text !== 'string' || text.trim() === '') return 'empty';
  if (text !== text.trim()) return 'surrounding whitespace';
  if (Array.from(text).length > CONCEPT_SENTENCE_MAX) return `longer than ${CONCEPT_SENTENCE_MAX}`;
  if (!text.endsWith('。')) return 'must end with 。';
  if (/[。！？!?\n]/.test(text.slice(0, -1))) return 'more than one sentence';
  if (/\d\s+家/.test(text)) return 'seat written with a space (use N家)';
  // 座位一律一個一個寫（「5家、0家」），不寫「50」「147」這種連號，10 號位也寫 0家；百分比、小數不算。
  if (/(?<![\d.])\d{2,}(?![\d.%])/.test(text)) return 'run of digits (write seats as N家, seat 10 as 0家)';
  return '';
}

/** 檢查整個卡庫的格式（不看文章存不存在，那個在測試裡對 wiki_data.json）。 */
export function conceptProblems(bank: unknown): string[] {
  const out: string[] = [];
  const b = bank as Partial<ConceptBank> | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.concepts)) return ['concepts must be an array'];
  if (typeof b.site !== 'string' || !/^https:\/\//.test(b.site)) out.push('site must be an https URL');
  if (b.retired !== undefined && !isStringArray(b.retired)) out.push('retired must be an array of ids');
  const retired = new Set(isStringArray(b.retired) ? b.retired : []);
  const seen = new Set<string>();
  b.concepts.forEach((c: Partial<Concept>, i) => {
    const at = `#${i} ${c?.id ?? '?'}`;
    if (typeof c?.id !== 'string' || !CONCEPT_ID_RE.test(c.id)) out.push(`${at}: bad id`);
    else if (seen.has(c.id)) out.push(`${at}: duplicate id`);
    else if (retired.has(c.id)) out.push(`${at}: id was retired`);
    else seen.add(c.id);
    for (const part of CONCEPT_PARTS) {
      const p = sentenceProblem(c?.[part]);
      if (p) out.push(`${at}: ${part} ${p}`);
    }
    const a = c?.article;
    if (!a || typeof a.slug !== 'string' || typeof a.title !== 'string' || typeof a.url !== 'string' || typeof a.shareUrl !== 'string') {
      out.push(`${at}: article needs slug, title, url, shareUrl`);
    } else {
      if (a.section !== undefined && (typeof a.section !== 'string' || a.section === '')) {
        out.push(`${at}: article.section must be a non-empty string when present`);
      }
      if (!/^https:\/\//.test(a.url) || !/^https:\/\//.test(a.shareUrl)) out.push(`${at}: article urls must be https`);
      if (a.sectionHash !== undefined && (typeof a.sectionHash !== 'string' || !SECTION_HASH_RE.test(a.sectionHash))) {
        out.push(`${at}: article.sectionHash must be 12 hex characters`);
      }
      if (
        a.sourceQuote !== undefined &&
        (typeof a.sourceQuote !== 'string' || a.sourceQuote.trim() === '' || a.sourceQuote !== a.sourceQuote.trim() || Array.from(a.sourceQuote).length > CONCEPT_QUOTE_MAX)
      ) {
        out.push(`${at}: article.sourceQuote must be a trimmed string of 1..${CONCEPT_QUOTE_MAX} characters`);
      }
    }
    if (c?.evidence !== null && !CONCEPT_EVIDENCE.includes(c?.evidence as ConceptEvidence)) out.push(`${at}: bad evidence`);
    const t = c?.tags;
    if (!t || typeof t !== 'object') {
      out.push(`${at}: tags missing`);
      return;
    }
    if (!isStringArray(t.decision) || t.decision.length === 0 || !t.decision.every((d) => CONCEPT_DECISIONS.includes(d as ConceptDecision))) {
      out.push(`${at}: tags.decision must be non-empty, from ${CONCEPT_DECISIONS.join('/')}`);
    }
    if (!isStringArray(t.round) || t.round.length === 0 || !t.round.every((r) => ROUND_RE.test(r))) out.push(`${at}: bad tags.round`);
    if (!CONCEPT_PHASES.includes(t.phase as ConceptPhase)) out.push(`${at}: tags.phase must be one of ${CONCEPT_PHASES.join('/')}`);
    if (
      t.role !== undefined &&
      (!isStringArray(t.role) || t.role.length === 0 || new Set(t.role).size !== t.role.length || !t.role.every((r) => CONCEPT_ROLE_TAGS.includes(r as ConceptRoleTag)))
    ) {
      out.push(`${at}: tags.role must be non-empty, unique, from ${CONCEPT_ROLE_TAGS.join('/')}`);
    }
    if (t.roles !== undefined && (!isStringArray(t.roles) || t.roles.length === 0 || !t.roles.every((r) => CONCEPT_ROLES.includes(r as Role)))) {
      out.push(`${at}: bad tags.roles`);
    }
    if (t.seats !== undefined && (!Array.isArray(t.seats) || t.seats.length === 0 || !t.seats.every((s) => Number.isInteger(s) && s >= 1 && s <= 10))) {
      out.push(`${at}: bad tags.seats (1..10)`);
    }
    if (t.score !== undefined && (!isStringArray(t.score) || t.score.length === 0 || !t.score.every((s) => SCORE_RE.test(s)))) out.push(`${at}: bad tags.score`);
    for (const k of ['lakeHolder', 'lastQuestMember'] as const) {
      if (t[k] !== undefined && typeof t[k] !== 'boolean') out.push(`${at}: tags.${k} must be boolean`);
    }
    if (t.lastQuestFails !== undefined && (!Array.isArray(t.lastQuestFails) || !t.lastQuestFails.every((n) => Number.isInteger(n) && n >= 0 && n <= 5))) {
      out.push(`${at}: bad tags.lastQuestFails`);
    }
    if (t.thumbsLed !== undefined && (!Array.isArray(t.thumbsLed) || t.thumbsLed.length === 0 || !t.thumbsLed.every((n) => n === 0 || n === 1 || n === 2))) {
      out.push(`${at}: bad tags.thumbsLed (0..2)`);
    }
  });
  return out;
}

/**
 * 由決策與局推階段：有刺殺 → 刺殺；沒有派隊 → 投票・湖中・出任務；派隊而 round 有 any → 通用；
 * 都在第 3～5 局 → 第三～五局派隊；跨了三局以上 → 通用；其他歸最早的那一局（第一局／第二局派隊）。
 */
export function conceptPhaseOf(tags: Pick<ConceptTags, 'decision' | 'round'>): ConceptPhase {
  if (tags.decision.includes('刺殺')) return '刺殺';
  if (!tags.decision.includes('派隊')) return '投票・湖中・出任務';
  if (tags.round.includes('any')) return '通用';
  const rounds = new Set(tags.round.map((r) => Number(r[0])).filter((n) => n >= 1 && n <= 5));
  if (rounds.size === 0) return '通用';
  const first = Math.min(...rounds);
  if (first >= 3) return '第三～五局派隊';
  if (rounds.size >= 3) return '通用';
  return first === 1 ? '第一局派隊' : '第二局派隊';
}

/** 讀卡庫：格式不對就丟錯（卡庫是 commit 進 repo 的檔案，壞了應該在測試就擋下）。 */
export function loadConceptBank(raw: unknown = CONCEPTS_FILE): ConceptBank {
  const problems = conceptProblems(raw);
  if (problems.length) throw new Error(`concepts.json: ${problems.slice(0, 5).join('; ')}`);
  return raw as ConceptBank;
}

let cached: ConceptBank | null = null;

/** 卡庫（第一次用時檢查一次）。 */
export function conceptBank(): ConceptBank {
  cached ??= loadConceptBank();
  return cached;
}

// ─── 題目 → 配對條件 ─────────────────────────────────────────────────────

/** 一道題目在配對時看的東西（都只用出題當下公開或那一家自己知道的資訊）。 */
export interface ConceptExercise {
  decision: ConceptDecision;
  /** 派票題：第幾局、第幾次；刺殺題都是 null。 */
  round: number | null;
  attempt: number | null;
  seat: number;
  role: Role;
  /** 這一局開始前的比分「藍:紅」（刺殺題是整局的）。 */
  score: string;
  /** 這一局結束後由他用湖中。 */
  lakeHolder: boolean;
  /** 他在上一局出任務的隊上；第一局 null。 */
  lastQuestMember: boolean | null;
  /** 上一局的失敗張數；第一局 null。 */
  lastQuestFails: number | null;
  /** 派西維爾的題：兩根拇指在這一題之前已經有幾根當過隊長；不是派西的派票題是 null。 */
  thumbsLed: number | null;
}

/** 第 round 局結束後用湖中的人：開局在 0家（10），之後是上一次被湖的人；有紀錄就用紀錄。 */
export function lakeHolderOf(game: SimGame, round: number): number | null {
  if (round < 2 || round > 4) return null;
  const rec = game.lakes.find((l) => l.round === round);
  if (rec) return rec.holderSeat;
  let holder = 10;
  for (let r = 2; r < round; r++) {
    const l = game.lakes.find((x) => x.round === r);
    if (!l) return null;
    holder = l.targetSeat;
  }
  return holder;
}

function scoreBefore(game: SimGame, round: number): string {
  const done = game.quests.filter((q) => q.round < round);
  const red = done.filter((q) => q.failed).length;
  return `${done.length - red}:${red}`;
}

/** 題庫的一個決定 → 配對條件。proposal = proposals[] 的索引；刺殺題是 null（seat = 刺客）。 */
export function exerciseOf(game: SimGame, proposal: number | null, seat: number): ConceptExercise {
  const role = game.seatRoles[seat - 1];
  if (proposal === null) {
    return {
      decision: '刺殺', round: null, attempt: null, seat, role, score: scoreBefore(game, 6),
      lakeHolder: false, lastQuestMember: null, lastQuestFails: null, thumbsLed: null,
    };
  }
  const p = game.proposals[proposal];
  const last = game.quests.find((q) => q.round === p.round - 1);
  const sight = sightFor(game, seat);
  let thumbsLed: number | null = null;
  if (sight.kind === 'percival') {
    const leaders = new Set(game.proposals.filter((x) => x.globalIndex < p.globalIndex).map((x) => x.leaderSeat));
    thumbsLed = sight.thumbs.filter((t) => leaders.has(t)).length;
  }
  return {
    decision: '派隊',
    round: p.round,
    attempt: p.attempt,
    seat,
    role,
    score: scoreBefore(game, p.round),
    lakeHolder: lakeHolderOf(game, p.round) === seat,
    lastQuestMember: last ? last.teamSeats.includes(seat) : null,
    lastQuestFails: last ? last.failCount : null,
    thumbsLed,
  };
}

/** Threads 的題目 → 配對條件。 */
export function exerciseOfPick(game: SimGame, pick: Pick<ThreadsPick, 'proposal' | 'seat'>): ConceptExercise {
  return exerciseOf(game, pick.proposal, pick.seat);
}

// ─── 配對 ────────────────────────────────────────────────────────────────

export interface ConceptMatch {
  concept: Concept;
  /** 越大越貼近這一題。 */
  score: number;
  /** 局面配對到的是「局-次」（刺殺題的 A）、「局-*」還是 any。 */
  roundMatch: 'exact' | 'round' | 'any';
}

/** 一張卡跟一道題目合不合（不合是 null）與貼近程度。 */
export function matchConcept(c: Concept, ex: ConceptExercise): ConceptMatch | null {
  const t = c.tags;
  if (!t.decision.includes(ex.decision)) return null;
  let roundMatch: ConceptMatch['roundMatch'];
  if (t.round.includes(ex.round === null ? 'A' : `${ex.round}-${ex.attempt}`)) roundMatch = 'exact';
  else if (ex.round !== null && t.round.includes(`${ex.round}-*`)) roundMatch = 'round';
  else if (t.round.includes('any')) roundMatch = 'any';
  else return null;
  let score = { exact: 3, round: 2, any: 1 }[roundMatch];
  if (t.roles) {
    if (!t.roles.includes(ex.role)) return null;
    score += t.roles.length === 1 ? 3 : t.roles.length <= 3 ? 2 : 1;
  }
  if (t.seats) {
    if (!t.seats.includes(ex.seat)) return null;
    score += 2;
  }
  if (t.score) {
    if (!t.score.includes(ex.score)) return null;
    score += 2;
  }
  if (t.lakeHolder !== undefined) {
    if (t.lakeHolder !== ex.lakeHolder) return null;
    score += 1;
  }
  if (t.lastQuestMember !== undefined) {
    if (ex.lastQuestMember === null || t.lastQuestMember !== ex.lastQuestMember) return null;
    score += 1;
  }
  if (t.lastQuestFails !== undefined) {
    if (ex.lastQuestFails === null || !t.lastQuestFails.includes(ex.lastQuestFails)) return null;
    score += 2;
  }
  if (t.thumbsLed !== undefined) {
    if (ex.thumbsLed === null || !t.thumbsLed.includes(ex.thumbsLed)) return null;
    score += 2;
  }
  return { concept: c, score, roundMatch };
}

export interface ConceptsForOptions {
  /** 最多幾張（預設 3）。 */
  limit?: number;
  /** 同一篇文章只取最貼近的一張（預設 true，讓留言可以附不同文章）。 */
  distinctArticles?: boolean;
  /** 只要局面有對到「局-次」「局-*」或 A 的卡（不收 any 的通則卡）。 */
  specificOnly?: boolean;
  /** 換一份卡庫（測試用）。 */
  concepts?: readonly Concept[];
}

/** 所有合的卡，最貼近的在前（同分照卡庫順序）。 */
export function conceptMatches(ex: ConceptExercise, concepts: readonly Concept[] = conceptBank().concepts): ConceptMatch[] {
  const out: { m: ConceptMatch; i: number }[] = [];
  concepts.forEach((c, i) => {
    const m = matchConcept(c, ex);
    if (m) out.push({ m, i });
  });
  return out.sort((a, b) => b.m.score - a.m.score || a.i - b.i).map((x) => x.m);
}

/** 一道題目最適合的觀念卡（附文章連結），最貼近的在前。 */
export function conceptsFor(ex: ConceptExercise, opts: ConceptsForOptions = {}): Concept[] {
  const limit = opts.limit ?? 3;
  const distinct = opts.distinctArticles ?? true;
  const used = new Set<string>();
  const out: Concept[] = [];
  for (const m of conceptMatches(ex, opts.concepts)) {
    if (out.length >= limit) break;
    if (opts.specificOnly && m.roundMatch === 'any') continue;
    if (distinct && used.has(m.concept.article.slug)) continue;
    used.add(m.concept.article.slug);
    out.push(m.concept);
  }
  return out;
}

