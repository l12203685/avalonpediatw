/**
 * 優化迴圈第 29 回合・紅方（2026-11-04）：繼續往強者紅方收斂（Edward 2026-11-04「讀人的模型只有一套，擬合強者」：機器人紅方越像強者，
 * 藍方換成強者表的代價越小）。同局面比較見 `scripts/strongRedGap.ts`；`docs/ai/optimization_loop.md` 第 29 回合。
 *
 * 開關（預設關，走勝率協定；硬約束另外註明）。第 29 回合採用：`redMatchPointFail` 與 `mordredSoloApprove=1`（兩個都是基本一致性修正，
 * 第 1E 節第 6 條：硬約束，預設開；自我對打 +0.0／−0.1）；其他只量。
 *   - `redMatchPointFail`（盤點 G1「紅方已兩紅：隊上的紅一定出失敗」）：紅方已兩紅、自己在隊上、自己＋看得到的隊友就夠讓任務失敗 →
 *     每一個看得到的紅都出失敗，不再照位階法讓一個人藏。真人第 3 局兩個相認紅、紅方兩紅：兩張失敗 75%（三個相認紅：三張 100%），
 *     機器人照位階法只出一張（強者點的藏牌率 10–46%，第 3 局整體 17.5% vs 強者 6%，差距幾乎全在這裡）。任務一失敗遊戲就結束，
 *     多一張失敗沒有代價；和人類隊友同隊時，位階法的藏牌反而可能兩個都藏（0 張失敗）——一致性修正，候選硬約束。
 *   - `redStackHide`：紅方未滿兩紅、第 2、3 局兩個以上看得到的紅同隊（沒有落單）：照真人「兩個都藏」的比例出成功（第 2 局 15%、第 3 局 22%；
 *     同一隊伍雜湊，隊上的相認紅抽到同一個結果），其他時候照位階法。真人第 3 局 0／1／2 張失敗 22／74／4%，機器人位階法 0／100／0%。
 *   - `mordredSoloApprove`（盤點 L7「隊內不會沒意義地內黑」；第 27 回合留下的 (5)）：第 3 局起莫德雷德在非強制、不是自己派的隊上、隊上沒有看得到的隊友。
 *     原因：正式路徑的評分器（`decideCore`）把「隊上的紅」算成看得到的隊友、不算投票者自己（`redSelfOnTeam` 關），莫德雷德的角色偏好只在有隊友時加贊成；
 *     刺客有 `r3NormalVotePrior`、莫甘娜有「在隊上一律贊成」、奧伯倫有 `oberonSelfOnTeam`，只有莫德雷德什麼都沒有 → 強者點贊成 18.7%（強者 72.4%）。
 *     1 = 自己一張失敗就能讓任務失敗（第 4 局以外）就投白；2 = 照強者莫德雷德的同局面比例改投白（`MORDRED_SOLO_FLIP`）；0 = 關。
 *   - `redTailVote`（第 28 回合 `goodTailVote` 0.85 → 0.7 之後，紅方照忠臣投票也跟著多開外白，量尺紅方三角色 −0.2～−0.3）：
 *     紅方照忠臣投票（`redNormalVote`）時，隊外外白的乾淨門檻用自己的值（例 0.85）；0 = 跟 `goodTailVote`。
 *   - `redLakeHuman`（紅方挑湖的模型；第 27 回合留下的 (3)）：強者紅方的湖目標用條件 logit 擬合（`docs/ai/optimization_loop.md` 第 29 回合；
 *     真人局 1,408 次紅方持湖、強者 154 次）。1 = 挑模型最可能的目標；2 = 照模型的機率抽（雜湊）；3 = 照 Edward 2026-10-13 的裁定先湖隊友，
 *     只有裁定的規則挑藍方時才換成模型在非隊友裡最可能的目標。1、2 不先湖隊友，**和 10/13 的裁定（盡量湖隊友）不符，只量、不採用**。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { missionFailed } from './missionFacts';

const key = (team: readonly string[]): string => [...team].sort().join(',');

function failsRequired(obs: PlayerObservation, round: number): number {
  return AVALON_CONFIG[obs.playerCount]?.questFailsRequired[round - 1] ?? 1;
}

function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

const fails = (obs: PlayerObservation): number => (obs.questResults ?? []).filter((r) => r === 'fail').length;
const wins = (obs: PlayerObservation): number => (obs.questResults ?? []).filter((r) => r === 'success').length;

/** 自己＋看得到的隊友在這一隊上的人數。 */
function knownRedsOn(obs: PlayerObservation, team: readonly string[]): number {
  const known = new Set([obs.myPlayerId, ...obs.knownEvils]);
  return team.filter((id) => known.has(id)).length;
}

// ── 任務牌 ─────────────────────────────────────────────────

/**
 * `redMatchPointFail`: 'fail' when red has two fails, this red is on the mission and the reds it knows on the team are enough to
 * fail it (the mission's fail ends the game; every known red fails instead of the rank order hiding one); null = no opinion.
 */
export function redMatchPointFailCard(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'fail' | null {
  if (!tuning.redMatchPointFail || obs.gamePhase !== 'quest_vote' || obs.myTeam !== 'evil') return null;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(obs.myPlayerId) || fails(obs) < 2) return null;
  return knownRedsOn(obs, team) >= failsRequired(obs, obs.currentRound ?? 1) ? 'fail' : null;
}

/** 真人第 2、3 局兩個以上相認紅同隊（隊上沒有奧伯倫）、紅方未滿兩紅時「全部出成功」的比例（`_r3cards29`：第 2 局 n 285、第 3 局 n 122）。 */
export const STACK_HIDE_RATE: Readonly<Record<number, number>> = { 2: 0.15, 3: 0.22 };

/**
 * `redStackHide`: 'success' when red has fewer than two fails, R2–R3 (one fail needed), at least two reds this red sees on the
 * mission — at the human both-hide rate, drawn from the mission (round + team) so every recognised red on it draws the same; null =
 * the rank order decides.
 */
export function redStackHideCard(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'success' | null {
  if (!tuning.redStackHide || obs.gamePhase !== 'quest_vote' || obs.myTeam !== 'evil' || obs.myRole === 'oberon') return null;
  const round = obs.currentRound ?? 1;
  const rate = STACK_HIDE_RATE[round] ?? 0;
  const team = obs.proposedTeam ?? [];
  if (rate <= 0 || !team.includes(obs.myPlayerId) || fails(obs) >= 2 || wins(obs) >= 2) return null;
  if (failsRequired(obs, round) !== 1 || knownRedsOn(obs, team) < 2) return null;
  return hash01(`${round}|${key(team)}|redstackhide`) < rate ? 'success' : null;
}

// ── 投票 ─────────────────────────────────────────────────

/**
 * 強者莫德雷德在隊上、沒有看得到的隊友時的贊成率 h 與現行預設在同一批點的贊成率 b 換成的改投比例 (h − b) / (1 − b)
 * （`strongRedGap.ts`，第 28 回合預設；鍵 = 局｜比分）。
 */
export const MORDRED_SOLO_FLIP: Readonly<Record<string, number>> = {
  'R3|其他': 0.79, 'R3|紅兩勝': 0.61, 'R3|藍兩勝': 0.67,
  'R4|其他': 0.7, 'R4|紅兩勝': 0.71, 'R4|藍兩勝': 0.8,
  'R5|紅兩勝': 0.69,
};

/**
 * `mordredSoloApprove`: true = approve (Mordred on a non-forced team he did not propose, R3+, no teammate he sees on it); null =
 * keep the pipeline's vote. Mode 1: when his own fail card fails the mission (one fail needed); mode 2: at the strong-Mordred flip
 * rate of the cell (hash of seat, round, attempt, team).
 */
export function mordredSoloApproveVote(tuning: Readonly<AgentTuning>, obs: PlayerObservation): true | null {
  const mode = tuning.mordredSoloApprove ?? 0;
  if (mode <= 0 || obs.gamePhase !== 'team_vote' || obs.myRole !== 'mordred') return null;
  const round = obs.currentRound ?? 1;
  if (round < 3 || (obs.failCount ?? 0) >= 4 || obs.currentLeader === obs.myPlayerId) return null;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(obs.myPlayerId) || team.some((id) => id !== obs.myPlayerId && obs.knownEvils.includes(id))) return null;
  if (mode === 1) return failsRequired(obs, round) <= 1 ? true : null;
  const state = fails(obs) >= 2 ? '紅兩勝' : wins(obs) >= 2 ? '藍兩勝' : '其他';
  const f = MORDRED_SOLO_FLIP[`R${round}|${state}`] ?? 0;
  return hash01(`${obs.myPlayerId}|${round}|${obs.failCount ?? 0}|${key(team)}|mordredsolo`) < f ? true : null;
}

/** `redTailVote`: the off-team outer-white threshold of a red's loyal-view vote (`redLoyalView`); null = `goodTailVote`. */
export function redTailVoteTau(tuning: Readonly<AgentTuning>, obs: PlayerObservation): number | null {
  const tau = tuning.redTailVote ?? 0;
  return tau > 0 && obs.redLoyalView === true ? tau : null;
}

// ── 湖 ─────────────────────────────────────────────────

/**
 * 紅方挑湖的條件 logit（強者紅方 154 次持湖；L2 0.05；5 折交叉 top-1 18.8%，現行規則 13.0%）。特徵（目標 t，持湖者 h）：
 * 隊友；隊友×出過失敗；隊友×沒出過任務；非隊友×出過失敗／沒出過任務／只出過成功；和 h 一起出過的失敗任務數、成功任務數（最多 2）；
 * h 自己派過的隊裡有 t 的比例；別人派的隊選 t 的比例；t 派過有 h 的隊；t 不在隊上卻贊成過失敗任務的隊（次數，最多 2）；t 是 h 的下一個座位。
 */
export const RED_LAKE_WEIGHTS = {
  ally: -0.01, allyFail: 0.36, allyNever: -0.26,
  blueFail: 0.18, blueNever: -0.11, blueSucc: -0.05,
  coFail: -0.27, coSucc: 0.24, holderShare: 0.35, picked: -0.09, tLedMe: -0.1, whiteFail: 0.04, next: -0.04,
} as const;

/** 目標 `t` 的模型分數（持湖者 = `obs.myPlayerId`；只用公開紀錄與自己看得到的隊友）。 */
export function redLakeScore(obs: PlayerObservation, t: string): number {
  const w = RED_LAKE_WEIGHTS;
  const h = obs.myPlayerId;
  const ally = obs.knownEvils.includes(t);
  const qs = obs.questHistory;
  const onFail = qs.filter((q) => missionFailed(q) && q.team.includes(t)).length;
  const onSucc = qs.filter((q) => !missionFailed(q) && q.team.includes(t)).length;
  const never = onFail + onSucc === 0;
  const coFail = Math.min(2, qs.filter((q) => missionFailed(q) && q.team.includes(t) && q.team.includes(h)).length);
  const coSucc = Math.min(2, qs.filter((q) => !missionFailed(q) && q.team.includes(t) && q.team.includes(h)).length);
  const props = obs.voteHistory;
  const mine = props.filter((v) => v.leader === h);
  const share = mine.filter((v) => v.team.includes(t)).length / Math.max(1, mine.length);
  const others = props.filter((v) => v.leader !== h && v.leader !== t);
  const picked = others.filter((v) => v.team.includes(t)).length / Math.max(1, others.length);
  const tLedMe = props.some((v) => v.leader === t && v.team.includes(h)) ? 1 : 0;
  let whiteFail = 0;
  for (const q of qs) {
    if (!missionFailed(q)) continue;
    const v = props.find((p) => p.round === q.round && p.approved);
    if (v && !v.team.includes(t) && v.votes?.[t] === true) whiteFail++;
  }
  const ids = obs.allPlayerIds;
  const next = ids[(ids.indexOf(h) + 1) % ids.length] === t ? 1 : 0;
  return (ally ? w.ally + (onFail > 0 ? w.allyFail : 0) + (never ? w.allyNever : 0)
    : onFail > 0 ? w.blueFail : never ? w.blueNever : w.blueSucc)
    + w.coFail * coFail + w.coSucc * coSucc + w.holderShare * share + w.picked * picked
    + w.tLedMe * tLedMe + w.whiteFail * Math.min(2, whiteFail) + w.next * next;
}

/** 模型最可能的目標（同分照座位順序）；`among` 空 = null。 */
export function redLakeArgmax(obs: PlayerObservation, among: readonly string[]): string | null {
  let best: string | null = null;
  let bestS = -Infinity;
  for (const id of obs.allPlayerIds) {
    if (!among.includes(id)) continue;
    const s = redLakeScore(obs, id);
    if (s > bestS + 1e-12) { best = id; bestS = s; }
  }
  return best;
}

/** 照模型的機率抽一個目標（雜湊：持湖者、局、合法目標）。 */
export function redLakeSample(obs: PlayerObservation, among: readonly string[]): string | null {
  const ids = obs.allPlayerIds.filter((id) => among.includes(id));
  if (ids.length === 0) return null;
  const s = ids.map((id) => redLakeScore(obs, id));
  const m = Math.max(...s);
  const e = s.map((x) => Math.exp(x - m));
  const z = e.reduce((a, b) => a + b, 0);
  let u = hash01(`${obs.myPlayerId}|${obs.currentRound ?? 1}|${key(ids)}|redlakehuman`) * z;
  for (let i = 0; i < ids.length; i++) { u -= e[i]; if (u <= 0) return ids[i]; }
  return ids[ids.length - 1];
}

/**
 * `redLakeHuman`: the red holder's lake target from the strong-red model; `ruled` = the target the 10/13 rule picks
 * (`pickEvilLakeTargetHuman`). Mode 1 argmax, 2 sample, 3 the ruled target when it is a teammate, else the model's argmax among
 * the non-teammates; null = keep `ruled`.
 */
export function redLakeHumanTarget(tuning: Readonly<AgentTuning>, obs: PlayerObservation, valid: readonly string[], ruled: string): string | null {
  const mode = tuning.redLakeHuman ?? 0;
  if (mode <= 0 || obs.myTeam !== 'evil' || valid.length === 0) return null;
  if (mode === 1) return redLakeArgmax(obs, valid);
  if (mode === 2) return redLakeSample(obs, valid);
  if (obs.knownEvils.includes(ruled)) return null;
  return redLakeArgmax(obs, valid.filter((id) => !obs.knownEvils.includes(id)));
}
