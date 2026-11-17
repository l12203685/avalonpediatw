/**
 * Threads 每日自動發佈（站長 2026-11-17 親口同意「threads 自動發佈」）。
 *
 * 分三段，讓 CI 在兩段之間把圖推上公開網址：
 *   1. prepare：產生今天的草稿、圖、第一則留言，檢查內容，寫出 plan.json。
 *   2. post：（只在正式發佈時）找昨天的貼文 id → 發 A（引用昨天）→ 先記下 A 的 id → 發第一則留言 → 記下網址。
 *   3. recordManual：站長手動發的那一天（例如 11/17）補記貼文 id，隔天才引用得到。
 *
 * 不會重複發：狀態檔（threads-state 分支的 state/<日期>.json）有貼文 id 就不再發 A；
 * 沒有的話再查自己最近的貼文裡有沒有「題號 <今天的題號>」（上次發了卻沒記下來）。
 * A 發了、第一則留言沒成功（狀態檔 commentId 是 null）的話，之後的執行只補發留言。
 * 每次真的發出東西就馬上把狀態檔推上去（checkpoint）；發佈的回應不明時先查是不是已經發了（threadsApi）；
 * 發留言前先查自己的回覆裡有沒有回這一篇的，有就沿用。
 * 內容檢查沒過時，plan.json 不放貼文、留言的內容（CI 的附件是公開的），只放檢查訊息。
 * 權杖只在 post 段用，不寫進任何檔案。
 */

import fs from 'fs';
import path from 'path';
import type { ThreadsDraft } from '../draft';
import { SEE_IMAGE_LINE, THREADS_MAX_CHARS, THREADS_TOPIC_TAG } from '../draft';
import type { ThreadsGenerator } from '../generate';
import { addDays, exerciseIdOfPick, taipeiToday } from '../plan';
import type { ThreadsApi, RecentPost } from './threadsApi';
import { INSTAGRAM_CAPTION_MAX, INSTAGRAM_CAROUSEL_MAX, type InstagramApi, type RecentMedia } from './instagramApi';

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

/**
 * 這條管線發的（或從最近的貼文補記的）A 已經記下、第一則留言卻沒成功（commentId 明確記成 null）：之後的執行要補留言
 * （補之前先查自己的回覆，已經發了就沿用）。站長手動發的（commentId 沒有記）不補。
 */
export function needsCommentResume(rec: ThreadsStateRecord | null): boolean {
  return !!rec?.postId && rec.source === 'auto' && rec.commentId === null;
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
  /** 第一張圖（題目卡，out 資料夾裡的檔名）；沒有圖是 null。 */
  image: string | null;
  /** 全部的圖，照發文順序：題目卡、牌譜圖、答案卡（有幾張放幾張）。兩張以上發成輪播。 */
  images: string[];
  /** 要引用的昨天貼文；第一天是 null。postId 沒記到的話 post 段會去自己最近的貼文裡找。 */
  quote: { date: string; exerciseId: string; postId: string | null } | null;
  /** 已經發過了（狀態檔有貼文 id）：post 段不再發 A。 */
  alreadyPublished: boolean;
  /** A 發了、第一則留言還沒成功：post 段只補發留言。 */
  resumeComment: boolean;
  errors: string[];
  warnings: string[];
  /**
   * 正式發佈不能發的原因（null＝可以）：例如題目卡的牌譜太長、要第二張續圖，但這條管線只發一張圖，
   * 發出去會是不完整的題目、還叫人往右滑。試跑照常產生（摘要有警告），正式發時 post 段直接失敗、不發。
   */
  liveBlock?: string | null;
  draft: ThreadsDraft;
}

export interface PrepareDeps {
  gen: ThreadsGenerator;
  stateDir: string;
  commentsDir: string;
  outDir: string;
  names?: readonly string[];
  /** 畫題目卡（PNG）；不給就不附圖。 */
  renderImage?: (date: string) => Buffer | null;
  /** 題目卡之後的圖（照順序：牌譜圖、答案卡），檔名是 `<日期>-<suffix>.png`；沒有題目卡就不畫。 */
  /** png 是 null＝這張今天不用（例如牌譜放得進題目卡，就沒有續圖）。 */
  renderExtraImages?: (date: string, draft: ThreadsDraft) => { suffix: string; png: Buffer | null }[];
  /** 有圖的時候檢查：這張圖單獨發會不會不完整（回傳原因；null＝沒問題）。 */
  imageIncomplete?: (date: string, images: readonly string[]) => string | null;
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
  const images = image ? [image] : [];
  if (image && deps.renderExtraImages) {
    try {
      for (const extra of deps.renderExtraImages(date, draft)) {
        if (!extra.png) continue;
        const name = `${date}-${extra.suffix}.png`;
        fs.writeFileSync(path.join(deps.outDir, name), extra.png);
        images.push(name);
      }
    } catch (err) {
      warnings.push(`其他的圖沒有全部產生（${(err as Error).message}）`);
    }
  }

  // 要續圖時，續圖要一張不少地產生（images 裡的 -grid-<n>）；畫圖失敗、少了幾張才擋。
  let liveBlock = image && deps.imageIncomplete ? deps.imageIncomplete(date, images) : null;
  // 貼文的牌譜縮成「完整局面看圖」卻沒有圖：只發文字會是不完整的題目。
  if (!liveBlock && !image && draft.post.text.includes(SEE_IMAGE_LINE)) liveBlock = '貼文的牌譜寫「完整局面看圖」，但圖沒有產生';
  if (liveBlock) warnings.push(`${liveBlock}（試跑照常；正式發佈這天不發）`);

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
    images,
    quote,
    alreadyPublished: !!existing?.postId,
    liveBlock,
    resumeComment: needsCommentResume(existing),
    errors: validatePost({ text: draft.post.text, comment, names: deps.names }),
    warnings,
    draft: existing?.draft ?? draft,
  };
  fs.mkdirSync(deps.outDir, { recursive: true });
  fs.writeFileSync(path.join(deps.outDir, 'plan.json'), `${JSON.stringify(plan.errors.length > 0 ? rejectedPlan(plan) : plan, null, 2)}\n`);
  return plan;
}

/**
 * 內容檢查沒過的 plan 寫檔用：拿掉貼文、留言和草稿（可能就是含玩家名字而被擋下的內容；CI 的紀錄和附件是公開的），
 * 只留檢查訊息（訊息本身不含名字）。
 */
export function rejectedPlan(plan: DailyPlan): Omit<DailyPlan, 'text' | 'comment' | 'draft'> & { rejected: true } {
  const out: Partial<DailyPlan> & { rejected: true } = { ...plan, rejected: true };
  delete out.text;
  delete out.comment;
  delete out.draft;
  return out as Omit<DailyPlan, 'text' | 'comment' | 'draft'> & { rejected: true };
}

/**
 * prepare 印到 CI 紀錄與摘要的內容（Actions 的紀錄是公開的）。
 * 內容檢查沒過（例如疑似玩家名字）就只印檢查訊息，不印貼文和留言。
 */
export function planSummary(plan: DailyPlan, mode: string): string[] {
  const out: string[] = [];
  out.push(`## Threads ${plan.date}（${plan.draft.theme}）— ${mode}`);
  out.push('');
  out.push(`- 題號 ${plan.exerciseId}，貼文 ${plan.chars} 字，圖：${plan.images.length === 0 ? '沒有' : plan.images.length === 1 ? '1 張' : `${plan.images.length} 張（輪播：${plan.images.join('、')}）`}，第一則留言：${plan.commentSource === 'chatgpt' ? 'ChatGPT' : '備案'}`);
  out.push(`- 引用：${plan.quote ? `${plan.quote.date}（題號 ${plan.quote.exerciseId}，貼文 id ${plan.quote.postId ?? '還沒記到，發文時去最近的貼文找'}）` : '不引用（第一天）'}`);
  if (plan.alreadyPublished) out.push(plan.resumeComment ? '- 這一天的 A 已經發了、第一則留言還沒成功：只補發留言' : '- 這一天已經發過了：不會再發');
  for (const w of plan.warnings) out.push(`- ⚠️ ${w}`);
  for (const e of plan.errors) out.push(`- ❌ ${e}`);
  if (plan.errors.length > 0) {
    out.push('- 內容檢查沒過：不印出貼文和留言（plan.json 也不放內容）');
    return out;
  }
  out.push('', '### 貼文 A', '```', plan.text, '```', '### 第一則留言', '```', plan.comment, '```');
  return out;
}

// ─── post ───────────────────────────────────────────────────────────────────

/**
 * 用這些公開網址的圖發今天這篇，題目會不會不完整（回傳原因；null＝可以發）。Threads 和 IG 共用：
 * prepare 已經擋下的（liveBlock）、要續圖但不是每張圖都有網址、貼文寫「完整局面看圖」卻一張圖都沒有。
 */
export function imageProblem(plan: Pick<DailyPlan, 'liveBlock' | 'images' | 'image' | 'text'>, imageUrls: readonly string[]): string | null {
  if (plan.liveBlock) return plan.liveBlock;
  const images = plan.images ?? (plan.image ? [plan.image] : []);
  if (images.some((n) => /-grid(-\d+)?\.png$/.test(n)) && imageUrls.length < images.length) return `題目要續圖，但只有 ${imageUrls.length}／${images.length} 張圖有公開網址`;
  if (plan.text.includes(SEE_IMAGE_LINE) && imageUrls.length === 0) return '貼文的牌譜寫「完整局面看圖」，但圖沒有公開網址';
  return null;
}

/** API 的時間（例如 2026-11-18T04:00:00+0000）→ 台北日期；讀不懂回 null。 */
export function taipeiDateOf(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(ms) ? null : taipeiToday(ms);
}

/**
 * 自己最近的貼文裡找「題號 <題號>」那一篇。給 date 時只認那一天（台北）發的：
 * 站長可能選了之前某天發過的同一題，舊的那篇不能當成今天的（也不能當成昨天的引用）。
 */
export function findByExercise(posts: readonly RecentPost[], exerciseId: string, date?: string): RecentPost | null {
  const needle = `題號 ${exerciseId}`;
  return posts.find((p) => (p.text ?? '').includes(needle) && (date === undefined || taipeiDateOf(p.timestamp) === date)) ?? null;
}

export interface PostResult {
  status: 'published' | 'already-published' | 'found-existing' | 'comment-resumed';
  postId: string;
  permalink?: string;
  commentId?: string | null;
  quotePostId?: string | null;
  notes: string[];
}

export interface PostDeps {
  api: ThreadsApi;
  stateDir: string;
  imageUrl?: string;
  imageUrls?: readonly string[];
  now?: () => Date;
  /**
   * 每次真的發出東西（A、第一則留言）、寫好狀態檔之後馬上呼叫：CI 用它把狀態檔 commit＋push 上 threads-state，
   * 中途中斷也不會丟掉「已經發了」的紀錄。失敗只記進 notes（下一次靠最近的貼文和自己的回覆補記，不會重發）。
   */
  checkpoint?: (label: string) => Promise<void> | void;
}

async function saveCheckpoint(deps: PostDeps, rec: ThreadsStateRecord, label: string, notes: string[]): Promise<void> {
  writeState(deps.stateDir, rec);
  if (!deps.checkpoint) return;
  try {
    await deps.checkpoint(label);
  } catch (err) {
    notes.push(`狀態檔沒推上去（${label}）：${(err as Error).message}`);
  }
}

/**
 * 第一則留言：先查自己的回覆裡有沒有回這一篇的（上次發了卻沒記下來），有就沿用；沒有才發。
 * 查不到自己的回覆（例如權限不夠）就不發：寧可少一則留言，也不重複留言。
 */
async function ensureComment(plan: DailyPlan, postId: string, deps: PostDeps, notes: string[]): Promise<string | null> {
  // 這一篇底下自己帳號的回覆（照分頁翻完；翻不完會丟錯＝不發）
  const findMine = async (): Promise<string | null> => (await deps.api.findOwnReplyTo(postId))?.id ?? null;
  let existing: string | null;
  try {
    existing = await findMine();
  } catch (err) {
    notes.push(`查不到自己的回覆，第一則留言這次不發（下次再補）：${(err as Error).message}`);
    return null;
  }
  if (existing) {
    notes.push('第一則留言之前已經發了（自己的回覆裡找到），補記、不再發');
    return existing;
  }
  try {
    return await deps.api.publishReply({ text: plan.comment, replyToId: postId, find: findMine });
  } catch (err) {
    notes.push(`第一則留言沒發成功：${(err as Error).message}`);
    return null;
  }
}

export async function postDaily(plan: DailyPlan, deps: PostDeps): Promise<PostResult> {
  const notes: string[] = [];
  const now = deps.now ?? ((): Date => new Date());
  if (plan.errors.length > 0) throw new Error(`內容檢查沒過：${plan.errors.join('；')}`);
  const existing = readState(deps.stateDir, plan.date);
  if (existing?.postId && needsCommentResume(existing)) {
    // A 已經發了（不再發），上次第一則留言沒成功：只補留言（先查是不是其實已經發了）。
    const base = { postId: existing.postId, permalink: existing.permalink, quotePostId: existing.quotePostId ?? null };
    const commentId = await ensureComment(plan, existing.postId, deps, notes);
    if (!commentId) return { status: 'already-published', ...base, commentId: null, notes: [...notes, '第一則留言還是沒有（下次再補）'] };
    await saveCheckpoint(deps, { ...existing, commentId }, '第一則留言', notes);
    return { status: 'comment-resumed', ...base, commentId, notes: ['A 之前已經發了，這次補上第一則留言', ...notes] };
  }
  if (existing?.postId) return { status: 'already-published', postId: existing.postId, permalink: existing.permalink, notes: ['狀態檔已經有這一天的貼文 id'] };

  const recent = await deps.api.recentPosts();
  const dup = findByExercise(recent, plan.exerciseId, plan.date);
  if (dup) {
    // 上次發了卻沒記下來（例如狀態檔沒推上去就中斷）：補記 A，留言也先查再補。
    // 同一天 IG 可能先發了：保留狀態檔裡已有的欄位。
    const rec: ThreadsStateRecord = { ...existing, date: plan.date, exerciseId: plan.exerciseId, draft: plan.draft, source: 'auto', postId: dup.id, permalink: dup.permalink, commentId: null, publishedAt: dup.timestamp };
    await saveCheckpoint(deps, rec, 'A（補記）', notes);
    const commentId = await ensureComment(plan, dup.id, deps, notes);
    if (commentId) await saveCheckpoint(deps, { ...rec, commentId }, '第一則留言', notes);
    return { status: 'found-existing', postId: dup.id, permalink: dup.permalink, commentId, notes: ['自己最近的貼文裡已經有今天的題號，補記、不再發', ...notes] };
  }

  let quotePostId: string | null = plan.quote?.postId ?? null;
  if (plan.quote && !quotePostId) {
    const y = findByExercise(recent, plan.quote.exerciseId, plan.quote.date);
    if (y) {
      quotePostId = y.id;
      const yState = readState(deps.stateDir, plan.quote.date);
      if (yState) writeState(deps.stateDir, { ...yState, postId: y.id, permalink: y.permalink ?? yState.permalink });
      notes.push(`昨天（${plan.quote.date}）的貼文 id 從最近的貼文找到`);
    } else {
      notes.push(`找不到昨天（${plan.quote.date}，題號 ${plan.quote.exerciseId}）的貼文：這篇不引用`);
    }
  }

  const imageUrls = deps.imageUrls?.length ? [...deps.imageUrls] : deps.imageUrl ? [deps.imageUrl] : [];
  const wanted = plan.images?.length ?? (plan.image ? 1 : 0);
  if (wanted > 0 && imageUrls.length === 0) notes.push('有圖但沒有公開網址：只發文字');
  else if (imageUrls.length > 0 && imageUrls.length < wanted) notes.push(`只有 ${imageUrls.length}／${wanted} 張圖有公開網址`);
  if (imageUrls.length > 1) notes.push(`輪播 ${imageUrls.length} 張`);
  // 題目不完整（少了續圖、要看圖卻沒有圖）就不發（fail closed）。補留言、補記不受影響。
  const missing = imageProblem(plan, imageUrls);
  if (missing) throw new Error(`這天不自動發：${missing}`);
  const postId = await deps.api.publishPost({
    text: plan.text,
    imageUrls,
    ...(quotePostId ? { quotePostId } : {}),
    // 回應不明時：自己最近的貼文裡有今天的題號就是已經發了
    find: async () => findByExercise(await deps.api.recentPosts(), plan.exerciseId, plan.date)?.id ?? null,
  });
  // 先記下 A（並推上去）：留言失敗或中斷時重跑不會再發一次 A。
  // 同一天 IG 可能先發了（只開 IG 的時候）：保留狀態檔裡已有的欄位。
  const rec: ThreadsStateRecord = { ...existing, date: plan.date, exerciseId: plan.exerciseId, draft: plan.draft, source: 'auto', postId, quotePostId, commentId: null, publishedAt: now().toISOString() };
  await saveCheckpoint(deps, rec, 'A', notes);

  // 留言一發成功就記下（並推上去）：之後查網址失敗或中斷，下一次也不會以為留言沒發、再留一次。
  const commentId = await ensureComment(plan, postId, deps, notes);
  if (commentId) await saveCheckpoint(deps, { ...rec, commentId }, '第一則留言', notes);
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
/** IG 最近的貼文裡找「題號 <題號>」那一篇；給 date 時只認那一天（台北）發的（同一題之前發過的舊貼文不算）。 */
export function findMediaByExercise(media: readonly RecentMedia[], exerciseId: string, date?: string): RecentMedia | null {
  const needle = `題號 ${exerciseId}`;
  return media.find((m) => (m.caption ?? '').includes(needle) && (date === undefined || taipeiDateOf(m.timestamp) === date)) ?? null;
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

export async function postInstagram(
  plan: DailyPlan,
  deps: { api: InstagramApi; stateDir: string; imageUrls: readonly string[]; now?: () => Date; checkpoint?: (label: string) => Promise<void> | void },
): Promise<IgResult> {
  const now = deps.now ?? ((): Date => new Date());
  if (plan.errors.length > 0) throw new Error(`內容檢查沒過：${plan.errors.join('；')}`);
  const existing = readState(deps.stateDir, plan.date);
  if (existing?.ig?.mediaId) return { status: 'already-published', mediaId: existing.ig.mediaId, permalink: existing.ig.permalink, notes: ['狀態檔已經有這一天的 IG 貼文'] };
  if (deps.imageUrls.length === 0) return { status: 'skipped', notes: ['沒有圖：IG 不能只發文字，這天不同步'] };
  // IG 輪播最多 10 張：牌譜分太多張時 IG 這天不同步（不截掉，免得少了續圖或答案卡；Threads 照發）。
  const igCount = Math.max(deps.imageUrls.length, plan.images?.length ?? 0);
  if (igCount > INSTAGRAM_CAROUSEL_MAX) return { status: 'skipped', notes: [`IG 這天不同步：圖有 ${igCount} 張，IG 輪播最多 ${INSTAGRAM_CAROUSEL_MAX} 張`] };
  // 題目不完整（prepare 擋下的、少了續圖的網址）：IG 這天不同步（只記原因，不影響 Threads）。
  const missing = imageProblem(plan, deps.imageUrls);
  if (missing) return { status: 'skipped', notes: [`IG 這天不同步：${missing}`] };

  const dup = findMediaByExercise(await deps.api.recentMedia(), plan.exerciseId, plan.date);
  if (dup) {
    writeState(deps.stateDir, { ...stateOrNew(deps.stateDir, plan), ig: { mediaId: dup.id, permalink: dup.permalink, publishedAt: dup.timestamp } });
    return { status: 'found-existing', mediaId: dup.id, permalink: dup.permalink, notes: ['IG 最近的貼文裡已經有今天的題號，補記、不再發'] };
  }
  const notes: string[] = deps.imageUrls.length > 1 ? [`輪播 ${deps.imageUrls.length} 張`] : [];
  const mediaId = await deps.api.publish({
    imageUrls: deps.imageUrls,
    caption: igCaption(plan),
    // 回應不明時：IG 最近的貼文裡有今天的題號就是已經發了
    find: async () => findMediaByExercise(await deps.api.recentMedia(), plan.exerciseId, plan.date)?.id ?? null,
  });
  // 發出去就記下並馬上推上去（跟 Threads 的 checkpoint 一樣）：中斷也不會再發一次。
  writeState(deps.stateDir, { ...stateOrNew(deps.stateDir, plan), ig: { mediaId, publishedAt: now().toISOString() } });
  if (deps.checkpoint) {
    try {
      await deps.checkpoint('IG');
    } catch (err) {
      notes.push(`狀態檔沒推上去（IG）：${(err as Error).message}`);
    }
  }
  const permalink = await deps.api.permalink(mediaId);
  if (permalink) writeState(deps.stateDir, { ...stateOrNew(deps.stateDir, plan), ig: { mediaId, permalink, publishedAt: now().toISOString() } });
  return { status: 'published', mediaId, permalink, notes };
}
