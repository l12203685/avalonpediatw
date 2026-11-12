/**
 * 篩選重算的核心 (Worker 與沒有 Worker 時的主執行緒共用)：讀 /api/analysis/games 一次，解碼，之後每個篩選
 * 呼叫 computeStats (@avalon/shared/stats)。
 */
import {
  applyFilter,
  computeStats,
  computeStrengthReport,
  computeTwoRedReport,
  decisiveReport,
  decodeGamesDataset,
  discoverFindings,
  discoveryBase,
  type DiscoveryBase,
  sanitizeFilter,
  DEFAULT_COHORT_CUTS,
  encodeCohortCuts,
  validCohortCuts,
  type CohortCuts,
  type DecodedDataset,
  type GameFilter,
  type GamesDataset,
  type PairRoster,
  type StatsResult,
  type StrengthGrouping,
  type StrengthReport,
  type DiscoveryResult,
  type DecisiveReport,
  type DecisiveScan,
  type DecisiveScope,
  type TwoRedProposals,
  type TwoRedReport,
  type TwoRedTable,
  type TwoRedCohortData,
  type DecisiveCohortData,
  type AbnormalCohortData,
  type Game,
  SEATS,
  decisiveCohortData,
  abnormalCohortData,
  scanAbnormalVotes,
  twoRedCohortData,
  scanDecisiveVotes,
  twoRedProposals,
  twoRedTable,
} from '@avalon/shared/stats';
import { toStateGames, type StateGamesResult } from '../components/analysis/stateTree/stateTree';
import type { ClaimData } from '../components/idClaim/claimIndex';

/** /api/analysis/games 的 context (伺服器 services/gamesDataset.ts GamesContext 的子集)。 */
export interface GamesContext {
  gamesKey: string;
  asOf: string;
  aliases: Record<string, string>;
  chemistryRoster: PairRoster;
  unfiltered: { totalGames: number; totalPlayers: number };
}

/** 篩選面板要的選項：玩家名單 (自動完成)、賽季、地點、note 旗標、基準日、局數。 */
export interface FilterVocab {
  asOf: string;
  totalGames: number;
  players: string[];
  aliases: Record<string, string>;
  seasons: string[];
  venues: string[];
  flags: string[];
  /** 玩家條件的資格門檻 (leaderboard 設定 + minGamesThreshold)，給面板說明用。 */
  thresholds: Record<string, number>;
}

export class GamesUnavailableError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GamesUnavailableError';
    this.status = status;
  }
}

interface Loaded {
  decoded: DecodedDataset;
  context: GamesContext;
  vocab: FilterVocab;
}

let loading: Promise<Loaded> | null = null;

function vocabOf(decoded: DecodedDataset, context: GamesContext): FilterVocab {
  const { dataset } = decoded;
  const tags: string[] = (dataset.vocab as { noteTags?: string[] }).noteTags ?? [];
  const pick = (prefix: string): string[] => tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
  return {
    asOf: context.asOf,
    // 百科AI 局與只在百科AI 局出現的名字不算 (decodeGamesDataset 已分開)
    totalGames: decoded.games.length,
    players: [...dataset.players],
    aliases: { ...(dataset.aliases ?? {}), ...context.aliases },
    seasons: pick('season:'),
    venues: pick('venue:'),
    flags: pick('flag:'),
    thresholds: {
      ...(dataset.config.leaderboard as unknown as Record<string, number>),
      minGamesThreshold: dataset.config.minGamesThreshold,
    },
  };
}

async function load(serverUrl: string): Promise<Loaded> {
  const res = await fetch(`${serverUrl}/api/analysis/games`);
  let body: { success?: boolean; data?: { dataset: GamesDataset; context: GamesContext }; error?: string } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body?.success || !body.data) {
    throw new GamesUnavailableError(res.status || 503, body?.error ?? `HTTP ${res.status}`);
  }
  const { dataset, context } = body.data;
  const decoded = decodeGamesDataset(dataset, context.gamesKey);
  return { decoded, context, vocab: vocabOf(decoded, context) };
}

function loaded(serverUrl: string): Promise<Loaded> {
  if (!loading) {
    loading = load(serverUrl);
    loading.catch(() => {
      loading = null; // 失敗不快取，下次重試
    });
  }
  return loading;
}

export async function filterVocab(serverUrl: string): Promise<FilterVocab> {
  return (await loaded(serverUrl)).vocab;
}

/** 數據分析「陣容強度」：篩選後的局依 grouping 分組的報告 (@avalon/shared computeStrengthReport)。 */
export async function computeStrength(serverUrl: string, raw: GameFilter | null, grouping: StrengthGrouping): Promise<StrengthReport> {
  const { decoded, context } = await loaded(serverUrl);
  const filter = raw ? sanitizeFilter(raw).filter : null;
  const { games } = applyFilter(decoded, { asOf: context.asOf, aliases: context.aliases, chemistryRoster: context.chemistryRoster }, filter);
  return computeStrengthReport(games, grouping);
}

const discoveries = new Map<string, DiscoveryResult>();
/** 非事件單位的候選（不靠切點）：依篩選快取，切點一換只重算三種事件單位。 */
const discoveryBases = new Map<string, DiscoveryBase>();

/** 自動發現：篩選後的局掃描全部維度 × 指標（@avalon/shared discoverFindings）；同一個篩選＋分組切點只算一次。 */
export async function computeDiscovery(serverUrl: string, raw: GameFilter | null, rawCuts?: CohortCuts | null): Promise<DiscoveryResult> {
  const { decoded, context } = await loaded(serverUrl);
  const filter = raw ? sanitizeFilter(raw).filter : null;
  // 分組的切點（強者／新手、高端／歡樂；網站上可調）：不合法就用預設
  const cuts = rawCuts && validCohortCuts(rawCuts) ? rawCuts : DEFAULT_COHORT_CUTS;
  const filterKey = JSON.stringify(filter);
  const key = `${filterKey}|${encodeCohortCuts(cuts)}`;
  const hit = discoveries.get(key);
  if (hit) return hit;
  const { games } = applyFilter(decoded, { asOf: context.asOf, aliases: context.aliases, chemistryRoster: context.chemistryRoster }, filter);
  let base = discoveryBases.get(filterKey);
  if (!base) {
    base = discoveryBase(games);
    discoveryBases.set(filterKey, base);
    while (discoveryBases.size > 4) discoveryBases.delete(discoveryBases.keys().next().value as string);
  }
  const result = discoverFindings(games, { cuts, base });
  discoveries.set(key, result);
  while (discoveries.size > 4) discoveries.delete(discoveries.keys().next().value as string);
  return result;
}

const twoRedPrepared = new Map<string, { data: TwoRedProposals; all: TwoRedTable; games: Game[] }>();

async function preparedTwoRed(serverUrl: string, raw: GameFilter | null): Promise<{ data: TwoRedProposals; all: TwoRedTable; games: Game[] }> {
  const { decoded, context } = await loaded(serverUrl);
  const filter = raw ? sanitizeFilter(raw).filter : null;
  const key = JSON.stringify(filter);
  let prepared = twoRedPrepared.get(key);
  if (!prepared) {
    const { games } = applyFilter(decoded, { asOf: context.asOf, aliases: context.aliases, chemistryRoster: context.chemistryRoster }, filter);
    const data = twoRedProposals(games);
    prepared = { data, all: twoRedTable(data.proposals), games };
    twoRedPrepared.set(key, prepared);
    while (twoRedPrepared.size > 4) twoRedPrepared.delete(twoRedPrepared.keys().next().value as string);
  }
  return prepared;
}

/**
 * 玩家雷達「兩紅之後的派隊」：篩選後的局裡這位玩家當藍方隊長、紅方已經兩勝時派出的隊（@avalon/shared computeTwoRedReport），
 * 加上全體的同一張表。每個篩選的提議與全體表只算一次，換人只重數那位玩家的。
 */
export async function computeTwoRed(serverUrl: string, raw: GameFilter | null, name: string): Promise<TwoRedReport> {
  const prepared = await preparedTwoRed(serverUrl, raw);
  return computeTwoRedReport([], name, prepared);
}

/**
 * 「兩紅之後的派隊」分組（強者／一般人／新手 × 高端／普通／歡樂，@avalon/shared cohort.ts）：篩選後的提議（精簡版）、
 * 每位玩家最近的 PR、PR／S 分布。切點在網站上換（主執行緒用 cohortGrid 重數），不用回來重算。
 */
export async function computeTwoRedCohort(serverUrl: string, raw: GameFilter | null): Promise<TwoRedCohortData> {
  const prepared = await preparedTwoRed(serverUrl, raw);
  return twoRedCohortData(prepared.games, prepared.data);
}

const decisiveScans = new Map<string, { scan: DecisiveScan; games: Game[] }>();

async function preparedDecisive(serverUrl: string, raw: GameFilter | null): Promise<{ scan: DecisiveScan; games: Game[] }> {
  const { decoded, context } = await loaded(serverUrl);
  const filter = raw ? sanitizeFilter(raw).filter : null;
  const key = JSON.stringify(filter);
  let hit = decisiveScans.get(key);
  if (!hit) {
    const { games } = applyFilter(decoded, { asOf: context.asOf, aliases: context.aliases, chemistryRoster: context.chemistryRoster }, filter);
    // allVotes：分組的「全部投票」要每一張藍方票（依局、座位合起來，約幾萬筆）
    hit = { scan: scanDecisiveVotes(games, { allVotes: true }), games };
    decisiveScans.set(key, hit);
    while (decisiveScans.size > 4) decisiveScans.delete(decisiveScans.keys().next().value as string);
  }
  return hit;
}

/**
 * 排行「關鍵外白／內黑」與玩家雷達「兩紅之後」的關鍵票那一行：篩選後的局裡藍方的關鍵票（@avalon/shared decisiveVotes.ts），
 * 一個範圍的報表（每位玩家＋全體依角色）。每個篩選只掃一次局（三個範圍一起），換範圍只重新加總。
 */
export async function computeDecisive(serverUrl: string, raw: GameFilter | null, scope: DecisiveScope): Promise<DecisiveReport> {
  const { scan } = await preparedDecisive(serverUrl, raw);
  return decisiveReport(scan, scope);
}

/** 「關鍵外白／內黑」分組：一個範圍的關鍵票與全部投票（依局、座位合起來的筆）＋PR／S 分布；切點在網站上換。 */
export async function computeDecisiveCohort(serverUrl: string, raw: GameFilter | null, scope: DecisiveScope): Promise<DecisiveCohortData> {
  const { scan, games } = await preparedDecisive(serverUrl, raw);
  return decisiveCohortData(scan, scope, games);
}

const abnormalScans = new Map<string, AbnormalCohortData>();

/**
 * 「關鍵外白／內黑」分組的小分頁「異常票（內黑／外白）」與玩家雷達「兩紅之後」的異常票那一行：篩選後的局裡，情境（兩紅之後、
 * 第三局・兩紅／一藍一紅、第四局・兩紅、第五局）內的藍方票依局、座位、情境合起來的筆（@avalon/shared abnormalVotes.ts）
 * ＋PR／S 分布。每個篩選只掃一次；情境、全部／關鍵、角色、切點都在網站上切。
 */
export async function computeAbnormalCohort(serverUrl: string, raw: GameFilter | null): Promise<AbnormalCohortData> {
  const { decoded, context } = await loaded(serverUrl);
  const filter = raw ? sanitizeFilter(raw).filter : null;
  const key = JSON.stringify(filter);
  let hit = abnormalScans.get(key);
  if (!hit) {
    const { games } = applyFilter(decoded, { asOf: context.asOf, aliases: context.aliases, chemistryRoster: context.chemistryRoster }, filter);
    hit = abnormalCohortData(scanAbnormalVotes(games), games);
    abnormalScans.set(key, hit);
    while (abnormalScans.size > 4) abnormalScans.delete(abnormalScans.keys().next().value as string);
  }
  return hit;
}

/** 數據分析「局勢樹」：篩選後的局縮成樹要的欄位（components/analysis/stateTree/stateTree.ts）。 */
export async function computeStateGames(serverUrl: string, raw: GameFilter | null): Promise<StateGamesResult> {
  const { decoded, context } = await loaded(serverUrl);
  const filter = raw ? sanitizeFilter(raw).filter : null;
  const { games } = applyFilter(decoded, { asOf: context.asOf, aliases: context.aliases, chemistryRoster: context.chemistryRoster }, filter);
  return toStateGames(games);
}

/** 篩選後的全部區塊。外來的篩選先過 sanitizeFilter。 */
export async function computeFiltered(serverUrl: string, raw: GameFilter): Promise<StatsResult> {
  const { decoded, context } = await loaded(serverUrl);
  const { filter } = sanitizeFilter(raw);
  return computeStats(decoded, {
    asOf: context.asOf, aliases: context.aliases, chemistryRoster: context.chemistryRoster,
  }, filter);
}

/**
 * ID 認領頁（components/idClaim）：全部局（不篩選）縮成每局的日期、當日場次、座位上的名字與角色、哪方贏，
 * 加上玩家名單與擁有者的別名。名字是正式名字（別名已在產生資料時合併）。
 */
export async function computeClaimData(serverUrl: string): Promise<ClaimData> {
  const { decoded, vocab } = await loaded(serverUrl);
  return {
    asOf: vocab.asOf,
    players: vocab.players,
    aliases: vocab.aliases,
    games: decoded.games.map((g) => ({
      seq: g.seq,
      date: g.date,
      slot: g.slot,
      players: g.seatPlayers,
      roles: SEATS.map((s) => g.seatRoles.get(s) ?? ''),
      winner: g.redWin ? 'red' : g.blueWin ? 'blue' : '',
    })),
  };
}
