/**
 * 複合篩選的模型（Edward 2026-10-14「我希望所有數據都有可以複合篩選的功能 最基本的是 比如 線瓦/面瓦、娛樂局、
 * 排除某些條件玩家（角色理論勝率/位置理論勝率/整體理論勝率 大於 小於 PR XX）之類的 包含但不限於以上的條件
 * 能的話盡可能客製化」）。
 *
 * 篩選 = 子句的 AND；子句內的清單（in / any / players / seats / role…）是 OR；每個子句可以 not（只反轉
 * 該子句本身）。全部可 JSON 序列化（分享連結、機器人、worker 訊息都用同一個物件）。
 */
import type { Role } from '../constants';

export type Side = 'red' | 'blue';
/** 座號 1..10（10 = 牌譜的 "0"）。 */
export type SeatNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type CategoryValue = '線瓦' | '面瓦' | '娛樂' | '未分類' | '其他';
export type OutcomeValue = '三紅' | '三藍死' | '三藍活' | 'other';
export type TrioOrder = '派梅娜' | '派娜梅' | '梅派娜' | '梅娜派' | '娜派梅' | '娜梅派';

interface Base {
  /** 反轉這個子句（「不是…的局」）。 */
  not?: boolean;
}

// ── 局 ──
export interface CategoryClause extends Base { kind: 'category'; in: CategoryValue[] }
export interface SourceClause extends Base { kind: 'source'; in: Array<'sheet' | 'discord'> }
/** 有日期：from ≤ date ≤ to（含兩端）；無日期的局只有 undated = 'include' 才算符合。 */
export interface DateClause extends Base { kind: 'date'; from?: string; to?: string; undated?: 'exclude' | 'include' }
/** ISO 星期：1 = 星期一 … 7 = 星期日（只有有日期的局）。 */
export interface WeekdayClause extends Base { kind: 'weekday'; in: number[] }
/** 場次（當天第幾局；沒寫的局不符合）。 */
export interface SessionIndexClause extends Base { kind: 'sessionIndex'; min?: number; max?: number }
export interface SeasonClause extends Base { kind: 'season'; in: string[] }
/** note 的地點標籤（'none' = 沒有地點標籤）。 */
export interface VenueClause extends Base { kind: 'venue'; in: string[] }
/** note 的旗標（spectated、badGame…），任一即符合。 */
export interface NoteFlagClause extends Base { kind: 'noteFlag'; any: string[] }
/** 有寫名字的座位數在 [min, max]（「只看 10 人全寫」= min 10）。 */
export interface NamedSeatsClause extends Base { kind: 'namedSeats'; min?: number; max?: number }
export interface OutcomeClause extends Base { kind: 'outcome'; in: OutcomeValue[] }
/** 最終結算的勝方：紅 = 三紅或三藍死，藍 = 三藍活。 */
export interface FinalWinnerClause extends Base { kind: 'finalWinner'; is: Side }
/** 打了幾個任務。 */
export interface MissionCountClause extends Base { kind: 'missionCount'; in: number[] }
/** 第 round 個任務：pass = 沒有小寫 x（第 4 局一張失敗也算 fail）；minFails / maxFails 限失敗張數。 */
export interface MissionClause extends Base {
  kind: 'mission'; round: number; result?: 'pass' | 'fail'; minFails?: number; maxFails?: number;
}
/** 局勢（例：紅紅藍藍藍）。 */
export interface GameStateClause extends Base { kind: 'gameState'; in: string[] }
/** 1-1 首隊：紅方人數、有沒有梅林 / 派西。 */
export interface FirstTeamClause extends Base {
  kind: 'firstTeam'; redCount?: number[]; hasMerlin?: boolean; hasPercival?: boolean;
}
/** 有持湖座位的湖數。 */
export interface LakeCountClause extends Base { kind: 'lakeCount'; in: number[] }
/** 第 index 湖：持湖 / 目標的陣營與角色，以及文字記錄第 index 條湖行的宣告。 */
export interface LakeClause extends Base {
  kind: 'lake'; index: 1 | 2 | 3; holderSide?: Side; targetSide?: Side;
  holderRole?: Role[]; targetRole?: Role[]; claim?: Array<'red' | 'blue' | 'none'>;
}
/** 三藍局的刺殺目標角色（'none' = 三藍但沒填）。 */
export interface AssassinationClause extends Base { kind: 'assassination'; target: Array<Role | 'none'> }
export interface RoleSeatClause extends Base { kind: 'roleSeat'; role: Role; seats: SeatNo[] }
/** 派 / 梅 / 娜 的順時針順序（seatOrder 區塊的定義）。 */
export interface TrioOrderClause extends Base { kind: 'trioOrder'; in: TrioOrder[] }
/** 第 round 個任務的隊長陣營（查不到的座位算忠臣 → 藍方，與 Python 相同）。 */
export interface CaptainClause extends Base { kind: 'captain'; round: number; side: Side }
export interface GameIdClause extends Base { kind: 'gameId'; in: string[] }

// ── 玩家在局 ──
/** 有一個有名字的座位是這位玩家，且角色 / 陣營 / 座位 / 勝負都符合（勝負只在三種結果的局成立）。 */
export interface WithPlayerClause extends Base {
  kind: 'withPlayer'; player: string; role?: Role[]; side?: Side; seat?: SeatNo[];
  result?: 'win' | 'loss'; resultRule?: 'final' | 'mission';
}
export interface WithAnyPlayerClause extends Base { kind: 'withAnyPlayer'; players: string[] }
export interface WithPlayersClause extends Base {
  kind: 'withPlayers'; players: [string, string]; relation: 'together' | 'sameTeam' | 'opposingTeams';
}

// ── 玩家集合（排除）──
export type MetricId =
  | 'roleTheory' | 'positionTheory' | 'overallTheory'
  | 'finalWinRate' | 'missionWinRate' | 'excessWinRate' | 'games'
  | 'roleFinalWinRate' | 'roleGames' | 'merlinSurvivalRate' | 'assassinHitRate'
  | 'daysSinceLastPlayed' | 'daysSinceFirstPlayed';

export type CompareOp = 'gt' | 'ge' | 'lt' | 'le';

export type PlayerSelector =
  | { by: 'names'; names: string[]; invert?: boolean }
  | {
    by: 'metric';
    metric: MetricId;
    /** roleFinalWinRate / roleGames 要指定角色。 */
    role?: Role;
    op: CompareOp;
    /** 和指標值比（一位小數的公開值）；與 pr 二擇一。 */
    value?: number;
    /** 和有資格者中的百分等級比（0–100，一位小數）。 */
    pr?: number;
    /** 指標看哪些局：'unfiltered'（預設，= 快取現成的數字）或 'filtered'（局子句之後的局）。 */
    evaluatedOn?: 'unfiltered' | 'filtered';
    /** 沒資格的人（例：角色窗沒打滿）：'keep'（預設，不會被選中）或 'select'（一律被選中）。 */
    ineligible?: 'keep' | 'select';
    /** 覆寫資格門檻（場數）；角色理論仍須打滿每個角色視窗。 */
    minGames?: number;
    /** 選「有資格但不符合」的人。 */
    invert?: boolean;
  };

/**
 * 排除某些條件的玩家：dropGames = 丟掉任一有名字座位是他們的局；hideFromLists = 局留著、只從名單 / 榜上拿掉
 * （不改任何人的數字）。dropIncompleteGames：連名字沒寫齊 10 人的局一起丟（看不到的座位可能就是他們）。
 */
export interface ExcludePlayersClause {
  kind: 'excludePlayers';
  who: PlayerSelector;
  scope: 'dropGames' | 'hideFromLists';
  dropIncompleteGames?: boolean;
}

export type GameClause =
  | CategoryClause | SourceClause | DateClause | WeekdayClause | SessionIndexClause | SeasonClause | VenueClause
  | NoteFlagClause | NamedSeatsClause | OutcomeClause | FinalWinnerClause | MissionCountClause | MissionClause
  | GameStateClause | FirstTeamClause | LakeCountClause | LakeClause | AssassinationClause | RoleSeatClause
  | TrioOrderClause | CaptainClause | GameIdClause | WithPlayerClause | WithAnyPlayerClause | WithPlayersClause;

export type Clause = GameClause | ExcludePlayersClause;

export interface FilterOptions {
  /**
   * 排行「近 N 天有出賽」「新人」看哪些局：'filtered'（預設，篩選後的局 = Python 在子集上跑
   * compute_leaderboard）、'all'（看全部局，數字與場數門檻仍看篩選後的局）、'none'（不要求近期出賽、不出新人榜）。
   */
  activity?: 'filtered' | 'all' | 'none';
  /** 'auto'（預設）= min(快取 asOf, 日期子句的 to)；或指定 YYYY-MM-DD。 */
  asOf?: 'auto' | string;
}

export interface GameFilter {
  v: 1;
  clauses: Clause[];
  options?: FilterOptions;
}

export const GAME_CLAUSE_KINDS = [
  'category', 'source', 'date', 'weekday', 'sessionIndex', 'season', 'venue', 'noteFlag', 'namedSeats', 'outcome',
  'finalWinner', 'missionCount', 'mission', 'gameState', 'firstTeam', 'lakeCount', 'lake', 'assassination',
  'roleSeat', 'trioOrder', 'captain', 'gameId', 'withPlayer', 'withAnyPlayer', 'withPlayers',
] as const;

export const METRIC_IDS: readonly MetricId[] = [
  'roleTheory', 'positionTheory', 'overallTheory', 'finalWinRate', 'missionWinRate', 'excessWinRate', 'games',
  'roleFinalWinRate', 'roleGames', 'merlinSurvivalRate', 'assassinHitRate', 'daysSinceLastPlayed', 'daysSinceFirstPlayed',
];
