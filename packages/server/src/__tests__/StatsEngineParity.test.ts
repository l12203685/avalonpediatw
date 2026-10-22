/**
 * 複合篩選的計算引擎（@avalon/shared/stats）與 generate_cache.py 逐欄相同（Edward 2026-10-14「我希望所有數據
 * 都有可以複合篩選的功能」；r9 設計 §4）。不允許任何容差：數字依數值比、物件比鍵集合、陣列依序。
 *
 *   A. committed 的 games_cache.json + analysis_cache.json：不篩選時引擎 = 快取的 overview / players /
 *      playerDetails / leaderboard。兩檔不同批（dataset.key ≠ overview.gamesKey，例如每日更新還沒用新的
 *      產生器寫過）時 skip 並說明原因。
 *   B. 虛構局的固定 fixture（fixtures/stats_parity/invented，build_stats_parity_fixtures.py --source invented
 *      --bundle 產生；名字全是虛構的）× fixtures/stats_parity/presets.json 的每個篩選：參考答案 = Python
 *      在篩選後的局上跑 build_cache（stats_filter_reference.py）。
 *   C. AVALON_STATS_PARITY_DIR（CI 從牌譜快照現產，不 commit）× 同一組篩選。
 *
 * 失敗時只印欄位路徑與差異數（playerDetails 的鍵換成 #索引），不印名字。
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import {
  computeStats,
  decodeGamesDataset,
  diffSections,
  type DecodedDataset,
  type GameFilter,
  type StatsContext,
} from '@avalon/shared/stats';

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const FIXTURES = path.resolve(__dirname, 'fixtures', 'stats_parity');
const SECTIONS = ['overview', 'players', 'missions', 'rounds', 'captainAnalysis', 'leaderboard',
  'lake', 'seatOrder', 'lakeClaim', 'pairs'] as const;

/** 本測試讀取的分析快取欄位。 */
interface CommittedCache {
  overview: { gamesKey?: string } & Record<string, unknown>;
  players: { aliases?: Record<string, string> } & Record<string, unknown>;
  playerDetails: Record<string, unknown>;
  missions: unknown;
  rounds: unknown;
  captainAnalysis: unknown;
  leaderboard: { asOf: string } & Record<string, unknown>;
  lake: unknown;
  seatOrder: unknown;
  chemistry: { coWin: { players: string[]; rowLabels?: string[] }; outcomePair: unknown };
  featureStudies?: { features: Array<{ loopId: string }> };
}

interface RefBody {
  id: string;
  filter: GameFilter;
  meta: { totalGames: number; gamesAfterClauses: number; games: number; droppedPlayers: number; hiddenPlayers: number; asOf: string };
  sections: Record<string, unknown>;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

/** compute_player_details 從 players 列推出的 playerDetails（bundle 不帶 playerDetails 時用）。 */
function detailsFromPlayers(players: { players: Array<Record<string, unknown>> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of players.players) {
    const { seatOutcomes: _seatOutcomes, ...player } = row;
    void _seatOutcomes;
    Object.defineProperty(out, row.name as string, {
      value: { player, radar: { ...(row.roleWinRates as Record<string, number>) } },
      enumerable: true,
    });
  }
  return out;
}

/** 每個區塊都比完再一起判定（失敗時看得到所有不同的區塊）。 */
function expectSame(pairs: Array<[label: string, expected: unknown, actual: unknown]>): void {
  const failures: string[] = [];
  for (const [label, expected, actual] of pairs) {
    const report = diffSections(expected, actual, label, 20);
    if (report.differences) failures.push(`${label}: ${report.differences} difference(s)`
      + (process.env.GITHUB_ACTIONS === 'true' ? '' : `: ${report.paths.join(', ')}`));
  }
  // eslint-disable-next-line no-console
  if (failures.length) console.error(`[parity]\n  ${failures.join('\n  ')}`);
  expect(failures).toEqual([]);
}

function checkReferences(dir: string, refs: Record<string, RefBody>, decoded: DecodedDataset, context: StatsContext): void {
  for (const ref of Object.values(refs)) {
    it(`${path.basename(dir)} / ${ref.id}`, () => {
      const result = computeStats(decoded, context, ref.filter);
      expect({
        totalGames: result.meta.totalGames,
        gamesAfterClauses: result.meta.gamesAfterClauses,
        games: result.meta.games,
        droppedPlayers: result.meta.droppedPlayers,
        hiddenPlayers: result.meta.hiddenPlayers,
        asOf: result.meta.asOf,
      }).toEqual(ref.meta);
      const details = ref.sections.playerDetails ?? detailsFromPlayers(ref.sections.players as { players: Array<Record<string, unknown>> });
      expectSame([
        ...SECTIONS.map((section): [string, unknown, unknown] => [section, ref.sections[section], result[section]]),
        ['playerDetails', details, result.playerDetails],
      ]);
    });
  }
}

function loadFixtureDir(dir: string): { decoded: DecodedDataset; context: StatsContext; refs: Record<string, RefBody> } {
  const context = readJson<StatsContext & { presets: string[] }>(path.join(dir, 'context.json'));
  const decoded = decodeGamesDataset(readJson(path.join(dir, 'games.json')));
  const bundle = path.join(dir, 'refs.json.gz');
  const refs: Record<string, RefBody> = fs.existsSync(bundle)
    ? (JSON.parse(zlib.gunzipSync(fs.readFileSync(bundle)).toString('utf-8')) as Record<string, RefBody>)
    : Object.fromEntries(context.presets.map((id) => [id, readJson<RefBody>(path.join(dir, 'ref', `${id}.json`))]));
  return { decoded, context, refs };
}

describe('stats engine parity — A: the committed games_cache.json and analysis_cache.json', () => {
  // 可用環境變數驗證另一組離線產生的分析快取與每局資料集。
  const datasetPath = path.resolve(process.env.AVALON_GAMES_DATASET?.trim() || path.join(SERVER_DIR, 'games_cache.json'));
  const cachePath = path.resolve(process.env.AVALON_ANALYSIS_CACHE?.trim() || path.join(SERVER_DIR, 'analysis_cache.json'));
  const cache = fs.existsSync(cachePath) ? readJson<CommittedCache>(cachePath) : null;
  const dataset = fs.existsSync(datasetPath) ? readJson<{ key: string }>(datasetPath) : null;
  const key = cache?.overview?.gamesKey;
  const reason = !dataset ? 'games_cache.json not found'
    : !cache ? 'analysis_cache.json not found'
      : key !== dataset.key ? 'the two files are not one batch: the daily refresh has not written them together yet'
        : '';
  if (reason) {
    it.skip(`skipped: ${reason}`, () => undefined);
    return;
  }
  it('every section the engine builds equals the cache (no filter)', () => {
    const decoded = decodeGamesDataset(dataset, key);
    const result = computeStats(decoded, { asOf: cache!.leaderboard.asOf, aliases: cache!.players.aliases ?? {},
      chemistryRoster: cache!.chemistry.coWin }, null);
    expectSame([
      ['overview', cache!.overview, result.overview],
      ['players', cache!.players, result.players],
      ['playerDetails', cache!.playerDetails, result.playerDetails],
      ['missions', cache!.missions, result.missions],
      ['rounds', cache!.rounds, result.rounds],
      ['captainAnalysis', cache!.captainAnalysis, result.captainAnalysis],
      ['leaderboard', cache!.leaderboard, result.leaderboard],
      ['lake', cache!.lake, result.lake],
      ['seatOrder', cache!.seatOrder, result.seatOrder],
      ['chemistry.outcomePair', cache!.chemistry.outcomePair, result.pairs.outcomePair],
      ['featureStudies.L141', cache!.featureStudies?.features.find((f) => f.loopId === 'L141'), result.lakeClaim],
    ]);
  });
});

describe('stats engine parity — B: invented games x the filter presets', () => {
  const { decoded, context, refs } = loadFixtureDir(path.join(FIXTURES, 'invented'));
  it('covers every preset', () => {
    const presets = readJson<Array<{ id: string; filter: GameFilter }>>(path.join(FIXTURES, 'presets.json'));
    expect(Object.keys(refs)).toEqual(presets.map((p) => p.id));
    for (const p of presets) expect(refs[p.id].filter).toEqual(p.filter);
  });
  checkReferences(path.join(FIXTURES, 'invented'), refs, decoded, context);
});

const parityDir = process.env.AVALON_STATS_PARITY_DIR?.trim();
describe('stats engine parity — C: AVALON_STATS_PARITY_DIR (the 牌譜 snapshot, built in CI)', () => {
  if (!parityDir || !fs.existsSync(path.join(parityDir, 'games.json'))) {
    it.skip('skipped: set AVALON_STATS_PARITY_DIR (python3.11 packages/server/scripts/build_stats_parity_fixtures.py --source snapshot --out DIR)', () => undefined);
    return;
  }
  const { decoded, context, refs } = loadFixtureDir(parityDir);
  checkReferences(parityDir, refs, decoded, context);
});
