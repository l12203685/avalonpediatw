/**
 * GET /api/analysis/games 的資料（複合篩選，Edward 2026-10-14；r9 設計 §1.7）：每局資料集
 * games_cache.json（generate_cache.py 與 analysis_cache.json 同一次寫出）+ 從快取組的 context。
 *
 * - 兩檔同一批才給：dataset.key 必須等於快取的 overview.gamesKey，否則 503（網站顯示「篩選暫時無法使用」，
 *   預設畫面照舊讀快取）。
 * - 執行期一致性檢查（engineCheck）：第一次被要求時在伺服器跑一次不篩選的引擎，與快取的同名區塊逐欄比
 *   （@avalon/shared/stats 的 diffSections）；不一致就 503，log 只印差異數。
 *   AVALON_STATS_ENGINE_CHECK=off 可跳過（本機）。
 * - 回應本體組一次、預先壓成 gzip / brotli（Express 沒有 compression 中介層），強 ETag，If-None-Match → 304。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import {
  computeStats,
  decodeGamesDataset,
  diffSections,
  type GamesDataset,
  type PairRoster,
} from '@avalon/shared/stats';
import { getAnalysisCache, type AnalysisCache } from './sheetsAnalysis';

/** 本機預覽用另一份資料集（比照 AVALON_ANALYSIS_CACHE）；正式環境不設。 */
export const ENV_GAMES_DATASET = 'AVALON_GAMES_DATASET';
/** 'off' = 不跑執行期一致性檢查。 */
export const ENV_STATS_ENGINE_CHECK = 'AVALON_STATS_ENGINE_CHECK';

const DATASET_PATHS = [
  path.resolve(__dirname, '..', '..', 'games_cache.json'),
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'packages', 'server', 'games_cache.json'),
];

export interface GamesContext {
  gamesKey: string;
  /** 快取的 leaderboard.asOf：引擎與預設畫面用同一天。 */
  asOf: string;
  leaderboardConfig: Record<string, unknown>;
  schemaVersion: number;
  aliases: Record<string, string>;
  chemistryRoster: PairRoster;
  unfiltered: { totalGames: number; totalPlayers: number };
  engineCheck: 'passed' | 'skipped';
}

export interface GamesPayload {
  identity: Buffer;
  gzip: Buffer;
  br: Buffer;
  etag: string;
  context: GamesContext;
}

export type GamesLoad = { ok: true; payload: GamesPayload } | { ok: false; status: number; error: string };

export const GAMES_NOT_GENERATED = 'Games dataset not yet generated';
export const GAMES_MISMATCH = 'Games dataset does not match the analysis cache';
export const GAMES_ENGINE_FAILED = 'Filtered statistics temporarily unavailable';

let loaded: GamesLoad | null = null;

function datasetPaths(): string[] {
  const override = process.env[ENV_GAMES_DATASET]?.trim();
  return override ? [path.resolve(override)] : DATASET_PATHS;
}

/** 引擎與快取的「從局算的區塊」逐欄比對；回傳差異數與前幾個路徑（沒有名字）。 */
export function engineParity(dataset: GamesDataset, cache: Readonly<AnalysisCache>): { differences: number; paths: string[] } {
  const decoded = decodeGamesDataset(dataset, cache.overview.gamesKey ?? null);
  const asOf = cache.leaderboard?.asOf ?? '';
  const result = computeStats(decoded, {
    asOf, aliases: cache.players.aliases ?? {}, chemistryRoster: chemistryRoster(cache),
  }, null);
  const sections: Array<[string, unknown, unknown]> = [
    ['overview', cache.overview, result.overview],
    ['players', cache.players, result.players],
    ['playerDetails', cache.playerDetails, result.playerDetails],
    ['missions', cache.missions, result.missions],
    ['rounds', cache.rounds, result.rounds],
    ['captainAnalysis', cache.captainAnalysis, result.captainAnalysis],
    ['leaderboard', cache.leaderboard, result.leaderboard],
    ['lake', cache.lake, result.lake],
    ['seatOrder', cache.seatOrder, result.seatOrder],
    ['chemistry.outcomePair', cache.chemistry.outcomePair, result.pairs.outcomePair],
  ];
  const lakeClaim = cache.featureStudies?.features.find((feature) => feature.loopId === 'L141');
  if (lakeClaim) {
    sections.push(['featureStudies.L141', lakeClaim, result.lakeClaim]);
    sections.push(['featureStudies.sampleSize.games', cache.featureStudies?.sampleSize.games, result.lakeClaim.sampleSize.games]);
    sections.push(['featureStudies.sampleSize.lakeLinks', cache.featureStudies?.sampleSize.lakeLinks, result.lakeClaim.sampleSize.links]);
  }
  let differences = 0;
  const paths: string[] = [];
  for (const [name, expected, actual] of sections) {
    const report = diffSections(expected, actual, name, 20 - paths.length);
    differences += report.differences;
    paths.push(...report.paths);
  }
  return { differences, paths };
}

function chemistryRoster(cache: Readonly<AnalysisCache>): PairRoster {
  const matrix = cache.chemistry.coWin;
  return { players: matrix?.players ?? [], rowLabels: matrix?.rowLabels };
}

function build(): GamesLoad {
  const file = datasetPaths().find((p) => fs.existsSync(p));
  if (!file) return { ok: false, status: 503, error: GAMES_NOT_GENERATED };
  let cache: Readonly<AnalysisCache>;
  let dataset: GamesDataset;
  try {
    cache = getAnalysisCache();
    dataset = JSON.parse(fs.readFileSync(file, 'utf-8')) as GamesDataset;
  } catch {
    console.error('[analysis/games] 讀取失敗：1');
    return { ok: false, status: 503, error: GAMES_NOT_GENERATED };
  }
  const gamesKey = cache.overview.gamesKey;
  if (!gamesKey || dataset.key !== gamesKey) {
    console.warn('[analysis/games] 批次不符：1');
    return { ok: false, status: 503, error: GAMES_MISMATCH };
  }
  let engineCheck: GamesContext['engineCheck'] = 'skipped';
  if (process.env[ENV_STATS_ENGINE_CHECK]?.trim().toLowerCase() !== 'off') {
    try {
      const started = Date.now();
      const { differences } = engineParity(dataset, cache);
      if (differences) {
        console.error(`[analysis/games] 差異欄位：${differences}`);
        return { ok: false, status: 503, error: GAMES_ENGINE_FAILED };
      }
      console.log(`[analysis/games] engine check passed (${dataset.games.length} games, ${Date.now() - started} ms)`);
      engineCheck = 'passed';
    } catch {
      console.error('[analysis/games] 計算失敗：1');
      return { ok: false, status: 503, error: GAMES_ENGINE_FAILED };
    }
  }
  const context: GamesContext = {
    gamesKey,
    asOf: cache.leaderboard?.asOf ?? '',
    leaderboardConfig: (cache.leaderboard?.config ?? {}) as Record<string, unknown>,
    schemaVersion: cache.overview.schemaVersion ?? 0,
    aliases: ((cache.players as { aliases?: Record<string, string> }).aliases) ?? {},
    chemistryRoster: chemistryRoster(cache),
    unfiltered: { totalGames: cache.overview.totalGames, totalPlayers: cache.overview.totalPlayers },
    engineCheck,
  };
  const identity = Buffer.from(JSON.stringify({ success: true, data: { dataset, context } }), 'utf-8');
  return {
    ok: true,
    payload: {
      identity,
      gzip: zlib.gzipSync(identity, { level: 9 }),
      br: zlib.brotliCompressSync(identity, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }),
      etag: `"${crypto.createHash('sha1').update(identity).digest('hex')}"`,
      context,
    },
  };
}

/** 第一次呼叫時讀檔、檢查、壓縮；之後回傳同一份（invalidateGamesPayload 清掉）。 */
export function loadGamesPayload(): GamesLoad {
  if (!loaded) loaded = build();
  return loaded;
}

export function invalidateGamesPayload(): void {
  loaded = null;
}

/** Accept-Encoding → 要回的編碼（br 優先，其次 gzip；q=0 視為不接受）。 */
export function pickEncoding(header: string | undefined): 'br' | 'gzip' | 'identity' {
  const accepted = new Set<string>();
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name);
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return 'identity';
}
