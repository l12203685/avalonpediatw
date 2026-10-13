/**
 * 三塊結果 — conditional outcome rates of a group of one player's games
 * (Edward 2026-10-14, docs/stats/two_stage_outcome.md「三塊結果」)。純函式，前後端共用。
 *
 * 一局的結果只有三種：三紅（紅方做滿三次失敗任務）、三藍死（藍方三次成功、梅林被刺中）、
 * 三藍活（三次成功、梅林沒被刺中）。任何一組場次（紅方場、藍方場、某角色、某位置）都分三塊看：
 *
 *   任務結果 mission       n = 全部場數；紅勝 = 三紅 / n，藍勝 = (三藍死 + 三藍活) / n
 *   刺殺結果 assassination n = 到達三藍的場數 (三藍死 + 三藍活)；紅勝 = 三藍死 / n，藍勝 = 三藍活 / n
 *                          （三紅的局沒有刺殺，不算在分母裡）
 *   遊戲結果 final         n = 全部場數；紅勝 = (三紅 + 三藍死) / n，藍勝 = 三藍活 / n
 *
 * 這組場次自己的「勝」看陣營：紅方角色（刺客、莫甘娜、莫德雷德、奧伯倫）取紅勝，藍方角色
 * （派西維爾、梅林、忠臣）取藍勝。每塊都附分母 n；n = 0 時勝率是 null（不是 0%）。
 *
 * 例：玩家當紅方的局裡 三紅 30、三藍死 20、三藍活 50 →
 *   任務結果 30 / 100 = 30.0%、刺殺結果 20 / 70 = 28.6%（n = 70）、遊戲結果 50 / 100 = 50.0%。
 *   舊的「三藍死(紅方) 20.0%」是 20 / 100（全部紅方場），不是刺殺成功率。
 *
 * 來源：players[].rawRed* / rawBlue*（各陣營）、players[].roleOutcomes（各角色，schemaVersion 4）、
 * players[].seatOutcomes（各位置；同一位置紅藍都有，呼叫端自己選陣營）。
 */

export type OutcomeFaction = 'red' | 'blue';

/** 三種結果的局數 (generate_cache.py OUTCOMES 的鍵)。 */
export interface OutcomeCounts {
  三紅: number;
  三藍死: number;
  三藍活: number;
}

/** 也收 OutcomeBreakdown 的英文鍵 (players[].seatOutcomes、overview.outcomeBreakdown)。 */
export type OutcomeCountsInput =
  | Partial<OutcomeCounts>
  | { threeRed?: number; threeBlueDead?: number; threeBlueAlive?: number };

export interface OutcomeBlock {
  /** 這組場次自己陣營的勝率 %，一位小數 (同 generate_cache.py rnd1：剛好 .x5 取偶數)；n = 0 時 null。 */
  win: number | null;
  /** 自己陣營贏的局數。 */
  wins: number;
  /** 這塊的分母。 */
  n: number;
}

export interface OutcomeBlocks {
  faction: OutcomeFaction;
  /** 任務結果：三紅 vs 三藍。 */
  mission: OutcomeBlock;
  /** 刺殺結果：只看到達三藍的局，三藍死 vs 三藍活。 */
  assassination: OutcomeBlock;
  /** 遊戲結果：三紅 + 三藍死 = 紅勝，三藍活 = 藍勝。 */
  final: OutcomeBlock;
}

/** 紅方角色 (generate_cache.py RED_ROLES)；其他角色 (派西維爾、梅林、忠臣) 是藍方。 */
export const RED_ROLE_NAMES: readonly string[] = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫'];

/** 角色的陣營 (中文角色名，與快取同)。 */
export function roleFaction(role: string): OutcomeFaction {
  return RED_ROLE_NAMES.includes(role) ? 'red' : 'blue';
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** 中文或英文鍵的三種結果局數；缺的、非數字、負數一律當 0。 */
export function normalizeOutcomeCounts(input: OutcomeCountsInput | null | undefined): OutcomeCounts {
  const o = (input ?? {}) as Record<string, unknown>;
  return {
    三紅: count(o['三紅'] ?? o.threeRed),
    三藍死: count(o['三藍死'] ?? o.threeBlueDead),
    三藍活: count(o['三藍活'] ?? o.threeBlueAlive),
  };
}

/**
 * wins / n 的百分比，一位小數，剛好 .x5 時取偶數 — 與 generate_cache.py 的 _rate / rnd1
 * (round(count / total * 100 * 10) / 10) 同樣的運算順序，所以和快取裡的數字一致。
 */
function pct1(wins: number, n: number): number | null {
  if (!(n > 0)) return null;
  const scaled = (wins / n) * 100 * 10;
  const floor = Math.floor(scaled);
  const tenths = scaled - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled);
  return tenths / 10;
}

function block(wins: number, n: number): OutcomeBlock {
  return { win: pct1(wins, n), wins, n };
}

/** 一組場次的三塊結果，從 `faction` 這一方看 (見檔頭)。 */
export function outcomeBlocks(counts: OutcomeCountsInput | null | undefined, faction: OutcomeFaction): OutcomeBlocks {
  const c = normalizeOutcomeCounts(counts);
  const total = c.三紅 + c.三藍死 + c.三藍活;
  const threeBlue = c.三藍死 + c.三藍活;
  const red = faction === 'red';
  return {
    faction,
    mission: block(red ? c.三紅 : threeBlue, total),
    assassination: block(red ? c.三藍死 : c.三藍活, threeBlue),
    final: block(red ? c.三紅 + c.三藍死 : c.三藍活, total),
  };
}

/** players 列的原始計數 (generate_cache.py 的 raw* 欄位；schemaVersion 1 起都有)。 */
export interface PlayerOutcomeSource {
  rawRedThreeRed?: number;
  rawRedMerlinDead?: number;
  rawRedMerlinAlive?: number;
  rawBlueThreeRed?: number;
  rawBlueMerlinDead?: number;
  rawBlueMerlinAlive?: number;
  /** schemaVersion 4：各角色生涯 {三紅, 三藍死, 三藍活}。 */
  roleOutcomes?: Record<string, OutcomeCountsInput> | null;
}

export interface PlayerOutcomeBlocks {
  /** 紅方場；快取沒有原始計數時 null。 */
  red: OutcomeBlocks | null;
  /** 藍方場；快取沒有原始計數時 null。 */
  blue: OutcomeBlocks | null;
  /** 各角色 (從該角色的陣營看)；舊快取 (schemaVersion < 4，沒有 roleOutcomes) 為 null。 */
  roles: Record<string, OutcomeBlocks> | null;
}

/** 一位玩家紅方場、藍方場、各角色的三塊結果。 */
export function playerOutcomeBlocks(p: PlayerOutcomeSource | null | undefined): PlayerOutcomeBlocks {
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const redRaw = [p?.rawRedThreeRed, p?.rawRedMerlinDead, p?.rawRedMerlinAlive];
  const blueRaw = [p?.rawBlueThreeRed, p?.rawBlueMerlinDead, p?.rawBlueMerlinAlive];
  const side = (raw: unknown[], faction: OutcomeFaction): OutcomeBlocks | null =>
    raw.every(isNum) ? outcomeBlocks({ 三紅: raw[0] as number, 三藍死: raw[1] as number, 三藍活: raw[2] as number }, faction) : null;
  let roles: Record<string, OutcomeBlocks> | null = null;
  const ro = p?.roleOutcomes;
  if (ro && typeof ro === 'object') {
    roles = {};
    for (const [role, counts] of Object.entries(ro)) roles[role] = outcomeBlocks(counts, roleFaction(role));
  }
  return { red: side(redRaw, 'red'), blue: side(blueRaw, 'blue'), roles };
}
