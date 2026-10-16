/**
 * captainAnalysis 區塊（generate_cache.compute_captain_analysis 逐行移植；網站「分析 › 派隊」的
 * CaptainAnalysis、GET /api/analysis/captain 原樣回傳）。Edward 2026-10-14 複合篩選：篩選後的局重算，
 * 不篩選時與快取逐欄相同。
 *
 *   perMission                  每個任務：隊長是紅方 / 藍方的比率
 *   captainFactionVsOutcome     (隊長陣營, 任務通過 / 失敗) 的次數與佔該陣營的比率
 *   captainMissionGameWinRates  同一組 (陣營, 通過 / 失敗) 的任務所在的局：紅藍勝率（任務階段）、三結果
 *
 * 隊長座位是產生器從文字記錄解析好的（資料集 `captains`，原文不出）：每個任務一個字元，null = 找不到提案行；
 * 「?」= 全形之類的非 ASCII 數字。座位對不到角色時當忠臣 → 藍方（Python 的 seat_roles.get(seat, "忠臣")）。
 * 只算有任務結果的任務；同一局的幾個任務各算一次（captainMissionGameWinRates 的局會重複計入）。
 * 排序照 Python 的 sorted(dict.items())：紅方 < 藍方（碼位）、fail < pass。
 */
import { roleFactionName } from './constants';
import type { Game } from './dataset';
import { missionOf } from './missions';
import { outcomeSplit, type OutcomeSplit } from './players';
import { rate, sortByKey } from './pyround';

type CaptainFaction = '紅方' | '藍方';

export interface CaptainPerMission {
  mission: number;
  redCaptainRate: number;
  blueCaptainRate: number;
  games: number;
}

export interface CaptainFactionVsOutcome {
  captainFaction: CaptainFaction;
  missionResult: 'pass' | 'fail';
  count: number;
  percentage: number;
}

export interface CaptainMissionGameWinRate {
  captainFaction: CaptainFaction;
  missionResult: 'pass' | 'fail';
  totalMissions: number;
  redGameWinRate: number;
  blueGameWinRate: number;
  outcomes: OutcomeSplit;
}

/** 快取 captainAnalysis 區塊（鍵與順序同 compute_captain_analysis）。 */
export interface CaptainAnalysisSection {
  perMission: CaptainPerMission[];
  captainFactionVsOutcome: CaptainFactionVsOutcome[];
  captainMissionGameWinRates: CaptainMissionGameWinRate[];
}

/** 一個有隊長、有結果的任務（index 0..4 = 第 1..5 個任務）。 */
export interface CaptainMission {
  index: number;
  faction: CaptainFaction;
  passed: boolean;
}

/** Python 只看前 5 個任務的隊長（資料集本來就最多 5 個）。 */
const MAX_MISSIONS = 5;

/** 一局裡每個有隊長、有任務結果的任務（依任務順序）。 */
export function captainMissions(g: Game): CaptainMission[] {
  const out: CaptainMission[] = [];
  g.captains.forEach((seat, index) => {
    if (index >= MAX_MISSIONS || seat === null) return;
    const role = g.seatRoles.get(seat) ?? '忠臣';
    const faction: CaptainFaction = roleFactionName(role) || '藍方';
    const mission = missionOf(g, index + 1);
    if (mission === undefined) return;
    out.push({ index, faction, passed: mission.fails === 0 });
  });
  return out;
}

const resultName = (passed: boolean): 'pass' | 'fail' => (passed ? 'pass' : 'fail');
const keyOf = (faction: CaptainFaction, passed: boolean): string => `${faction}|${passed ? 1 : 0}`;

/** generate_cache.compute_captain_analysis（全部局）。 */
export function computeCaptainAnalysis(games: readonly Game[]): CaptainAnalysisSection {
  const perMission = Array.from({ length: MAX_MISSIONS }, () => ({ red: 0, blue: 0, total: 0 }));
  // (陣營, 通過) → 次數與那些任務所在的局（第一次出現的順序；最後依鍵排序，順序不影響結果）
  const groups = new Map<string, { faction: CaptainFaction; passed: boolean; count: number; games: Game[] }>();
  const factionTotal = new Map<CaptainFaction, number>();

  for (const g of games) {
    for (const { index, faction, passed } of captainMissions(g)) {
      const counts = perMission[index];
      counts.total += 1;
      if (faction === '紅方') counts.red += 1;
      else counts.blue += 1;
      const key = keyOf(faction, passed);
      let group = groups.get(key);
      if (!group) {
        group = { faction, passed, count: 0, games: [] };
        groups.set(key, group);
      }
      group.count += 1;
      group.games.push(g);
      factionTotal.set(faction, (factionTotal.get(faction) ?? 0) + 1);
    }
  }

  const perMissionOut: CaptainPerMission[] = [];
  perMission.forEach((c, i) => {
    if (c.total === 0) return;
    perMissionOut.push({
      mission: i + 1,
      redCaptainRate: rate(c.red, c.total),
      blueCaptainRate: rate(c.blue, c.total),
      games: c.total,
    });
  });

  const sorted = sortByKey([...groups.values()], (grp) => [grp.faction, grp.passed]);
  const captainFactionVsOutcome: CaptainFactionVsOutcome[] = sorted.map((grp) => ({
    captainFaction: grp.faction,
    missionResult: resultName(grp.passed),
    count: grp.count,
    percentage: rate(grp.count, factionTotal.get(grp.faction) ?? 0),
  }));
  const captainMissionGameWinRates: CaptainMissionGameWinRate[] = sorted
    .filter((grp) => grp.games.length > 0)
    .map((grp) => {
      const total = grp.games.length;
      let red = 0;
      let blue = 0;
      for (const g of grp.games) {
        if (g.redWin) red += 1;
        if (g.blueWin) blue += 1;
      }
      return {
        captainFaction: grp.faction,
        missionResult: resultName(grp.passed),
        totalMissions: total,
        redGameWinRate: rate(red, total),
        blueGameWinRate: rate(blue, total),
        outcomes: outcomeSplit(grp.games),
      };
    });

  return { perMission: perMissionOut, captainFactionVsOutcome, captainMissionGameWinRates };
}
