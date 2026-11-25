/**
 * 第 78 回合（紅方・任務牌）：紅方什麼時候出失敗、什麼時候出成功。
 *
 * 起點：站長 2026-11-25「各角色的強者 × 百科AI」線索表（`docs/ai/gap/role-breakdown-leads.md`）第 2 項（奧伯倫第 4 局、比分 1:2 在隊上）
 * 與第 5 項（莫甘娜、莫德雷德和認得的隊友同隊）。全部真人局照「隊上實際有哪些紅方」拆開（`scripts/redCardStudy78.ts`、
 * `docs/ai/gap/r78-red-cards.md`）之後，差別集中在三個地方：
 *   (a) 第 4 局（要兩張失敗）、紅方已兩勝、自己是隊上唯一看得到的紅：機器人一律出成功（第 27 回合 `redHideR4Solo=1`）。
 *       真人落單時也幾乎都藏（88～92%）；隊上其實還有一個互相看不到的紅（奧伯倫＋一個相認紅）時真人兩張都出 21%、機器人 0%。
 *   (b) 第 2 局莫甘娜＋莫德雷德同隊：機器人兩張都藏 95%（位階法：莫德雷德藏、莫甘娜先觀察），真人 18%。
 *   (c) 第 3 局刺客＋莫甘娜同隊：機器人兩張都出 100%（刺客出、莫甘娜為了「至少一張」也出），真人 6%。
 * (b)(c) 的原因相同：紅方只認得隊友是誰、不知道隊友的角色，位階法是「各角色照自己的規則」，莫甘娜分不出隊友是刺客還是莫德雷德。
 * 任務牌是蓋著出的，藍方只看得到「幾張失敗」，看不到是誰出的——所以誰出都一樣，重點只有張數；兩個相認的紅只要有一個
 * 兩邊都算得出來的約定，就能剛好出一張。
 *
 * 開關（都預設 0 = 關；關著時這個檔案不改任何決定。例外：基準線 `DEFAULT_AGENT_TUNING.redPairOne78 = 4`（第 78 回合採用，只有第 3 局、照座位；
 * 真人桌在 humanProfile 維持 0））：
 * - `r4KeyFail78 = v`：(a) 那一格（要兩張以上失敗的任務、紅方已兩勝、自己＋看得到的隊友不夠讓任務失敗）改出失敗。
 *   v ≥ 1 = 一律出失敗（A1「紅方已兩勝，紅一定出失敗」照字面，沒有第 4 局的例外）；0 < v < 1 = 自己的後驗 P(隊上的紅夠讓任務失敗) ≥ v 才出失敗，
 *   其他時候照原本（`redHideR4Solo` 藏）。`r4KeyFail78Roles`：位元 1 = 奧伯倫、2 = 相認紅（刺客／莫甘娜／莫德雷德）；0 = 兩種都算。
 * - `redPairOne78 = 位元`（1 = 第 1 局、2 = 第 2 局、4 = 第 3 局）：一張失敗就夠的任務、兩邊都還沒兩勝、隊上剛好兩個相認紅 → 照約定只出一張。
 *   `redPairOne78Who`：1 = 座位在前面的那一個出（照 `allPlayerIds` 的順序；兩個人都算得出同一個答案，機器人之間一定剛好一張）；
 *   2 = 先看公開紀錄（百科〈紅方基礎原則〉I3「出者恆出、藏者恆藏」：之前單獨上過有失敗牌的任務的人繼續出、另一個藏；
 *   之前單獨上過零失敗任務的人繼續藏、另一個出），兩個人的紀錄一樣時照原本的位階法——只補一格：兩個人上一次一起出任務都藏了，
 *   這一次莫甘娜出（照位階法會一起藏的只有莫甘娜＋莫德雷德，位階低的出）；3 = 同 2，紀錄一樣時照座位。0 = 1。
 * - `redPairAlways78 = 位元`（同上的局）：一張失敗就夠的任務、兩邊都還沒兩勝、隊上剛好兩個相認紅 → 自己一律出失敗（不靠隊友；
 *   給真人桌量「至少一張」用——真人隊友不會照機器人的約定）。`redPairOne78` 同一局有開時以 `redPairOne78` 為準。
 *
 * 不動的：紅方已兩勝、自己知道的紅夠讓任務失敗 → 每一個相認紅都出失敗（`redMatchPointFail`，第 29 回合的硬約束，在這些開關之前判）；
 * 落單的紅第 1、2 局的藏牌比例（`redHideHuman`、`redR2Lead61`）；三個相認紅同隊（位階法已經剛好一張）；奧伯倫第 1～3 局。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamRedsBelow } from './belief/BayesBelief';

const RECOGNISED: ReadonlySet<string> = new Set(['assassin', 'morgana', 'mordred']);

function failsRequired(obs: PlayerObservation, round: number): number {
  return AVALON_CONFIG[obs.playerCount]?.questFailsRequired[round - 1] ?? 1;
}

const fails = (obs: PlayerObservation): number => (obs.questResults ?? []).filter((r) => r === 'fail').length;
const wins = (obs: PlayerObservation): number => (obs.questResults ?? []).filter((r) => r === 'success').length;

/** 診斷計數（自我對打拆解用；不影響決策）：`key` = `r4KeyFail78` 改出失敗的次數、`pair` = `redPairOne78`／`redPairAlways78` 決定一張牌的次數。 */
export const round78Stats = { key: 0, pair: 0 };

/** 第 78 回合的開關有沒有任何一個打開。 */
export function round78On(tuning: Readonly<AgentTuning>): boolean {
  return (tuning.r4KeyFail78 ?? 0) > 0 || (tuning.redPairOne78 ?? 0) > 0 || (tuning.redPairAlways78 ?? 0) > 0;
}

// ── (a) 要兩張失敗的任務、紅方已兩勝、自己看得到的紅不夠 ─────────────────────────

/** (a) 那一格：要兩張以上失敗、紅方已兩勝、自己在隊上、自己＋看得到的隊友不夠讓任務失敗。 */
export function inR4KeyCell78(obs: PlayerObservation): boolean {
  if (obs.gamePhase !== 'quest_vote' || obs.myTeam !== 'evil') return false;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(me)) return false;
  const required = failsRequired(obs, obs.currentRound ?? 1);
  if (required < 2 || fails(obs) !== 2 || wins(obs) >= 3) return false;
  const known = new Set([me, ...obs.knownEvils]);
  return team.filter((id) => known.has(id)).length < required;
}

/** 自己的後驗：P(隊上的紅夠讓任務失敗)（自己算在內；沒有世界 = null）。 */
export function enoughRedsProb78(tuning: Readonly<AgentTuning>, obs: PlayerObservation): number | null {
  const team = obs.proposedTeam ?? [];
  const below = bayesTeamRedsBelow(obs, team, failsRequired(obs, obs.currentRound ?? 1), bayesOptionsOf(tuning));
  return below === null ? null : 1 - below;
}

/**
 * `r4KeyFail78`: 'fail' in the two-fail, red-has-two-wins cell where this red sees too few reds on the team to fail it;
 * null = no opinion (switch off, another cell, role not in `r4KeyFail78Roles`, or the posterior below the bar).
 */
export function r4KeyFailCard78(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'fail' | null {
  const v = tuning.r4KeyFail78 ?? 0;
  if (!(v > 0) || !inR4KeyCell78(obs)) return null;
  const mask = (tuning.r4KeyFail78Roles ?? 0) > 0 ? tuning.r4KeyFail78Roles : 3;
  if ((mask & (obs.myRole === 'oberon' ? 1 : 2)) === 0) return null;
  if (v < 1) {
    const p = enoughRedsProb78(tuning, obs);
    if (p === null || p < v) return null;
  }
  round78Stats.key++;
  return 'fail';
}

// ── (b)(c) 兩個相認紅同隊、一張失敗就夠 ──────────────────────────────────────

/** 隊上自己看得到的隊友；不是「一張就夠、兩邊都還沒兩勝、剛好一個隊友」的格子 = null。 */
export function pairMate78(obs: PlayerObservation): string | null {
  if (obs.gamePhase !== 'quest_vote' || obs.myTeam !== 'evil' || !RECOGNISED.has(obs.myRole as string)) return null;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  const round = obs.currentRound ?? 1;
  if (!team.includes(me) || round > 3 || failsRequired(obs, round) !== 1 || fails(obs) >= 2 || wins(obs) >= 2) return null;
  const mates = team.filter((id) => id !== me && obs.knownEvils.includes(id));
  return mates.length === 1 ? mates[0] : null;
}

export type PairStatus78 = 'F' | 'H' | 'N';

/**
 * 兩個相認紅各自的公開紀錄（I3「出者恆出、藏者恆藏」用）：F = 最近一次「隊上只有他一個相認紅」的任務有失敗牌（大家當他出過）、
 * H = 那一次零失敗（他藏過）、N = 沒有這種任務。兩個人一起上的任務：零失敗 → 都是 H；兩張以上 → 都是 F；剛好一張時，
 * 原本只有一個 F（他繼續出）或一個 H 一個 N（藏的繼續藏、另一個出）照約定延續，其他情況分不出是誰 → 兩個都回到 N。
 * 只用公開紀錄＋「誰是相認紅」，所以兩個人算出來一定一樣。
 */
export function pairStatus78(obs: PlayerObservation, a: string, b: string): [PairStatus78, PairStatus78] {
  const known = new Set([obs.myPlayerId, ...obs.knownEvils]);
  const round = obs.currentRound ?? 1;
  let sa: PairStatus78 = 'N';
  let sb: PairStatus78 = 'N';
  for (const q of [...obs.questHistory].filter((x) => x.round < round).sort((x, y) => x.round - y.round)) {
    const on = q.team.filter((id) => known.has(id));
    const cards = q.failCount ?? (q.result === 'fail' ? 1 : 0);
    if (on.length === 1) {
      if (on[0] === a) sa = cards > 0 ? 'F' : 'H';
      else if (on[0] === b) sb = cards > 0 ? 'F' : 'H';
    } else if (on.length === 2 && on.includes(a) && on.includes(b)) {
      if (cards === 0) { sa = 'H'; sb = 'H'; }
      else if (cards >= 2) { sa = 'F'; sb = 'F'; }
      else if ((sa === 'F') !== (sb === 'F')) { /* 出過的那一個繼續出 */ }
      else if (sa === 'H' && sb === 'N') sb = 'F';
      else if (sb === 'H' && sa === 'N') sa = 'F';
      else { sa = 'N'; sb = 'N'; }
    }
  }
  return [sa, sb];
}

/** 兩個人最近一次一起上的任務（隊上只有這兩個相認紅）是不是零失敗。 */
export function lastJointHid78(obs: PlayerObservation, a: string, b: string): boolean {
  const known = new Set([obs.myPlayerId, ...obs.knownEvils]);
  const round = obs.currentRound ?? 1;
  const joint = obs.questHistory
    .filter((q) => q.round < round && q.team.includes(a) && q.team.includes(b) && q.team.filter((id) => known.has(id)).length === 2)
    .sort((x, y) => y.round - x.round)[0];
  return joint !== undefined && (joint.failCount ?? (joint.result === 'fail' ? 1 : 0)) === 0;
}

/** 座位在前面（`allPlayerIds` 的順序）的那一個 = true。 */
function seatFirst(obs: PlayerObservation, me: string, mate: string): boolean {
  return obs.allPlayerIds.indexOf(me) < obs.allPlayerIds.indexOf(mate);
}

const roundBit = (mask: number, round: number): boolean => (mask & (1 << (round - 1))) !== 0;

/**
 * `redPairOne78` / `redPairAlways78`: the card of a recognised red with exactly one recognised teammate on a one-fail mission
 * (R1–R3, neither side at two wins); null = the rank order decides as before.
 */
export function pairCard78(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'fail' | 'success' | null {
  const card = pairCardOf78(tuning, obs);
  if (card !== null) round78Stats.pair++;
  return card;
}

function pairCardOf78(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'fail' | 'success' | null {
  const one = tuning.redPairOne78 ?? 0;
  const always = tuning.redPairAlways78 ?? 0;
  if (!(one > 0) && !(always > 0)) return null;
  const mate = pairMate78(obs);
  if (mate === null) return null;
  const round = obs.currentRound ?? 1;
  const me = obs.myPlayerId;
  if (one > 0 && roundBit(one, round)) {
    const who = (tuning.redPairOne78Who ?? 0) > 0 ? tuning.redPairOne78Who : 1;
    if (who === 1) return seatFirst(obs, me, mate) ? 'fail' : 'success';
    const [sMe, sMate] = pairStatus78(obs, me, mate);
    if (sMe === 'F' && sMate !== 'F') return 'fail';
    if (sMate === 'F' && sMe !== 'F') return 'success';
    if (sMe === 'H' && sMate === 'N') return 'success';
    if (sMate === 'H' && sMe === 'N') return 'fail';
    if (who === 3) return seatFirst(obs, me, mate) ? 'fail' : 'success';
    // 紀錄一樣 → 位階法。唯一補的一格：兩個人上一次一起出任務都藏了（零失敗）——照位階法會兩個都藏的只有莫甘娜＋莫德雷德，
    // 所以莫甘娜知道隊友是莫德雷德（他照位階法繼續藏），這一次由位階低的莫甘娜出（原本是「跟著隊友一起藏」，又是零失敗）。
    if (obs.myRole === 'morgana' && sMe === 'H' && sMate === 'H' && lastJointHid78(obs, me, mate)) return 'fail';
    return null;
  }
  if (always > 0 && roundBit(always, round)) return 'fail';
  return null;
}
