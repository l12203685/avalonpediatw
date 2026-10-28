/**
 * 從一組局算出快取的「從局算的區塊」（generate_cache.build_cache 的對應；目前：overview、players、
 * playerDetails、missions、rounds、captainAnalysis、leaderboard）。不篩選時 = analysis_cache.json 的同名區塊，逐欄相同。
 */
import { computeCaptainAnalysis, type CaptainAnalysisSection } from './captain';
import type { Game, GamesDatasetConfig } from './dataset';
import { computePlayerDetails, computePlayersEndpoint, type PlayerDetail, type PlayersSection } from './details';
import { computeLeaderboard, type LeaderboardOptions, type LeaderboardSection } from './leaderboard';
import { computeMissions, type MissionsSection } from './missions';
import { computeOverview, type OverviewSection } from './overview';
import { computePlayerStats, computeSeatOutcomesPerPlayer, type PlayerRow } from './players';
import { computeRounds, type RoundsSection } from './rounds';
import type { PlayerSeat } from './theory';
import { computeLake, type LakeSection } from './lake';
import { computeLakeClaimFeature, type LakeClaimFeature } from './featureL141';
import { computeSeatOrder, type SeatOrderSection } from './seatOrder';
import { computePairs, type PairsSection, type PairRoster } from './pairs';

export interface Sections {
  overview: OverviewSection;
  players: PlayersSection;
  playerDetails: Record<string, PlayerDetail>;
  /** 這三個區塊只看局（hidden 不影響）。 */
  missions: MissionsSection;
  rounds: RoundsSection;
  captainAnalysis: CaptainAnalysisSection;
  leaderboard: LeaderboardSection;
  lake: LakeSection;
  lakeClaim: LakeClaimFeature;
  seatOrder: SeatOrderSection;
  pairs: PairsSection;
}

export interface BuildOptions {
  /** 只從名單 / 榜上拿掉的人（不改任何人的數字）。 */
  hidden?: ReadonlySet<string>;
  gamesKey?: string;
  leaderboard?: Omit<LeaderboardOptions, 'hidden'>;
  aliases?: Record<string, string>;
  chemistryRoster?: PairRoster;
}

export interface BuildResult {
  sections: Sections;
  /** 全部玩家的列（含被隱藏的人；玩家條件「看篩選後」用）。 */
  rows: PlayerRow[];
  timelines: Map<string, PlayerSeat[]>;
  /** 實際算的局（日期晚於 asOf 的已當作無日期）。 */
  games: Game[];
}

/** generate_cache.drop_dates_after：日期晚於 asOf 的局當作沒有日期（複本；排序日期 timelineDate 不變）。 */
export function dropDatesAfter(games: readonly Game[], asOf: string): Game[] {
  return games.map((g) => (g.date && g.date > asOf ? { ...g, date: '' } : g));
}

/** generate_cache.build_cache 的「從局算的區塊」。 */
export function buildSections(
  input: readonly Game[],
  config: GamesDatasetConfig,
  asOf: string,
  options: BuildOptions = {},
): BuildResult {
  const games = dropDatesAfter(input, asOf);
  const { hidden } = options;
  const stats = computePlayerStats(games, config);
  const overview = computeOverview(games, stats.rows, stats.roleFinalWinRates, stats.seatFinalWinRates, config, {
    roleSeatFinalWinRates: stats.roleSeatFinalWinRates,
    hidden,
    gamesKey: options.gamesKey,
  });
  const seatOutcomes = computeSeatOutcomesPerPlayer(games, stats.rows);
  for (const p of stats.rows) p.seatOutcomes = seatOutcomes.get(p.name) ?? {};
  const listed = hidden && hidden.size ? stats.rows.filter((p) => !hidden.has(p.name)) : stats.rows;
  const leaderboard = computeLeaderboard(
    games, asOf, overview.roleFinalWinRates, overview.seatFinalWinRates, config,
    { ...options.leaderboard, hidden, timelines: stats.timelines, roleSeatRates: overview.roleSeatFinalWinRates },
  );
  return {
    sections: {
      overview,
      players: computePlayersEndpoint(listed, options.aliases),
      playerDetails: computePlayerDetails(listed),
      missions: computeMissions(games),
      rounds: computeRounds(games),
      captainAnalysis: computeCaptainAnalysis(games),
      leaderboard,
      lake: computeLake(games),
      lakeClaim: computeLakeClaimFeature(games, config, asOf),
      seatOrder: computeSeatOrder(games),
      pairs: computePairs(games, options.chemistryRoster, hidden),
    },
    rows: stats.rows,
    timelines: stats.timelines,
    games,
  };
}
