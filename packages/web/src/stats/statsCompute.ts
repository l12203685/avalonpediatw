/**
 * 篩選重算的核心 (Worker 與沒有 Worker 時的主執行緒共用)：讀 /api/analysis/games 一次，解碼，之後每個篩選
 * 呼叫 computeStats (@avalon/shared/stats)。
 */
import {
  applyFilter,
  computeStats,
  computeStrengthReport,
  decodeGamesDataset,
  sanitizeFilter,
  type DecodedDataset,
  type GameFilter,
  type GamesDataset,
  type PairRoster,
  type StatsResult,
  type StrengthGrouping,
  type StrengthReport,
} from '@avalon/shared/stats';

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

function vocabOf(dataset: GamesDataset, context: GamesContext): FilterVocab {
  const tags: string[] = (dataset.vocab as { noteTags?: string[] }).noteTags ?? [];
  const pick = (prefix: string): string[] => tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
  return {
    asOf: context.asOf,
    totalGames: dataset.games.length,
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
  return { decoded, context, vocab: vocabOf(dataset, context) };
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

/** 篩選後的全部區塊。外來的篩選先過 sanitizeFilter。 */
export async function computeFiltered(serverUrl: string, raw: GameFilter): Promise<StatsResult> {
  const { decoded, context } = await loaded(serverUrl);
  const { filter } = sanitizeFilter(raw);
  return computeStats(decoded, {
    asOf: context.asOf, aliases: context.aliases, chemistryRoster: context.chemistryRoster,
  }, filter);
}
