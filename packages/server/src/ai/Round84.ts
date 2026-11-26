/**
 * 第 84 回合（藍紅雙方・紅方聽牌時的內黑／外白）：站長 2026-11-26（原話）：
 *
 * > 你的百科AI 藍紅雙方 目前知道在紅方聽牌的時候 應該要非常注意考慮是否要內黑外白嗎 特別是
 * > 如果是藍方 判斷該局要提前出任務（後方都是紅方）並且隊伍是全好 就應該開外白
 * > 自己被選到 隊伍有紅方的時候 要識情況內黑
 * > 如果是紅方 判斷該局輪到尾派非常有可能派出全好 / 或是隊友進任務 有可能六白衝出去
 * > 都應該要考慮外白
 *
 * 紅方聽牌 = 紅方已兩勝（第 3 局 0:2、第 4 局 1:2、第 5 局 2:2），這一隊過了、隊上的紅出失敗（A1）紅方就贏。只看非強制的提議（第 1–4 次）。
 * 量測（`scripts/matchPointVoteStudy84.py`，`docs/ai/gap/r84-match-point-votes.md`）：第 3 局 0:2，之後到強制局的隊長全是紅時，
 * 藍方不在隊上、隊上沒有紅 → 投白 兩邊都強的真人 54%／全部真人 64%，機器人 42%；同一格藍方在隊上、隊上有紅 → 投白（沒內黑）真人 91／86%，機器人 51%；
 * 相認紅不在隊上、看得到隊友、強制局的隊長是藍 → 投白 真人 20／21%，機器人 8%。
 *
 * 開關（都預設 0 = 關；關著時這個檔案不改任何決定）：
 *
 * **藍方**（忠臣／派西／梅林；`ForwardAgent` 在 `loyalTailWhite` 之前判，投白不越過好人投票關卡與梅林的致命隊）
 * - `earlyGo84 = τ`（B1，不在隊上 → 外白）：紅方聽牌、非強制、不在隊上、不是隊長。
 *   之後每一任隊長（到強制局為止）是紅的機率連乘 = P(後面都是紅) ≥ τ，而且這隊乾淨的機率 p ≥ 之後每一任隊長會派的隊（站在他的位置、公開視角最乾淨的幾個人＋他自己；
 *   在觀察者眼裡算，含那個隊長 ⇒ 已經乘上「他是藍」）——後面換不到更乾淨的隊——而且 p ≥ ν × 觀察者眼裡最乾淨的那幾個人組成的隊（不在隊上時不含自己；
 *   `earlyGoNear84`，0 = 0.9；這隊接近最好）。
 *   自己也是之後的隊長 → P(後面都是紅) = 0，不開（自己會派）。
 * - `earlyGoOn84 = τ`（B2，在隊上 → 不內黑）：同一個條件在隊上：門檻規則要內黑、但後面換不到更乾淨的隊，就投白（「識情況」：這隊已經是好人能期待的最好的隊）。
 * - `innerBlackBar84 = θ`（B2 的另一半）：紅方聽牌在隊上，P(隊上的紅夠讓任務失敗) ≥ θ 才內黑（取代 `goodBayesBadKey`；0 = 照原本）。
 * - `earlyGoScope84`（位元）：1 = 梅林不做；2 = 派西不做；4 = 只有第 3 局（0:2）；8 = 一半做一半不做（第 1C 節；照座位、局、第幾次提議雜湊）；
 *   16 = 不看「後面都是紅」，只看「後面換不到更乾淨的隊」＋「接近最好」。
 *   梅林：條件用坐在他位置、只看公開紀錄的忠臣算（同 `mpTailWhite`），而且隊上沒有他看得到的紅；在隊上不用 B2（他看得到）。
 *   派西：自己的後驗（含拇指）和公開視角都要過。
 *
 * **紅方**（相認紅：刺客、莫甘娜、莫德雷德；奧伯倫看不到隊友，不在範圍內）：紅方聽牌、非強制、不在隊上、隊上看得到的隊友夠讓任務失敗。
 * `ForwardAgent` 在「紅方照雜魚投票」的關鍵隊分支、`redKeyCrowd69` 之前判。
 * - `redTailWhite84 = q`（R1）：強制局的隊長不是看得到的紅，而且站在他的位置（公開視角）他會派的隊（他＋公開最乾淨的幾個人）沒有看得到的紅
 *   ——「尾派非常有可能派出全好」——以比例 q（照座位、局、第幾次提議雜湊）外白。
 * - `redSixWhite84 = q`（R2）：估這隊的白票：隊上的人（看得到的紅都白；其他人站在自己的座位估「這隊沒有紅」≥ `goodKeyVote` 門檻才算，同 `redKeyWhite`）
 *   ＋不在隊上的看得到的紅＋不在隊上的其他人站在自己的座位會不會白（公開 P(乾淨) ≥ `goodBayesGoodKey`，或公開視角會開尾家外白 `tailWhiteCore`）；
 *   ≥ 過半（十人局六白）→ 以比例 q 外白（照局、第幾次提議雜湊，同一個提議所有紅方同一個結果）。
 * - `redWhiteScope84`（位元）：1 = R2 也要 R1 的「尾派會派全好」（只在另一條路更糟時才外白）；2 = 只有第 3 局；
 *   4 = R2 只讓需要的人數外白（過半 − 其他白票，不在隊上的看得到的紅照座位排序，前幾個；避免整群紅一起外白，第 81 回合的教訓）。
 *
 * A0、A1 照舊是硬的（這裡只改投票；紅方聽牌時紅方的任務牌由 `redMatchPointFail` 決定）。硬約束（隊長自己的提議、奧伯倫在藍方聽牌、紅方持湖者言行一致）在呼叫端之前就處理掉了。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean, type BayesOptions } from './belief/BayesBelief';
import { leaderAhead, tailLeaderOf, tailWhiteCore } from './GoodVoteAlt';

/** 診斷計數（自我對打拆解用；不影響決策）。 */
export const round84Stats = { b1Checked: 0, b1White: 0, b2Checked: 0, b2White: 0, barKept: 0, r1Checked: 0, r1White: 0, r2Checked: 0, r2White: 0 };

const RECOGNISED: ReadonlySet<string> = new Set(['assassin', 'morgana', 'mordred']);
const NEAR_DEFAULT = 0.9;

function hash01(key: string): number {
  let h = 0x811c9dc5;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

function failsRequired(obs: PlayerObservation): number {
  return AVALON_CONFIG[obs.playerCount]?.questFailsRequired[(obs.currentRound ?? 1) - 1] ?? 1;
}

const failsOf = (obs: PlayerObservation): number => (obs.questResults ?? []).filter((r) => r === 'fail').length;

/** 紅方聽牌、非強制、第 3 局起（第 5 局 2:2 也算）。 */
export function redMatchPoint84(obs: PlayerObservation): boolean {
  return obs.gamePhase === 'team_vote' && (obs.currentRound ?? 1) >= 3 && failsOf(obs) === 2 && (obs.failCount ?? 0) <= 3;
}

/** 坐在 `viewer` 位置、只看公開紀錄的忠臣。 */
function publicView(obs: PlayerObservation, viewer: string = obs.myPlayerId): PlayerObservation {
  return {
    ...obs, myPlayerId: viewer, myRole: 'loyal', myTeam: 'good', seatTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined,
    myLakeResults: viewer === obs.myPlayerId ? obs.myLakeResults : [], publicLoyalView: false,
  } as PlayerObservation;
}

export interface EarlyGo84Eval {
  /** 這隊乾淨的機率。 */
  p: number;
  /** 之後每一任隊長（到強制局）是紅的機率連乘。 */
  laterRed: number;
  /** 之後每一任隊長會派的隊（站在他的位置、公開視角最乾淨的幾個人＋他自己）在觀察者眼裡乾淨的機率，取最大。 */
  alt: number;
  /** 觀察者眼裡最乾淨的那幾個人（不在隊上的時候不含自己）組成的隊乾淨的機率。 */
  best: number;
}

/** 站在 `leader` 的位置（公開視角，他當自己是藍）會派的隊：他＋公開最乾淨的 k − 1 個人。 */
export function forecastTeam84(obs: PlayerObservation, leader: string, k: number, opts: Readonly<BayesOptions>): string[] {
  const share = bayesRedShare(publicView(obs, leader), opts);
  const others = obs.allPlayerIds.filter((id) => id !== leader)
    .sort((a, b) => (share.get(a) ?? 0.5) - (share.get(b) ?? 0.5) || a.localeCompare(b, undefined, { numeric: true }));
  return [leader, ...others.slice(0, Math.max(0, k - 1))];
}

/** B1／B2 的量（觀察者的後驗；`view` 已經是要用的視角）。 */
export function earlyGoEval84(view: PlayerObservation, opts: Readonly<BayesOptions>): EarlyGo84Eval | null {
  const team = view.proposedTeam ?? [];
  if (team.length === 0) return null;
  const p = bayesTeamClean(view, team, opts);
  if (p === null) return null;
  const fc = view.failCount ?? 0;
  const me = view.myPlayerId;
  const share = bayesRedShare(view, opts);
  let laterRed = 1;
  let alt = 0;
  for (let o = 1; o <= 4 - fc; o++) {
    const l = leaderAhead(view, o);
    if (l === null) continue;
    laterRed *= l === me ? 0 : (share.get(l) ?? 0.5);
    alt = Math.max(alt, bayesTeamClean(view, l === me ? cleanestTeam(view, share, team.length, true) : forecastTeam84(view, l, team.length, opts), opts) ?? 0);
  }
  const best = Math.max(p, bayesTeamClean(view, cleanestTeam(view, share, team.length, team.includes(me)), opts) ?? 0);
  return { p, laterRed, alt, best };
}

/** 觀察者眼裡最乾淨的 k 個人（`withMe` = 自己算進來）。 */
function cleanestTeam(view: PlayerObservation, share: ReadonlyMap<string, number>, k: number, withMe: boolean): string[] {
  const me = view.myPlayerId;
  const pool = view.allPlayerIds.filter((id) => withMe || id !== me)
    .sort((a, b) => (a === me ? -1 : b === me ? 1 : (share.get(a) ?? 0.5) - (share.get(b) ?? 0.5)) || a.localeCompare(b, undefined, { numeric: true }));
  return pool.slice(0, k);
}

function earlyGoPasses(e: EarlyGo84Eval, tau: number, nu: number, scope: number): boolean {
  if (!(e.p > 0)) return false;
  if ((scope & 16) === 0 && e.laterRed < tau) return false;
  return e.p >= e.alt && e.p >= nu * e.best;
}

/**
 * B1／B2：true = 改投白（呼叫端負責好人投票關卡、梅林的致命隊）；false = 照原本。
 * 在隊上只在門檻規則本來要內黑時才有差（呼叫端照順序，投白的規則本來就先判）。
 */
export function earlyGo84(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (obs.myTeam !== 'good' || obs.publicLoyalView === true || obs.redLoyalView === true || !redMatchPoint84(obs)) return false;
  if (obs.currentLeader === obs.myPlayerId) return false;
  const team = obs.proposedTeam ?? [];
  if (team.length === 0) return false;
  const on = team.includes(obs.myPlayerId);
  const tau = on ? (tuning.earlyGoOn84 ?? 0) : (tuning.earlyGo84 ?? 0);
  if (!(tau > 0)) return false;
  const scope = tuning.earlyGoScope84 ?? 0;
  const role = obs.myRole;
  if (role !== 'loyal' && role !== 'percival' && role !== 'merlin') return false;
  if (role === 'merlin' && ((scope & 1) !== 0 || on)) return false;
  if (role === 'percival' && (scope & 2) !== 0) return false;
  if ((scope & 4) !== 0 && (obs.currentRound ?? 1) !== 3) return false;
  if ((scope & 8) !== 0 && hash01(`${obs.myPlayerId}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|earlygo84`) >= 0.5) return false;
  if (role === 'merlin' && team.some((id) => obs.knownEvils.includes(id))) return false;
  if (on) round84Stats.b2Checked++; else round84Stats.b1Checked++;
  const opts = bayesOptionsOf(tuning);
  const nu = (tuning.earlyGoNear84 ?? 0) || NEAR_DEFAULT;
  const views = role === 'loyal' ? [obs] : role === 'merlin' ? [publicView(obs)] : [obs, publicView(obs)];
  for (const v of views) {
    const e = earlyGoEval84(v, opts);
    if (!e || !earlyGoPasses(e, tau, nu, scope)) return false;
  }
  if (on) round84Stats.b2White++; else round84Stats.b1White++;
  return true;
}

/**
 * `innerBlackBar84`：紅方聽牌、在隊上（忠臣／派西，`bayesVoteCriteria` 的在隊上那一段）時內黑的門檻；null = 照原本。
 */
export function innerBlackBar84(tuning: Readonly<AgentTuning>, obs: PlayerObservation): number | null {
  const bar = tuning.innerBlackBar84 ?? 0;
  if (!(bar > 0) || !redMatchPoint84(obs) || obs.myTeam !== 'good') return null;
  if (((tuning.earlyGoScope84 ?? 0) & 4) !== 0 && (obs.currentRound ?? 1) !== 3) return null;
  if (obs.myRole === 'percival' && ((tuning.earlyGoScope84 ?? 0) & 2) !== 0) return null;
  return bar;
}

/** 紅方的格子：相認紅、紅方聽牌、非強制、不在隊上、不是隊長、隊上看得到的隊友夠讓任務失敗（局照位元 2）。 */
export function inRedCell84(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (obs.myTeam !== 'evil' || !RECOGNISED.has(obs.myRole) || !redMatchPoint84(obs)) return false;
  if (obs.currentLeader === obs.myPlayerId) return false;
  if (((tuning.redWhiteScope84 ?? 0) & 2) !== 0 && (obs.currentRound ?? 1) !== 3) return false;
  const team = obs.proposedTeam ?? [];
  if (team.includes(obs.myPlayerId)) return false;
  return team.filter((id) => obs.knownEvils.includes(id)).length >= failsRequired(obs);
}

/** R1：強制局的隊長不是看得到的紅，站在他的位置（公開視角）他會派的隊沒有看得到的紅。 */
export function tailSendsClean84(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const tail = tailLeaderOf(obs);
  if (tail === null) return false;
  const reds = new Set([obs.myPlayerId, ...obs.knownEvils]);
  if (reds.has(tail)) return false;
  const team = forecastTeam84(obs, tail, (obs.proposedTeam ?? []).length, bayesOptionsOf(tuning));
  return !team.some((id) => reds.has(id));
}

export interface SixWhite84 {
  /** 不算不在隊上的看得到的紅的白票估計。 */
  othersYes: number;
  /** 不在隊上的看得到的紅（含自己），照座位排序。 */
  offReds: string[];
  majority: number;
}

/** R2：估這隊的白票（只用投票前的公開紀錄）。 */
export function sixWhiteEstimate84(tuning: Readonly<AgentTuning>, obs: PlayerObservation): SixWhite84 {
  const reds = new Set([obs.myPlayerId, ...obs.knownEvils]);
  const team = obs.proposedTeam ?? [];
  const opts = bayesOptionsOf(tuning);
  const onTau = tuning.goodKeyVote > 0 ? tuning.goodKeyVote : 0.5;
  const offTau = tuning.goodBayesGoodKey || 0.9;
  let othersYes = 0;
  const offReds: string[] = [];
  for (const id of obs.allPlayerIds) {
    const on = team.includes(id);
    if (reds.has(id)) { if (on) othersYes++; else offReds.push(id); continue; }
    if (id === obs.currentLeader) { othersYes++; continue; }
    const v = publicView(obs, id);
    const p = bayesTeamClean(v, team, opts) ?? 0;
    if (on) { if (p >= onTau) othersYes++; continue; }
    if (p >= offTau || tailWhiteCore(tuning, v)) othersYes++;
  }
  offReds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { othersYes, offReds, majority: Math.floor(obs.playerCount / 2) + 1 };
}

/** R1／R2：true = 外白；false = 照原本。 */
export function redMatchWhite84(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const q1 = tuning.redTailWhite84 ?? 0;
  const q2 = tuning.redSixWhite84 ?? 0;
  if (!(q1 > 0 || q2 > 0) || !inRedCell84(tuning, obs)) return false;
  const scope = tuning.redWhiteScope84 ?? 0;
  const round = obs.currentRound ?? 1;
  const fc = obs.failCount ?? 0;
  let tailClean: boolean | null = null;
  if (q1 > 0) {
    round84Stats.r1Checked++;
    tailClean = tailSendsClean84(tuning, obs);
    if (tailClean && hash01(`${obs.myPlayerId}|${round}|${fc}|redtail84`) < q1) { round84Stats.r1White++; return true; }
  }
  if (q2 > 0) {
    if ((scope & 1) !== 0) {
      if (tailClean === null) tailClean = tailSendsClean84(tuning, obs);
      if (!tailClean) return false;
    }
    round84Stats.r2Checked++;
    const e = sixWhiteEstimate84(tuning, obs);
    if (e.othersYes + e.offReds.length < e.majority) return false;
    if ((scope & 4) !== 0) {
      const needed = Math.max(0, e.majority - e.othersYes);
      if (needed === 0 || e.offReds.indexOf(obs.myPlayerId) >= needed) return false;
    }
    if (hash01(`${round}|${fc}|redsix84`) >= q2) return false;
    round84Stats.r2White++;
    return true;
  }
  return false;
}
