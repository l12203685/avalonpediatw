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
 *   /區間 789=2 460=1     區間（選填；百科寫法 `7 8 9 *2 4 6 0 *1`、`12=1-2`、`3=紅`、`5=好` 也可以）
 *   /下一步  /公布（/解答）  /結束
 *
 * 斜線可以是全形「／」，指令和內容之間的空白可有可無（跟 /戰績 一樣），全形數字照收。
 * 只認這幾個指令字：`/派西 2` 不是 /派（後面不是數字 → 'usage'，沒有進行中的題目時呼叫端不回），
 * `/結束了嗎` 不是 /結束（不回）。一般聊天一律回 null。
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
  /** 是模擬指令，但內容看不懂；`problem` 是給使用者看的一句話。 */
  | { kind: 'usage'; command: SimUsageCommand; problem?: string };

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

const COUNT_RE = /^(\d{1,2})(?:\s*[-~～到]\s*(\d{1,2}))?$/u;

/**
 * /區間 的內容 → 各組。每組 = 座位 + `=k` 或 `*k`（k 可以是 `1-2` 這種範圍，
 * 或 `紅`（全紅）、`好`（全好））。各組座位不能重疊。
 */
export function parseInterval(raw: string): { groups: IntervalGroup[] } | { problem: string } {
  const t = (raw ?? '').normalize('NFKC').replace(/[壞坏]/g, '紅').replace(/红/g, '紅').trim();
  if (!t) return { problem: '請寫區間，例如 /區間 789=2 460=1' };
  const groups: IntervalGroup[] = [];
  const seen = new Set<number>();
  const re = /([0-9][0-9\s,、]*?)\s*[=*]\s*(\d{1,2}(?:\s*[-~～到]\s*\d{1,2})?|紅|好)/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    if (t.slice(last, m.index).trim()) return { problem: '看不懂這一段：' + clip(t.slice(last, m.index).trim()) };
    last = re.lastIndex;
    const seats = parseSeatDigits(m[1]);
    if (!seats || seats.length === 0) return { problem: '每一組要先寫座位' };
    if (new Set(seats).size !== seats.length) return { problem: '同一組裡座位重複' };
    for (const s of seats) {
      if (seen.has(s)) return { problem: `第 ${s === 10 ? 0 : s} 家寫在兩組裡，各組不能重疊` };
    }
    seats.forEach((s) => seen.add(s));
    let min: number;
    let max: number;
    if (m[2] === '紅') { min = seats.length; max = seats.length; }
    else if (m[2] === '好') { min = 0; max = 0; }
    else {
      const c = COUNT_RE.exec(m[2].trim());
      if (!c) return { problem: '紅的數量看不懂' };
      min = Number(c[1]);
      max = c[2] === undefined ? min : Number(c[2]);
      if (min > max) [min, max] = [max, min];
    }
    if (max > seats.length) return { problem: `${seats.map((s) => (s === 10 ? 0 : s)).join('')} 只有 ${seats.length} 人，不會有 ${max} 紅` };
    if (max > 4) return { problem: '全場只有 4 紅' };
    groups.push({ seats: [...seats].sort((a, b) => a - b), min, max });
    if (groups.length > 10) return { problem: '最多 10 組' };
  }
  if (t.slice(last).trim()) return { problem: '看不懂這一段：' + clip(t.slice(last).trim()) };
  if (groups.length === 0) return { problem: '請寫區間，例如 /區間 789=2 460=1' };
  return { groups };
}

/** 使用者打的字最多回顯這麼多（避免整段貼回）。 */
function clip(s: string): string {
  return s.length > 12 ? `${s.slice(0, 12)}…` : s;
}

function parseStartArgs(rest: string): SimCommand {
  let t = rest.normalize('NFKC').trim();
  if (!t) return { kind: 'start' };
  const byId = /^(?:題號?|题号?|#)\s*(\S+)$/u.exec(t);
  if (byId) {
    const id = normalizeExerciseId(byId[1]);
    return id ? { kind: 'start', exerciseId: id } : { kind: 'usage', command: 'start', problem: '題號長得像 K7Q2M-4' };
  }
  const bareId = normalizeExerciseId(t);
  if (bareId && /-/.test(t)) return { kind: 'start', exerciseId: bareId };

  let role: SimRoleChoice | undefined;
  let seat: number | undefined;
  for (const [alias, r] of ROLE_ALIASES) {
    const i = t.indexOf(alias);
    if (i >= 0) {
      role = r;
      t = `${t.slice(0, i)} ${t.slice(i + alias.length)}`;
      break;
    }
  }
  const tokens = t.split(/[\s,、]+/u).filter(Boolean);
  for (const tok of tokens) {
    const s = seatOfToken(tok.replace(/[家號号]$/u, ''));
    if (s === null || seat !== undefined) return { kind: 'usage', command: 'start' };
    seat = s;
  }
  return { kind: 'start', ...(role ? { role } : {}), ...(seat !== undefined ? { seat } : {}) };
}

/**
 * 一段聊天文字 → 模擬指令，或 null（不是模擬指令，呼叫端照一般聊天處理、不回）。
 */
export function parseSimCommand(text: string): SimCommand | null {
  const m = FULL_RE.exec((text ?? '').normalize('NFKC').trim());
  if (!m) return null;
  const rest = m[2];
  switch (m[1]) {
    case '模擬瓦':
    case '模拟瓦':
    case '模擬':
    case '模拟':
      return parseStartArgs(rest);
    case '派': {
      const r = parseTeam(rest);
      return 'team' in r ? { kind: 'propose', team: r.team } : { kind: 'usage', command: 'propose', problem: r.problem };
    }
    case '區間':
    case '区间': {
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
