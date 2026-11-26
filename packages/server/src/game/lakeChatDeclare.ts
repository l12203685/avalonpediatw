/**
 * 湖中宣告只打在聊天裡（站長 2026-11-26：「因為有時候玩家的湖中宣告會只送文字」）。
 *
 * 有的玩家驗完湖不按「宣告」，而是直接在房間聊天打「湖3好」「2>3 o」「3是好人」。以前這些話只是聊天，
 * 紀錄、重播和百科AI 都看不到這次宣告（百科AI 看到的是「沒宣告」）。現在：剛驗完湖、還沒宣告的那位
 * （紀錄最後一筆的 holderId）在下一個任務結果出來之前打的這種話，讀得懂就照按鈕一樣記下
 * （GameEngine.declareLakeResult，紀錄上多一個 declaredVia: 'chat'），系統訊息多「（取自聊天）」。
 *
 * 認得很保守，寧可漏掉也不要讀錯：
 *   - 只認「被驗的那一家的號碼」（10 家寫 0 或 10）＋剛好一個陣營字：
 *     好／好人／藍／白／o／○ 對 壞／壞人／紅／黑／x／×；也認「N>M o」（N 要是驗湖的人自己）。
 *   - 沒寫號碼、只打陣營字（「好人」「x」）：只在驗完之後他打的第一句才算。
 *   - 出現別的號碼、兩種陣營、問句（嗎／?／？／吧／呢）、或拿掉號碼和填充字之後還剩別的字 → 不算。
 *   - 「不是好人」當壞、「不是壞人」當好；其他「不」開頭的都不算。
 *   - 指令（/ 開頭）、超過 30 個字的話不算。
 *
 * 純函式；房間狀態的判斷（是不是驗湖的人、還沒宣告、下一個任務結果出來前）在 lakeChatDeclareFor。
 * LAKE_CHAT_DECLARE=off（false／0／no）整個關掉。
 */

import type { LadyOfTheLakeRecord, Room } from '@avalon/shared';

export type LakeClaim = 'good' | 'evil';

/** 比這更長的話不當成宣告。 */
export const LAKE_CHAT_MAX_CHARS = 30;

/** 系統訊息裡附的字。 */
export const LAKE_CHAT_SUFFIX = '（取自聊天）';

/** LAKE_CHAT_DECLARE：預設開；off / false / 0 / no 關。每次呼叫都重讀（測試可以改）。 */
export function lakeChatDeclareEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.LAKE_CHAT_DECLARE ?? '').trim().toLowerCase();
  return !['off', 'false', '0', 'no', 'none'].includes(raw);
}

export interface LakeChatParseContext {
  /** 被驗的那一家（1–10）。 */
  targetSeat: number;
  /** 驗湖的那一家（1–10）；「N>M」的 N 要對得上。 */
  holderSeat: number;
  /** 這是他驗完之後打的第一句（只打陣營字時才看這個）。 */
  firstMessageAfterInspection: boolean;
}

const GOOD_WORDS = ['好人', '好', '藍', '蓝', '白', 'o', '○', '⭕'];
const EVIL_WORDS = ['壞人', '坏人', '壞', '坏', '紅', '红', '黑', 'x', '×', '❌'];

/** 拿掉號碼之後可以忽略的字（「湖到 3 是 好人 喔」）。 */
const FILLER = /湖中|湖|到|驗|验|看|查|我|是|為|为|的|了|啦|喔|哦|囉|唷|耶|號|号|家|方|色|陣營|阵营|[\s,，.。、:：!！~～\-—]/gu;

/** 座位字串 → 1–10；「0」「10」都是 10 家；其他 → null。 */
function seatOfToken(tok: string): number | null {
  if (!/^\d{1,2}$/.test(tok)) return null;
  const n = Number(tok);
  if (n === 0 || n === 10) return 10;
  return n >= 1 && n <= 9 ? n : null;
}

/**
 * 一句聊天是不是湖中宣告；是 → 'good' / 'evil'，不是或讀不準 → null。
 */
export function parseLakeChatDeclaration(text: string, ctx: LakeChatParseContext): LakeClaim | null {
  let t = (text ?? '').normalize('NFKC').trim();
  if (!t || [...t].length > LAKE_CHAT_MAX_CHARS) return null;
  if (/^[/／]/u.test(t)) return null;
  // 問句不算（「3是好人嗎」「3藍？」）。
  if (/[?？嗎吗吧呢]/u.test(t)) return null;
  t = t.toLowerCase();

  let seatSeen = false;
  // 「N>M」：N 要是驗湖的人、M 要是被驗的人。
  const arrows = [...t.matchAll(/(\d{1,2})\s*[>＞→]\s*(\d{1,2})/gu)];
  if (arrows.length > 1) return null;
  if (arrows.length === 1) {
    const [whole, a, b] = arrows[0];
    if (seatOfToken(a) !== ctx.holderSeat || seatOfToken(b) !== ctx.targetSeat) return null;
    t = t.replace(whole, ' ');
    seatSeen = true;
  }
  if (/[>＞→]/u.test(t)) return null;
  // 其他號碼都要是被驗的那一家。
  for (const m of t.matchAll(/\d+/gu)) {
    if (seatOfToken(m[0]) !== ctx.targetSeat) return null;
    seatSeen = true;
  }
  t = t.replace(/\d+/gu, ' ');

  // 「不是好人」→ 壞、「不是壞人」→ 好；其他「不」都不算。
  t = t.replace(/不是(?:好人|好|藍|蓝|白)/gu, '壞').replace(/不是(?:壞人|坏人|壞|坏|紅|红|黑)/gu, '好');
  if (/[不没沒非]/u.test(t)) return null;

  const rest = t.replace(FILLER, '');
  // 剩下的要剛好是一個陣營字。
  let claim: LakeClaim | null = null;
  if (GOOD_WORDS.includes(rest)) claim = 'good';
  else if (EVIL_WORDS.includes(rest)) claim = 'evil';
  if (!claim) return null;
  if (!seatSeen && !ctx.firstMessageAfterInspection) return null;
  return claim;
}

// ─── 房間狀態 ────────────────────────────────────────────────────────────

type LakeRoom = Pick<Room, 'players' | 'state' | 'questHistory' | 'ladyOfTheLakeHistory'>;

/** 1-based 座位（Object.keys(room.players) 的順序，跟 GameEngine 一樣）；不在房間 → 0。 */
function seatIn(room: LakeRoom, playerId: string): number {
  return Object.keys(room.players).indexOf(playerId) + 1;
}

/**
 * 還在等宣告的那一筆湖：最後一筆、還沒宣告、遊戲還沒結束、下一個任務結果還沒出來
 * （紀錄的 round 是剛結束的那一局任務，所以 questHistory 長度還沒超過它）。沒有 → null。
 */
export function openLakeForChat(room: LakeRoom): LadyOfTheLakeRecord | null {
  const history = room.ladyOfTheLakeHistory ?? [];
  const last = history[history.length - 1];
  if (!last || last.declared === true) return null;
  if (room.state === 'ended' || room.state === 'lobby') return null;
  if ((room.questHistory?.length ?? 0) > last.round) return null;
  return last;
}

/** 每個房間記：目前看的是第幾筆湖、驗湖的人在那之後講過幾句。 */
export class LakeChatWatcher {
  private readonly rooms = new Map<string, { lakeCount: number; holderMessages: number }>();
  /** 數字給 /api/bots/status（numbers only）。 */
  readonly counts = { declared: 0, holderMessagesUnread: 0 };

  /**
   * 一句真人聊天進來：是驗湖的人在等宣告時說的、讀得懂 → 回 claim（呼叫端去 declareLakeResult）；
   * 其他 → null。每句都要叫（用來算「驗完之後第一句」）。
   */
  claimFor(roomId: string, room: LakeRoom, playerId: string, text: string): LakeClaim | null {
    const lakeCount = room.ladyOfTheLakeHistory?.length ?? 0;
    let st = this.rooms.get(roomId);
    if (!st || st.lakeCount !== lakeCount) {
      st = { lakeCount, holderMessages: 0 };
      this.rooms.set(roomId, st);
    }
    const open = openLakeForChat(room);
    if (!open || open.holderId !== playerId) return null;
    const first = st.holderMessages === 0;
    st.holderMessages += 1;
    if (!lakeChatDeclareEnabled()) return null;
    const claim = parseLakeChatDeclaration(text, {
      targetSeat: seatIn(room, open.targetId),
      holderSeat: seatIn(room, playerId),
      firstMessageAfterInspection: first,
    });
    if (!claim) this.counts.holderMessagesUnread += 1;
    return claim;
  }

  /** 記下一筆成功的宣告（數字）。 */
  noteDeclared(): void {
    this.counts.declared += 1;
  }

  /** 房間沒了。 */
  forget(roomId: string): void {
    this.rooms.delete(roomId);
  }

  /** 拿掉已經不存在的房間（GameServer 定期叫）。 */
  prune(alive: (roomId: string) => boolean): void {
    for (const id of [...this.rooms.keys()]) if (!alive(id)) this.rooms.delete(id);
  }
}

let watcher: LakeChatWatcher | null = null;

/** 全程序一個（GameServer 用來判斷、/api/bots/status 讀數字）。 */
export function getLakeChatWatcher(): LakeChatWatcher {
  if (!watcher) watcher = new LakeChatWatcher();
  return watcher;
}

/** /api/bots/status → lakeChatDeclare（只有數字和開關）。 */
export function lakeChatDeclareStatus(): { enabled: boolean; declared: number; holderMessagesUnread: number } {
  const w = getLakeChatWatcher();
  return { enabled: lakeChatDeclareEnabled(), ...w.counts };
}
