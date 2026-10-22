/**
 * 任務分析 missions 區塊（generate_cache.compute_missions 逐行移植；網站「分析 › 任務」、
 * GET /api/analysis/missions 原樣回傳）。Edward 2026-10-14 複合篩選：篩選後的局重算，不篩選時與快取逐欄相同。
 *
 *   missionPassRates           每個任務：打到這個任務的局數、通過率
 *   missionOutcomeByRound      每個任務：0 張 / 1 張 / 2 張以上失敗的局數
 *   missionOutcomeCorrelation  每個任務通過 / 失敗之後：藍方勝（任務階段）/ 紅方勝的比率與三結果
 *
 * 看全部局（含結果不在三紅 / 三藍死 / 三藍活 的局，所以三結果的 % 加起來可能不到 100）。任務「通過」=
 * 任務格裡沒有小寫 x（count_mission_fails == 0：第 4 局 1 張失敗也算失敗、大寫 X 不算失敗，與 Python 同）。
 * 勝負是任務階段的規則（red_win = 三紅、blue_win = 三藍死或三藍活）。Python 裡算了沒輸出的
 * `mission_by_composition` 是死碼，不移植。
 */
import type { Game, MissionResult } from './dataset';
import { outcomeSplit, type OutcomeSplit } from './players';
import { rate } from './pyround';

/** 任務編號 1..5（牌譜 第一局成功失敗..第五局成功失敗）。 */
export const MISSION_ROUNDS = [1, 2, 3, 4, 5] as const;

export interface MissionPassRate {
  round: number;
  passRate: number;
  totalGames: number;
}

export interface MissionOutcomeByRound {
  round: number;
  allPass: number;
  oneFail: number;
  /** 2 張以上失敗。 */
  twoFail: number;
  total: number;
}

export interface MissionOutcomeCorrelation {
  round: number;
  passedGames: number;
  passedThenBlueWin: number;
  passedBlueWinRate: number;
  passedOutcomes: OutcomeSplit;
  failedGames: number;
  failedThenRedWin: number;
  failedRedWinRate: number;
  failedOutcomes: OutcomeSplit;
}

/** 快取 missions 區塊（鍵與順序同 compute_missions）。 */
export interface MissionsSection {
  missionPassRates: MissionPassRate[];
  missionOutcomeByRound: MissionOutcomeByRound[];
  missionOutcomeCorrelation: MissionOutcomeCorrelation[];
}

/** 該局的第 round 個任務（沒打 = undefined；Python 的 next(m for m in g.missions if m["round"] == r)）。 */
export function missionOf(g: Game, round: number): MissionResult | undefined {
  return g.missions.find((m) => m.round === round);
}

/** any(m["round"] == r and test(m) for m in g.missions)。 */
function hasMission(g: Game, round: number, test: (m: MissionResult) => boolean = () => true): boolean {
  return g.missions.some((m) => m.round === round && test(m));
}

const passed = (m: MissionResult): boolean => m.fails === 0;
const failed = (m: MissionResult): boolean => m.fails > 0;

/** generate_cache.compute_missions（全部局）。 */
export function computeMissions(games: readonly Game[]): MissionsSection {
  const missionPassRates: MissionPassRate[] = [];
  const missionOutcomeByRound: MissionOutcomeByRound[] = [];
  const missionOutcomeCorrelation: MissionOutcomeCorrelation[] = [];

  for (const r of MISSION_ROUNDS) {
    const withMission = games.filter((g) => hasMission(g, r));
    if (!withMission.length) continue;

    // 每個任務的通過率
    const passCount = withMission.reduce((n, g) => n + (hasMission(g, r, passed) ? 1 : 0), 0);
    missionPassRates.push({ round: r, passRate: rate(passCount, withMission.length), totalGames: withMission.length });

    // 任務通過 / 失敗之後的最終結果（任務階段的勝負）
    const passedGames = withMission.filter((g) => hasMission(g, r, passed));
    const failedGames = withMission.filter((g) => hasMission(g, r, failed));
    const passedThenBlueWin = passedGames.reduce((n, g) => n + (g.blueWin ? 1 : 0), 0);
    const failedThenRedWin = failedGames.reduce((n, g) => n + (g.redWin ? 1 : 0), 0);
    missionOutcomeCorrelation.push({
      round: r,
      passedGames: passedGames.length,
      passedThenBlueWin,
      passedBlueWinRate: rate(passedThenBlueWin, passedGames.length),
      passedOutcomes: outcomeSplit(passedGames),
      failedGames: failedGames.length,
      failedThenRedWin,
      failedRedWinRate: rate(failedThenRedWin, failedGames.length),
      failedOutcomes: outcomeSplit(failedGames),
    });

    // 失敗張數：0 / 1 / 2 張以上
    let allPass = 0;
    let oneFail = 0;
    let twoFail = 0;
    for (const g of withMission) {
      const m = missionOf(g, r);
      if (m === undefined) continue;
      if (m.fails === 0) allPass += 1;
      else if (m.fails === 1) oneFail += 1;
      else twoFail += 1;
    }
    missionOutcomeByRound.push({ round: r, allPass, oneFail, twoFail, total: withMission.length });
  }

  return { missionPassRates, missionOutcomeByRound, missionOutcomeCorrelation };
}
