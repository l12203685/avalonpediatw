/**
 * rounds 區塊（generate_cache.compute_rounds 逐行移植；網站「分析 › 派隊」的 RoundsAnalysis、
 * GET /api/analysis/rounds 原樣回傳）。Edward 2026-10-14 複合篩選：篩選後的局重算，不篩選時與快取逐欄相同。
 *
 *   visionStats       首隊（1-1）有沒有梅林 / 派西維爾：第一個任務通過率、紅藍勝率、三結果
 *   redInR11          首隊的紅方人數（座位對到紅方角色的字元數）→ 同上，依人數排序
 *   mission1Branch    第一個任務通過 / 失敗之後：紅方勝率、梅林被刺率、三結果
 *   roundProgression  第一局..第五局 欄：藍 / 紅 的比率（有寫的局；「?」= 其他寫法，算進局數）
 *   gameStates        局勢欄（紅藍順序）最常見的 20 種：紅方勝率、三結果（同局數保持首次出現順序）
 *
 * 看全部局（含結果不在三種內的局）；勝負是任務階段的規則（red_win = 三紅、blue_win = 三藍死或三藍活、
 * merlin_killed = 三藍死）。首隊只算 1-1 有寫的局（r11_seats 非空）。
 */
import type { Game } from './dataset';
import { MISSION_ROUNDS } from './missions';
import { outcomeSplit, type OutcomeSplit } from './players';
import { rate, sortByKey } from './pyround';

/** 第一局..第五局（roundProgression 的鍵；牌譜每個任務紅 / 藍的欄名）。 */
export const ROUND_LABELS = ['第一局', '第二局', '第三局', '第四局', '第五局'] as const;
/** gameStates 只列最常見的這麼多種。 */
export const GAME_STATES_TOP_N = 20;

export interface VisionCell {
  games: number;
  mission1PassRate: number;
  redWinRate: number;
  outcomes: OutcomeSplit;
}

/** 梅林那兩格多一個藍方勝率（派西維爾那兩格沒有，與 Python 同）。 */
export interface MerlinVisionCell {
  games: number;
  mission1PassRate: number;
  redWinRate: number;
  blueWinRate: number;
  outcomes: OutcomeSplit;
}

export interface RoundsSection {
  visionStats: {
    merlinInTeam: MerlinVisionCell;
    merlinNotInTeam: MerlinVisionCell;
    percivalInTeam: VisionCell;
    percivalNotInTeam: VisionCell;
  };
  redInR11: Array<{ redCount: number } & VisionCell>;
  mission1Branch: Array<{ passed: boolean; games: number; redWinRate: number; merlinKillRate: number; outcomes: OutcomeSplit }>;
  roundProgression: Record<string, { bluePct: number; redPct: number; total: number }>;
  gameStates: Array<{ state: string; games: number; redWinRate: number; outcomes: OutcomeSplit }>;
}

function count(games: readonly Game[], test: (g: Game) => boolean): number {
  let n = 0;
  for (const g of games) if (test(g)) n += 1;
  return n;
}

/** 第一個任務通過（沒有小寫 x）的比率；沒有局 = 0。 */
function mission1PassRate(gs: readonly Game[]): number {
  return rate(count(gs, (g) => g.missions.some((m) => m.round === MISSION_ROUNDS[0] && m.fails === 0)), gs.length);
}

function redWinRate(gs: readonly Game[]): number {
  return rate(count(gs, (g) => g.redWin), gs.length);
}

function blueWinRate(gs: readonly Game[]): number {
  return rate(count(gs, (g) => g.blueWin), gs.length);
}

function merlinKillRate(gs: readonly Game[]): number {
  return rate(count(gs, (g) => g.merlinKilled), gs.length);
}

function merlinCell(gs: readonly Game[]): MerlinVisionCell {
  return {
    games: gs.length,
    mission1PassRate: mission1PassRate(gs),
    redWinRate: redWinRate(gs),
    blueWinRate: blueWinRate(gs),
    outcomes: outcomeSplit(gs),
  };
}

function visionCell(gs: readonly Game[]): VisionCell {
  return { games: gs.length, mission1PassRate: mission1PassRate(gs), redWinRate: redWinRate(gs), outcomes: outcomeSplit(gs) };
}

/** generate_cache.count_mission_fails：小寫 x 的個數。 */
function countFails(cell: string): number {
  let n = 0;
  for (const ch of cell) if (ch === 'x') n += 1;
  return n;
}

/** generate_cache.compute_rounds（全部局）。 */
export function computeRounds(games: readonly Game[]): RoundsSection {
  const valid = games.filter((g) => g.r11Seats.length > 0);

  const merlinIn = valid.filter((g) => g.r11HasMerlin);
  const merlinOut = valid.filter((g) => !g.r11HasMerlin);
  const percIn = valid.filter((g) => g.r11HasPercival);
  const percOut = valid.filter((g) => !g.r11HasPercival);

  // 首隊紅方人數（defaultdict 的分組，再依人數排序；人數不重複，排序與首次出現順序無關）
  const byRedCount = new Map<number, Game[]>();
  for (const g of valid) {
    const list = byRedCount.get(g.r11RedCount);
    if (list) list.push(g);
    else byRedCount.set(g.r11RedCount, [g]);
  }
  const redInR11 = sortByKey(
    [...byRedCount].map(([redCount, gs]) => ({ redCount, ...visionCell(gs) })),
    (row) => [row.redCount],
  );

  // 第一個任務的分支：第一局成功失敗 欄有寫的局
  const withM1 = games.filter((g) => Boolean(g.roundResults[0]));
  const m1Passed = withM1.filter((g) => countFails(g.roundResults[0]) === 0);
  const m1Failed = withM1.filter((g) => countFails(g.roundResults[0]) > 0);
  const branch = (isPassed: boolean, gs: readonly Game[]): RoundsSection['mission1Branch'][number] => ({
    passed: isPassed,
    games: gs.length,
    redWinRate: redWinRate(gs),
    merlinKillRate: merlinKillRate(gs),
    outcomes: outcomeSplit(gs),
  });

  // 每個任務 紅 / 藍 的比率（第N局 欄有寫的局）
  const roundProgression: RoundsSection['roundProgression'] = {};
  ROUND_LABELS.forEach((label, i) => {
    const withRound = games.filter((g) => Boolean(g.rounds[i]));
    if (!withRound.length) return;
    roundProgression[label] = {
      bluePct: rate(count(withRound, (g) => g.rounds[i] === '藍'), withRound.length),
      redPct: rate(count(withRound, (g) => g.rounds[i] === '紅'), withRound.length),
      total: withRound.length,
    };
  });

  // 局勢：依局數由多到少（穩定：同局數保持首次出現順序，= Python sorted(reverse=True)），取前 20
  const byState = new Map<string, Game[]>();
  for (const g of games) {
    if (!g.gameState) continue;
    const list = byState.get(g.gameState);
    if (list) list.push(g);
    else byState.set(g.gameState, [g]);
  }
  const gameStates = sortByKey(
    [...byState].map(([state, gs]) => ({ state, games: gs.length, redWinRate: redWinRate(gs), outcomes: outcomeSplit(gs) })),
    (row) => [-row.games],
  ).slice(0, GAME_STATES_TOP_N);

  return {
    visionStats: {
      merlinInTeam: merlinCell(merlinIn),
      merlinNotInTeam: merlinCell(merlinOut),
      percivalInTeam: visionCell(percIn),
      percivalNotInTeam: visionCell(percOut),
    },
    redInR11,
    mission1Branch: [branch(true, m1Passed), branch(false, m1Failed)],
    roundProgression,
    gameStates,
  };
}
