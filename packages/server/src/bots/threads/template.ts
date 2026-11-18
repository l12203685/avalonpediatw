/**
 * Threads 每日一題的貼文格式（2026-11-18）：貼文 A 和第一則留言都用「範本＋佔位符」組出來。
 *
 * 站長 11/18：「我可以再主控台那邊 先調整貼文格式? (應該只有出題內容會改 大部分都可以套用?)」
 * → 格式只改一次（主控台「貼文格式（每天共用）」），每天只換佔位符的內容（draft.ts 算出來的 parts）。
 *
 * 正本：commit 進 repo 的 `packages/server/threads_template.json` {post, comment, updatedAt, note}，
 * 由 Claude 每天台北 08:00 的同步從主控台 db 的 meta/postTemplate 寫進來（不要手改）。
 * 沒有檔、檔壞了、或某一欄不合格：那一欄用內建格式（DEFAULT_TEMPLATE），並留一則警告。
 *
 * 規則：
 *   - `{名稱}` 換成那天的內容；名稱只能用下面列的（不認得的佔位符＝範本不合格）。
 *   - 一行只有佔位符、而且都是空的（例如第一天沒有 {昨天答案}、不是延續的日子沒有 {接續}）：整行拿掉；
 *     拿掉之後上下會變成連續兩個空行的話，只留一個。
 *   - 貼文第一行一定是 {標題}、而且只有它（自動發佈靠第一行＋日期認出那天的貼文，防重複發、補記都靠它）；
 *     一定要有 {你是} 和 {派票紀錄}（沒有身分或牌譜的話，圖沒產生就會發出看不懂的題目）；
 *     最後一行一定是 {標籤}，其他行不能自己寫主題標籤（自動發佈要求主題標籤剛好一行、在最後一行）。
 *   - 留言一定要有 {小觀念}。
 *   - 各題型可以有自己的格式（站長 11/18：「順便幫我整理分類 目前有的題型 我直接進去改各種題型的格式」）：
 *     threads_template.json 的 byType[<題型>]（THREADS_TYPES）有、而且合格就用它，沒有就用上面共用的，再沒有就用內建格式。
 *   - 套完之後一樣要 ≤ 500 字：放不下先縮牌譜、再縮答案（跟以前一樣），還是放不下就那一天改用內建格式（警告）。
 */

import fs from 'fs';
import type { ThreadsKind } from './plan';

/** 貼文 A 的佔位符（順序＝主控台列出來的順序）。 */
export const POST_PLACEHOLDERS = ['標題', '主題', '題號', '接續', '你是', '派票紀錄', '提問', '昨天答案', '標籤'] as const;
/** 第一則留言的佔位符。 */
export const COMMENT_PLACEHOLDERS = ['小觀念', '主題', '題號', '標籤'] as const;

export type PostPlaceholder = (typeof POST_PLACEHOLDERS)[number];
export type CommentPlaceholder = (typeof COMMENT_PLACEHOLDERS)[number];
/** 一天的貼文內容：每個佔位符換成什麼（多行的用 \n 接；沒有的是空字串）。 */
export type PostParts = Record<PostPlaceholder, string>;
export type CommentParts = Record<CommentPlaceholder, string>;

/** 每個佔位符是什麼（文件、主控台用）。 */
export const PLACEHOLDER_HELP: Readonly<Record<PostPlaceholder | CommentPlaceholder, string>> = {
  標題: '第一行，例「【阿瓦隆每日一題｜週三・1-5 尾派】」（自動發佈靠第一行認出那天的貼文）',
  主題: '星期＋主題，例「週三・1-5 尾派」',
  題號: '題庫代號，例「SV1Q8-1-5」（內建格式不寫，題號在圖上）',
  接續: '週四、週六接昨天那一局時的一行，例「接昨天那一局（SV1Q8-1-5），同一家又輪到尾派：」；其他日子是空的',
  你是: '「你是 5家 忠臣 | 無其他資訊 | 派 3 人」那一行',
  派票紀錄: '牌譜（[第 1 局] 起的派票、任務、湖）；太長會自動縮成只留任務與湖、再縮成「（完整局面看圖）」',
  提問: '最後的問題，例「你會派誰？」、刺殺題「三藍，誰是梅林？」',
  昨天答案: '整段昨天的答案（[昨天 … 的答案] 起）；第一天或昨天沒貼文時是空的，太長會自動拿掉理由',
  標籤: '主題標籤那一行（#阿瓦隆 …），一定要是貼文最後一行',
  小觀念: '第一則留言的內文（docs/threads/comments/<日期>.md 去掉第一行標題）',
};

/** 第一則留言的標題行（docs/threads/comments 每個檔的第一行）。 */
export const COMMENT_HEADER = '【阿瓦隆百科小觀念】';

/** 內建格式：跟 2026-11-18 的貼文一字不差（ThreadsTemplate.test.ts 比對兩週的題目）。 */
export const DEFAULT_POST_TEMPLATE = ['{標題}', '{接續}', '{你是}', '{派票紀錄}', '{提問}', '', '{昨天答案}', '', '{標籤}'].join('\n');
export const DEFAULT_COMMENT_TEMPLATE = `${COMMENT_HEADER}\n{小觀念}`;

/** 一個題型自己的格式：只寫要改的那一欄，沒寫的用共用的。 */
export interface TypeTemplate {
  post?: string;
  comment?: string;
}

export interface ThreadsTemplate {
  post: string;
  comment: string;
  /** 各題型自己的格式（鍵是 ThreadsKind；讀檔時已經檢查過，不合格的不會在這裡）。 */
  byType?: Partial<Record<ThreadsKind, TypeTemplate>>;
}

/** 題型（＝ ThreadsPick.kind）：主控台照這個順序列，各自可以改格式。 */
export interface ThreadsType {
  kind: ThreadsKind;
  /** 中文名稱。 */
  name: string;
  /** 一句話說明這個題型在問什麼。 */
  description: string;
  /** 哪幾天出這個題型（docs/THREADS.md 的表）。 */
  days: string;
}

/**
 * 目前有的題型。尾派不再細分「接前一天」和「獨立」：兩種的差別只在 {接續} 那一行（獨立的日子是空的、整行拿掉）
 * 和昨天答案的寫法（延續的日子不公布幾好幾壞和角色，內容本身已經不同），同一個格式兩種都能用。
 */
export const THREADS_TYPES: readonly ThreadsType[] = [
  { kind: 'assassin', name: '刺殺梅林', description: '三藍之後，刺客（和紅方隊友一起討論）從整場的資訊找出梅林', days: '週一' },
  { kind: 'percival', name: '派西維爾思考', description: '派西維爾當隊長派隊：看到兩根拇指但分不出誰是梅林、誰是莫甘娜（第 2 局以後）', days: '週二' },
  {
    kind: 'tail',
    name: '尾派',
    description: '第 5 次提案（強制出發）的隊長派隊；週四、週六接前一天同一局（有 {接續} 那一行），接不上的週四出獨立的 3-5',
    days: '週三 1-5、週四 3-5、週五 2-5、週六 4-5',
  },
  { kind: 'round4', name: '第四局忠臣派 5 人', description: '第 4 局忠臣當隊長派 5 人（要 2 張失敗才開紅）', days: '週六（沒有能接的 2-5＋4-5 時）' },
  { kind: 'final', name: '第五局決策', description: '2:2 的決勝局，隊長派 5 人：開紅直接輸、開藍進入刺殺', days: '週日' },
];

export function typeOf(kind: ThreadsKind): ThreadsType {
  return THREADS_TYPES.find((t) => t.kind === kind) as ThreadsType;
}

/** 這個題型實際用的格式：題型自己的 → 共用的（內建格式已經在共用的裡面）。 */
export function templateFor(t: ThreadsTemplate, kind: ThreadsKind): { post: string; comment: string } {
  const own = t.byType?.[kind];
  return { post: own?.post ?? t.post, comment: own?.comment ?? t.comment };
}

export const DEFAULT_TEMPLATE: Readonly<ThreadsTemplate> = { post: DEFAULT_POST_TEMPLATE, comment: DEFAULT_COMMENT_TEMPLATE };

const TOKEN = /\{([^{}\n]*)\}/g;

/** 整行只有 #標籤（例「#阿瓦隆 #梅林」）。 */
export function isTagLine(line: string): boolean {
  return /^\s*#[^\s#]+(?:\s+#[^\s#]+)*\s*$/.test(line);
}

/** 換行統一成 \n、去掉結尾的空白與空行（主控台的文字框常多一個換行）。 */
export function normalizeTemplate(t: string): string {
  return t.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/** 範本裡用到的佔位符名稱（照出現順序，重複的也列）。 */
export function placeholdersIn(t: string): string[] {
  return [...t.matchAll(TOKEN)].map((m) => m[1]);
}

/** 範本的問題清單（空＝合格）。字數要套進當天的內容才知道，在 renderPost／renderComment 檢查。 */
export function validateTemplate(kind: 'post' | 'comment', raw: string): string[] {
  const errors: string[] = [];
  const t = normalizeTemplate(raw);
  if (!t.trim()) return ['是空的'];
  const allowed: readonly string[] = kind === 'post' ? POST_PLACEHOLDERS : COMMENT_PLACEHOLDERS;
  const unknown = [...new Set(placeholdersIn(t).filter((n) => !allowed.includes(n)))];
  if (unknown.length) errors.push(`不認得的佔位符：${unknown.map((n) => `{${n}}`).join('、')}（可以用：${allowed.map((n) => `{${n}}`).join('、')}）`);
  if (kind === 'post') {
    const lines = t.split('\n');
    const used = placeholdersIn(t);
    if (lines[0].trim() !== '{標題}' || used.filter((n) => n === '標題').length !== 1) errors.push('第一行要是 {標題}，而且只有它（自動發佈靠第一行認出那天的貼文，防重複發）');
    if (!used.includes('你是')) errors.push('要有 {你是}（沒有座位、角色和要做的決策，圖沒產生時會發出看不懂的題目）');
    if (!used.includes('派票紀錄')) errors.push('要有 {派票紀錄}（沒有牌譜，圖沒產生時會發出沒有局面的題目）');
    const tagCount = used.filter((n) => n === '標籤').length;
    if (tagCount !== 1 || lines[lines.length - 1].trim() !== '{標籤}') errors.push('最後一行要是 {標籤}，而且只能出現一次（自動發佈要求主題標籤剛好一行、在最後一行）');
    if (lines.slice(0, -1).some(isTagLine)) errors.push('主題標籤只能用最後一行的 {標籤}，其他行不要自己寫 #標籤（否則每天的貼文都過不了檢查）');
  } else if (!placeholdersIn(t).includes('小觀念')) errors.push('要有 {小觀念}（留言的內文）');
  const literal = [...t.replace(TOKEN, '')].length;
  if (literal > 500) errors.push(`固定的文字就有 ${literal} 字，超過 500`);
  return errors;
}

/**
 * 套範本：`{名稱}` 換成 parts 的內容。一行只有佔位符、而且都是空的 → 整行拿掉；拿掉後上下變成連續兩個空行就只留一個。
 * 不認得的佔位符原樣留著（範本先用 validateTemplate 擋掉）。
 */
export function renderTemplate(template: string, parts: Readonly<Record<string, unknown>>): string {
  const lines = normalizeTemplate(template).split('\n');
  const out: (string | null)[] = lines.map((line) => {
    const names = placeholdersIn(line);
    const rendered = line.replace(TOKEN, (m, name: string) => (typeof parts[name] === 'string' && Object.prototype.hasOwnProperty.call(parts, name) ? (parts[name] as string) : m));
    const onlyTokens = names.length > 0 && line.replace(TOKEN, '').trim() === '';
    return onlyTokens && rendered.trim() === '' ? null : rendered;
  });
  const res: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (v !== null) {
      res.push(v);
      continue;
    }
    // 拿掉的那一行：前面是空行（或在最前面）、後面也是空行 → 後面那個空行一起拿掉。
    if ((res.length === 0 || res[res.length - 1] === '') && out[i + 1] === '') i++;
  }
  return res.join('\n');
}

/** 第一則留言的內文：去掉第一行的「【阿瓦隆百科小觀念】」（有的話）。 */
export function commentBody(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').trim();
  return t.startsWith(`${COMMENT_HEADER}\n`) ? t.slice(COMMENT_HEADER.length + 1).trim() : t === COMMENT_HEADER ? '' : t;
}

// ─── 讀 threads_template.json ───────────────────────────────────────────────

export interface LoadedTemplate {
  template: ThreadsTemplate;
  /** 每一欄用的是檔案裡的還是內建的。 */
  source: { post: 'file' | 'default'; comment: 'file' | 'default'; byType?: Partial<Record<ThreadsKind, { post?: 'file'; comment?: 'file' }>> };
  updatedAt?: string;
  warnings: string[];
}

/** 解析範本檔的內容（已經 JSON.parse 過）。不合格的欄位用內建格式，原因寫進 warnings。 */
/** 一欄格式的檢查：空的＝沒寫（null）；不合格回錯誤訊息。 */
function checkField(kind: 'post' | 'comment', v: unknown): { value: string | null; error?: string } {
  if (v === undefined || v === null || v === '') return { value: null };
  if (typeof v !== 'string') return { value: null, error: '不是文字' };
  const errors = validateTemplate(kind, v);
  return errors.length ? { value: null, error: errors.join('；') } : { value: normalizeTemplate(v) };
}

const FIELD_NAME = { post: '貼文格式', comment: '留言格式' } as const;

/**
 * 解析範本檔的內容（已經 JSON.parse 過）。不合格的欄位用內建格式，原因寫進 warnings。
 * byType：{ <題型>: { post?, comment? } }；題型不認得、或某一欄不合格就略過那一欄（用共用的），也寫進 warnings。
 */
export function parseTemplateFile(raw: unknown, label = 'threads_template.json'): LoadedTemplate {
  const out: LoadedTemplate = { template: { ...DEFAULT_TEMPLATE }, source: { post: 'default', comment: 'default' }, warnings: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    out.warnings.push(`${label} 格式不對（要是 {post, comment} 物件），用內建的貼文格式`);
    return out;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.updatedAt === 'string') out.updatedAt = o.updatedAt;
  for (const kind of ['post', 'comment'] as const) {
    const r = checkField(kind, o[kind]);
    if (r.error) out.warnings.push(`${label} 的${FIELD_NAME[kind]}不合格（${r.error}），用內建的`);
    if (r.value === null) continue;
    out.template[kind] = r.value;
    out.source[kind] = 'file';
  }
  if (o.byType === undefined || o.byType === null) return out;
  if (typeof o.byType !== 'object' || Array.isArray(o.byType)) {
    out.warnings.push(`${label} 的 byType 格式不對（要是 {題型: {post, comment}}），各題型用共用的格式`);
    return out;
  }
  const byType: NonNullable<ThreadsTemplate['byType']> = {};
  const src: NonNullable<LoadedTemplate['source']['byType']> = {};
  for (const [key, val] of Object.entries(o.byType as Record<string, unknown>)) {
    const type = THREADS_TYPES.find((t) => t.kind === key);
    if (!type) {
      out.warnings.push(`${label} 的 byType 有不認得的題型「${key}」（可以用：${THREADS_TYPES.map((t) => t.kind).join('、')}），略過`);
      continue;
    }
    if (val === undefined || val === null) continue;
    if (typeof val !== 'object' || Array.isArray(val)) {
      out.warnings.push(`${label} 的 byType.${key} 格式不對（要是 {post, comment}），${type.name}用共用的格式`);
      continue;
    }
    const own: TypeTemplate = {};
    for (const kind of ['post', 'comment'] as const) {
      const r = checkField(kind, (val as Record<string, unknown>)[kind]);
      if (r.error) out.warnings.push(`${label} 的「${type.name}」${FIELD_NAME[kind]}不合格（${r.error}），用共用的`);
      if (r.value === null) continue;
      own[kind] = r.value;
      (src[type.kind] ??= {})[kind] = 'file';
    }
    if (own.post !== undefined || own.comment !== undefined) byType[type.kind] = own;
  }
  if (Object.keys(byType).length) {
    out.template.byType = byType;
    out.source.byType = src;
  }
  return out;
}

/** 讀範本檔；沒有檔或讀不了就用內建格式（附警告）。 */
export function readTemplateFile(file: string): LoadedTemplate {
  const label = file.split(/[\\/]/).pop() || 'threads_template.json';
  if (!file || !fs.existsSync(file)) {
    return { template: { ...DEFAULT_TEMPLATE }, source: { post: 'default', comment: 'default' }, warnings: [`沒有 ${label}，用內建的貼文格式`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { template: { ...DEFAULT_TEMPLATE }, source: { post: 'default', comment: 'default' }, warnings: [`${label} 讀不了（${(err as Error).message}），用內建的貼文格式`] };
  }
  return parseTemplateFile(raw, label);
}
