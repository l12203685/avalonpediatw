/**
 * 兩紅之後的派隊（Edward 2026-11-11）：紅方已經拿下兩個任務之後，藍方（梅林／派西維爾／忠臣）當隊長時派出的隊
 * 裡有沒有紅方。原話：「兩紅代表所有玩家都至少給過一次任務組合，並且湖中也至少使用過一次」，所以到這時候每個人
 * 手上的資訊最多，派出來的隊最能看出功力。
 *
 *   時機   提議當下紅方剛好已經贏兩個任務（之前的任務都有結果、三紅還沒出現）：第 3 局（前兩局都紅）、
 *          第 4 局（前三局兩紅一藍）、第 5 局（二比二）。
 *   隊長   每次提議的隊長由跨輪輪替推出來（deriveLeaderSeats，與失誤偵測、自動發現同一套）；推不出來的局整局不算。
 *          輪替假設提議紀錄完整、依序：提議紀錄有缺（不是從第 1 局第 1 次開始、某局整局沒有、某局的次數跳號）的局，
 *          缺口之後的隊長會推錯，所以也整局不算（記在略過的局數裡）。
 *   次序   該局的第幾次提議（資料集的 attempt）：第 1～4 次、第 5 次 = 尾派（強制派出）。
 *   分類   紅方 = 刺客、莫甘娜、莫德雷德、奧伯倫；「拇指」= 梅林夜裡看得到的紅方（刺客、莫甘娜、奧伯倫；遊戲的角色
 *          定義 types/game.ts：梅林看得到莫德雷德以外的所有紅方，所以奧伯倫也是拇指，莫德雷德不是）。
 *          分類互斥，每一列加起來 = 100%：
 *            第 3、5 局（一張失敗就紅）
 *              全好                     隊上沒有紅方
 *              全沒拇指但派到莫德雷德   沒有拇指、但莫德雷德在隊上
 *              派到至少一根拇指         隊上至少一個拇指（有沒有莫德雷德都一樣）
 *            第 4 局（兩張失敗才紅）
 *              全好                     隊上沒有紅方
 *              全沒拇指但派到莫德雷德   隊上唯一的紅方是莫德雷德
 *              只含一拇指               隊上剛好一個紅方、而且是拇指
 *              含兩壞以上               隊上兩個以上紅方（莫德雷德也算）
 *
 * 資料集只有 10 人局（配置 6 碼 = 刺客、莫甘娜、莫德雷德、奧伯倫、派西維爾、梅林，其餘四位忠臣），定義照 10 人局；
 * 配置不是 6 個不同數字的局（角色不完整）不算。
 */
import { RED_ROLES, SEATS } from './constants';
import type { Game } from './dataset';
import { deriveLeaderSeats } from './mistakes';
import {
  PLAYER_TIER_KEYS, cohortGrid, cohortHistogram, latestPlayerPr, playerTier, seatCohort,
  type CohortCell, type CohortCuts, type CohortGrid, type CohortHistogram, type CohortRecord, type PlayerTierKey,
} from './cohort';

export const TWO_RED_ROLES = ['梅林', '派西維爾', '忠臣'] as const;
export type TwoRedRole = (typeof TWO_RED_ROLES)[number];
export const TWO_RED_ROUNDS = [3, 4, 5] as const;
export type TwoRedRound = (typeof TWO_RED_ROUNDS)[number];
/** 每張表的列：第 1～4 次、尾派（第 5 次）、合計。 */
export const TWO_RED_SLOTS = [1, 2, 3, 4, 5] as const;
export const TWO_RED_TOTAL_INDEX = 5;

export const MORDRED = '莫德雷德';
/** 梅林看得到的紅方（拇指）= 莫德雷德以外的紅方：刺客、莫甘娜、奧伯倫。 */
export const MERLIN_VISIBLE_REDS: ReadonlySet<string> = new Set([...RED_ROLES].filter((r) => r !== MORDRED));

/**
 * 分類（互斥）：allGood 全好、mordred 全沒拇指但派到莫德雷德、thumb 派到至少一根拇指（第 3、5 局）、
 * oneThumb 只含一拇指、twoPlusRed 含兩壞以上（第 4 局）。
 */
export type TwoRedCategory = 'allGood' | 'mordred' | 'thumb' | 'oneThumb' | 'twoPlusRed';

/** 每一局的分類（表的欄，依序）；同一局的分類加起來 = 該列的次數。 */
export const TWO_RED_CATEGORIES: Readonly<Record<TwoRedRound, readonly TwoRedCategory[]>> = {
  3: ['allGood', 'mordred', 'thumb'],
  4: ['allGood', 'mordred', 'oneThumb', 'twoPlusRed'],
  5: ['allGood', 'mordred', 'thumb'],
};

/** 一隊屬於哪一類：reds = 紅方人數、thumbs = 拇指人數（紅方 − 拇指 = 莫德雷德）。 */
export function twoRedCategory(round: TwoRedRound, reds: number, thumbs: number): TwoRedCategory {
  if (reds === 0) return 'allGood';
  if (round === 4) {
    if (reds >= 2) return 'twoPlusRed';
    return thumbs === 1 ? 'oneThumb' : 'mordred';
  }
  return thumbs > 0 ? 'thumb' : 'mordred';
}

/** 一格：提議次數與各分類的次數（只有該局的分類會有數字）。 */
export type TwoRedCounts = { n: number } & Record<TwoRedCategory, number>;

/** 角色 → 第幾局 → 6 列（第 1～4 次、尾派、合計）。 */
export type TwoRedTable = Record<TwoRedRole, Record<TwoRedRound, TwoRedCounts[]>>;

/** 一次符合條件的提議。 */
export interface TwoRedProposal {
  seq: number;
  /** 隊長座位上的名字（沒寫名字 = null）。 */
  player: string | null;
  /** 隊長的座位字元（SEATS 的一個；自動發現的「隊長座位」與叢集用）。 */
  seat: string;
  role: TwoRedRole;
  round: TwoRedRound;
  /** 1..5（5 = 尾派）。 */
  slot: number;
  team: string;
  reds: number;
  thumbs: number;
  category: TwoRedCategory;
  /** 隊長那一局開打前的 PR（benchmarks.ts seatPr；暫定、沒寫名字、沒評分 = null）。分組（cohort.ts）用。 */
  pr: number | null;
  /** 那一局的 S（沒評分 = null）。 */
  s: number | null;
}

export interface TwoRedProposals {
  proposals: TwoRedProposal[];
  /** 有兩紅局面的局數（不論隊長能不能推出來）。 */
  twoRedGames: number;
  /** 其中隊長推不出來（或提議紀錄有缺）、整局不算的局數。 */
  skippedGames: number;
}

export interface TwoRedReport {
  /** 這位玩家（沒有提議 = 全部 0）。 */
  player: TwoRedTable;
  /** 全體：所有隊長的合計（同一組局）。 */
  all: TwoRedTable;
  /** 這位玩家有幾局出現在表裡。 */
  playerGames: number;
  twoRedGames: number;
  skippedGames: number;
}

const isTwoRedRole = (role: string): role is TwoRedRole => (TWO_RED_ROLES as readonly string[]).includes(role);

/** 隊伍的紅方人數與拇指人數。 */
export function teamReds(team: string, seatRoles: ReadonlyMap<string, string>): { reds: number; thumbs: number } {
  let reds = 0;
  let thumbs = 0;
  for (const seat of team) {
    const role = seatRoles.get(seat) ?? '';
    if (RED_ROLES.has(role)) reds += 1;
    if (MERLIN_VISIBLE_REDS.has(role)) thumbs += 1;
  }
  return { reds, thumbs };
}

/**
 * 第 round 局開始前紅方贏了幾個任務；前面有任務沒有結果（"" / "?"）時 null（比分不知道）。
 * 用 Game.rounds（第 4 局兩張失敗才算紅，與牌譜的局勢欄相同）。
 */
export function redWinsBefore(g: Pick<Game, 'rounds'>, round: number): number | null {
  let red = 0;
  for (let i = 0; i < round - 1; i += 1) {
    const r = g.rounds[i];
    if (r === '紅') red += 1;
    else if (r !== '藍') return null;
  }
  return red;
}

/** 配置是 6 個不同的數字（六個特殊角色都有座位）。 */
export const fullConfig = (config: string): boolean => /^[0-9]{6}$/.test(config) && new Set(config).size === 6;

/**
 * 提議紀錄完整、依序：從第 1 局第 1 次開始，同一局的次數 1, 2, 3…連號，下一局從第 1 次開始、局數連號。
 * 有缺口時跨輪輪替會在缺口之後錯位，推出來的隊長不可信。
 */
export function contiguousProposals(proposals: Game['votingProposals']): boolean {
  let round = 1;
  let attempt = 0;
  for (const [r, a] of proposals) {
    if (r === round && a === attempt + 1) attempt = a;
    else if (r === round + 1 && a === 1) { round = r; attempt = 1; }
    else return false;
  }
  return proposals.length > 0;
}

/** 一局裡符合條件的提議；隊長推不出來（或提議紀錄有缺）→ null（有兩紅局面時呼叫端記為略過）。 */
function gameTwoRedProposals(g: Game): { hasTwoRed: boolean; proposals: TwoRedProposal[] | null } {
  if (!fullConfig(g.config)) return { hasTwoRed: false, proposals: [] };
  const indexes: number[] = [];
  g.votingProposals.forEach(([round], k) => {
    // 紅方剛好兩勝（三紅還沒出現）；藍方最多兩勝（第 5 局 = 二比二），所以遊戲還沒結束
    if ((round === 3 || round === 4 || round === 5) && redWinsBefore(g, round) === 2) indexes.push(k);
  });
  if (!indexes.length) return { hasTwoRed: false, proposals: [] };
  const leaders = contiguousProposals(g.votingProposals) ? deriveLeaderSeats(g.votingProposals.map((p) => p[2])) : null;
  if (!leaders) return { hasTwoRed: true, proposals: null };
  const out: TwoRedProposal[] = [];
  for (const k of indexes) {
    const [round, attempt, team] = g.votingProposals[k];
    const seat = leaders[k];
    const role = g.seatRoles.get(seat) ?? '';
    if (!isTwoRedRole(role)) continue;
    const i = (SEATS as readonly string[]).indexOf(seat);
    const { reds, thumbs } = teamReds(team, g.seatRoles);
    const cohort = i >= 0 ? seatCohort(g, i) : { pr: null, s: g.lineup ? g.lineup.s : null };
    out.push({
      seq: g.seq,
      player: i >= 0 ? g.seatPlayers[i] : null,
      seat,
      role,
      round: round as TwoRedRound,
      slot: Math.min(Math.max(attempt, 1), 5),
      team,
      reds,
      thumbs,
      category: twoRedCategory(round as TwoRedRound, reds, thumbs),
      pr: cohort.pr,
      s: cohort.s,
    });
  }
  return { hasTwoRed: true, proposals: out };
}

/** 全部局裡藍方隊長在兩紅之後的提議。 */
export function twoRedProposals(games: readonly Game[]): TwoRedProposals {
  const proposals: TwoRedProposal[] = [];
  let twoRedGames = 0;
  let skippedGames = 0;
  for (const g of games) {
    const r = gameTwoRedProposals(g);
    if (!r.hasTwoRed) continue;
    twoRedGames += 1;
    if (r.proposals === null) skippedGames += 1;
    else proposals.push(...r.proposals);
  }
  return { proposals, twoRedGames, skippedGames };
}

const emptyCounts = (): TwoRedCounts => ({ n: 0, allGood: 0, mordred: 0, thumb: 0, oneThumb: 0, twoPlusRed: 0 });

export function emptyTwoRedTable(): TwoRedTable {
  const table = {} as TwoRedTable;
  for (const role of TWO_RED_ROLES) {
    table[role] = {} as Record<TwoRedRound, TwoRedCounts[]>;
    for (const round of TWO_RED_ROUNDS) table[role][round] = Array.from({ length: TWO_RED_SLOTS.length + 1 }, emptyCounts);
  }
  return table;
}

function addTo(c: TwoRedCounts, p: TwoRedProposal): void {
  c.n += 1;
  c[p.category] += 1;
}

/** 提議 → 表（player 給了就只算那位玩家的提議）。 */
export function twoRedTable(proposals: readonly TwoRedProposal[], player?: string | null): TwoRedTable {
  const table = emptyTwoRedTable();
  for (const p of proposals) {
    if (player !== undefined && player !== null && p.player !== player) continue;
    const rows = table[p.role][p.round];
    addTo(rows[p.slot - 1], p);
    addTo(rows[TWO_RED_TOTAL_INDEX], p);
  }
  return table;
}

/** 一位玩家的兩紅之後派隊表＋全體的同一張表。 */
export function computeTwoRedReport(games: readonly Game[], player: string, prepared?: { data: TwoRedProposals; all: TwoRedTable }): TwoRedReport {
  const data = prepared?.data ?? twoRedProposals(games);
  const all = prepared?.all ?? twoRedTable(data.proposals);
  const mine = data.proposals.filter((p) => p.player === player);
  return {
    player: twoRedTable(mine),
    all,
    playerGames: new Set(mine.map((p) => p.seq)).size,
    twoRedGames: data.twoRedGames,
    skippedGames: data.skippedGames,
  };
}

/** 比率（%，一位小數）；n = 0 → null。顯示整數時直接用 hits / n 四捨五入，不要再把這個值取整（會四捨五入兩次）。 */
export function twoRedShare(hits: number, n: number): number | null {
  return n > 0 ? Math.round((hits / n) * 1000) / 10 : null;
}

// ── 分組：強者／一般人／新手 × 高端／普通／歡樂（cohort.ts 的慣例：個人樣本太小，看合併的組）──────────

/** 九宮格的 counts 依這個順序（cohortGrid 的 width = 5）。 */
export const TWO_RED_CATEGORY_ORDER: readonly TwoRedCategory[] = ['allGood', 'mordred', 'thumb', 'oneThumb', 'twoPlusRed'];
/** 第 4 局「最多一個紅方」= 全好 + 只有莫德雷德 + 只含一拇指（兩張失敗才紅，這支隊出任務一定成功）。 */
export const TWO_RED_R4_SAFE: readonly TwoRedCategory[] = ['allGood', 'mordred', 'oneThumb'];

/** 分組用的提議（給網站的精簡版：沒有隊伍與人數）。 */
export type TwoRedCohortProposal = Pick<TwoRedProposal, 'seq' | 'player' | 'role' | 'round' | 'slot' | 'category' | 'pr' | 's'>;

export interface TwoRedCohortData {
  proposals: TwoRedCohortProposal[];
  /** 每位玩家在這些局裡最近一局有 PR 的 PR（玩家雷達「跟自己的組比」用）。 */
  playerPr: Record<string, number>;
  /** 這些局的 PR 與 S 分布（切點的說明用）。 */
  histogram: CohortHistogram;
  twoRedGames: number;
  skippedGames: number;
}

/** 局 → 分組要的資料（統計 Worker 裡算一次，切點在網站上換，不用重算）。 */
export function twoRedCohortData(games: readonly Game[], prepared?: TwoRedProposals): TwoRedCohortData {
  const data = prepared ?? twoRedProposals(games);
  return {
    proposals: data.proposals.map(({ seq, player, role, round, slot, category, pr, s }) => ({ seq, player, role, round, slot, category, pr, s })),
    playerPr: Object.fromEntries(latestPlayerPr(games)),
    histogram: cohortHistogram(games),
    twoRedGames: data.twoRedGames,
    skippedGames: data.skippedGames,
  };
}

/** 一次提議 → 九宮格的一筆（counts = TWO_RED_CATEGORY_ORDER 的 one-hot）。 */
export function twoRedCohortRecord(p: TwoRedCohortProposal): CohortRecord {
  return {
    player: p.player,
    game: p.seq,
    pr: p.pr,
    s: p.s,
    n: 1,
    counts: TWO_RED_CATEGORY_ORDER.map((c) => (c === p.category ? 1 : 0)),
  };
}

/** 選哪一格：角色、第幾局、哪一列（1..5 = 第 1～4 次、尾派；'total' = 合計）。 */
export interface TwoRedSelection {
  role: TwoRedRole;
  round: TwoRedRound;
  slot: number | 'total';
}

const inSelection = (p: TwoRedCohortProposal, sel: TwoRedSelection): boolean =>
  p.role === sel.role && p.round === sel.round && (sel.slot === 'total' || p.slot === sel.slot);

/** 選定的角色／局／列 → 九宮格（玩家分層 × 桌分層；counts = TWO_RED_CATEGORY_ORDER）。 */
export function twoRedCohortGrid(proposals: readonly TwoRedCohortProposal[], cuts: CohortCuts, sel: TwoRedSelection): CohortGrid {
  return cohortGrid(proposals.filter((p) => inSelection(p, sel)).map(twoRedCohortRecord), cuts, TWO_RED_CATEGORY_ORDER.length);
}

/** 一格的分類次數＋人數（分組的表）。 */
export type TwoRedCohortCounts = TwoRedCounts & { players: number };

/** 九宮格的一格 → 表的一格。 */
export function twoRedCountsOf(cell: CohortCell): TwoRedCohortCounts {
  const out = { n: cell.n, players: cell.players } as TwoRedCohortCounts;
  TWO_RED_CATEGORY_ORDER.forEach((c, k) => { out[c] = cell.counts[k] ?? 0; });
  return out;
}

export type TwoRedTierKey = PlayerTierKey | 'all';
export const TWO_RED_TIER_KEYS: readonly TwoRedTierKey[] = [...PLAYER_TIER_KEYS, 'all'];

/** 依玩家分層的表（每組一張跟玩家雷達同形狀的表）＋每組的人數與提議數（全部角色、局合計）。 */
export interface TwoRedTierTables {
  tables: Record<TwoRedTierKey, Record<TwoRedRole, Record<TwoRedRound, TwoRedCohortCounts[]>>>;
  players: Record<TwoRedTierKey, number>;
  proposals: Record<TwoRedTierKey, number>;
}

/**
 * 提議 → 每個玩家分層（強者／一般人／新手／未評分）與全體各一張表。每一列都由同一個 cohortGrid 的列合計來，
 * 所以表與九宮格的合計一定對得上。
 */
export function twoRedTierTables(proposals: readonly TwoRedCohortProposal[], cuts: CohortCuts): TwoRedTierTables {
  const tables = {} as TwoRedTierTables['tables'];
  for (const tier of TWO_RED_TIER_KEYS) {
    tables[tier] = {} as Record<TwoRedRole, Record<TwoRedRound, TwoRedCohortCounts[]>>;
    for (const role of TWO_RED_ROLES) tables[tier][role] = {} as Record<TwoRedRound, TwoRedCohortCounts[]>;
  }
  for (const role of TWO_RED_ROLES) {
    for (const round of TWO_RED_ROUNDS) {
      const slots: Array<number | 'total'> = [...TWO_RED_SLOTS, 'total'];
      const grids = slots.map((slot) => twoRedCohortGrid(proposals, cuts, { role, round, slot }));
      for (const tier of TWO_RED_TIER_KEYS) {
        tables[tier][role][round] = grids.map((g) => twoRedCountsOf(tier === 'all' ? g.all : g.rows[tier]));
      }
    }
  }
  const people = {} as Record<TwoRedTierKey, Set<string>>;
  const proposalsN = {} as Record<TwoRedTierKey, number>;
  for (const tier of TWO_RED_TIER_KEYS) { people[tier] = new Set(); proposalsN[tier] = 0; }
  for (const p of proposals) {
    for (const tier of [playerTier(p.pr, cuts), 'all'] as const) {
      proposalsN[tier] += 1;
      if (p.player !== null) people[tier].add(p.player);
    }
  }
  const players = Object.fromEntries(TWO_RED_TIER_KEYS.map((k) => [k, people[k].size])) as Record<TwoRedTierKey, number>;
  return { tables, players, proposals: proposalsN };
}
