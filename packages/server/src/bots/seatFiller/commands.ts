/**
 * 補位機器人 commands (2026-11-03) — text parsing and reply texts shared by the
 * LINE text handler and the Discord slash command. The dispatch itself (limits,
 * GitHub workflow_dispatch) lives in services/signagePlayerDispatch.ts.
 *
 *   LINE    /補位 Room-1460 [局數]   (also /機器人補位, full-width ／, a bare 1460)
 *   Discord /機器人補位 房號:Room-1460 [局數:1]
 *
 * docs/BOT_SETUP.md「補位機器人」.
 */

import {
  getSignagePlayerDispatcher,
  parseSeatFillerArgs,
  SEAT_FILLER_GAMES,
  SEAT_FILLER_LIMITS,
  type SeatFillerOutcome,
  type SeatFillerParseError,
} from '../../services/signagePlayerDispatch';

export type SeatFillerPlatform = 'line' | 'discord';

/** Command syntax as advertised in the help texts. */
export const SEAT_FILLER_USAGE: Record<SeatFillerPlatform, string> = {
  line: '/補位 房號 [局數]',
  discord: '/機器人補位 房號 [局數]',
};

/** One-line description for the help texts. */
export const SEAT_FILLER_HELP_TEXT = `叫補位機器人進 signage-cloud 房間測試（局數 ${SEAT_FILLER_GAMES.min}–${SEAT_FILLER_GAMES.max}，預設 ${SEAT_FILLER_GAMES.default}）`;

/** The abuse limits in words (Discord /help). */
export const SEAT_FILLER_LIMITS_TEXT = `全站每 ${SEAT_FILLER_LIMITS.cooldownMs / 60000} 分鐘一次、每天最多 ${SEAT_FILLER_LIMITS.dailyMax} 次、同一房 ${SEAT_FILLER_LIMITS.sameRoomMs / 60000} 分鐘內不重複`;

/** Answer to a LINE redelivery of a command this process already handled. */
export const SEAT_FILLER_REDELIVERY_TEXT = '這則補位指令已經處理過了，不會重複叫機器人。';

export interface SeatFillerTextCommand {
  /** First argument (room) as typed, '' when missing. */
  room: string;
  /** Second argument (games) as typed, undefined when missing. */
  games?: string;
  /** More than two arguments were typed. */
  extra: boolean;
}

/**
 * "/補位 Room-1460 2" → { room: 'Room-1460', games: '2' }; "/機器人補位" →
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
  const args = rest.trim() ? rest.trim().split(/\s+/u) : [];
  return { room: args[0] ?? '', games: args[1], extra: args.length > 2 };
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
  const example = platform === 'line' ? '/補位 Room-1460 或 /補位 1460 2' : '/機器人補位 房號:Room-1460 局數:2';
  switch (error) {
    case 'usage':
      return `用法：${SEAT_FILLER_USAGE[platform]}，例如 ${example}（局數 ${SEAT_FILLER_GAMES.min}–${SEAT_FILLER_GAMES.max}，不填就是 ${SEAT_FILLER_GAMES.default} 局）。`;
    case 'room':
      return `房號格式不對：請輸入 Room-1460 或 1460（1–6 位數字），例如 ${example}。`;
    case 'games':
      return `局數要是 ${SEAT_FILLER_GAMES.min}–${SEAT_FILLER_GAMES.max} 的整數（不填就是 ${SEAT_FILLER_GAMES.default} 局）。`;
  }
}

export function formatSeatFillerOutcome(outcome: SeatFillerOutcome): string {
  switch (outcome.kind) {
    case 'dispatched':
      return `已叫補位機器人到 ${outcome.room}（${outcome.games} 局），約 1–2 分鐘後進房；打完會離開。`;
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
  const parsed = parseSeatFillerArgs(cmd.room, cmd.games);
  if (!parsed.ok) return formatSeatFillerParseError(parsed.error, platform);
  return formatSeatFillerOutcome(await getSignagePlayerDispatcher().dispatch(parsed.request));
}
