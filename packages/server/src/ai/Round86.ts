/**
 * 第 86 回合（藍紅雙方・互相剝削）：站長 2026-11-26（原話）：
 *
 * > 現在你有辦法順便研究 紅藍方怎麼互相剝削對方目前的策略嗎
 * > 比如 紅方發現藍方只有一種固定模式/玩法 就採用完全可以反制藍方這樣玩的策略
 * > 同理 藍方如果發現紅方刺殺只會怎麼做 就可以反制讓紅方刺不到梅林
 *
 * 第 1 步的習慣清單（`scripts/exploitAudit86.py`，`docs/ai/gap/r86-exploitability.md`）裡最固定的藍方習慣：
 * 第 1 局任務成功之後，機器人藍隊長（忠臣、梅林）第 2 局的提議 **100%** 整隊包含第 1 局的任務隊（強的真人 68–76%）；
 * 含第 1 局整隊的任務失敗之後還照派 52%（真人 26%）。這是玩家回報過的「3+1」（第 85 回合）。
 * 紅方的反制很直接：第 1 局落單上任務就出成功（藏），第 2 局幾乎一定還在隊上。
 *
 * 開關（預設 0 = 關；關著時這個檔案不改任何決定）：
 * - `r1Ride86`（紅方，位元；剝削對手，用來量藍方被剝削多少，不是要採用的改法）：
 *   1 = 第 1 局自己是任務隊上唯一看得到的紅（奧伯倫：隊上只有自己）→ 一律出成功；
 *   2 = 第 2 局（第 1 局成功之後）同一種情況也出成功（再搭一次車，第 3 局起才出失敗）。
 *   A1（紅方已兩勝必出失敗）不相干：第 1、2 局紅方不可能已經兩勝。在 `ForwardAgent` 的紅方任務牌裡，排在紅方聽牌的兩條硬規則之後、
 *   其他藏牌規則（`redR2Lead61`、`redHideHuman`…）之前。
 *
 * 其他手臂用現有的開關（藍方 `lakePickSuspicion50`、`merlinTierCover82`、`r1ReuseRate49`；紅方 `redLakeDisguise50`），見回合紀錄。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';

/** 診斷計數（研究腳本用；不影響決策）。 */
export const round86Stats = { ride: 0 };

/**
 * `r1Ride86`：第 1 局（位元 1）／第 1 局成功之後的第 2 局（位元 2），自己是任務隊上唯一看得到的紅 → 'success'；其他情況 null（照原本）。
 */
export function r1RideCard86(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'success' | null {
  const mode = tuning.r1Ride86 ?? 0;
  if (mode <= 0 || obs.gamePhase !== 'quest_vote' || obs.myTeam !== 'evil') return null;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(me)) return null;
  if (team.some((id) => id !== me && obs.knownEvils.includes(id))) return null;
  const round = obs.currentRound ?? 1;
  const results = obs.questResults ?? [];
  const ok = round === 1 ? (mode & 1) !== 0 : round === 2 && (mode & 2) !== 0 && results.length === 1 && results[0] === 'success';
  if (!ok) return null;
  round86Stats.ride++;
  return 'success';
}
