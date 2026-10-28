/**
 * 每局資料集 games_cache.json（generate_cache.encode_games_dataset 每天與 analysis_cache.json 同一次寫出）
 * 的型別與解碼（Edward 2026-10-14 複合篩選）。
 *
 * 一局一個位置固定的陣列（`fields`），名字放 `players` 表、局裡存索引；只有解析後的結構化欄位，沒有
 * 文字記錄或 note 原文。解碼規則與 Python 的 decode_games_dataset 完全相同（兩邊都由 round-trip 守門與
 * 一致性測試保證）：衍生欄位（座位→角色、勝負、任務失敗數、首隊、湖的陣營與角色）在這裡算一次，
 * timelineDate（player_timelines 的排序日期）在「全部局」上算一次，篩選不改它。
 */
import {
  ALL_ROLES,
  CONFIG_ROLE_ORDER,
  OUTCOME_BLUE_ALIVE,
  OUTCOME_BLUE_DEAD,
  OUTCOME_THREE_RED,
  RED_ROLES,
  ROLE_DEAL_TENTHS,
  SEATS,
  decodeConfig,
  roleFactionName,
} from './constants';

export const GAMES_DATASET_FORMAT = 'avalon-games';
export const GAMES_DATASET_VERSION = 2;
export const GAMES_DATASET_FIELDS = [
  'id', 'src', 'date', 'cat', 'slot', 'note', 'config', 'outcome', 'kill',
  'seats', 'missions', 'rounds', 'state', 'firstTeam', 'lakes', 'claims', 'captains', 'votes',
] as const;

/** generate_cache.LEADERBOARD_CONFIG（引擎不假設任何門檻，一律讀這裡）。 */
export interface LeaderboardConfig {
  theoryMinCellGames: number;
  activeDays: number;
  topN: number;
  mainGames: number;
  roleWindowGames: number;
  loyalWindowGames: number;
  overallMinGames: number;
  /** theory 榜（一張表）：生涯至少幾場、是否要角色窗打滿（1 / 0）。 */
  theoryMinGames: number;
  requireRoleWindows: number;
  assassinAttempts: number;
  assassinMinAttempts: number;
  newcomerDays: number;
  newcomerMinGames: number;
  /** 角色王（Edward 2026-10-28）：特殊角色 / 忠臣的完整視窗與「不到一半人打滿」時的退回視窗。 */
  roleTitleGames: number;
  roleTitleFallbackGames: number;
  loyalTitleGames: number;
  loyalTitleFallbackGames: number;
  [key: string]: number;
}

export interface GamesDatasetConfig {
  leaderboard: LeaderboardConfig;
  theoryWindows: number[];
  minGamesThreshold: number;
  excessShrinkK: number;
  lakeClaimMinSample: number;
}

/** 一局的位置陣列（順序 = GAMES_DATASET_FIELDS）。 */
export type GameTuple = [
  id: string, src: number, date: string, cat: number, slot: number, note: number[], config: string,
  outcome: number, kill: string, seats: number[], missions: string, rounds: string, state: number,
  firstTeam: string, lakes: string, claims: string, captains: string, votes: VotingProposal[],
];

/** 回合、提議序號、隊伍、贊成座位；第 5 次強制派隊的贊成座位固定為空。 */
export type VotingProposal = [round: number, attempt: number, team: string, approved: string];

export interface GamesDataset {
  format: string;
  version: number;
  key: string;
  cacheSchemaVersion: number;
  config: GamesDatasetConfig;
  constants: {
    allRoles: string[];
    configRoleOrder: string[];
    redRoles: string[];
    seats: string[];
    roleDealTenths: Record<string, number>;
  };
  counts: { games: number; fromSheet: number; fromDiscord: number; players: number; dated: number; undated: number };
  vocab: { category: string[]; outcome: string[]; state: string[]; noteTags: string[] };
  players: string[];
  aliases: Record<string, string>;
  fields: string[];
  games: GameTuple[];
}

/** 湖：持湖與目標的座位字元（"?" = 不是單一數字）、角色、陣營（generate_cache._lake_factions）。 */
export interface LakeInfo {
  holder: string;
  target: string;
  holderRole: string;
  targetRole: string;
  holderFaction: '紅方' | '藍方' | '';
  targetFaction: '紅方' | '藍方' | '';
}

/** 文字記錄的湖行：持湖、目標座位、宣告（紅 / 藍 / ""）。 */
export interface LakeClaim {
  holder: string;
  target: string;
  claim: '紅' | '藍' | '';
}

export interface MissionResult {
  round: number;
  /** 小寫 x 的個數（count_mission_fails）。 */
  fails: number;
  total: number;
}

/** 解碼後的一局（generate_cache.GameRow 的對應）。 */
export interface Game {
  /** 合併順序（陣列索引）。 */
  seq: number;
  id: string;
  source: 0 | 1;
  date: string;
  /** 分類原文的白名單值（線瓦 / 面瓦 / 娛樂 / "" / 其他）。 */
  category: string;
  slot: number;
  noteTags: string[];
  config: string;
  seatRoles: Map<string, string>;
  outcome: string;
  redWin: boolean;
  blueWin: boolean;
  merlinKilled: boolean;
  /** 三藍局的刺殺座位字元（"?" = 不是單一數字；其他局為空）。 */
  kill: string;
  /** SEATS 順序的玩家名字（null = 沒寫名字）。 */
  seatPlayers: Array<string | null>;
  namedSeats: number;
  roundResults: string[];
  missions: MissionResult[];
  /** 第一局..第五局：紅 / 藍 / "" / "?"。 */
  rounds: string[];
  gameState: string;
  r11Seats: string[];
  r11RedCount: number;
  r11HasMerlin: boolean;
  r11HasPercival: boolean;
  lakes: Array<LakeInfo | null>;
  claims: LakeClaim[];
  captains: Array<string | null>;
  votingProposals: VotingProposal[];
  /** player_timelines 的排序日期（自己的日期，否則上一個有日期局的日期；全部局上算一次）。 */
  timelineDate: string;
}

export interface DecodedDataset {
  dataset: GamesDataset;
  games: Game[];
  config: GamesDatasetConfig;
}

export class GamesDatasetError extends Error {}

const ROUND_NAMES: Record<string, string> = { R: '紅', B: '藍', '-': '', '?': '?' };
const CLAIM_NAMES: Record<string, '紅' | '藍' | ''> = { x: '紅', o: '藍', '-': '' };

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 資料集的規則常數與引擎的不同（產生器改了規則）→ 錯誤訊息；相同 → null。 */
export function constantsMismatch(dataset: Pick<GamesDataset, 'constants'>): string | null {
  const c = dataset.constants;
  if (!c) return 'constants missing';
  if (!sameJson(c.allRoles, ALL_ROLES)) return 'allRoles';
  if (!sameJson(c.configRoleOrder, CONFIG_ROLE_ORDER)) return 'configRoleOrder';
  if (!sameJson(c.redRoles, ALL_ROLES.filter((r) => RED_ROLES.has(r)))) return 'redRoles';
  if (!sameJson(c.seats, SEATS)) return 'seats';
  if (!sameJson(c.roleDealTenths, ROLE_DEAL_TENTHS)) return 'roleDealTenths';
  return null;
}

function lakeInfo(pair: string, seatRoles: Map<string, string>): LakeInfo | null {
  if (pair === '--') return null;
  const holder = pair[0];
  const target = pair[1];
  const holderRole = seatRoles.get(holder) ?? '';
  const targetRole = seatRoles.get(target) ?? '';
  return {
    holder, target, holderRole, targetRole,
    holderFaction: holderRole ? roleFactionName(holderRole) : '',
    targetFaction: targetRole ? roleFactionName(targetRole) : '',
  };
}

function countX(cell: string): number {
  let n = 0;
  for (const ch of cell) if (ch === 'x') n += 1;
  return n;
}

/** 一局的位置陣列 → Game（timelineDate 由 decodeGamesDataset 補上）。 */
function decodeGame(row: GameTuple, seq: number, dataset: GamesDataset, idx: Record<string, number>): Game {
  const get = <T>(name: string): T => row[idx[name]] as unknown as T;
  const { vocab, players } = dataset;
  const config = get<string>('config');
  const seatRoles = decodeConfig(config);
  const outcome = vocab.outcome[get<number>('outcome')];
  const seatIndexes = get<number[]>('seats');
  const seatPlayers = SEATS.map((_, i) => (seatIndexes[i] >= 0 ? players[seatIndexes[i]] : null));
  const roundResults = get<string>('missions').split('|');
  const missions: MissionResult[] = [];
  roundResults.forEach((cell, i) => {
    if (cell) missions.push({ round: i + 1, fails: countX(cell), total: [...cell].length });
  });
  const r11Seats = [...get<string>('firstTeam')];
  const r11Roles = r11Seats.map((s) => seatRoles.get(s) ?? '?');
  const lakes = get<string>('lakes');
  const claimsText = get<string>('claims');
  const claims: LakeClaim[] = [];
  for (let i = 0; i + 2 < claimsText.length; i += 3) {
    claims.push({ holder: claimsText[i], target: claimsText[i + 1], claim: CLAIM_NAMES[claimsText[i + 2]] ?? '' });
  }
  const state = get<number>('state');
  return {
    seq,
    id: get<string>('id'),
    source: get<number>('src') === 1 ? 1 : 0,
    date: get<string>('date'),
    category: vocab.category[get<number>('cat')],
    slot: get<number>('slot'),
    noteTags: get<number[]>('note').map((i) => vocab.noteTags[i]),
    config,
    seatRoles,
    outcome,
    redWin: outcome === OUTCOME_THREE_RED,
    blueWin: outcome === OUTCOME_BLUE_DEAD || outcome === OUTCOME_BLUE_ALIVE,
    merlinKilled: outcome === OUTCOME_BLUE_DEAD,
    kill: get<string>('kill'),
    seatPlayers,
    namedSeats: seatPlayers.filter((p) => p !== null).length,
    roundResults,
    missions,
    rounds: [...get<string>('rounds')].map((c) => ROUND_NAMES[c] ?? '?'),
    gameState: state >= 0 ? vocab.state[state] : '',
    r11Seats,
    r11RedCount: r11Roles.filter((r) => RED_ROLES.has(r)).length,
    r11HasMerlin: r11Roles.includes('梅林'),
    r11HasPercival: r11Roles.includes('派西維爾'),
    lakes: [0, 2, 4].map((i) => lakeInfo(lakes.slice(i, i + 2), seatRoles)),
    claims,
    captains: [...get<string>('captains')].map((c) => (c === '-' ? null : c)),
    votingProposals: get<VotingProposal[]>('votes'),
    timelineDate: '',
  };
}

/** generate_cache.assign_timeline_dates：自己的日期，否則上一個有日期局的日期（全部局，含沒有結果的局）。 */
export function assignTimelineDates(games: Game[]): void {
  let last = '';
  for (const g of games) {
    if (g.date) last = g.date;
    g.timelineDate = g.date || last;
  }
}

/**
 * games_cache.json → 解碼後的局。格式、版本、欄位、規則常數不符就丟 GamesDatasetError（寧可停用篩選，
 * 也不要算出錯的數字）。`expectedKey`（快取的 overview.gamesKey）給了就必須相同（兩檔同一批）。
 */
export function decodeGamesDataset(raw: unknown, expectedKey?: string | null): DecodedDataset {
  const dataset = raw as GamesDataset;
  if (!dataset || typeof dataset !== 'object') throw new GamesDatasetError('not an object');
  if (dataset.format !== GAMES_DATASET_FORMAT || dataset.version !== GAMES_DATASET_VERSION) {
    throw new GamesDatasetError(`unsupported dataset ${String(dataset.format)} v${String(dataset.version)}`);
  }
  if (expectedKey !== undefined && expectedKey !== null && dataset.key !== expectedKey) {
    throw new GamesDatasetError('dataset key does not match the analysis cache (overview.gamesKey)');
  }
  if (!sameJson(dataset.fields, GAMES_DATASET_FIELDS)) throw new GamesDatasetError('unexpected fields');
  const mismatch = constantsMismatch(dataset);
  if (mismatch) throw new GamesDatasetError(`rule constants differ from the engine's: ${mismatch}`);
  if (!Array.isArray(dataset.games) || !Array.isArray(dataset.players)) throw new GamesDatasetError('games / players missing');
  const idx: Record<string, number> = {};
  dataset.fields.forEach((f, i) => { idx[f] = i; });
  const games = dataset.games.map((row, i) => decodeGame(row, i, dataset, idx));
  assignTimelineDates(games);
  return { dataset, games, config: dataset.config };
}
