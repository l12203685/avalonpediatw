/**
 * 模擬瓦（2026-10-14）— 指令解析，純函式（不讀檔、不連網、不記 log）。
 *
 * Edward 2026-10-14：「Line bot/dc bot 有辦法支援模擬瓦嗎? 不是練習局
 * 模擬瓦比較像是練習邏輯思考跟派隊資訊的釋放與解讀」。
 *
 *   /模擬                 隨機一題（第 1 局 2～5 家，任何角色）
 *   /模擬 派西 2          指定角色／座位（順序不拘，也可以只給其中一個；紅、藍 = 隨機紅方／藍方角色）
 *   /模擬 題 K7Q2M-4      指定題號（整群可以做同一題）；2026-11-21 起 `K7Q2M 3-5`、`K7Q2M 4家`、`K7Q2M 刺殺`、
 *                         只打局號 `K7Q2M` 也可以（「題」可以省略），見 parseExerciseRef
 *   /派 469               作答（0 = 0 家；`4 6 9`、`4,6,9`、`4 6 10` 都可以）
 *   /區間 789=2 460=1     區間（選填；百科寫法 `7 8 9 *2 4 6 0 *1`、`12=1-2`、`3=紅`、`3 壞`、`5=好`、
 *                         `1 5 9 *1+` 也可以；各組可以重疊，跟百科「1 2 *1-2」「2 3 7 *2」一樣）
 *   /分析                 剛剛那次 /派 的完整解讀（2026-11-16：/派 只回幾好幾壞，解讀改用這個指令看）
 *   /模擬 1-5～4-5、5局   從那一局第 5 次派票（尾派）／第 5 局開始（可以加角色、座位：/模擬 3-5 梅林）
 *   /模擬 4局             第 4 局隨機一次忠臣當隊長的派票（2026-11-19；加角色就出那個角色）
 *   /模擬 刺殺            刺殺題（你是刺客），/刺 座位 作答
 *   /模擬 今天            照 Threads 的每週主題出題（2026-11-16）
 *   /區間                 （不帶內容）百科AI 怎麼讀這個局面：各家紅機率、最可能的紅方、百科AI 會派的隊（Edward 2026-11-17）
 *   /公布（/解答）  /結束
 *   （/下一步 2026-11-17 拿掉：打了只回一行說明）
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

export type SimUsageCommand = 'start' | 'propose' | 'interval' | 'assassinate';

export type SimCommand =
  | {
    kind: 'start'; role?: SimRoleChoice; seat?: number; exerciseId?: string; midRound?: number; anyAttempt?: boolean; special?: 'assassin' | 'today';
    /** 只有局號（`/模擬 K7Q2M`，2026-11-21）：這一局最值得想的地方。 */
    gameId?: string;
  }
  /** /刺 座位：刺殺題的答案。 */
  | { kind: 'assassinate'; seat: number }
  | { kind: 'propose'; team: number[] }
  /** /分析：這個決定點最後一次 /派 的完整解讀。 */
  | { kind: 'analyze' }
  | { kind: 'interval'; groups: IntervalGroup[] }
  /** /區間（不帶內容）：百科AI 怎麼讀這個局面。 */
  | { kind: 'read' }
  /** 拿掉的指令（/下一步）：回一行說明。 */
  | { kind: 'removed'; command: string }
  | { kind: 'reveal' }
  | { kind: 'end' }
  /** /模擬 說明：全部指令的白話說明。 */
  | { kind: 'help' }
  /** 是模擬指令，但內容看不懂；`problem` 是給使用者看的一句話。 */
  | { kind: 'usage'; command: SimUsageCommand; problem?: string };

/** 對開著的題目做的事（/派 /分析 /區間 /公布 /結束，以及看不懂的 /派、/區間）。 */
export function isFollowUpCommand(cmd: SimCommand): boolean {
  return isCoAnswerable(cmd) || cmd.kind === 'removed' || (cmd.kind === 'usage' && cmd.command !== 'start');
}

/**
 * 可以幫別人的題目代答的指令：只有**寫對的** /派 /區間 /公布 /結束（2026-10-22 審查修正）。
 * 看不懂的 /派、/區間（像聊天的斜線句子）不代答：自己沒開題的人打的照舊不回、照舊同步、不延長別人的題目。
 */
export function isCoAnswerable(cmd: SimCommand): boolean {
  return cmd.kind === 'propose' || cmd.kind === 'assassinate' || cmd.kind === 'analyze' || cmd.kind === 'interval' || cmd.kind === 'read' || cmd.kind === 'reveal' || cmd.kind === 'end';
}

/** /模擬 後面的「說明」字：說明、幫助、指令、?（全形也可以）。 */
const HELP_WORDS = new Set(['說明', '说明', '幫助', '帮助', '指令', '?', '？', 'help']);

/** 指令字（長的在前：模擬瓦 先於 模擬）。chatExport/rows.ts 也用它認出打字的指令。 */
export const SIM_COMMAND_RE = /^[/／]\s*(模擬瓦|模拟瓦|模擬|模拟|區間|区间|下一步|公布|解答|結束|结束|分析|刺殺|刺杀|刺|派)/u;

const FULL_RE = /^\/\s*(模擬瓦|模拟瓦|模擬|模拟|區間|区间|下一步|公布|解答|結束|结束|分析|刺殺|刺杀|刺|派)(.*)$/su;

/** 角色別名 → 角色（長的先比）。 */
const ROLE_ALIASES: ReadonlyArray<readonly [string, SimRoleChoice]> = ([
  // 2026-11-21（玩家回饋「/模擬 奧伯5」不認得）：補上常見的短寫與同音字（奧伯、歐伯倫、莫甘、娜娜、莫德雷、魔德、派西維…）。
  ['派西維爾', 'percival'], ['派西维尔', 'percival'], ['派西瓦爾', 'percival'], ['派西瓦尔', 'percival'], ['派西維', 'percival'], ['派西维', 'percival'],
  ['派希維爾', 'percival'], ['派希维尔', 'percival'], ['派西', 'percival'], ['派希', 'percival'], ['派', 'percival'],
  ['梅林', 'merlin'], ['梅', 'merlin'],
  ['忠臣', 'loyal'], ['雜魚', 'loyal'], ['杂鱼', 'loyal'], ['忠', 'loyal'],
  ['刺客', 'assassin'], ['刺', 'assassin'],
  ['莫甘娜', 'morgana'], ['魔甘娜', 'morgana'], ['摩甘娜', 'morgana'], ['莫甘', 'morgana'], ['魔甘', 'morgana'], ['娜娜', 'morgana'], ['娜', 'morgana'],
  ['莫德雷德', 'mordred'], ['默德雷德', 'mordred'], ['莫德雷', 'mordred'], ['默德雷', 'mordred'], ['莫德', 'mordred'], ['默德', 'mordred'], ['魔德', 'mordred'], ['德', 'mordred'],
  ['奧伯倫', 'oberon'], ['奥伯伦', 'oberon'], ['奧柏倫', 'oberon'], ['奥柏伦', 'oberon'], ['歐伯倫', 'oberon'], ['欧伯伦', 'oberon'],
  ['奧伯龍', 'oberon'], ['奥伯龙', 'oberon'], ['奧伯', 'oberon'], ['奥伯', 'oberon'], ['奧柏', 'oberon'], ['奥柏', 'oberon'], ['歐伯', 'oberon'], ['欧伯', 'oberon'],
  ['奧', 'oberon'], ['奥', 'oberon'],
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

/** Crockford base32 的局號字元（題號前半段）。 */
const GAME_CODE = '[0-9A-HJKMNP-TV-Z]{5,8}';

/** I/L 當 1、O 當 0，不分大小寫。 */
function crockfordUpper(raw: string): string {
  return (raw ?? '').normalize('NFKC').trim().toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
}

/**
 * Crockford base32：題號裡 I/L 當 1、O 當 0，不分大小寫。
 * `K7Q2M-4`（4 家的第一個決定）或 `K7Q2M-3-5`（第 3 局第 5 次開始，2026-11-16）。
 */
export function normalizeExerciseId(raw: string): string | null {
  const t = crockfordUpper(raw);
  return new RegExp(`^${GAME_CODE}-(?:[0-9]|[1-5]-[1-5]|A)$`).test(t) ? t : null;
}

/** 局號（題號前半段，例如 `K7Q2M`），或 null。 */
export function normalizeGameCode(raw: string): string | null {
  const t = crockfordUpper(raw);
  return new RegExp(`^${GAME_CODE}$`).test(t) ? t : null;
}

/**
 * 題號的寫法（2026-11-21，玩家回饋：想跳到同一局的別的時間點，打 `K7Q2M 3-5`、`K7Q2M-5 1-1` 都回用法）。
 * 題號 = **局號 + 位置**，中間空白或 `-` 都可以：
 *   - `K7Q2M 3-5`／`K7Q2M-3-5`：第 3 局第 5 次（坐那一次的隊長）；`1-1`～`5-5` 都可以；
 *   - `K7Q2M 4家`／`K7Q2M 4`／`K7Q2M-4`：4 家第一次派票（舊寫法照舊）；
 *   - `K7Q2M 刺殺`／`K7Q2M-A`：刺殺題；
 *   - 只打 `K7Q2M`：這一局最值得想的地方（跟什麼都沒指定的 /模擬 同一套評分），附同一局另外值得想的題號；
 *   - 舊題號後面再接位置（`K7Q2M-4 3-5`）：換到那個位置（同一局）。
 * 回傳：`exerciseId`（正式題號，`K7Q2M-3-5` 這種，Threads 與題庫用的同一個）、`gameId`（只有局號），
 * 或 `problem`（局號看得懂、位置看不懂）。不像題號 → null。
 */
export type ExerciseRef = { exerciseId: string } | { gameId: string } | { problem: string };

/** 題號後半段（位置）→ 正式題號的尾巴（`4`、`3-5`、`A`），看不懂 null。 */
function spotSuffix(raw: string): string | null {
  const t = raw.normalize('NFKC').trim();
  if (/^(?:A|a|刺殺|刺杀|刺殺題|刺)$/u.test(t)) return 'A';
  const stage = /^([1-5])\s*[-－~～]\s*([1-5])$/u.exec(t);
  if (stage) return `${stage[1]}-${stage[2]}`;
  const seat = /^(10|[0-9])\s*[家號号]?$/u.exec(t);
  if (seat) return seat[1] === '10' ? '0' : seat[1];
  return null;
}

export const SAME_GAME_HINT = '同一局換位置：題號後面空一格寫位置，例如 /模擬 K7Q2M 3-5（第 3 局第 5 次）、/模擬 K7Q2M 4家（4家第一次派票）、/模擬 K7Q2M 刺殺；只打 /模擬 K7Q2M = 這局最值得想的地方';

export function parseExerciseRef(raw: string): ExerciseRef | null {
  const t = (raw ?? '').normalize('NFKC').trim();
  const whole = normalizeExerciseId(t);
  if (whole) return { exerciseId: whole };
  const m = /^([0-9A-Za-z]{5,8})(.*)$/su.exec(t);
  const code = m ? normalizeGameCode(m[1]) : null;
  if (!m || !code) return null;
  const rest = m[2];
  if (!rest.trim()) return { gameId: code };
  // 舊題號（K7Q2M-4、K7Q2M-A）後面再接位置：位置算數（同一局）。
  const after = /^-(?:10|[0-9]|[Aa])\s+(.+)$/su.exec(rest) ?? /^[-\s]+(.+)$/su.exec(rest);
  if (!after) return null;
  const suffix = spotSuffix(after[1]);
  return suffix ? { exerciseId: `${code}-${suffix}` } : { problem: SAME_GAME_HINT };
}

/** `/模擬 1-5`～`4-5`（尾派）、`4局`（第 4 局任何一次，2026-11-19）、`5局`（第 5 局）的局面字（-、－、~ 都可以）。 */
const MID_RE = /(?:^|\s)(?:([1-4])\s*[-－~～]\s*5|(?:第\s*)?([45四五])\s*局)(?=\s|$)/u;

/** `/模擬 刺殺`、`/模擬 今天`（只能單獨用）。 */
const SPECIAL_WORDS: ReadonlyMap<string, 'assassin' | 'today'> = new Map([
  ['刺殺', 'assassin'], ['刺杀', 'assassin'], ['刺殺題', 'assassin'],
  ['今天', 'today'], ['今日', 'today'], ['本日', 'today'],
]);

/** 座位字：1–9、0 或 10 → 1–10。 */
function seatOfToken(tok: string): number | null {
  if (tok === '10' || tok === '0') return 10;
  if (/^[1-9]$/.test(tok)) return Number(tok);
  return null;
}

/**
 * 座位字串 → 座位。`469`、`4 6 9`、`4,6,9`、`4、6、9`、`4 6 10`：用分隔符號分開的
 * 一段剛好是 `10` 也當成 0 家（第十個座位），其他每個數字一個座位（0 = 0 家）。
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
  if (!seats || seats.length === 0) return { problem: '請在 /派 後面寫座位，例如 /派 123（0 家寫 0）' };
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

/** 題號（parseExerciseRef 的結果）→ 開題指令；不像題號或位置看不懂 → 用法。 */
export function refCommand(ref: ExerciseRef | null): SimCommand {
  if (ref && 'exerciseId' in ref) return { kind: 'start', exerciseId: ref.exerciseId };
  if (ref && 'gameId' in ref) return { kind: 'start', gameId: ref.gameId };
  return { kind: 'usage', command: 'start', problem: ref ? ref.problem : `題號長得像 K7Q2M-4 或 K7Q2M 3-5。${SAME_GAME_HINT}` };
}

/**
 * /模擬 後面的內容。照段落看：數字（可以接「家」）是座位、其他字要剛好是角色別名。
 * 一個都認不得（`/模擬什麼時候可以玩`）→ null，當一般聊天；認得一部分 → 用法。
 */
function parseStartArgs(rest: string): SimCommand | null {
  const t = rest.normalize('NFKC').trim();
  if (!t) return { kind: 'start' };
  if (HELP_WORDS.has(t.toLowerCase())) return { kind: 'help' };
  const byId = /^(?:題號?|题号?|#)\s*(.+)$/su.exec(t);
  if (byId) return refCommand(parseExerciseRef(byId[1]));
  // 不加「題」也可以：開頭是局號（裡面有英文字母，免得跟座位數字混在一起）或完整的舊題號。
  if (normalizeExerciseId(t) || /^(?=[0-9]*[A-Za-z])[0-9A-Za-z]{5,8}(?:$|[-\s])/u.test(t)) {
    const ref = parseExerciseRef(t);
    if (ref) return refCommand(ref);
  }

  const special = SPECIAL_WORDS.get(t);
  if (special) return { kind: 'start', special };
  if ([...SPECIAL_WORDS.keys()].some((w) => t.split(/\s+/u).includes(w))) return { kind: 'usage', command: 'start' };

  // 局面（1-5～4-5、5局）：先拿掉局面字，剩下的照角色、座位讀（`/模擬 3-5 梅林`）。
  const mid = MID_RE.exec(t);
  if (mid) {
    const others = t.replace(MID_RE, ' ').trim();
    const parsed = others ? parseStartArgs(others) : { kind: 'start' as const };
    if (!parsed) return { kind: 'usage', command: 'start' };
    if (parsed.kind !== 'start' || parsed.exerciseId || parsed.gameId || parsed.midRound !== undefined || parsed.special) return { kind: 'usage', command: 'start' };
    if (mid[1]) return { ...parsed, midRound: Number(mid[1]) };
    return mid[2] === '4' || mid[2] === '四' ? { ...parsed, midRound: 4, anyAttempt: true } : { ...parsed, midRound: 5 };
  }

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
      if (rest.trim() === '') return { kind: 'read' };
      const r = parseInterval(rest);
      return 'groups' in r ? { kind: 'interval', groups: r.groups } : { kind: 'usage', command: 'interval', problem: r.problem };
    }
    case '分析':
      return rest.trim() ? null : { kind: 'analyze' };
    case '刺':
    case '刺殺':
    case '刺杀': {
      // `/刺客`、`/刺殺梅林吧`：後面沒有數字 → 聊天。
      if (rest.trim() === '' || chatty) return null;
      const seats = parseSeatDigits(rest);
      if (!seats || seats.length !== 1) return { kind: 'usage', command: 'assassinate', problem: '只能刺一個座位，例如 /刺 3' };
      return { kind: 'assassinate', seat: seats[0] };
    }
    case '下一步':
      return rest.trim() ? null : { kind: 'removed', command: '下一步' };
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
