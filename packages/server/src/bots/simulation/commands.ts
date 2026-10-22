/**
 * 模擬瓦（2026-10-14）— 指令解析，純函式（不讀檔、不連網、不記 log）。
 *
 * Edward 2026-10-14：「Line bot/dc bot 有辦法支援模擬瓦嗎? 不是練習局
 * 模擬瓦比較像是練習邏輯思考跟派隊資訊的釋放與解讀」。
 *
 *   /模擬                 隨機一題（第 1 局 2～5 家，任何角色）
 *   /模擬 派西 2          指定角色／座位（順序不拘，也可以只給其中一個；紅、藍 = 隨機紅方／藍方角色）
 *   /模擬 題 K7Q2M-4      指定題號（整群可以做同一題）
 *   /派 469               作答（0 = 第 10 家；`4 6 9`、`4,6,9`、`4 6 10` 都可以）
 *   /區間 789=2 460=1     區間（選填；百科寫法 `7 8 9 *2 4 6 0 *1`、`12=1-2`、`3=紅`、`3 壞`、`5=好`、
 *                         `1 5 9 *1+` 也可以；各組可以重疊，跟百科「1 2 *1-2」「2 3 7 *2」一樣）
 *   /下一步  /公布（/解答）  /結束
 *   /模擬 說明            全部指令，每個一行白話（/模擬 幫助、/模擬 指令、/模擬 ? 也可以；2026-10-22）
 *
 * 斜線可以是全形「／」，指令和內容之間的空白可有可無（跟 /戰績 一樣），全形數字照收。
 * 只認這幾個指令字：`/派西 2` 不是 /派（後面不是數字 → 'usage'，沒有進行中的題目時呼叫端不回），
 * `/結束了嗎` 不是 /結束（不回）。一般聊天一律回 null。
 *
 * Edward 2026-10-14 審查修正：
 *   - 看不懂時**絕不回顯使用者打的字**（鏡像群是公開的，回顯等於機器人替人把名字貼出去），
 *     只說第幾組看不懂；
 *   - 像聊天的斜線句子不回：`/模擬什麼時候可以玩`（沒有角色、座位、題號）、`/派對 今晚`、
 *     `/區間 我覺得…`（後面沒有數字）都是 null。
 */

import type { Role } from '@avalon/shared';

export type SimRoleChoice = Role | 'red' | 'blue';

export interface IntervalGroup {
  /** 這一組的座位（1–10，不重複）。 */
  seats: number[];
  /** 這一組有幾紅：min–max（`*2` → 2–2；`=1-2` → 1–2）。 */
  min: number;
  max: number;
}

export type SimUsageCommand = 'start' | 'propose' | 'interval';

export type SimCommand =
  | { kind: 'start'; role?: SimRoleChoice; seat?: number; exerciseId?: string }
  | { kind: 'propose'; team: number[] }
  | { kind: 'interval'; groups: IntervalGroup[] }
  | { kind: 'next' }
  | { kind: 'reveal' }
  | { kind: 'end' }
  /** /模擬 說明：全部指令的白話說明。 */
  | { kind: 'help' }
  /** 是模擬指令，但內容看不懂；`problem` 是給使用者看的一句話。 */
  | { kind: 'usage'; command: SimUsageCommand; problem?: string };

/** 對開著的題目做的事（/派 /區間 /下一步 /公布 /結束，以及看不懂的 /派、/區間）：可以幫別人的題目代答。 */
export function isFollowUpCommand(cmd: SimCommand): boolean {
  return cmd.kind === 'propose' || cmd.kind === 'interval' || cmd.kind === 'next' || cmd.kind === 'reveal' || cmd.kind === 'end'
    || (cmd.kind === 'usage' && cmd.command !== 'start');
}

/** /模擬 後面的「說明」字：說明、幫助、指令、?（全形也可以）。 */
const HELP_WORDS = new Set(['說明', '说明', '幫助', '帮助', '指令', '?', '？', 'help']);

/** 指令字（長的在前：模擬瓦 先於 模擬）。chatExport/rows.ts 也用它認出打字的指令。 */
export const SIM_COMMAND_RE = /^[/／]\s*(模擬瓦|模拟瓦|模擬|模拟|區間|区间|下一步|公布|解答|結束|结束|派)/u;

const FULL_RE = /^\/\s*(模擬瓦|模拟瓦|模擬|模拟|區間|区间|下一步|公布|解答|結束|结束|派)(.*)$/su;

/** 角色別名 → 角色（長的先比）。 */
const ROLE_ALIASES: ReadonlyArray<readonly [string, SimRoleChoice]> = ([
  ['派西維爾', 'percival'], ['派西维尔', 'percival'], ['派西', 'percival'], ['派', 'percival'],
  ['梅林', 'merlin'], ['梅', 'merlin'],
  ['忠臣', 'loyal'], ['雜魚', 'loyal'], ['杂鱼', 'loyal'], ['忠', 'loyal'],
  ['刺客', 'assassin'], ['刺', 'assassin'],
  ['莫甘娜', 'morgana'], ['魔甘娜', 'morgana'], ['娜', 'morgana'],
  ['莫德雷德', 'mordred'], ['莫德', 'mordred'], ['默德', 'mordred'], ['德', 'mordred'],
  ['奧伯倫', 'oberon'], ['奥伯伦', 'oberon'], ['奧柏倫', 'oberon'], ['奥柏伦', 'oberon'], ['奧', 'oberon'], ['奥', 'oberon'],
  ['紅方', 'red'], ['红方', 'red'], ['壞人', 'red'], ['坏人', 'red'], ['紅', 'red'], ['红', 'red'],
  ['藍方', 'blue'], ['蓝方', 'blue'], ['好人', 'blue'], ['藍', 'blue'], ['蓝', 'blue'],
] as Array<[string, SimRoleChoice]>).sort((a, b) => b[0].length - a[0].length);

/** 角色的中文全名（回覆用）。 */
export const ROLE_ZH: Readonly<Record<Role, string>> = {
  merlin: '梅林',
  percival: '派西維爾',
  loyal: '忠臣',
  assassin: '刺客',
  morgana: '莫甘娜',
  mordred: '莫德雷德',
  oberon: '奧伯倫',
  minion: '爪牙',
};

/** 文字 → 角色選擇，或 null。 */
export function parseRoleChoice(raw: string): SimRoleChoice | null {
  const t = (raw ?? '').normalize('NFKC').trim();
  for (const [alias, role] of ROLE_ALIASES) if (t === alias) return role;
  return null;
}

/** Crockford base32：題號裡 I/L 當 1、O 當 0，不分大小寫。 */
export function normalizeExerciseId(raw: string): string | null {
  const t = (raw ?? '').normalize('NFKC').trim().toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
  return /^[0-9A-HJKMNP-TV-Z]{5,8}-[0-9]$/.test(t) ? t : null;
}

/** 座位字：1–9、0 或 10 → 1–10。 */
function seatOfToken(tok: string): number | null {
  if (tok === '10' || tok === '0') return 10;
  if (/^[1-9]$/.test(tok)) return Number(tok);
  return null;
}

/**
 * 座位字串 → 座位。`469`、`4 6 9`、`4,6,9`、`4、6、9`、`4 6 10`：用分隔符號分開的
 * 一段剛好是 `10` 就是第 10 家，其他每個數字一個座位（0 = 第 10 家）。
 * 有數字以外的字 → null。重複座位照樣回傳（呼叫端檢查）。
 */
export function parseSeatDigits(raw: string): number[] | null {
  const t = (raw ?? '').normalize('NFKC').trim();
  if (!t || !/^[0-9\s,、;；/]+$/u.test(t)) return null;
  const seats: number[] = [];
  for (const tok of t.split(/[\s,、;；/]+/u).filter(Boolean)) {
    if (tok === '10') { seats.push(10); continue; }
    for (const ch of tok) seats.push(ch === '0' ? 10 : Number(ch));
  }
  return seats;
}

/** /派 的內容 → 隊伍，或看不懂的原因。人數由呼叫端依局數檢查。 */
export function parseTeam(raw: string): { team: number[] } | { problem: string } {
  const seats = parseSeatDigits(raw);
  if (!seats || seats.length === 0) return { problem: '請在 /派 後面寫座位，例如 /派 123（0 = 第 10 家）' };
  if (new Set(seats).size !== seats.length) return { problem: '同一個座位寫了兩次' };
  return { team: [...seats].sort((a, b) => a - b) };
}

/** 紅數：`2`、`1-2`（`~`、`～`、`到` 也可以）、`1+`（至少 1）。 */
const COUNT_RE = /^(\d{1,2})(?:\s*(?:[-~～到]\s*(\d{1,2})|(\+)))?$/u;

/**
 * /區間 的內容 → 各組。每組 = 座位 + `=k` 或 `*k`（k 可以是 `1-2` 這種範圍、`1+`（至少），
 * 或 `紅`（全紅）、`好`（全好）），或座位直接接 `紅`／`壞`／`好`（百科：「3 壞」）。
 * 各組可以重疊（百科 4家：「1 2 *1-2」「2 3 7 *2」）。看不懂時只說第幾組，不回顯打的字。
 */
export function parseInterval(raw: string): { groups: IntervalGroup[] } | { problem: string } {
  const t = (raw ?? '').normalize('NFKC').replace(/[壞坏]/g, '紅').replace(/红/g, '紅').trim();
  if (!t) return { problem: '請寫區間，例如 /區間 789=2 460=1' };
  const groups: IntervalGroup[] = [];
  const re = /([0-9][0-9\s,、]*?)\s*(?:[=*]\s*(\d{1,2}\s*(?:[-~～到]\s*\d{1,2}|\+)?|紅|好)|(紅|好))/gu;
  const unreadable = (): { problem: string } => ({ problem: `第 ${groups.length + 1} 組看不懂（每組寫成 789=2、7 8 9 *2 或 3 紅）` });
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    if (t.slice(last, m.index).trim()) return unreadable();
    last = re.lastIndex;
    const spec = (m[2] ?? m[3] ?? '').trim();
    const seats = parseSeatDigits(m[1]);
    if (!seats || seats.length === 0) return unreadable();
    if (new Set(seats).size !== seats.length) return { problem: `第 ${groups.length + 1} 組裡座位重複` };
    let min: number;
    let max: number;
    if (spec === '紅') { min = seats.length; max = seats.length; }
    else if (spec === '好') { min = 0; max = 0; }
    else {
      const c = COUNT_RE.exec(spec);
      if (!c) return unreadable();
      min = Number(c[1]);
      max = c[3] ? Math.min(seats.length, 4) : c[2] === undefined ? min : Number(c[2]);
      if (min > max) [min, max] = [max, min];
    }
    if (max > seats.length) return { problem: `${seats.map((s) => (s === 10 ? 0 : s)).join('')} 只有 ${seats.length} 人，不會有 ${max} 紅` };
    if (max > 4) return { problem: '全場只有 4 紅' };
    groups.push({ seats: [...seats].sort((a, b) => a - b), min, max });
    if (groups.length > 10) return { problem: '最多 10 組' };
  }
  if (t.slice(last).trim()) return unreadable();
  if (groups.length === 0) return { problem: '請寫區間，例如 /區間 789=2 460=1' };
  return { groups };
}

/**
 * /模擬 後面的內容。照段落看：數字（可以接「家」）是座位、其他字要剛好是角色別名。
 * 一個都認不得（`/模擬什麼時候可以玩`）→ null，當一般聊天；認得一部分 → 用法。
 */
function parseStartArgs(rest: string): SimCommand | null {
  const t = rest.normalize('NFKC').trim();
  if (!t) return { kind: 'start' };
  if (HELP_WORDS.has(t.toLowerCase())) return { kind: 'help' };
  const byId = /^(?:題號?|题号?|#)\s*(\S+)$/u.exec(t);
  if (byId) {
    const id = normalizeExerciseId(byId[1]);
    return id ? { kind: 'start', exerciseId: id } : { kind: 'usage', command: 'start', problem: '題號長得像 K7Q2M-4' };
  }
  const bareId = normalizeExerciseId(t);
  if (bareId && /-/.test(t)) return { kind: 'start', exerciseId: bareId };

  let role: SimRoleChoice | undefined;
  let seat: number | undefined;
  let recognized = false;
  let junk = false;
  for (const m of t.matchAll(/(\d+)\s*[家號号]?|([^\d\s,、]+)/gu)) {
    if (m[1] !== undefined) {
      // 數字一定是想選座位（`/模擬 11` 給用法，不是聊天）。
      recognized = true;
      const s = seatOfToken(m[1]);
      if (s === null || seat !== undefined) junk = true;
      else seat = s;
      continue;
    }
    const r = parseRoleChoice(m[2]);
    if (r === null || role !== undefined) { junk = true; continue; }
    role = r;
    recognized = true;
  }
  if (junk) return recognized ? { kind: 'usage', command: 'start' } : null;
  return { kind: 'start', ...(role ? { role } : {}), ...(seat !== undefined ? { seat } : {}) };
}

/**
 * 一段聊天文字 → 模擬指令，或 null（不是模擬指令，呼叫端照一般聊天處理、不回）。
 */
export function parseSimCommand(text: string): SimCommand | null {
  const m = FULL_RE.exec((text ?? '').normalize('NFKC').trim());
  if (!m) return null;
  const rest = m[2];
  // `/派對 今晚`、`/區間 我覺得…`：後面有字但沒有任何數字 → 聊天，不是作答。
  const chatty = rest.trim() !== '' && !/[0-9]/.test(rest);
  switch (m[1]) {
    case '模擬瓦':
    case '模拟瓦':
    case '模擬':
    case '模拟':
      return parseStartArgs(rest);
    case '派': {
      if (chatty) return null;
      const r = parseTeam(rest);
      return 'team' in r ? { kind: 'propose', team: r.team } : { kind: 'usage', command: 'propose', problem: r.problem };
    }
    case '區間':
    case '区间': {
      if (chatty) return null;
      const r = parseInterval(rest);
      return 'groups' in r ? { kind: 'interval', groups: r.groups } : { kind: 'usage', command: 'interval', problem: r.problem };
    }
    case '下一步':
      return rest.trim() ? null : { kind: 'next' };
    case '公布':
    case '解答':
      return rest.trim() ? null : { kind: 'reveal' };
    case '結束':
    case '结束':
      return rest.trim() ? null : { kind: 'end' };
    default:
      return null;
  }
}

/** 是不是模擬指令（含看不懂的 /派西 2 這種）：意見計數、聊天匯出跳過它。 */
export function isSimCommandText(text: string): boolean {
  return parseSimCommand(text) !== null;
}

/** 區間的寫法（回覆用）：`789=2`、`12=1-2`。 */
export function formatIntervalGroup(g: IntervalGroup): string {
  const seats = g.seats.map((s) => (s === 10 ? '0' : String(s))).join('');
  if (g.min === 0 && g.max === 0) return `${seats}=好`;
  if (g.min === g.seats.length && g.max === g.seats.length) return `${seats}=紅`;
  return `${seats}=${g.min === g.max ? g.min : `${g.min}-${g.max}`}`;
}
