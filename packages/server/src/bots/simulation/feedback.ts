/**
 * 模擬瓦 — 玩家對題目的回饋（站長 2026-11-26：「還有玩家如果反饋是爛局或是吐槽的內容記得記錄下來」）。
 *
 * 剛 /公布 完（或題目開著、剛有人動過）的聊天室裡，有人說「爛局」「這題怪」「紀錄有問題」「亂打」「吐槽…」這類話：
 *   - 記下來：題號、局號、平台、打的人（雜湊過的 id，跟題目存檔同一種：persist.simIdHash）、時間、原文（最多 500 字）。
 *     記到 /意見 同一個地方（feedback/service.ts：站長的管理員頻道「大劍管理員」，沒有名字；只需要 Discord bot，
 *     不需要 GITHUB_ACCOUNTS_TOKEN 那些變數）。原文**不進公開 repo**、不寫 log。
 *   - 回一句「收到，已記下這題的回饋」：同一個人同一題最多一次（之後照樣記，不再回）。
 *   - 同一局有 2 位以上（不同的人）說是爛局：標成「要人看」（管理員頻道多一則提醒；狀態頁有數字）。**不會自動從題庫拿掉**——
 *     要拿掉是站長決定，加進 packages/server/sim_bank_exclude.json。
 *
 * 認得很保守：一定要有下面的關鍵字，而且只在那個聊天室 SIM_FEEDBACK_WINDOW_MS 之內有人 /公布、或有開著的題目剛被動過。
 * 指令（/ 開頭）不算。純函式；記錄、計數在 session.ts（SimEngine.feedbackFor）。
 */

/** 'bad' = 說這局／這題本身有問題（算進「要人看」）；'complaint' = 其他吐槽（只記錄）。 */
export type SimFeedbackKind = 'bad' | 'complaint';

/** /公布 之後（或題目最後一次被動過之後）幾分鐘內的話才算。 */
export const SIM_FEEDBACK_WINDOW_MS = 15 * 60 * 1000;
/** 回覆（同一人同一題最多一次）。 */
export const SIM_FEEDBACK_ACK = '收到，已記下這題的回饋';
/** 記下的原文最多幾個字。 */
export const SIM_FEEDBACK_MAX_CHARS = 500;
/** 比這更長的訊息不當成對題目的回饋（多半是在聊別的）。 */
export const SIM_FEEDBACK_MAX_INPUT = 300;
/** 同一局幾位不同的人說爛局就標成要人看。 */
export const SIM_FEEDBACK_FLAG_AT = 2;

const BAD_PATTERNS: readonly RegExp[] = [
  // 爛局、鬼局、屎局、垃圾局、雷局、亂局
  /(?:爛|烂|鬼|屎|垃圾|雷|亂|乱)局/u,
  // 這題怪、這局很爛、題目有問題、這題好奇怪
  /(?:題|题|局)目?(?:真的|也|很|好|超|有夠|太)?(?:爛|烂|怪|奇怪|有問題|有问题|有毛病|有bug)/iu,
  /(?:爛|烂|怪)題|怪局/u,
  // 紀錄有問題、牌譜錯、拇指記錯、記錯了
  /(?:紀錄|記錄|纪录|记录|牌譜|牌谱|拇指|票)(?:好像|應該|应该)?(?:有)?(?:問題|问题|錯|错|怪|亂|乱)/u,
  // 「我亂派的」「我記錯了」是在說自己，不算（前面是「我」「我是」「我都」…就跳過）。
  /(?<!我(?:是|都|就|也|只是|剛剛|剛)?)(?:記錯|记错|記反|记反|亂打|乱打|亂玩|乱玩|亂派|乱派|亂投|乱投|亂刺|乱刺)/u,
];

const COMPLAINT_PATTERNS: readonly RegExp[] = [
  /吐槽|不合理|太扯|很扯|好扯|怪怪的|很怪|好怪|太怪|有bug|有 bug|看不懂(?:這|这)(?:題|题|局)/iu,
];

/** 一段聊天文字是不是對題目的回饋；不是 → null。 */
export function classifySimFeedback(text: string): SimFeedbackKind | null {
  const t = (text ?? '').normalize('NFKC').trim();
  if (!t || t.length > SIM_FEEDBACK_MAX_INPUT || /^[/／]/u.test(t)) return null;
  if (BAD_PATTERNS.some((re) => re.test(t))) return 'bad';
  if (COMPLAINT_PATTERNS.some((re) => re.test(t))) return 'complaint';
  return null;
}

/** 記下的一則回饋（交給 feedback/service.ts 轉到管理員頻道）。沒有名字、沒有原始 id。 */
export interface SimFeedbackRecord {
  exerciseId: string;
  gameId: string;
  platform: 'line' | 'discord';
  /** 打的人（雜湊過的 id）；沒有 id 時是 '*'。 */
  user: string;
  /** 毫秒。 */
  at: number;
  kind: SimFeedbackKind;
  /** 原文（最多 SIM_FEEDBACK_MAX_CHARS 字）。 */
  text: string;
  /** 這一局目前有幾位不同的人說爛局。 */
  badReporters: number;
  /** 這一則讓這一局剛好到 SIM_FEEDBACK_FLAG_AT 位（第一次標成要人看）。 */
  flagged: boolean;
}

/** 原文截斷（照字算，不切斷 emoji）。 */
export function clipFeedbackText(text: string): string {
  const chars = [...(text ?? '').trim()];
  return chars.length > SIM_FEEDBACK_MAX_CHARS ? `${chars.slice(0, SIM_FEEDBACK_MAX_CHARS - 1).join('')}…` : chars.join('');
}

/** 台北時間「2026-11-26 14:03」。 */
export function taipeiTime(at: number): string {
  const d = new Date(at + 8 * 60 * 60 * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/**
 * 管理員頻道的那一則：`🎲 模擬瓦回饋（LINE）｜爛局｜題 K7Q2M-4｜使用者 a1b2c3d4e5f6｜2026-11-26 14:03：原文`；
 * 剛好標成要人看時，後面多一行提醒（不會自動拿掉）。
 */
export function formatSimFeedbackForward(r: SimFeedbackRecord): string {
  const where = r.platform === 'line' ? 'LINE' : 'Discord';
  const kind = r.kind === 'bad' ? '爛局／紀錄有問題' : '吐槽';
  const lines = [`🎲 模擬瓦回饋（${where}）｜${kind}｜題 ${r.exerciseId}｜使用者 ${r.user}｜${taipeiTime(r.at)}：${r.text}`];
  if (r.flagged) {
    lines.push(`⚠️ 局 ${r.gameId} 已有 ${r.badReporters} 位說是爛局或紀錄有問題，請看要不要加進 sim_bank_exclude.json（不會自動從題庫拿掉）`);
  }
  return lines.join('\n');
}
