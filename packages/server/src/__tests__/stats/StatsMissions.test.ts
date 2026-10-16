/**
 * 任務層級的區塊（missions、rounds、captainAnalysis；網站「分析 › 任務」「分析 › 派隊」）在篩選後的局上重算
 * （Edward 2026-10-14「我希望所有數據都有可以複合篩選的功能 … 線瓦/面瓦、娛樂局、排除某些條件玩家 …」；
 * r9 設計 §3.6：這三個區塊只看「哪些局」，與 as-of、名字、隱藏的人無關）。
 *
 *   一致性（與 generate_cache.py 逐欄相同，不允許任何容差）：
 *     A. committed 的 games_cache.json + analysis_cache.json 同批時，不篩選 = 快取的三個區塊（不同批時 skip）。
 *     B. 虛構局 fixture × presets.json 的每個篩選、加上「怪局」（大寫 X、跳過的任務、全形隊長、沒有 1-1、
 *        局勢 / 第N局 的怪值…）：參考答案 = Python 在篩選後的局上跑 build_cache
 *        （scripts/build_mission_parity_fixture.py --source invented 產生 mission_refs.json.gz）。
 *     C. AVALON_STATS_PARITY_DIR 裡有 mission_refs.json.gz 時（牌譜快照，CI 現產，不 commit）× 同一組篩選。
 *   篩選後的數字：小型虛構資料集，逐一手算。
 *
 * 失敗時只印欄位路徑與差異數，不印名字。
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import {
  applyFilter,
  computeCaptainAnalysis,
  computeMissions,
  computeRounds,
  decodeGamesDataset,
  diffSections,
  missionOf,
  type Clause,
  type DecodedDataset,
  type Game,
  type GameFilter,
  type GamesDataset,
} from '@avalon/shared/stats';
import { TEN, makeDataset, type GameSpec } from './datasetBuilder';

const SERVER_DIR = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'stats_parity');
const REFS_NAME = 'mission_refs.json.gz';
const SECTION_NAMES = ['missions', 'rounds', 'captainAnalysis'] as const;
const AS_OF = '2026-10-14';

type SectionName = (typeof SECTION_NAMES)[number];

interface MissionRefs {
  presets: Record<string, { id: string; filter: GameFilter; games: number; sections: Record<SectionName, unknown> }>;
  odd?: { dataset: GamesDataset; sections: Record<SectionName, unknown> };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

function readRefs(dir: string): MissionRefs {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, REFS_NAME))).toString('utf-8')) as MissionRefs;
}

function missionSections(games: readonly Game[]): Record<SectionName, unknown> {
  return { missions: computeMissions(games), rounds: computeRounds(games), captainAnalysis: computeCaptainAnalysis(games) };
}

/** 三個區塊都比完再一起判定（失敗時看得到所有不同的路徑）。 */
function expectSameSections(expected: Record<string, unknown>, actual: Record<string, unknown>): void {
  const failures: string[] = [];
  for (const name of SECTION_NAMES) {
    const report = diffSections(expected[name], actual[name], name, 20);
    if (report.differences) failures.push(`${name}: ${report.differences} difference(s): ${report.paths.join(', ')}`);
  }
  // eslint-disable-next-line no-console
  if (failures.length) console.error(`[mission parity]\n  ${failures.join('\n  ')}`);
  expect(failures).toEqual([]);
}

function checkPresets(label: string, decoded: DecodedDataset, asOf: string, refs: MissionRefs): void {
  for (const ref of Object.values(refs.presets)) {
    it(`${label} / ${ref.id}`, () => {
      const app = applyFilter(decoded, { asOf }, ref.filter);
      expect(app.games.length).toBe(ref.games);
      expectSameSections(ref.sections, missionSections(app.games));
    });
  }
}

describe('mission-level parity — A: the committed games_cache.json and analysis_cache.json', () => {
  const datasetPath = path.resolve(process.env.AVALON_GAMES_DATASET?.trim() || path.join(SERVER_DIR, 'games_cache.json'));
  const cachePath = path.resolve(process.env.AVALON_ANALYSIS_CACHE?.trim() || path.join(SERVER_DIR, 'analysis_cache.json'));
  const cache = fs.existsSync(cachePath)
    ? readJson<{ overview: { gamesKey?: string }; leaderboard: { asOf: string } } & Record<string, unknown>>(cachePath)
    : null;
  const dataset = fs.existsSync(datasetPath) ? readJson<{ key: string }>(datasetPath) : null;
  const key = cache?.overview?.gamesKey;
  const reason = !dataset ? 'games_cache.json not found'
    : !cache ? 'analysis_cache.json not found'
      : key !== dataset.key ? `the two files are not one batch (overview.gamesKey ${String(key)} vs dataset ${dataset.key})`
        : '';
  if (reason) {
    it.skip(`skipped: ${reason}`, () => undefined);
    return;
  }
  it('missions, rounds and captainAnalysis of every game equal the cache (no filter)', () => {
    const decoded = decodeGamesDataset(dataset, key);
    expectSameSections(cache!, missionSections(applyFilter(decoded, { asOf: cache!.leaderboard.asOf }, null).games));
  });
});

describe('mission-level parity — B: invented games x the filter presets, and odd games', () => {
  const dir = path.join(FIXTURES, 'invented');
  const refs = readRefs(dir);
  const context = readJson<{ asOf: string }>(path.join(dir, 'context.json'));
  const decoded = decodeGamesDataset(readJson(path.join(dir, 'games.json')));

  it('covers every preset', () => {
    const presets = readJson<Array<{ id: string; filter: GameFilter }>>(path.join(FIXTURES, 'presets.json'));
    expect(Object.keys(refs.presets)).toEqual(presets.map((p) => p.id));
    for (const p of presets) expect(refs.presets[p.id].filter).toEqual(p.filter);
  });
  checkPresets('invented', decoded, context.asOf, refs);

  it('odd games: upper-case X, skipped missions, full-width captains, blank / odd 1-1, 第N局 and 局勢 cells', () => {
    const odd = refs.odd!;
    const games = decodeGamesDataset(odd.dataset).games;
    expect(games).toHaveLength(10);
    expect(games.some((g) => g.roundResults.some((cell) => cell.includes('X')))).toBe(true);
    expect(games.some((g) => g.captains.includes('?'))).toBe(true);
    expect(games.some((g) => g.gameState === '?')).toBe(true);
    expectSameSections(odd.sections, missionSections(games));
  });
});

const parityDir = process.env.AVALON_STATS_PARITY_DIR?.trim();
describe('mission-level parity — C: AVALON_STATS_PARITY_DIR (the 牌譜 snapshot, built in CI)', () => {
  if (!parityDir || !fs.existsSync(path.join(parityDir, 'games.json')) || !fs.existsSync(path.join(parityDir, REFS_NAME))) {
    it.skip('skipped: set AVALON_STATS_PARITY_DIR to a directory written by build_stats_parity_fixtures.py and build_mission_parity_fixture.py (--source snapshot --out DIR)', () => undefined);
    return;
  }
  const context = readJson<{ asOf: string }>(path.join(parityDir, 'context.json'));
  checkPresets('snapshot', decodeGamesDataset(readJson(path.join(parityDir, 'games.json'))), context.asOf, readRefs(parityDir));
});

// ── 篩選後的數字（手算）────────────────────────────────────────────────────────
// 配置 123456：1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫、5 派西維爾、6 梅林、7..10 忠臣。
const QUILL = 'Quill';
const SPECS: GameSpec[] = [
  // 線瓦。任務 1 一張失敗、2 通過、3 兩張失敗。首隊 1 5 7：一紅、有派西。
  { id: 'A', cat: '線瓦', outcome: '三紅', missions: 'oox|oooo|oxxo||', rounds: 'RBR--', state: '紅藍紅', firstTeam: '157', captains: '12' },
  // 線瓦。全部通過。首隊 6 7 8：有梅林。Quill 在 10 號位。
  {
    id: 'B', cat: '線瓦', outcome: '三藍活', missions: 'ooo|oooo|oooo||', rounds: 'BBB--', state: '藍藍藍', firstTeam: '678',
    captains: '7-6', names: [...TEN.slice(0, 9), QUILL],
  },
  // 面瓦。沒有 1-1；任務 2 失敗、任務 4 通過；第一個隊長是「?」（全形數字之類：當忠臣 → 藍方）。
  { id: 'C', cat: '面瓦', outcome: '三藍死', missions: 'ooo|oxoo|oooo|ooooo|', rounds: 'BRBB-', state: '藍紅藍藍', firstTeam: '', captains: '?3' },
  // 娛樂。任務 1 三張失敗、任務 2 大寫 X（不算失敗）、第三局 欄是怪值「?」。首隊 1 2：兩紅。
  { id: 'D', cat: '娛樂', outcome: '三紅', missions: 'xxx|ooXo|oxxx||', rounds: 'RB?--', state: '紅藍紅', firstTeam: '12', captains: '4' },
  // 線瓦、沒有結果、只打了兩個任務；第三個隊長沒有任務結果（不算）。
  { id: 'E', cat: '線瓦', outcome: '', missions: 'oox|ooo||', rounds: 'RB---', firstTeam: '90', captains: '005' },
];
const decoded = decodeGamesDataset(makeDataset(SPECS));

function gamesOf(...clauses: Clause[]): Game[] {
  return applyFilter(decoded, { asOf: AS_OF }, { v: 1, clauses }).games;
}

const split = (threeRed: number, threeBlueDead: number, threeBlueAlive: number, n: number) => ({
  threeRed, threeBlueDead, threeBlueAlive,
  threeRedPct: n ? Math.round((threeRed / n) * 1000) / 10 : 0,
  threeBlueDeadPct: n ? Math.round((threeBlueDead / n) * 1000) / 10 : 0,
  threeBlueAlivePct: n ? Math.round((threeBlueAlive / n) * 1000) / 10 : 0,
});

describe('missions on the filtered games', () => {
  it('every game: pass rates, fail counts, what followed a passed / failed mission', () => {
    const m = computeMissions(decoded.games);
    expect(m.missionPassRates).toEqual([
      { round: 1, passRate: 40, totalGames: 5 }, // B C pass
      { round: 2, passRate: 80, totalGames: 5 }, // only C fails (D's upper-case X is not a fail)
      { round: 3, passRate: 50, totalGames: 4 },
      { round: 4, passRate: 100, totalGames: 1 },
    ]);
    expect(m.missionOutcomeByRound).toEqual([
      { round: 1, allPass: 2, oneFail: 2, twoFail: 1, total: 5 },
      { round: 2, allPass: 4, oneFail: 1, twoFail: 0, total: 5 },
      { round: 3, allPass: 2, oneFail: 0, twoFail: 2, total: 4 },
      { round: 4, allPass: 1, oneFail: 0, twoFail: 0, total: 1 },
    ]);
    expect(m.missionOutcomeCorrelation[0]).toEqual({
      round: 1,
      passedGames: 2, passedThenBlueWin: 2, passedBlueWinRate: 100, passedOutcomes: split(0, 1, 1, 2),
      failedGames: 3, failedThenRedWin: 2, failedRedWinRate: 66.7, failedOutcomes: split(2, 0, 0, 3), // E has no 結果
    });
    expect(m.missionOutcomeCorrelation[1]).toMatchObject({ passedGames: 4, passedThenBlueWin: 1, passedBlueWinRate: 25, failedGames: 1, failedRedWinRate: 0 });
    expect(m.missionOutcomeCorrelation[3]).toEqual({
      round: 4,
      passedGames: 1, passedThenBlueWin: 1, passedBlueWinRate: 100, passedOutcomes: split(0, 1, 0, 1),
      failedGames: 0, failedThenRedWin: 0, failedRedWinRate: 0, failedOutcomes: split(0, 0, 0, 0),
    });
  });

  it('線瓦 only: A B E', () => {
    const games = gamesOf({ kind: 'category', in: ['線瓦'] });
    expect(games.map((g) => g.id)).toEqual(['A', 'B', 'E']);
    const m = computeMissions(games);
    expect(m.missionPassRates).toEqual([
      { round: 1, passRate: 33.3, totalGames: 3 },
      { round: 2, passRate: 100, totalGames: 3 },
      { round: 3, passRate: 50, totalGames: 2 },
    ]);
    expect(m.missionOutcomeByRound[0]).toEqual({ round: 1, allPass: 1, oneFail: 2, twoFail: 0, total: 3 });
    expect(m.missionOutcomeCorrelation[0]).toMatchObject({
      passedGames: 1, passedBlueWinRate: 100, failedGames: 2, failedThenRedWin: 1, failedRedWinRate: 50, failedOutcomes: split(1, 0, 0, 2),
    });
  });

  it('without 娛樂: D (3 fails on mission 1, all-red mission 3) is gone', () => {
    const m = computeMissions(gamesOf({ kind: 'category', in: ['娛樂'], not: true }));
    expect(m.missionOutcomeByRound[0]).toEqual({ round: 1, allPass: 2, oneFail: 2, twoFail: 0, total: 4 });
    expect(m.missionPassRates[2]).toEqual({ round: 3, passRate: 66.7, totalGames: 3 });
    expect(m.missionOutcomeCorrelation[0].failedRedWinRate).toBe(50); // A of A, E
  });

  it('composite: 線瓦 AND without the games of a player (dropGames) — only A and E are left', () => {
    const games = gamesOf(
      { kind: 'category', in: ['線瓦'] },
      { kind: 'excludePlayers', scope: 'dropGames', who: { by: 'names', names: ['quill'] } },
    );
    expect(games.map((g) => g.id)).toEqual(['A', 'E']);
    const m = computeMissions(games);
    expect(m.missionPassRates[0]).toEqual({ round: 1, passRate: 0, totalGames: 2 });
    expect(m.missionOutcomeCorrelation[0]).toMatchObject({ passedGames: 0, passedBlueWinRate: 0, failedGames: 2, failedRedWinRate: 50 });
    // 只隱藏名單會保留全部對局，任務數字不變。
    const hidden = gamesOf({ kind: 'excludePlayers', scope: 'hideFromLists', who: { by: 'names', names: [QUILL] } });
    expect(computeMissions(hidden)).toEqual(computeMissions(decoded.games));
  });

  it('no game, no row', () => {
    expect(computeMissions([])).toEqual({ missionPassRates: [], missionOutcomeByRound: [], missionOutcomeCorrelation: [] });
    expect(missionOf(decoded.games[4], 3)).toBeUndefined();
    expect(missionOf(decoded.games[3], 2)).toEqual({ round: 2, fails: 0, total: 4 });
  });
});

describe('rounds on the filtered games', () => {
  it('every game: first team, mission 1 branch, round progression, game states', () => {
    const r = computeRounds(decoded.games);
    // 有首隊記錄的有效對局為 A、B、D、E。
    expect(r.visionStats.merlinInTeam).toEqual({ games: 1, mission1PassRate: 100, redWinRate: 0, blueWinRate: 100, outcomes: split(0, 0, 1, 1) });
    expect(r.visionStats.merlinNotInTeam).toEqual({ games: 3, mission1PassRate: 0, redWinRate: 66.7, blueWinRate: 0, outcomes: split(2, 0, 0, 3) });
    expect(r.visionStats.percivalInTeam).toEqual({ games: 1, mission1PassRate: 0, redWinRate: 100, outcomes: split(1, 0, 0, 1) });
    expect(r.visionStats.percivalNotInTeam).toEqual({ games: 3, mission1PassRate: 33.3, redWinRate: 33.3, outcomes: split(1, 0, 1, 3) });
    expect(r.redInR11).toEqual([
      { redCount: 0, games: 2, mission1PassRate: 50, redWinRate: 0, outcomes: split(0, 0, 1, 2) }, // B E
      { redCount: 1, games: 1, mission1PassRate: 0, redWinRate: 100, outcomes: split(1, 0, 0, 1) }, // A
      { redCount: 2, games: 1, mission1PassRate: 0, redWinRate: 100, outcomes: split(1, 0, 0, 1) }, // D
    ]);
    expect(r.mission1Branch).toEqual([
      { passed: true, games: 2, redWinRate: 0, merlinKillRate: 50, outcomes: split(0, 1, 1, 2) },
      { passed: false, games: 3, redWinRate: 66.7, merlinKillRate: 0, outcomes: split(2, 0, 0, 3) },
    ]);
    expect(r.roundProgression).toEqual({
      第一局: { bluePct: 40, redPct: 60, total: 5 },
      第二局: { bluePct: 80, redPct: 20, total: 5 },
      第三局: { bluePct: 50, redPct: 25, total: 4 }, // D's "?" counts in the total only
      第四局: { bluePct: 100, redPct: 0, total: 1 },
    });
    // most games first; a tie keeps first-seen order (藍藍藍 before 藍紅藍藍, though 紅 < 藍 by code point)
    expect(r.gameStates).toEqual([
      { state: '紅藍紅', games: 2, redWinRate: 100, outcomes: split(2, 0, 0, 2) },
      { state: '藍藍藍', games: 1, redWinRate: 0, outcomes: split(0, 0, 1, 1) },
      { state: '藍紅藍藍', games: 1, redWinRate: 0, outcomes: split(0, 1, 0, 1) },
    ]);
  });

  it('面瓦 + 娛樂: C has no 1-1, so only D is in the first-team tables', () => {
    const r = computeRounds(gamesOf({ kind: 'category', in: ['面瓦', '娛樂'] }));
    expect(r.redInR11).toEqual([{ redCount: 2, games: 1, mission1PassRate: 0, redWinRate: 100, outcomes: split(1, 0, 0, 1) }]);
    expect(r.visionStats.merlinInTeam).toEqual({ games: 0, mission1PassRate: 0, redWinRate: 0, blueWinRate: 0, outcomes: split(0, 0, 0, 0) });
    expect(r.mission1Branch.map((b) => b.games)).toEqual([1, 1]);
    expect(r.roundProgression.第四局).toEqual({ bluePct: 100, redPct: 0, total: 1 });
    expect(r.gameStates.map((s) => s.state)).toEqual(['藍紅藍藍', '紅藍紅']);
  });

  it('only the 20 most common game states', () => {
    // 22 different 局勢 (1-4 missions: the binary digits of 2..23 after the leading 1, 0 = 紅, 1 = 藍)
    const states = Array.from({ length: 22 }, (_, i) => (i + 2).toString(2).slice(1).replace(/0/g, '紅').replace(/1/g, '藍'));
    const many = decodeGamesDataset(makeDataset([...states, states[21]].map((state) => ({ state })))).games;
    const r = computeRounds(many);
    expect(r.gameStates).toHaveLength(20);
    expect(r.gameStates[0]).toMatchObject({ state: states[21], games: 2 });
    expect(r.gameStates.slice(1).map((s) => s.state)).toEqual(states.slice(0, 19));
  });
});

describe('captainAnalysis on the filtered games', () => {
  it('every game: red / blue captains per mission, faction x result, the games behind them', () => {
    const c = computeCaptainAnalysis(decoded.games);
    expect(c.perMission).toEqual([
      { mission: 1, redCaptainRate: 40, blueCaptainRate: 60, games: 5 }, // A D red; B, C ("?"), E blue
      { mission: 2, redCaptainRate: 66.7, blueCaptainRate: 33.3, games: 3 }, // A C red, E blue (B has none)
      { mission: 3, redCaptainRate: 0, blueCaptainRate: 100, games: 1 }, // B; E's has no mission result
    ]);
    // sorted like Python: 紅方 < 藍方 (code point), fail < pass
    expect(c.captainFactionVsOutcome).toEqual([
      { captainFaction: '紅方', missionResult: 'fail', count: 3, percentage: 75 },
      { captainFaction: '紅方', missionResult: 'pass', count: 1, percentage: 25 },
      { captainFaction: '藍方', missionResult: 'fail', count: 1, percentage: 20 },
      { captainFaction: '藍方', missionResult: 'pass', count: 4, percentage: 80 },
    ]);
    expect(c.captainMissionGameWinRates).toEqual([
      { captainFaction: '紅方', missionResult: 'fail', totalMissions: 3, redGameWinRate: 66.7, blueGameWinRate: 33.3, outcomes: split(2, 1, 0, 3) },
      { captainFaction: '紅方', missionResult: 'pass', totalMissions: 1, redGameWinRate: 100, blueGameWinRate: 0, outcomes: split(1, 0, 0, 1) },
      { captainFaction: '藍方', missionResult: 'fail', totalMissions: 1, redGameWinRate: 0, blueGameWinRate: 0, outcomes: split(0, 0, 0, 1) },
      // B 計兩次：兩位藍方隊長的任務皆通過。
      { captainFaction: '藍方', missionResult: 'pass', totalMissions: 4, redGameWinRate: 0, blueGameWinRate: 75, outcomes: split(0, 1, 2, 4) },
    ]);
  });

  it('面瓦 only: C — the "?" captain is blue, seat 3 (莫德雷德) is red', () => {
    const c = computeCaptainAnalysis(gamesOf({ kind: 'category', in: ['面瓦'] }));
    expect(c.perMission).toEqual([
      { mission: 1, redCaptainRate: 0, blueCaptainRate: 100, games: 1 },
      { mission: 2, redCaptainRate: 100, blueCaptainRate: 0, games: 1 },
    ]);
    expect(c.captainFactionVsOutcome).toEqual([
      { captainFaction: '紅方', missionResult: 'fail', count: 1, percentage: 100 },
      { captainFaction: '藍方', missionResult: 'pass', count: 1, percentage: 100 },
    ]);
  });

  it('no captain parsed: empty tables', () => {
    expect(computeCaptainAnalysis(gamesOf({ kind: 'gameId', in: ['nothing'] }))).toEqual({
      perMission: [], captainFactionVsOutcome: [], captainMissionGameWinRates: [],
    });
  });
});
