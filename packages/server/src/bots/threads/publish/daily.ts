/**
 * Threads 每日自動發佈（站長 2026-11-17 親口同意「threads 自動發佈」）。
 *
 * 分三段，讓 CI 在兩段之間把圖推上公開網址：
 *   1. prepare：產生今天的草稿、圖、第一則留言，檢查內容，寫出 plan.json。
 *   2. post：（只在正式發佈時）找昨天的貼文 id → 發 A（引用昨天）→ 先記下 A 的 id → 發第一則留言 → 記下網址。
 *   3. recordManual：站長手動發的那一天（例如 11/17）補記貼文 id，隔天才引用得到。
 *
 * 不會重複發：狀態檔（threads-state 分支的 state/<日期>.json）有貼文 id 就跳過；
 * 沒有的話再查自己最近的貼文裡有沒有「題號 <今天的題號>」（上次發了卻沒記下來）。
 * 權杖只在 post 段用，不寫進任何檔案。
 */

import fs from 'fs';
import path from 'path';
import type { ThreadsDraft } from '../draft';
import { THREADS_MAX_CHARS, THREADS_TOPIC_TAG } from '../draft';
import type { ThreadsGenerator } from '../generate';
import { addDays, exerciseIdOfPick } from '../plan';
import type { ThreadsApi, RecentPost } from './threadsApi';
import { INSTAGRAM_CAPTION_MAX, type InstagramApi, type RecentMedia } from './instagramApi';

// ─── 站長選的題（threads_picks.json） ───────────────────────────────────────

/** `packages/server/threads_picks.json`：{ "version": 1, "picks": { "YYYY-MM-DD": "題號" } }。 */
export interface ThreadsPicksFile {
  version: 1;
  picks: Record<string, string>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXERCISE_RE = /^[0-9A-Z]{5}-(?:A|\d-\d)$/;

/** 讀選題檔；格式不對的行略過（原因放進 warnings）。檔案不存在＝沒有選題。 */
export function readPicks(file: string, warnings: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(file)) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    warnings.push(`threads_picks.json 讀不進來（${(err as Error).message}），全部照計畫`);
    return out;
  }
  const picks = (raw as { picks?: unknown })?.picks;
  if (!picks || typeof picks !== 'object') return out;
  for (const [date, ex] of Object.entries(picks as Record<string, unknown>)) {
    if (DATE_RE.test(date) && typeof ex === 'string' && EXERCISE_RE.test(ex)) out.set(date, ex);
    else warnings.push(`threads_picks.json：${date} → ${String(ex)} 格式不對，略過`);
  }
  return out;
}

// ─── 狀態（threads-state 分支） ─────────────────────────────────────────────

export interface ThreadsStateRecord {
  date: string;
  exerciseId: string;
  /** 當天實際用的草稿（之後的日子靠它算「昨天的答案」，題庫更新也不會換題）。 */
  draft: ThreadsDraft;
  /** auto＝這條管線發的；manual＝站長手動發、事後補記。 */
  source: 'auto' | 'manual';
  postId: string | null;
  permalink?: string;
  quotePostId?: string | null;
  commentId?: string | null;
  publishedAt?: string;
  /** Instagram 同步（有開才有）。 */
  ig?: { mediaId: string; permalink?: string; publishedAt?: string };
}

export function statePath(stateDir: string, date: string): string {
  return path.join(stateDir, 'state', `${date}.json`);
}

export function readState(stateDir: string, date: string): ThreadsStateRecord | null {
  const f = statePath(stateDir, date);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as ThreadsStateRecord;
  } catch {
    return null;
  }
}

export function writeState(stateDir: string, rec: ThreadsStateRecord): void {
  const f = statePath(stateDir, rec.date);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(rec, null, 2)}\n`);
}

/** 給 ThreadsGenerator 的 readSaved：已經發過（或補記過）的日子沿用當天的草稿。 */
export function savedFromState(stateDir: string): (date: string) => ThreadsDraft | null {
  return (date) => readState(stateDir, date)?.draft ?? null;
}

// ─── 第一則留言（ChatGPT 寫在 docs/threads/comments/<日期>.md） ──────────────

export function commentPath(commentsDir: string, date: string): string {
  return path.join(commentsDir, `${date}.md`);
}

/** 讀 ChatGPT 寫的留言：整個檔案就是留言內容；`<!-- -->` 註解拿掉。沒有檔案回 null。 */
export function readComment(commentsDir: string, date: string): string | null {
  const f = commentPath(commentsDir, date);
  if (!fs.existsSync(f)) return null;
  const text = fs
    .readFileSync(f, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  return text || null;
}

/** 沒有 ChatGPT 的留言時的備案：一句觀念＋建議文章的網址（不提今天的答案）。 */
export function fallbackComment(draft: ThreadsDraft): string {
  const topics = draft.firstComment.tags.slice(0, 3).join('、');
  const url = draft.firstComment.articles[0]?.url ?? 'https://avalon-game-platform.web.app/';
  return `今天這題跟「${topics}」有關，觀念整理在這篇：\n${url}`;
}

// ─── 內容檢查 ───────────────────────────────────────────────────────────────

/** 玩家名字（只拿來擋，不輸出）：games_cache.json 的 players 加上 player_aliases.json 兩邊。 */
export function loadPlayerNames(serverRoot: string): string[] {
  const names = new Set<string>();
  try {
    const g = JSON.parse(fs.readFileSync(path.join(serverRoot, 'games_cache.json'), 'utf8')) as { players?: unknown };
    if (Array.isArray(g.players)) for (const n of g.players) if (typeof n === 'string') names.add(n);
  } catch {
    /* 沒有快取就只用別名 */
  }
  try {
    const a = JSON.parse(fs.readFileSync(path.join(serverRoot, 'player_aliases.json'), 'utf8')) as { aliases?: Record<string, string> };
    for (const [k, v] of Object.entries(a.aliases ?? {})) {
      names.add(k);
      names.add(v);
    }
  } catch {
    /* ignore */
  }
  return [...names];
}

function nameHit(text: string, name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (/^[\x20-\x7e]+$/.test(n)) {
    // 英數名字：3 個字以上、整個字比對（避免 ED、JOY 撞到一般字）。
    if (n.length < 3 || /^\d+$/.test(n)) return false;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, 'i').test(text);
  }
  // 中文名字：2 個字以上才比（單字名字太容易撞到一般用字）。
  return [...n].length >= 2 && text.includes(n);
}

/** 發文前的檢查；回傳問題清單（空＝可以發）。訊息不含名字本身（CI 紀錄是公開的）。 */
export function validatePost(input: { text: string; comment: string; names?: readonly string[] }): string[] {
  const errors: string[] = [];
  const { text, comment } = input;
  const chars = [...text].length;
  if (chars > THREADS_MAX_CHARS) errors.push(`貼文 ${chars} 字，超過 ${THREADS_MAX_CHARS}`);
  if (chars === 0) errors.push('貼文是空的');
  const lines = text.split('\n');
  const tagLines = lines.filter((l) => l.trim() === THREADS_TOPIC_TAG).length;
  if (tagLines !== 1 || lines[lines.length - 1].trim() !== THREADS_TOPIC_TAG) errors.push(`貼文要剛好一行 ${THREADS_TOPIC_TAG}、放在最後一行`);
  const commentChars = [...comment].length;
  if (commentChars === 0) errors.push('第一則留言是空的');
  if (commentChars > THREADS_MAX_CHARS) errors.push(`第一則留言 ${commentChars} 字，超過 ${THREADS_MAX_CHARS}`);
  for (const [label, t] of [
    ['貼文', text],
    ['第一則留言', comment],
  ] as const) {
    if (/10\s*[家號]/.test(t)) errors.push(`${label}把第十個座位寫成兩位數，要寫「0 家」`);
    if ((input.names ?? []).some((n) => nameHit(t, n))) errors.push(`${label}含疑似玩家名字（不列出名字）`);
  }
  return errors;
}

// ─── prepare ────────────────────────────────────────────────────────────────

export interface DailyPlan {
  date: string;
  exerciseId: string;
  text: string;
  chars: number;
  comment: string;
  commentSource: 'chatgpt' | 'fallback';
  /** 圖檔（out 資料夾裡的檔名）；沒有圖是 null。 */
  image: string | null;
  /** 要引用的昨天貼文；第一天是 null。postId 沒記到的話 post 段會去自己最近的貼文裡找。 */
  quote: { date: string; exerciseId: string; postId: string | null } | null;
  /** 已經發過了（狀態檔有貼文 id）：post 段什麼都不做。 */
  alreadyPublished: boolean;
  errors: string[];
  warnings: string[];
  draft: ThreadsDraft;
}

export interface PrepareDeps {
  gen: ThreadsGenerator;
  stateDir: string;
  commentsDir: string;
  outDir: string;
  names?: readonly string[];
  /** 畫圖（pv → PNG）；不給就不附圖。 */
  renderImage?: (date: string) => Buffer | null;
  warnings?: string[];
}

export function prepareDaily(date: string, deps: PrepareDeps): DailyPlan | null {
  const warnings = [...(deps.warnings ?? [])];
  const existing = readState(deps.stateDir, date);
  let image: string | null = null;
  if (deps.renderImage) {
    try {
      const png = deps.renderImage(date);
      if (png) {
        fs.mkdirSync(deps.outDir, { recursive: true });
        image = `${date}.png`;
        fs.writeFileSync(path.join(deps.outDir, image), png);
      }
    } catch (err) {
      warnings.push(`圖沒有產生（${(err as Error).message}），只發文字`);
    }
  }
  const draft = deps.gen.draftFor(date, image ? { image } : {});
  if (!draft) return null;
  warnings.push(...deps.gen.warnings);

  const chatgpt = readComment(deps.commentsDir, date);
  if (!chatgpt) warnings.push(`沒有 ChatGPT 寫的留言（${path.basename(deps.commentsDir)}/${date}.md），用備案`);
  const comment = chatgpt ?? fallbackComment(draft);

  let quote: DailyPlan['quote'] = null;
  if (draft.quoteYesterday) {
    const yDate = addDays(date, -1);
    const yState = readState(deps.stateDir, yDate);
    const yPick = deps.gen.pickFor(yDate);
    const yGame = yPick ? deps.gen.gameOf(yPick.gameId) : null;
    const yEx = yState?.exerciseId ?? draft.answerToYesterday?.exerciseId ?? (yPick && yGame ? exerciseIdOfPick(yPick, yGame.game) : null);
    if (yEx) quote = { date: yDate, exerciseId: yEx, postId: yState?.postId ?? null };
  }

  const plan: DailyPlan = {
    date,
    exerciseId: draft.exerciseId,
    text: draft.post.text,
    chars: draft.post.chars,
    comment,
    commentSource: chatgpt ? 'chatgpt' : 'fallback',
    image,
    quote,
    alreadyPublished: !!existing?.postId,
    errors: validatePost({ text: draft.post.text, comment, names: deps.names }),
    warnings,
    draft: existing?.draft ?? draft,
  };
  fs.mkdirSync(deps.outDir, { recursive: true });
  fs.writeFileSync(path.join(deps.outDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

// ─── post ───────────────────────────────────────────────────────────────────

/** 自己最近的貼文裡找「題號 <題號>」那一篇。 */
export function findByExercise(posts: readonly RecentPost[], exerciseId: string): RecentPost | null {
  const needle = `題號 ${exerciseId}`;
  return posts.find((p) => (p.text ?? '').includes(needle)) ?? null;
}

export interface PostResult {
  status: 'published' | 'already-published' | 'found-existing';
  postId: string;
  permalink?: string;
  commentId?: string | null;
  quotePostId?: string | null;
  notes: string[];
}

export async function postDaily(plan: DailyPlan, deps: { api: ThreadsApi; stateDir: string; imageUrl?: string; now?: () => Date }): Promise<PostResult> {
  const notes: string[] = [];
  const now = deps.now ?? ((): Date => new Date());
  if (plan.errors.length > 0) throw new Error(`內容檢查沒過：${plan.errors.join('；')}`);
  const existing = readState(deps.stateDir, plan.date);
  if (existing?.postId) return { status: 'already-published', postId: existing.postId, permalink: existing.permalink, notes: ['狀態檔已經有這一天的貼文 id'] };

  const recent = await deps.api.recentPosts();
  const dup = findByExercise(recent, plan.exerciseId);
  if (dup) {
    writeState(deps.stateDir, { ...existing, date: plan.date, exerciseId: plan.exerciseId, draft: plan.draft, source: 'auto', postId: dup.id, permalink: dup.permalink, publishedAt: dup.timestamp });
    return { status: 'found-existing', postId: dup.id, permalink: dup.permalink, notes: ['自己最近的貼文裡已經有今天的題號，補記、不再發'] };
  }

  let quotePostId: string | null = plan.quote?.postId ?? null;
  if (plan.quote && !quotePostId) {
    const y = findByExercise(recent, plan.quote.exerciseId);
    if (y) {
      quotePostId = y.id;
      const yState = readState(deps.stateDir, plan.quote.date);
      if (yState) writeState(deps.stateDir, { ...yState, postId: y.id, permalink: y.permalink ?? yState.permalink });
      notes.push(`昨天（${plan.quote.date}）的貼文 id 從最近的貼文找到`);
    } else {
      notes.push(`找不到昨天（${plan.quote.date}，題號 ${plan.quote.exerciseId}）的貼文：這篇不引用`);
    }
  }

  if (plan.image && !deps.imageUrl) notes.push('有圖但沒有公開網址：只發文字');
  const postId = await deps.api.publishPost({ text: plan.text, ...(plan.image && deps.imageUrl ? { imageUrl: deps.imageUrl } : {}), ...(quotePostId ? { quotePostId } : {}) });
  // 先記下 A：留言失敗時重跑不會再發一次 A。
  // 同一天 IG 可能先發了（只開 IG 的時候）：保留狀態檔裡已有的欄位。
  const rec: ThreadsStateRecord = { ...existing, date: plan.date, exerciseId: plan.exerciseId, draft: plan.draft, source: 'auto', postId, quotePostId, commentId: null, publishedAt: now().toISOString() };
  writeState(deps.stateDir, rec);

  let commentId: string | null = null;
  try {
    commentId = await deps.api.publishReply({ text: plan.comment, replyToId: postId });
  } catch (err) {
    notes.push(`第一則留言沒發成功：${(err as Error).message}`);
  }
  const permalink = await deps.api.permalink(postId);
  writeState(deps.stateDir, { ...rec, commentId, ...(permalink ? { permalink } : {}) });
  return { status: 'published', postId, permalink, commentId, quotePostId, notes };
}

// ─── 手動發的那一天補記 ─────────────────────────────────────────────────────

export function recordManual(date: string, postId: string | null, deps: { gen: ThreadsGenerator; stateDir: string; permalink?: string }): ThreadsStateRecord | null {
  const draft = readState(deps.stateDir, date)?.draft ?? deps.gen.draftFor(date);
  if (!draft) return null;
  const rec: ThreadsStateRecord = { date, exerciseId: draft.exerciseId, draft, source: 'manual', postId, ...(deps.permalink ? { permalink: deps.permalink } : {}) };
  writeState(deps.stateDir, rec);
  return rec;
}

// ─── Instagram 同步 ─────────────────────────────────────────────────────────

/**
 * IG 的貼文說明：Threads 那篇的文字（IG 沒有引用貼文，昨天的答案照樣寫在裡面），
 * 後面接第一則留言（觀念＋文章網址；IG 說明裡的網址不能點，照純文字放）。#阿瓦隆 放最後一行。
 */
export function igCaption(plan: Pick<DailyPlan, 'text' | 'comment'>): string {
  const body = plan.text
    .split('\n')
    .filter((l) => l.trim() !== THREADS_TOPIC_TAG)
    .join('\n')
    .trimEnd();
  const caption = `${body}\n\n${plan.comment.trim()}\n\n${THREADS_TOPIC_TAG}`;
  return [...caption].length <= INSTAGRAM_CAPTION_MAX ? caption : `${body}\n\n${THREADS_TOPIC_TAG}`;
}

/** 自己最近的 IG 貼文裡找「題號 <題號>」那一篇。 */
export function findMediaByExercise(media: readonly RecentMedia[], exerciseId: string): RecentMedia | null {
  const needle = `題號 ${exerciseId}`;
  return media.find((m) => (m.caption ?? '').includes(needle)) ?? null;
}

export interface IgResult {
  status: 'published' | 'already-published' | 'found-existing' | 'skipped';
  mediaId?: string;
  permalink?: string;
  notes: string[];
}

/** 狀態檔沒有這一天時（例如只開了 IG）先建一筆，Threads 那邊之後照樣能發。 */
function stateOrNew(stateDir: string, plan: DailyPlan): ThreadsStateRecord {
  return readState(stateDir, plan.date) ?? { date: plan.date, exerciseId: plan.exerciseId, draft: plan.draft, source: 'auto', postId: null };
}

export async function postInstagram(plan: DailyPlan, deps: { api: InstagramApi; stateDir: string; imageUrls: readonly string[]; now?: () => Date }): Promise<IgResult> {
  const now = deps.now ?? ((): Date => new Date());
  if (plan.errors.length > 0) throw new Error(`內容檢查沒過：${plan.errors.join('；')}`);
  const existing = readState(deps.stateDir, plan.date);
  if (existing?.ig?.mediaId) return { status: 'already-published', mediaId: existing.ig.mediaId, permalink: existing.ig.permalink, notes: ['狀態檔已經有這一天的 IG 貼文'] };
  if (deps.imageUrls.length === 0) return { status: 'skipped', notes: ['沒有圖：IG 不能只發文字，這天不同步'] };

  const dup = findMediaByExercise(await deps.api.recentMedia(), plan.exerciseId);
  if (dup) {
    writeState(deps.stateDir, { ...stateOrNew(deps.stateDir, plan), ig: { mediaId: dup.id, permalink: dup.permalink, publishedAt: dup.timestamp } });
    return { status: 'found-existing', mediaId: dup.id, permalink: dup.permalink, notes: ['IG 最近的貼文裡已經有今天的題號，補記、不再發'] };
  }
  const mediaId = await deps.api.publish({ imageUrls: deps.imageUrls, caption: igCaption(plan) });
  writeState(deps.stateDir, { ...stateOrNew(deps.stateDir, plan), ig: { mediaId, publishedAt: now().toISOString() } });
  const permalink = await deps.api.permalink(mediaId);
  if (permalink) writeState(deps.stateDir, { ...stateOrNew(deps.stateDir, plan), ig: { mediaId, permalink, publishedAt: now().toISOString() } });
  return { status: 'published', mediaId, permalink, notes: deps.imageUrls.length > 1 ? [`輪播 ${deps.imageUrls.length} 張`] : [] };
}
