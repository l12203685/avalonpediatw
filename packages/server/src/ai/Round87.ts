/**
 * 第 87 回合（藍方・梅林）：Gemini 交接 v2 第 1 項 `merlinInnerBlackShield`（`docs/ai/gemini_claude_handoff_v2.md` 第四節 1；Issue #149 的「第 65 回合」）。
 *
 * 提案的根據是第 59／63 回合的量：真人桌讀法的百科AI 同桌時，「梅林在隊上內黑、隊上的忠臣／派西贊成」出現在 28.3% 的三藍局，這些局刺中 65.9%、
 * 沒有的局 40.1%。提案：梅林在隊上時，用遮掉他私人視野的忠臣公開視角看這一隊；公開視角下隊上的忠臣／派西大概會贊成、而且這隊過了不會當場輸，
 * 就照公開視角贊成，不靠私人視野內黑。忠臣、派西的票一律不動（第 63 回合 G1 的教訓）。
 *
 * `merlinInnerBlackShield87 = τ`（0–1，0 = 關）：梅林、投票階段、自己在隊上、不是隊長、非強制（第 1–4 次提議）、範圍內，管線最後的票是**反對**時——
 *   1. 不做：梅林看得到的紅就足以讓這隊當場輸（`merlinVoteFatal`：紅方已兩勝、隊上有他看得到的紅；第 4 局隊上兩個看得到的紅）——A1 下紅方一定出失敗；
 *      他自己的湖查到紅的人在隊上；公開視角的邏輯閘門（會失敗、被支配）擋下；或他自己的視野（`mustFail` 除外）擋下。
 *   2. 公開的「這隊夠乾淨」p = 坐在他位置、只看公開紀錄的忠臣（`loyalViewOf`）的後驗：一張失敗就輸的局 P(隊上沒有紅)，第 4 局（7 人以上，兩張失敗）P(隊上的紅 < 2)。
 *   3. 硬門檻（`merlinInnerBlackShieldTemp87 = 0`）：p ≥ τ 就贊成；溫度 T > 0：以 1 / (1 + e^{−(p − τ)/T}) 的比例贊成（照座位、局、第幾次提議雜湊）。
 *   4. 比例 `merlinInnerBlackShieldRate87 = q`（0 = 1）：整條規則只在雜湊 < q 的決策點做（機率遮罩）。
 * `merlinInnerBlackShieldScope87`（位元）：1 = 第 1、2 局也做（預設只有第 3 局起，第 59／63 回合的事件範圍）；2 = 紅方已兩勝的局完全不做（預設只排除當場會輸的隊）；
 *   4 = 只在隊上沒有他看得到的紅時做；8 = 只在隊上有他看得到的紅時做；16 = 第 4 局不做；
 *   32 = p 改成「隊上其他人（他看得到的紅以外）坐在自己位置、只看公開紀錄時，照忠臣在隊上的投票準則（`bayesVoteCriteria`）會贊成的比例」——
 *        提案原文的「隊上其他忠臣／派西投贊成的估計比例」；門檻 τ 是比例（例如 0.5 = 至少一半會贊成）。
 * 只改梅林自己的票（反對 → 贊成），不改派隊、湖、刺殺，也不改任何其他座位。A0、A1 不相干（A1 的局面 = 第 1 步排除）。
 * INV-M1 在隊上的贊成本來就是登記的例外（站長 2026-10-30「正常票內白沒有任何問題」）。開關關時逐局相同（不抽亂數、不改狀態）。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesTeamClean, bayesTeamRedsBelow } from './belief/BayesBelief';
import { bayesVoteCriteria } from './BlueRound33';
import { merlinVoteFatal } from './MerlinLoyalStyle';
import { loyalViewOf } from './RedR1Teammate';

/** 診斷計數（研究腳本用；不影響決策）。 */
export const round87Stats = { applies: 0, rolled: 0, evaluated: 0, approved: 0 };

function hash01(key: string): number {
  let h = 0x811c9dc5;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

export interface Shield87Config { tau: number; temp: number; rate: number; scope: number }

export function shield87Config(tuning: Readonly<Partial<AgentTuning>>): Shield87Config {
  const rate = tuning.merlinInnerBlackShieldRate87 ?? 0;
  return {
    tau: tuning.merlinInnerBlackShield87 ?? 0,
    temp: tuning.merlinInnerBlackShieldTemp87 ?? 0,
    rate: rate > 0 ? rate : 1,
    scope: tuning.merlinInnerBlackShieldScope87 ?? 0,
  };
}

/** 一張失敗就輸的局：第 4 局在 7 人以上要兩張。 */
function failsNeeded(obs: PlayerObservation): number {
  return (obs.currentRound ?? 1) === 4 && obs.playerCount >= 7 ? 2 : 1;
}

/**
 * 範圍（不含門檻、比例）：梅林、投票、在隊上、不是隊長、非強制、這一票本來是反對、範圍內的局，而且他看得到的紅不會讓這隊當場輸。
 * 純函數：不抽亂數。
 */
export function shield87Applies(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation, vote: boolean): boolean {
  const cfg = shield87Config(tuning);
  if (!(cfg.tau > 0) || vote) return false;
  if (obs.gamePhase !== 'team_vote' || obs.myRole !== 'merlin') return false;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(obs.myPlayerId) || obs.currentLeader === obs.myPlayerId) return false;
  if ((obs.failCount ?? 0) >= 4) return false;
  const round = obs.currentRound ?? 1;
  if (round <= 2 && (cfg.scope & 1) === 0) return false;
  if (round === 4 && (cfg.scope & 16) !== 0) return false;
  const fails = obs.questResults.filter((r) => r === 'fail').length;
  if (fails >= 2 && (cfg.scope & 2) !== 0) return false;
  const seen = team.filter((id) => obs.knownEvils.includes(id)).length;
  if ((cfg.scope & 4) !== 0 && seen > 0) return false;
  if ((cfg.scope & 8) !== 0 && seen === 0) return false;
  // 當場會輸：A1 下紅方一定出失敗（`merlinVoteFatal`，第 4 局照 `merlinFatalR4`）。紅方已兩勝、隊上有看得到的紅一定在這裡擋下。
  if (merlinVoteFatal(obs, tuning)) return false;
  if (fails >= 2 && seen > 0) return false;
  if (failsNeeded(obs) === 2 && seen >= 2) return false;
  // 他自己的湖查到紅的人在隊上：照原本反對（公開上他也宣告了）。
  if ((obs.myLakeResults ?? []).some((l) => l.result === 'evil' && team.includes(l.targetId))) return false;
  return true;
}

/** 公開視角（坐在他位置、只看公開紀錄的忠臣）的「這隊夠乾淨」：一張失敗就輸 → P(隊上沒有紅)；第 4 局兩張 → P(隊上的紅 < 2)。 */
export function shield87PublicClean(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation): number | null {
  const view = loyalViewOf(obs);
  const team = obs.proposedTeam ?? [];
  const opts = bayesOptionsOf(tuning);
  return failsNeeded(obs) === 2 ? bayesTeamRedsBelow(view, team, 2, opts) : bayesTeamClean(view, team, opts);
}

/**
 * 位元 32：隊上其他人（他看得到的紅以外）坐在自己位置、只看公開紀錄的忠臣，照忠臣在隊上的投票準則會贊成的比例（沒有人 → null）。
 * 準則不適用（null）的座位算贊成（忠臣在隊上的預設是贊成）。
 */
export function shield87MatesApprove(tuning: Readonly<AgentTuning>, obs: PlayerObservation): number | null {
  const team = obs.proposedTeam ?? [];
  const mates = team.filter((id) => id !== obs.myPlayerId && !obs.knownEvils.includes(id));
  if (mates.length === 0) return null;
  let yes = 0;
  for (const id of mates) {
    const view = {
      ...obs, myPlayerId: id, myRole: 'loyal', myTeam: 'good', seatTeam: 'good', knownEvils: [], knownWizards: undefined,
      allEvilIds: undefined, allEvilRoles: undefined, myLakeResults: [], publicLoyalView: true,
    } as PlayerObservation;
    const v = bayesVoteCriteria(tuning, view);
    if (v === null || v.vote) yes++;
  }
  return yes / mates.length;
}

/**
 * 梅林在隊上的反對改成贊成嗎？`gatesOk` = 公開視角的邏輯閘門與他自己的閘門（`mustFail` 除外）都沒有擋下（呼叫端算，`ForwardAgent`）。
 * 回傳 null = 不在範圍內或這一次不做（照原本的反對）；否則 { approve, p }。
 */
export function shield87Decide(
  tuning: Readonly<AgentTuning>, obs: PlayerObservation, vote: boolean, gatesOk: () => boolean,
): { approve: boolean; p: number } | null {
  if (!shield87Applies(tuning, obs, vote)) return null;
  round87Stats.applies++;
  const cfg = shield87Config(tuning);
  const key = `${obs.myPlayerId}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|${(obs.proposedTeam ?? []).join(',')}`;
  if (cfg.rate < 1 && hash01(`${key}|shield87rate`) >= cfg.rate) return null;
  round87Stats.rolled++;
  if (!gatesOk()) return null;
  const p = (cfg.scope & 32) !== 0 ? shield87MatesApprove(tuning, obs) : shield87PublicClean(tuning, obs);
  if (p === null) return null;
  round87Stats.evaluated++;
  const approve = cfg.temp > 0 ? hash01(`${key}|shield87temp`) < 1 / (1 + Math.exp(-(p - cfg.tau) / cfg.temp)) : p >= cfg.tau;
  if (approve) round87Stats.approved++;
  return { approve, p };
}
