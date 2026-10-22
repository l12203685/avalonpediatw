/**
 * 複合篩選的計算引擎 — lake 區塊與 featureStudies 的 L141「湖中宣告可信度」與 generate_cache.py 逐欄相同
 * （Edward 2026-10-14「我希望所有數據都有可以複合篩選的功能」；r9 設計 §4）。不允許任何容差，中英文字串一字不差。
 *
 *   A. committed 的 games_cache.json + analysis_cache.json：不篩選時引擎 = 快取的 lake 與 featureStudies
 *      （L141 換成引擎算的、generatedAt / sampleSize 跟著換；其他研究原樣）。兩檔不同批時 skip 並說明原因。
 *   B. 虛構局的固定 fixture（fixtures/stats_parity/invented/lake_refs.json.gz，build_lake_parity_fixture.py
 *      --source invented 產生；名字全是虛構的）× presets.json 的每個篩選：參考答案 = Python 在篩選後的局上
 *      跑 build_cache 的 lake 與 refresh_feature_studies（沒有舊區塊、以及虛構的沿用區塊兩種）。
 *   C. AVALON_STATS_PARITY_DIR 裡的 lake_refs.json（build_lake_parity_fixture.py --source snapshot 從牌譜快照
 *      現產，不 commit）× 同一組篩選。
 *
 * 失敗時只印欄位路徑與差異數，不印名字（lake 與 L141 本來就沒有名字）。
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  computeFeatureStudies,
  computeLake,
  decodeGamesDataset,
  diffSections,
  type DecodedDataset,
  type FeatureStudiesSection,
  type GameFilter,
} from '@avalon/shared/stats';

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const FIXTURES = path.resolve(__dirname, 'fixtures', 'stats_parity');

interface LakeRef {
  id: string;
  filter: GameFilter;
  meta: { games: number; asOf: string };
  lake: unknown;
  featureStudies: unknown;
  /** 虛構的沿用區塊（其他研究、放在中間的舊 L141、多的鍵）與 Python 換進 L141 後的結果。 */
  previousStudies: FeatureStudiesSection;
  featureStudiesMerged: unknown;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

function expectSame(pairs: Array<[label: string, expected: unknown, actual: unknown]>): void {
  const failures: string[] = [];
  for (const [label, expected, actual] of pairs) {
    const report = diffSections(expected, actual, label, 20);
    if (report.differences) failures.push(`${label}: ${report.differences} difference(s): ${report.paths.join(', ')}`);
  }
  // eslint-disable-next-line no-console
  if (failures.length) console.error(`[lake parity]\n  ${failures.join('\n  ')}`);
  expect(failures).toEqual([]);
}

function checkReferences(dir: string, refs: Record<string, LakeRef>, decoded: DecodedDataset, asOf: string): void {
  for (const ref of Object.values(refs)) {
    it(`${path.basename(dir)} / ${ref.id}`, () => {
      const app = applyFilter(decoded, { asOf }, ref.filter);
      expect({ games: app.games.length, asOf: app.asOf }).toEqual(ref.meta);
      expectSame([
        ['lake', ref.lake, computeLake(app.games)],
        ['featureStudies', ref.featureStudies, computeFeatureStudies(app.games, decoded.config, app.asOf)],
        ['featureStudiesMerged', ref.featureStudiesMerged,
          computeFeatureStudies(app.games, decoded.config, app.asOf, ref.previousStudies)],
      ]);
    });
  }
}

describe('lake parity — A: the committed games_cache.json and analysis_cache.json', () => {
  const datasetPath = path.resolve(process.env.AVALON_GAMES_DATASET?.trim() || path.join(SERVER_DIR, 'games_cache.json'));
  const cachePath = path.resolve(process.env.AVALON_ANALYSIS_CACHE?.trim() || path.join(SERVER_DIR, 'analysis_cache.json'));
  const cache = fs.existsSync(cachePath)
    ? readJson<{
      overview: { gamesKey?: string };
      leaderboard: { asOf: string };
      lake: unknown;
      featureStudies?: FeatureStudiesSection;
    }>(cachePath)
    : null;
  const dataset = fs.existsSync(datasetPath) ? readJson<{ key: string }>(datasetPath) : null;
  const key = cache?.overview?.gamesKey;
  const reason = !dataset ? 'games_cache.json not found'
    : !cache ? 'analysis_cache.json not found'
      : key !== dataset.key ? `the two files are not one batch (overview.gamesKey ${String(key)} vs dataset ${dataset.key}): the daily refresh has not written them together yet`
        : '';
  if (reason) {
    it.skip(`skipped: ${reason}`, () => undefined);
    return;
  }
  it('lake and featureStudies (L141 recomputed, the other studies as they are) equal the cache (no filter)', () => {
    const decoded = decodeGamesDataset(dataset, key);
    const app = applyFilter(decoded, { asOf: cache!.leaderboard.asOf }, null);
    expectSame([
      ['lake', cache!.lake, computeLake(app.games)],
      ['featureStudies', cache!.featureStudies, computeFeatureStudies(app.games, decoded.config, app.asOf, cache!.featureStudies)],
    ]);
  });
});

describe('lake parity — B: invented games x the filter presets', () => {
  const dir = path.join(FIXTURES, 'invented');
  const context = readJson<{ asOf: string; presets: string[] }>(path.join(dir, 'context.json'));
  const decoded = decodeGamesDataset(readJson(path.join(dir, 'games.json')));
  const refs = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'lake_refs.json.gz'))).toString('utf-8')) as Record<string, LakeRef>;
  it('covers every preset', () => {
    const presets = readJson<Array<{ id: string; filter: GameFilter }>>(path.join(FIXTURES, 'presets.json'));
    expect(Object.keys(refs)).toEqual(presets.map((p) => p.id));
    for (const p of presets) expect(refs[p.id].filter).toEqual(p.filter);
  });
  checkReferences(dir, refs, decoded, context.asOf);
});

const parityDir = process.env.AVALON_STATS_PARITY_DIR?.trim();
describe('lake parity — C: AVALON_STATS_PARITY_DIR (the 牌譜 snapshot, built in CI)', () => {
  const refsPath = parityDir ? path.join(parityDir, 'lake_refs.json') : '';
  if (!parityDir || !fs.existsSync(path.join(parityDir, 'games.json')) || !fs.existsSync(refsPath)) {
    it.skip('skipped: set AVALON_STATS_PARITY_DIR to a directory with games.json and lake_refs.json (python3.11 packages/server/scripts/build_stats_parity_fixtures.py --source snapshot --out DIR, then build_lake_parity_fixture.py --source snapshot --out DIR)', () => undefined);
    return;
  }
  const context = readJson<{ asOf: string }>(path.join(parityDir, 'context.json'));
  const decoded = decodeGamesDataset(readJson(path.join(parityDir, 'games.json')));
  checkReferences(parityDir, readJson<Record<string, LakeRef>>(refsPath), decoded, context.asOf);
});
