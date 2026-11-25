/**
 * 第 73 回合（紅方・刺客；節點分支的拆解）：第 4 局（要兩張失敗）只有一個梅林看得到的紅的隊。
 *
 * 站長 2026-11-25：「策略的優化方式可以從我說的 節點分支的拆解或是情境分析去做」。局勢樹重算（`docs/ai/gap/r73-keyspots.md`）之後
 * 刺殺仍是頻率 × 落差最大的節點；把刺殺的每一種讀法照「局 × 隊伍組成」拆開、在全部真人局的提議與票上量梅林和其他藍方的比例
 * （`scripts/assassinScenarioStudy73.py`），只有一個局面和現行的寫法明顯對不上：
 *
 * **第 4 局任務要兩張失敗**，隊上只有一個梅林看得到的紅時，這一個紅自己沒辦法讓任務失敗。真人梅林在這個局面——
 * - 當隊長：非強制的第 4 局提議帶剛好一個看得到的紅 22.3%（66／296），其他藍方隊長 37.6%（502／1,336），概似比 0.59；
 *   第 3 局是 8.1% 對 38.8%（0.21），第 5 局 3.1% 對 21.7%（0.14）。
 * - 投票：紅方已兩勝時在這種隊上贊成 53.8% 對其他藍方 61.9%（未兩勝 77.8% 對 76.2%）；紅方已兩勝時不在隊上贊成 13.5% 對 15.3%——幾乎沒有差別。
 * 現行的刺殺把它當成和其他局一樣：分層（`assassinVisibleRedTier`）直接把這樣派過的人排到第二層（真人刺殺點裡只因為這一種提議被排掉的
 * 候選人 17.7% 是梅林，沒有任何這類紀錄的候選人 27.2%；被排掉的梅林 105 個裡 23 個只因為這一種）、隊長讀法用 ε = 0.05、
 * 投票讀法在紅方已兩勝時把「在隊上贊成」當成梅林幾乎不會做的事（ε = 0.05 對 0.52）。
 *
 * `assassinNeedTwo73`（位元；0 = 關）——只在「這一局任務要兩張失敗、隊上剛好一個梅林看得到的紅」的提議上：
 * 1 = 分層不算（這樣派過的人留在第一層）；2 = 隊長讀法改用量到的概似比 `NEED_TWO_LEAD_LR`（不再用 ε = 0.05）；
 * 4 = 投票讀法不讀這一票（在隊上、不在隊上都一樣）。
 * 只在紅方開牌之後（`allEvilRoles`，知道誰是莫德雷德）套用；沒有的舊觀測照原本。A0（好人持湖說實話）、A1（紅方已兩勝必出失敗）不相干，
 * 刺殺照舊四個紅方一起討論。機器人梅林自己不會在第 4 局帶看得到的紅（INV-M1），所以這是讀真人梅林的開關。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentTuning } from './AgentTuning';

/** 診斷計數（研究腳本用；不影響決策）。 */
export const round73Stats = { tier: 0, lead: 0, vote: 0 };

/**
 * 真人梅林／其他藍方隊長在第 4 局（要兩張失敗）非強制的提議帶剛好一個梅林看得到的紅的比例之比：66／296 對 502／1,336
 * （`games_cache.json` 嚴格重播 2,234 局全部的第 4 局提議，不是只看刺殺點；`scripts/assassinScenarioStudy73.py --part cells`）。
 */
export const NEED_TWO_LEAD_LR = 0.59;

/** Whether round `round`'s mission needs two fail cards at this table size (10 players: R4). */
export function needsTwoFails73(playerCount: number, round: number): boolean {
  return (AVALON_CONFIG[playerCount]?.questFailsRequired?.[round - 1] ?? 1) >= 2;
}

/** The parts of `assassinNeedTwo73` that are on (bits 1 tier, 2 lead read, 4 vote read). */
export function needTwoParts73(tuning: Readonly<AgentTuning>): { tier: boolean; lead: boolean; vote: boolean } {
  const bits = tuning.assassinNeedTwo73 ?? 0;
  return { tier: (bits & 1) !== 0, lead: (bits & 2) !== 0, vote: (bits & 4) !== 0 };
}

/**
 * A proposal on a two-fail round holding exactly one red Merlin sees (`seen` = every red but Mordred): that red cannot fail the
 * mission by himself. `team` may hold Mordred too — Merlin does not see him.
 */
export function needTwoSingleSeen73(playerCount: number, round: number, team: readonly string[], seen: ReadonlySet<string>): boolean {
  if (!needsTwoFails73(playerCount, round)) return false;
  let n = 0;
  for (const id of team) if (seen.has(id)) n++;
  return n === 1;
}
