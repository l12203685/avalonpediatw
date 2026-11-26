/**
 * 第 85 回合（藍方提議・第 1 局隊伍的錨定）：玩家回報（站長轉述 2026-11-26，原話）
 *
 * > 有人反應百科AI有個問題 / 只要第一局任務結果開藍 / 後面只有能力者才會拆 / 而且0家三加一 任務失敗後 / 所有人還是會直接無腦繼續第一局三加一
 *
 * 量測（`scripts/r1AnchorStudy85.py`／`.ts`，`docs/ai/gap/r85-r1-anchor.md`）：
 *   - 第 1 局成功之後第 2 局，機器人忠臣 100%（真人 75.6%、兩邊都強的真人局 75.7%）的提議包含整個第 1 局的隊——連梅林也 100%（不是「只有能力者會拆」）。
 *     第 2 局的原因是寫死的照派（第 24 回合 `goodReuseExact=2`：站長 11/03 練習台「2890 已經成功過」）加上後驗本來就把第 1 局的人讀得最乾淨。
 *   - 第 1 局成功、之後一局的任務隊包含整個第 1 局的隊而且失敗：下一局機器人忠臣 72%（真人 26%、兩邊都強 31%）的提議還包含整個第 1 局的隊。
 *     這一格沒有寫死的照派，是後驗挑「P(沒有紅) 最高的隊」的結果。
 *   - 但這不是信念的錯：現行後驗在這一格說「第 1 局的隊上有紅」60.1%，真相 59.9%（真人局 771 個決策點；第 4 局 73.6 對 74.1%）——失敗**有**算到第 1 局的人身上。
 *     第 1 局的人各自仍然比隊外的人乾淨（真人局：每個人約 0.2–0.25，隊外約 0.5），所以「第 1 局的隊＋1」常常仍是 P(沒有紅) 最高的隊；
 *     真人局下一局出任務的隊包含第 1 局的隊時任務成功 46.0%，拆掉的 31.8%。
 *
 * 開關（預設關）：
 *   - `r1Split85 = λ`：第 1 局任務成功（沒有失敗牌）、前一局（第 2 局起）出了失敗牌的任務隊包含整個第 1 局的隊，忠臣／派西當隊長、非強制，
 *     正式流程最後派的隊又包含整個第 1 局的隊時，「含自己、不含整個第 1 局的隊」裡後驗 P(沒有紅) 最高的那一隊 ≥ λ × 原本那一隊 → 改派那一隊。
 *     λ = 1：只有數學上一樣乾淨（或更乾淨）才拆；λ 越小越常拆（站長要的「除非數學說它還是最乾淨，不要再派一次第 1 局＋1」）。
 *     替代的隊仍然要過隊長的邏輯閘門與投票規則（呼叫端的 `ok`）、隊長自己湖的宣告（`goodVouchTeamConstraint`）、自己的投票規則（`ownVoteRejects`）。
 *     第 30 回合的 `loyalR2Reuse` 是同一個做法用在第 2 局（第 1 局成功之後），所以第 2 局那一半直接用那個開關量，不另寫。
 *   - `r1Split85Scope`（位元）：1 = 梅林也做；2 = 不只前一局——之前任何一局出了失敗牌、包含整個第 1 局的隊都算；4 = 強制局也做。
 *
 * 純函式；沒有 `Math.random`。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { goodVouchTeamConstraint } from './GoodLakeFollowUp';
import { ownVoteRejects } from './GoodLeadConsistent';

/** 自我對打的計數（只給 `sp.ts` 印；不影響決策）。 */
export const round85Stats = { spots: 0, split: 0, keptMath: 0, noAlt: 0 };

const subset = (a: readonly string[], b: readonly string[]): boolean => a.every((x) => b.includes(x));

function combinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

/**
 * 這一次提議是不是第 85 回合的格：第 1 局任務成功（沒有失敗牌），前一局（位元 2：之前任何一局，第 2 局起）出了失敗牌的任務隊包含整個第 1 局的隊。
 * 是 → 第 1 局的隊；不是 → null。只看公開紀錄。
 */
export function r1SplitCore85(obs: PlayerObservation, scope = 0): string[] | null {
  const round = obs.currentRound ?? 1;
  if (round < 3) return null;
  if ((obs.failCount ?? 0) >= 4 && (scope & 4) === 0) return null;
  const q1 = obs.questHistory.find((q) => q.round === 1);
  if (!q1 || obs.questResults[0] !== 'success' || (q1.failCount ?? 0) > 0) return null;
  const tainted = (q: { round: number; team: readonly string[]; failCount: number }): boolean => q.round >= 2 && (q.failCount ?? 0) > 0 && subset(q1.team, q.team);
  const prev = obs.questHistory.find((q) => q.round === round - 1);
  const hit = (scope & 2) !== 0 ? obs.questHistory.some((q) => q.round < round && tainted(q)) : !!prev && tainted(prev);
  return hit ? [...q1.team] : null;
}

/** 開關開著、這個座位與這一次提議在範圍內（真的藍方座位：忠臣／派西，位元 1 加梅林；紅方的忠臣視角不算）。 */
export function r1Split85Applies(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (!((tuning.r1Split85 ?? 0) > 0) || obs.myTeam !== 'good' || obs.publicLoyalView === true) return false;
  if ((obs.seatTeam ?? obs.myTeam) !== 'good') return false;
  const scope = tuning.r1Split85Scope ?? 0;
  if (obs.myRole !== 'loyal' && obs.myRole !== 'percival' && !(obs.myRole === 'merlin' && (scope & 1) !== 0)) return false;
  return r1SplitCore85(obs, scope) !== null;
}

/**
 * `r1Split85`：範圍內、`team` 包含整個第 1 局的隊時，回傳「含自己、不含整個第 1 局的隊」裡 P(沒有紅) 最高、過得了 `ok` 的那一隊（≥ λ × 原本那一隊）；
 * 不改 → null。`ok` = 隊長的邏輯閘門、投票規則、湖的禁止名單（呼叫端給）。
 */
export function r1Split85Team(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  team: readonly string[],
  ok: (team: readonly string[]) => boolean = () => true,
): string[] | null {
  if (!r1Split85Applies(tuning, obs)) return null;
  const core = r1SplitCore85(obs, tuning.r1Split85Scope ?? 0)!;
  if (!subset(core, team)) return null;
  round85Stats.spots++;
  const lambda = tuning.r1Split85 ?? 0;
  const opts = bayesOptionsOf(tuning);
  const base = bayesTeamClean(obs, team, opts);
  if (base === null) return null;
  const me = obs.myPlayerId;
  const vouch = tuning.goodVouchFollowUp ? goodVouchTeamConstraint(obs) : null;
  const scored: { t: string[]; p: number }[] = [];
  for (const fill of combinations(obs.allPlayerIds.filter((id) => id !== me), team.length - 1)) {
    const t = [me, ...fill];
    if (subset(core, t)) continue;
    scored.push({ t, p: bayesTeamClean(obs, t, opts) ?? 0 });
  }
  // Cleanest first; ties keep the seat order of the enumeration (deterministic).
  scored.sort((a, b) => b.p - a.p);
  for (const { t, p } of scored) {
    if (p < lambda * base) { round85Stats.keptMath++; return null; }
    if (!ok(t)) continue;
    if (vouch && (vouch.banned.some((id) => t.includes(id)) || vouch.required.some((id) => !t.includes(id)))) continue;
    if (ownVoteRejects(tuning, obs, t)) continue;
    round85Stats.split++;
    return t;
  }
  round85Stats.noAlt++;
  return null;
}
