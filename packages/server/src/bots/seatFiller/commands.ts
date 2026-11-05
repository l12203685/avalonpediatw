/**
 * 補位機器人 commands (2026-11-03) — text parsing and reply texts shared by the
 * LINE text handler and the Discord slash command. The dispatch itself (limits,
 * GitHub workflow_dispatch) lives in services/signagePlayerDispatch.ts.
 *
 *   LINE    /補位 <房號或房間描述> [補滿|N人] [密碼:xxxx]   (also /機器人補位, full-width ／, a bare 1460)
 *   Discord /機器人補位 房號或描述:… [人數:1–9／補滿] [密碼:…]
 * (Edward 2026-11-04：房間內看不到房號 → 可以用房間描述；私房要密碼；一次補滿；局數不限、請它離開就好)
 *
 * docs/BOT_SETUP.md「補位機器人」.
 */

import {
  getSignagePlayerDispatcher,
  parseSeatFillerArgs,
  SEAT_FILLER_BOTS,
  SEAT_FILLER_LIMITS,
  type SeatFillerOutcome,
  type SeatFillerParseError,
} from '../../services/signagePlayerDispatch';

export type SeatFillerPlatform = 'line' | 'discord';

/** Command syntax as advertised in the help texts. */
export const SEAT_FILLER_USAGE: Record<SeatFillerPlatform, string> = {
  line: '/補位 房號或房間描述 [補滿｜幾人] [密碼:xxxx]',
  discord: '/機器人補位 房號或描述 [人數] [密碼]',
};

/** One-line description for the help texts. */
export const SEAT_FILLER_HELP_TEXT = `叫百科AI 進 signage-cloud 房間補位（房號或房間描述都可以；一次 ${SEAT_FILLER_BOTS.min}–${SEAT_FILLER_BOTS.max} 個或「補滿」；私房加密碼；局數不限，房內有人說「離開」它就走）`;

/** The abuse limits in words (Discord /help). */
export const SEAT_FILLER_LIMITS_TEXT = `全站每 ${SEAT_FILLER_LIMITS.cooldownMs / 60000} 分鐘一次、每天最多 ${SEAT_FILLER_LIMITS.dailyMax} 次、同一房 ${SEAT_FILLER_LIMITS.sameRoomMs / 60000} 分鐘內不重複`;

/** Answer to a LINE redelivery of a command this process already handled. */
export const SEAT_FILLER_REDELIVERY_TEXT = '這則補位指令已經處理過了，不會重複叫機器人。';

export interface SeatFillerTextCommand {
  /** Room number or description piece as typed ('' when missing). 「…」 may wrap a description with spaces. */
  room: string;
  /** How many bots as typed ("補滿", "3", "3人"), undefined when missing. */
  bots?: string;
  /** Password as typed after 密碼: / pw:, undefined when missing. */
  password?: string;
  /** Unrecognised or repeated arguments were typed. */
  extra: boolean;
}

const PASSWORD_ARG = /^(?:密碼|密码|pw|pass(?:word)?)[:：=]?(.*)$/iu;
const BOTS_ARG = /^(?:補滿|滿|fill|full|\d+\s*[人個隻位]?)$/iu;

/**
 * "/補位 1460 補滿 密碼:1234" → { room: '1460', bots: '補滿', password: '1234' };
 * "/補位 「百科 陪練」 3人" → { room: '百科 陪練', bots: '3人' }; "/機器人補位" →
 * { room: '' } (caller shows the usage); anything else → null. The command
 * word must end the text or be followed by a space, a digit or "room", so
 * "/補位置" stays ordinary chatter.
 */
export function parseSeatFillerText(text: string): SeatFillerTextCommand | null {
  const t = (text ?? '').normalize('NFKC').trim();
  const m = /^\/\s*(?:機器人補位|補位)([\s\S]*)$/u.exec(t);
  if (!m) return null;
  const rest = m[1];
  if (rest && !/^\s/u.test(rest) && !/^(?:room|\d)/iu.test(rest)) return null;
  let body = rest.trim();
  let room = '';
  const quoted = /^「([^」]*)」\s*/u.exec(body);
  if (quoted) { room = quoted[1].trim(); body = body.slice(quoted[0].length); }
  const args = body ? body.split(/\s+/u) : [];
  if (!quoted) room = args.shift() ?? '';
  const out: SeatFillerTextCommand = { room, extra: false };
  for (const a of args) {
    const pw = PASSWORD_ARG.exec(a);
    if (pw && out.password === undefined) out.password = pw[1];
    else if (BOTS_ARG.test(a) && out.bots === undefined) out.bots = a;
    else out.extra = true;
  }
  return out;
}

/** Is this text a 補位 command (feedback topic counting and chat export skip it)? */
export function isSeatFillerCommandText(text: string): boolean {
  return parseSeatFillerText(text) !== null;
}

/** "2 分 5 秒" / "45 秒" (rounded up to the second). */
export function formatWait(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min === 0) return `${sec} 秒`;
  return sec === 0 ? `${min} 分鐘` : `${min} 分 ${sec} 秒`;
}

export function formatSeatFillerParseError(error: SeatFillerParseError, platform: SeatFillerPlatform): string {
  const example = platform === 'line' ? '/補位 1460、/補位 百科陪練 補滿 密碼:1234' : '/機器人補位 房號或描述:百科陪練 人數:補滿 密碼:1234';
  switch (error) {
    case 'usage':
      return `用法：${SEAT_FILLER_USAGE[platform]}，例如 ${example}。房號在大廳看得到；在房間裡看不到房號時，用建房時寫的房間描述裡的一段字就行。人數不填就是 1 個，「補滿」= 補到 10 人。`;
    case 'room':
      return `房號或房間描述不對：房號請輸入 Room-1460 或 1460；房間描述最多 40 個字，不能有引號或換行。例如 ${example}。`;
    case 'bots':
      return `人數要是 ${SEAT_FILLER_BOTS.min}–${SEAT_FILLER_BOTS.max} 或「補滿」（不填就是 ${SEAT_FILLER_BOTS.default} 個）。`;
    case 'password':
      return '密碼最多 32 個字，不能有空白或引號。';
  }
}

export function formatSeatFillerOutcome(outcome: SeatFillerOutcome): string {
  switch (outcome.kind) {
    case 'dispatched':
      return `已叫百科AI 到「${outcome.room}」（${outcome.bots === SEAT_FILLER_BOTS.max ? '補到 10 人' : `${outcome.bots} 個`}），約 1–2 分鐘後進房；局數不限，要它走就在房內聊天室打「離開」。`;
    case 'not_configured':
      return '補位機器人還沒設定好（管理者尚未完成設定），暫時不能叫。';
    case 'cooldown':
      return `補位機器人剛被叫過，請 ${formatWait(outcome.retryAfterMs)}後再試（全站每 ${SEAT_FILLER_LIMITS.cooldownMs / 60000} 分鐘最多叫一次）。`;
    case 'daily_cap':
      return `今天的補位次數已經用完（每天最多 ${outcome.max} 次，台北時間午夜重置）。`;
    case 'duplicate_room':
      return `${outcome.room} 在 ${SEAT_FILLER_LIMITS.sameRoomMs / 60000} 分鐘內已經叫過補位機器人了，請 ${formatWait(outcome.retryAfterMs)}後再試。`;
    case 'github_error':
      return outcome.status === null
        ? '叫補位機器人時連不到 GitHub（可能已經送出），請等 2 分鐘看機器人有沒有進房，沒有再重試。'
        : `叫補位機器人失敗（GitHub 回應 ${outcome.status}），請稍後再試或告訴管理者。`;
  }
}

/**
 * Reply text for a typed 補位 command, or null when `text` is not one.
 * `redelivery`: LINE re-sent an event this process already handled — answer,
 * but never dispatch a second time.
 */
export async function answerSeatFillerTextCommand(
  text: string,
  platform: SeatFillerPlatform = 'line',
  opts: { redelivery?: boolean } = {},
): Promise<string | null> {
  const cmd = parseSeatFillerText(text);
  if (!cmd) return null;
  if (opts.redelivery) return SEAT_FILLER_REDELIVERY_TEXT;
  if (cmd.extra) return formatSeatFillerParseError('usage', platform);
  const parsed = parseSeatFillerArgs(cmd.room, cmd.bots, cmd.password);
  if (!parsed.ok) return formatSeatFillerParseError(parsed.error, platform);
  return formatSeatFillerOutcome(await getSignagePlayerDispatcher().dispatch(parsed.request));
}
