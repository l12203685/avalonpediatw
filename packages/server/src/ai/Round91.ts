/**
 * 第 91 回合（路線圖 Phase D，Issue #215，`docs/ai/NEXT_GEN_AI_ROADMAP.md`）：
 * 1–2 層深度受限前瞻搜尋（Depth-Limited Lookahead）＋終端局勢價值評估器（Terminal Value Estimator）。
 *
 * 針對三個高槓桿關鍵局面進行受限前瞻，嚴格遵守所有硬規則（A0 藍方湖中照實、A1 紅方兩敗必失敗且不放過敗局車、
 * 藍方任務必成功、`LogicGates` INV-T1/V1/K1/K1V/P3/L1/Pe1/M1/PR1/PL/PL2/B3），單次決策耗時 < 5 ms（上限 < 50 ms），
 * 100% 確定性可重現（零 `Math.random`）。
 *
 * 開關（`AgentTuning.ts`）：
 * - `lookahead91`：0 = 關（預設，對局與基準線完全一致）；1 = 標準平衡前瞻；2 = 積極前瞻（較小期望值優勢即觸發）。
 * - `lookahead91Scope`（位元遮罩；0 = 預設 7 = 三個關鍵局面全開）：
 *   - 位元 1：`n-5`（第 5 次強制提議）與 `n-4`（強制前關鍵換隊）派隊前瞻
 *   - 位元 2：關鍵洗尾／聽牌投票前瞻（`redFails >= 2` 或 `bluePasses >= 2`，第 3 局起非強制）
 *   - 位元 4：湖中女神目標選擇 2 層前瞻（資訊增益 × 下一湖交給好／壞人的潛在反制）
 *   - 位元 8：梅林也參與派隊與投票前瞻（僅用公開忠臣視角，且嚴守 INV-M1 不派不贊成可見紅）
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation, TeamSelectAction } from './types';
import { bayesOptionsOf, bayesWorlds, type BayesOptions } from './belief/BayesBelief';
import { popcount } from './belief/Certainty';
import { anotherLakeFollows, buildWorlds } from './GoodLakeInfo';
import { leaderAhead } from './GoodVoteAlt';
import { provenRedBar } from './ProvenRed';

/** 診斷計數（效能與觸發頻率監控；不影響決策）。 */
export const round91Stats = {
  teamChecked: 0,
  teamSwapped: 0,
  voteChecked: 0,
  voteOverridden: 0,
  lakeChecked: 0,
  lakePicked: 0,
};

export interface Lookahead91Cfg {
  /** 1 = 標準平衡；2 = 積極模式（較低優勢門檻）。 */
  mode: 1 | 2;
  /** 啟用 n-5 / n-4 關鍵派隊前瞻（位元 1）。 */
  team: boolean;
  /** 啟用關鍵聽牌／洗尾投票前瞻（位元 2）。 */
  vote: boolean;
  /** 啟用湖中女神目標 2 層前瞻（位元 4）。 */
  lake: boolean;
  /** 梅林也參與派隊與投票前瞻（位元 8，嚴守公開視角與 INV-M1）。 */
  merlin: boolean;
}

/** 解析第 91 回合開關設定；關閉時回傳 null。 */
export function lookahead91Cfg(t: Readonly<Partial<AgentTuning>>): Lookahead91Cfg | null {
  const m = t.lookahead91 ?? 0;
  if (m !== 1 && m !== 2) return null;
  const rawScope = t.lookahead91Scope ?? 0;
  const scope = rawScope === 0 ? 7 : rawScope;
  return {
    mode: m,
    team: (scope & 1) !== 0,
    vote: (scope & 2) !== 0,
    lake: (scope & 4) !== 0,
    merlin: (scope & 8) !== 0,
  };
}

// ── Terminal Value Estimator V(state) ───────────────────────────

export interface TerminalValueInput {
  bluePasses: number;
  redFails: number;
  nextRound: number;
  playerCount: number;
  /** 目前後驗下，藍方下一輪最優可達隊伍通過任務的估計機率 [0, 1]。 */
  pCleanNext: number;
  /** 下一任隊長為好人的機率 [0, 1]。 */
  nextLeaderGoodProb: number;
  /** 下一任持湖者為好人的機率 [0, 1]（若無後續湖則無作用）。 */
  nextLakeGoodProb: number;
  /** 後續是否還有湖中女神檢驗。 */
  hasFutureLake: boolean;
  /** 三藍後梅林被刺中機率（預設 0.40，對應強者真人局基準 40.0%）。 */
  assassinationRate?: number;
}

const DEFAULT_ASSASSINATION_RATE = 0.40;
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

function failsRequiredAt(playerCount: number, round: number): number {
  return AVALON_CONFIG[playerCount]?.questFailsRequired[round - 1] ?? 1;
}

function teamSizeAt(playerCount: number, round: number): number {
  return AVALON_CONFIG[playerCount]?.questTeams[round - 1] ?? 4;
}

/**
 * 終端局勢價值評估器 `V(belief_state, score, leader, lake_holder)`：
 * 給定當前比分 `(bluePasses, redFails)`、下一輪資訊與後驗清晰度，透過精確 3×3 動態規劃
 * 估算藍方最終贏得遊戲（三藍且梅林存活）的期望勝率 [0, 1]。
 *
 * 計算量為常數 O(9)（< 0.01 ms），100% 確定性。
 */
export function evaluateTerminalValue91(input: Readonly<TerminalValueInput>): number {
  const assassRate = clamp(input.assassinationRate ?? DEFAULT_ASSASSINATION_RATE, 0, 1);
  const blueWinVal = 1 - assassRate;

  if (input.redFails >= 3) return 0;
  if (input.bluePasses >= 3) return blueWinVal;

  const baseClean = clamp(input.pCleanNext, 0.05, 0.95);
  const leaderDelta = 0.08 * (clamp(input.nextLeaderGoodProb, 0, 1) - 0.5);
  const lakeDelta = input.hasFutureLake ? 0.11 * (clamp(input.nextLakeGoodProb, 0, 1) - 0.5) : 0;

  // dp[b][r] = blue win probability from score (b bluePasses, r redFails)
  const dp: number[][] = Array.from({ length: 4 }, () => new Array<number>(4).fill(0));
  for (let r = 0; r < 3; r++) dp[3][r] = blueWinVal;
  for (let b = 0; b < 3; b++) dp[b][3] = 0;

  for (let b = 2; b >= input.bluePasses; b--) {
    for (let r = 2; r >= input.redFails; r--) {
      const rd = b + r + 1;
      const dist = Math.max(0, rd - input.nextRound);
      const twoFailBonus = failsRequiredAt(input.playerCount, rd) >= 2 ? 0.16 : 0;
      // 下一輪直接採用當前信念與隊長優勢；更遠的輪次適度回歸並受湖中傳遞鏈影響
      const decay = dist === 0 ? 1 : Math.pow(0.75, dist);
      const baseRoundP = dist === 0
        ? baseClean + leaderDelta + 0.5 * lakeDelta
        : 0.52 * (1 - decay) + baseClean * decay + lakeDelta;
      const pPass = clamp(baseRoundP + twoFailBonus, 0.05, 0.95);
      dp[b][r] = pPass * dp[b + 1][r] + (1 - pPass) * dp[b][r + 1];
    }
  }

  return dp[input.bluePasses][input.redFails];
}

// ── Shared Posterior Helpers ────────────────────────────────────

interface WorldDist {
  worlds: readonly number[];
  wts: readonly number[];
  bitOf: (id: string) => number;
  allIds: readonly string[];
  n: number;
}

function getWorldDist(obs: PlayerObservation, opts: Readonly<BayesOptions>): WorldDist | null {
  const bw = bayesWorlds(obs, opts);
  if (bw.worlds.length === 0) return null;
  return {
    worlds: bw.worlds,
    wts: bw.wts,
    bitOf: bw.bitOf,
    allIds: obs.allPlayerIds,
    n: obs.allPlayerIds.length,
  };
}

function maskOfIds(ids: readonly string[], bitOf: (id: string) => number): number {
  let m = 0;
  for (const id of ids) m |= bitOf(id);
  return m;
}

function redMarginalsFromDist(dist: WorldDist, filter?: (w: number) => boolean): { pRed: number[]; total: number } {
  const { worlds, wts, n } = dist;
  const pRed = new Array<number>(n).fill(0);
  let total = 0;
  for (let k = 0; k < worlds.length; k++) {
    const w = worlds[k];
    if (filter && !filter(w)) continue;
    const wt = wts[k];
    total += wt;
    for (let i = 0; i < n; i++) {
      if ((w & (1 << i)) !== 0) pRed[i] += wt;
    }
  }
  if (total > 0) {
    for (let i = 0; i < n; i++) pRed[i] /= total;
  }
  return { pRed, total };
}

/** 計算給定隊伍在後驗下「任務成功」（紅人數 < failsReq）的精確機率。 */
function teamPassProb(dist: WorldDist, teamMask: number, failsReq: number, filter?: (w: number) => boolean): number {
  const { worlds, wts } = dist;
  let total = 0;
  let pass = 0;
  for (let k = 0; k < worlds.length; k++) {
    const w = worlds[k];
    if (filter && !filter(w)) continue;
    const wt = wts[k];
    total += wt;
    if (popcount(w & teamMask) < failsReq) pass += wt;
  }
  return total > 0 ? pass / total : 0.5;
}

/** 給定邊際紅機率 `pRed`，回傳最乾淨的 `size` 人隊伍的位元遮罩（可選強迫含某人）。 */
function cleanestMaskFromMarginals(
  pRed: readonly number[],
  size: number,
  mustIncludeIdx = -1,
): number {
  const n = pRed.length;
  const order = Array.from({ length: n }, (_, i) => i)
    .filter((i) => i !== mustIncludeIdx)
    .sort((a, b) => (pRed[a] - pRed[b]) || (a - b));
  let mask = mustIncludeIdx >= 0 ? (1 << mustIncludeIdx) : 0;
  const need = mustIncludeIdx >= 0 ? size - 1 : size;
  for (let i = 0; i < need && i < order.length; i++) {
    mask |= 1 << order[i];
  }
  return mask;
}

/** 在指定世界子集（filter）下，估計下一輪最優可達隊伍的過關機率。 */
function bestCleanProbForRound(
  dist: WorldDist,
  nextRound: number,
  playerCount: number,
  filter?: (w: number) => boolean,
): number {
  const size = teamSizeAt(playerCount, nextRound);
  const failsReq = failsRequiredAt(playerCount, nextRound);
  const { pRed, total } = redMarginalsFromDist(dist, filter);
  if (total <= 1e-12) return 0.5;
  const mask = cleanestMaskFromMarginals(pRed, size);
  return teamPassProb(dist, mask, failsReq, filter);
}

function binaryEntropy(p: number): number {
  if (p <= 1e-12 || p >= 1 - 1e-12) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

function scoreCounts(obs: PlayerObservation): { bluePasses: number; redFails: number } {
  let bluePasses = 0;
  let redFails = 0;
  for (const r of obs.questResults ?? []) {
    if (r === 'fail') redFails++;
    else bluePasses++;
  }
  return { bluePasses, redFails };
}

/** 坐在自己位置、只看公開紀錄的忠臣視角（供梅林嚴守公開資訊使用）。 */
function publicLoyalView91(obs: PlayerObservation): PlayerObservation {
  return {
    ...obs,
    myRole: 'loyal',
    myTeam: 'good',
    seatTeam: 'good',
    knownEvils: [],
    knownWizards: undefined,
    allEvilIds: undefined,
    publicLoyalView: true,
  };
}

/** 推估目前持湖者是誰（最近一次湖的目標，或開局首湖者 0 家 / 尾家）。 */
function currentLakeHolderId(obs: PlayerObservation): string | null {
  const lh = obs.lakeHistory ?? [];
  if (lh.length > 0) return lh[lh.length - 1].targetId;
  // 開局持湖者通常為最後一位玩家（隊長的上一家）
  return obs.allPlayerIds.length > 0 ? obs.allPlayerIds[obs.allPlayerIds.length - 1] : null;
}

/** 推估下一輪開始時的隊長 ID。 */
function nextRoundLeaderId(obs: PlayerObservation, proposalsLeftThisRound = 0): string | null {
  return leaderAhead(obs, proposalsLeftThisRound + 1);
}

// ── Spot 1: n-5 / n-4 Critical Team Selection Lookahead ─────────

export interface Lookahead91TeamEval {
  teamIds: string[];
  ev: number;
  pPass: number;
  pApprove: number;
}

/**
 * 關鍵局面（`n-5` 強制局、`n-4` 強制前換隊、或第 3 局起聽牌局）的 1–2 層前瞻派隊：
 * - 僅評估通過 `gateOk` 且不含 `provenRedBar`（INV-PR1）且（對梅林）不含 `knownEvils`（INV-M1）的合法候選隊伍。
 * - `n-5`（`failCount === 4`）：1 層展開隊伍執行後的成功／失敗終端價值與後驗清晰度。
 * - `n-4`（`failCount === 3`）：2 層展開「本隊通過執行」vs「否決流到 `n-5` 尾家隊長」之期望價值，
 *   當尾家偏紅時自動偏好更容易獲得場上同意且乾淨的關鍵換隊。
 */
export function lookahead91Team(
  tuning: Readonly<Partial<AgentTuning>>,
  obs: PlayerObservation,
  baseAction: TeamSelectAction,
  gateOk: (team: readonly string[]) => boolean,
): TeamSelectAction {
  const cfg = lookahead91Cfg(tuning);
  if (!cfg || !cfg.team) return baseAction;
  if (obs.myTeam !== 'good' || obs.gamePhase !== 'team_select') return baseAction;
  if (obs.myRole !== 'loyal' && obs.myRole !== 'percival' && !(cfg.merlin && obs.myRole === 'merlin')) {
    return baseAction;
  }

  const round = obs.currentRound ?? 1;
  const fc = obs.failCount ?? 0;
  const { bluePasses, redFails } = scoreCounts(obs);
  const isHighLeverage = fc >= 3 || (round >= 3 && (redFails >= 2 || bluePasses >= 2));
  if (!isHighLeverage) return baseAction;

  const teamSize = baseAction.teamIds.length;
  if (teamSize <= 0 || teamSize > obs.allPlayerIds.length) return baseAction;

  const view = obs.myRole === 'merlin' ? publicLoyalView91(obs) : obs;
  const opts = bayesOptionsOf(tuning);
  const dist = getWorldDist(view, opts);
  if (!dist) return baseAction;

  round91Stats.teamChecked++;

  const provenSet = new Set(provenRedBar(tuning, obs));
  const seenEvilSet = obs.myRole === 'merlin' ? new Set(obs.knownEvils) : new Set<string>();
  const isLegalCandidate = (team: readonly string[]): boolean => {
    if (team.length !== teamSize) return false;
    for (const id of team) {
      if (provenSet.has(id) || seenEvilSet.has(id)) return false;
    }
    return gateOk(team);
  };

  // 生成候選隊伍：基準隊伍 + 依後驗紅機率排序前 7 位非自己玩家的所有合法組合（最多取 Top-12）
  const { pRed } = redMarginalsFromDist(dist);
  const me = obs.myPlayerId;
  const seatIdx = new Map(obs.allPlayerIds.map((id, i) => [id, i]));
  const othersRanked = obs.allPlayerIds
    .filter((id) => id !== me && !provenSet.has(id) && !seenEvilSet.has(id))
    .sort((a, b) => (pRed[seatIdx.get(a) ?? 0] - pRed[seatIdx.get(b) ?? 0]) || ((seatIdx.get(a) ?? 0) - (seatIdx.get(b) ?? 0)));

  const pool = othersRanked.slice(0, Math.min(othersRanked.length, Math.max(teamSize + 2, 7)));
  const candidates: string[][] = [];
  const seenKey = new Set<string>();
  const addCandidate = (t: readonly string[]): void => {
    if (!isLegalCandidate(t)) return;
    const key = [...t].sort().join('|');
    if (seenKey.has(key)) return;
    seenKey.add(key);
    candidates.push([...t]);
  };

  addCandidate(baseAction.teamIds);
  const need = teamSize - 1;
  const gen = (start: number, acc: string[]): void => {
    if (acc.length === need) {
      addCandidate([me, ...acc]);
      return;
    }
    for (let i = start; i <= pool.length - (need - acc.length); i++) {
      acc.push(pool[i]);
      gen(i + 1, acc);
      acc.pop();
    }
  };
  if (need >= 0 && need <= pool.length) gen(0, []);

  if (candidates.length < 2) return baseAction;

  const failsReq = failsRequiredAt(obs.playerCount, round);
  const nextRound = Math.min(5, round + 1);
  const hasFutureLake = anotherLakeFollows({ ...obs, currentRound: round });
  const lakeHolder = currentLakeHolderId(obs);
  const lakeGoodProb = lakeHolder ? 1 - (pRed[seatIdx.get(lakeHolder) ?? 0] ?? 0.4) : 0.5;
  const nextLeader = nextRoundLeaderId(obs, 0);
  const nextLeaderGoodProb = nextLeader ? 1 - (pRed[seatIdx.get(nextLeader) ?? 0] ?? 0.4) : 0.5;

  // 先對候選依單步 pPass 預篩 Top-12，確保執行時間遠低於 50 ms
  const preScored = candidates.map((team) => {
    const mask = maskOfIds(team, dist.bitOf);
    return { team, mask, pPass: teamPassProb(dist, mask, failsReq) };
  });
  const baseKey = [...baseAction.teamIds].sort().join('|');
  preScored.sort((a, b) => b.pPass - a.pPass);
  const topCandidates = preScored.slice(0, 12);
  if (!topCandidates.some((c) => [...c.team].sort().join('|') === baseKey)) {
    const baseItem = preScored.find((c) => [...c.team].sort().join('|') === baseKey);
    if (baseItem) topCandidates.push(baseItem);
  }

  // 若在 n-4（failCount === 3），預先算好「否決流到 n-5 尾家」的 2 層期望價值 V_tail
  let vTail = 0;
  let tailRedProb = 0.4;
  if (fc === 3) {
    const tailLeader = leaderAhead(obs, 1);
    const tailIdx = tailLeader ? (seatIdx.get(tailLeader) ?? -1) : -1;
    tailRedProb = tailIdx >= 0 ? pRed[tailIdx] : 0.4;
    const tailCleanMask = tailIdx >= 0 ? cleanestMaskFromMarginals(pRed, teamSize, tailIdx) : 0;
    const tailNextLeader = nextRoundLeaderId(obs, 1);
    const tailNextLeaderGoodProb = tailNextLeader ? 1 - (pRed[seatIdx.get(tailNextLeader) ?? 0] ?? 0.4) : 0.5;

    let pTailPass = 0;
    for (let k = 0; k < dist.worlds.length; k++) {
      const w = dist.worlds[k];
      const wt = dist.wts[k];
      const tailIsEvil = tailIdx >= 0 && (w & (1 << tailIdx)) !== 0;
      if (tailIsEvil) {
        // 紅方尾家：紅方聽牌（A1）必失敗；否則 90% 出失敗
        const passIfEvil = redFails >= 2 ? 0 : 0.10;
        pTailPass += wt * passIfEvil;
      } else if (popcount(w & tailCleanMask) < failsReq) {
        pTailPass += wt;
      }
    }
    const baseCleanNext = bestCleanProbForRound(dist, nextRound, obs.playerCount);
    const vTailPass = evaluateTerminalValue91({
      bluePasses: bluePasses + 1,
      redFails,
      nextRound,
      playerCount: obs.playerCount,
      pCleanNext: baseCleanNext,
      nextLeaderGoodProb: tailNextLeaderGoodProb,
      nextLakeGoodProb: lakeGoodProb,
      hasFutureLake,
    });
    const vTailFail = evaluateTerminalValue91({
      bluePasses,
      redFails: redFails + 1,
      nextRound,
      playerCount: obs.playerCount,
      pCleanNext: baseCleanNext,
      nextLeaderGoodProb: tailNextLeaderGoodProb,
      nextLakeGoodProb: lakeGoodProb,
      hasFutureLake,
    });
    vTail = pTailPass * vTailPass + (1 - pTailPass) * vTailFail;
  }

  const evals: Lookahead91TeamEval[] = topCandidates.map(({ team, mask, pPass }) => {
    // 條件後驗更新：若本隊成功／失敗，下一輪最優隊伍的清晰度
    const pCleanAfterPass = bestCleanProbForRound(dist, nextRound, obs.playerCount, (w) => popcount(w & mask) < failsReq);
    const pCleanAfterFail = bestCleanProbForRound(dist, nextRound, obs.playerCount, (w) => popcount(w & mask) >= failsReq);

    const vPass = evaluateTerminalValue91({
      bluePasses: bluePasses + 1,
      redFails,
      nextRound,
      playerCount: obs.playerCount,
      pCleanNext: pCleanAfterPass,
      nextLeaderGoodProb,
      nextLakeGoodProb: lakeGoodProb,
      hasFutureLake,
    });
    const vFail = evaluateTerminalValue91({
      bluePasses,
      redFails: redFails + 1,
      nextRound,
      playerCount: obs.playerCount,
      pCleanNext: pCleanAfterFail,
      nextLeaderGoodProb,
      nextLakeGoodProb: lakeGoodProb,
      hasFutureLake,
    });
    const vExec = pPass * vPass + (1 - pPass) * vFail;

    let pApprove = 1.0;
    let ev = vExec;
    if (fc === 3) {
      // 估計本隊在 n-4 通過投票的機率：
      // 隊上玩家（高機率贊成，除非隊伍明顯可疑）＋隊外好人見尾家偏紅且本隊乾淨時願意洗尾外白
      const majority = Math.floor(obs.playerCount / 2) + 1;
      let expectedApproves = 1; // 隊長自己必贊成
      for (const id of obs.allPlayerIds) {
        if (id === me) continue;
        const onTeam = team.includes(id);
        const idx = seatIdx.get(id) ?? 0;
        const pGoodSeat = 1 - pRed[idx];
        if (onTeam) {
          // 隊上好人多半贊成（隊伍越乾淨越不會內黑）；隊上紅人若本隊必敗亦贊成
          expectedApproves += pGoodSeat * clamp(0.45 + 0.50 * pPass, 0.25, 0.96) + (1 - pGoodSeat) * 0.85;
        } else {
          // 隊外好人洗尾傾向取決於尾家紅機率與本隊乾淨度
          const washProb = pGoodSeat * clamp(0.65 * tailRedProb * pPass, 0, 0.55);
          // 隊外紅人僅在隊上有紅時可能外白
          const redOuterProb = (1 - pGoodSeat) * (1 - pPass) * 0.35;
          expectedApproves += washProb + redOuterProb;
        }
      }
      // Logistic 轉換成過半通過機率
      pApprove = 1 / (1 + Math.exp(-1.4 * (expectedApproves - (majority - 0.5))));
      ev = pApprove * vExec + (1 - pApprove) * vTail;
    }

    return { teamIds: team, ev, pPass, pApprove };
  });

  const baseEval = evals.find((e) => [...e.teamIds].sort().join('|') === baseKey);
  if (!baseEval) return baseAction;

  // 確定性排序：EV 高者優先，平手以座位序總和較小者優先
  const seatOrderSum = (t: readonly string[]): number => t.reduce((s, id) => s + (seatIdx.get(id) ?? 0), 0);
  evals.sort((a, b) => {
    const diff = b.ev - a.ev;
    if (Math.abs(diff) > 1e-9) return diff;
    return seatOrderSum(a.teamIds) - seatOrderSum(b.teamIds);
  });

  const best = evals[0];
  const refSpread = Math.max(
    0.08,
    evaluateTerminalValue91({
      bluePasses: bluePasses + 1, redFails, nextRound, playerCount: obs.playerCount,
      pCleanNext: 0.55, nextLeaderGoodProb, nextLakeGoodProb: lakeGoodProb, hasFutureLake,
    }) - evaluateTerminalValue91({
      bluePasses, redFails: redFails + 1, nextRound, playerCount: obs.playerCount,
      pCleanNext: 0.55, nextLeaderGoodProb, nextLakeGoodProb: lakeGoodProb, hasFutureLake,
    }),
  );
  const margin = refSpread * (cfg.mode === 2 ? 0.015 : 0.04);
  if (best && best.ev > baseEval.ev + margin) {
    round91Stats.teamSwapped++;
    return { type: 'team_select', teamIds: best.teamIds };
  }
  return baseAction;
}

// ── Spot 2: Critical Tail-Washing / Match-Point Vote Lookahead ──

export interface Lookahead91VoteDecision {
  vote: boolean;
  evApprove: number;
  evReject: number;
  reason: string;
}

/**
 * 關鍵洗尾／聽牌投票 2 層前瞻（`redFails >= 2` 或 `bluePasses >= 2`，第 3 局起非強制）：
 * 比較「贊成讓此隊過關執行（`evApprove`）」vs「反對讓提議流向後續隊長直到 `n-5` 尾家（`evReject`）」。
 * 呼叫端必須在贊成前再通過 `goodVoteGate` 與梅林 `merlinVoteFatal` 檢查（絕不越過硬規則）。
 */
export function lookahead91Vote(
  tuning: Readonly<Partial<AgentTuning>>,
  obs: PlayerObservation,
): Lookahead91VoteDecision | null {
  const cfg = lookahead91Cfg(tuning);
  if (!cfg || !cfg.vote) return null;
  if (obs.myTeam !== 'good' || obs.gamePhase !== 'team_vote') return null;

  const round = obs.currentRound ?? 1;
  const fc = obs.failCount ?? 0;
  if (round < 3 || fc >= 4) return null; // R1-R2 遵守正常票桌規；強制局必贊成
  if (obs.currentLeader === obs.myPlayerId) return null; // 隊長不反對自己的隊

  const { bluePasses, redFails } = scoreCounts(obs);
  if (redFails < 2 && bluePasses < 2) return null;

  if (obs.myRole !== 'loyal' && obs.myRole !== 'percival' && !(cfg.merlin && obs.myRole === 'merlin')) {
    return null;
  }

  const team = obs.proposedTeam ?? [];
  if (team.length === 0) return null;

  // 梅林僅使用公開忠臣視角評估，且絕不對含可見紅的隊伍投贊成（INV-M1）
  const merlinHasSeenRed = obs.myRole === 'merlin' && team.some((id) => obs.knownEvils.includes(id));
  const view = obs.myRole === 'merlin' ? publicLoyalView91(obs) : obs;
  const opts = bayesOptionsOf(tuning);
  const dist = getWorldDist(view, opts);
  if (!dist) return null;

  round91Stats.voteChecked++;

  const failsReq = failsRequiredAt(obs.playerCount, round);
  const nextRound = Math.min(5, round + 1);
  const hasFutureLake = anotherLakeFollows({ ...obs, currentRound: round });
  const { pRed } = redMarginalsFromDist(dist);
  const seatIdx = new Map(obs.allPlayerIds.map((id, i) => [id, i]));

  const lakeHolder = currentLakeHolderId(obs);
  const lakeGoodProb = lakeHolder ? 1 - (pRed[seatIdx.get(lakeHolder) ?? 0] ?? 0.4) : 0.5;
  const nextLeaderNow = nextRoundLeaderId(obs, 0);
  const nextLeaderGoodNow = nextLeaderNow ? 1 - (pRed[seatIdx.get(nextLeaderNow) ?? 0] ?? 0.4) : 0.5;

  // 分支 1：本隊通過執行
  const propMask = maskOfIds(team, dist.bitOf);
  const pPassNow = teamPassProb(dist, propMask, failsReq);
  const pCleanPassNow = bestCleanProbForRound(dist, nextRound, obs.playerCount, (w) => popcount(w & propMask) < failsReq);
  const pCleanFailNow = bestCleanProbForRound(dist, nextRound, obs.playerCount, (w) => popcount(w & propMask) >= failsReq);

  const vPassNow = evaluateTerminalValue91({
    bluePasses: bluePasses + 1,
    redFails,
    nextRound,
    playerCount: obs.playerCount,
    pCleanNext: pCleanPassNow,
    nextLeaderGoodProb: nextLeaderGoodNow,
    nextLakeGoodProb: lakeGoodProb,
    hasFutureLake,
  });
  const vFailNow = evaluateTerminalValue91({
    bluePasses,
    redFails: redFails + 1,
    nextRound,
    playerCount: obs.playerCount,
    pCleanNext: pCleanFailNow,
    nextLeaderGoodProb: nextLeaderGoodNow,
    nextLakeGoodProb: lakeGoodProb,
    hasFutureLake,
  });
  const evApprove = pPassNow * vPassNow + (1 - pPassNow) * vFailNow;

  // 分支 2：反對並流向後續隊長（從尾家 n-5 往回做 1–2 層倒推）
  const remainingSteps = 4 - fc; // 1..4
  const futureLeaders: { idx: number; cleanMask: number }[] = [];
  for (let o = 1; o <= remainingSteps; o++) {
    const lid = leaderAhead(obs, o);
    const idx = lid ? (seatIdx.get(lid) ?? -1) : -1;
    const cleanMask = idx >= 0 ? cleanestMaskFromMarginals(pRed, team.length, idx) : 0;
    futureLeaders.push({ idx, cleanMask });
  }

  let pPassFlow = 0;
  for (let k = 0; k < dist.worlds.length; k++) {
    const w = dist.worlds[k];
    const wt = dist.wts[k];
    // 從最後一位（n-5 強制尾家，必執行）倒推到下一位隊長
    const tail = futureLeaders[futureLeaders.length - 1];
    const tailIsEvil = tail.idx >= 0 && (w & (1 << tail.idx)) !== 0;
    let pSuccessFromHere = tailIsEvil
      ? (redFails >= 2 ? 0 : 0.10)
      : (popcount(w & tail.cleanMask) < failsReq ? 1 : 0);

    // 倒推中間的非強制隊長（最多回推 2 層）
    for (let s = futureLeaders.length - 2; s >= 0; s--) {
      const step = futureLeaders[s];
      const stepIsEvil = step.idx >= 0 && (w & (1 << step.idx)) !== 0;
      const pPassIfExec = stepIsEvil
        ? (redFails >= 2 ? 0 : 0.10)
        : (popcount(w & step.cleanMask) < failsReq ? 1 : 0);
      // 中間提議被場上同意的估計機率（偏近尾家時洗尾機率上升）
      const qExec = stepIsEvil ? 0.18 : (s === futureLeaders.length - 2 ? 0.42 : 0.25);
      pSuccessFromHere = qExec * pPassIfExec + (1 - qExec) * pSuccessFromHere;
    }
    pPassFlow += wt * pSuccessFromHere;
  }

  const tailNextLeader = nextRoundLeaderId(obs, remainingSteps);
  const tailNextLeaderGood = tailNextLeader ? 1 - (pRed[seatIdx.get(tailNextLeader) ?? 0] ?? 0.4) : 0.5;
  const baseCleanNext = bestCleanProbForRound(dist, nextRound, obs.playerCount);

  const vPassFlow = evaluateTerminalValue91({
    bluePasses: bluePasses + 1,
    redFails,
    nextRound,
    playerCount: obs.playerCount,
    pCleanNext: baseCleanNext,
    nextLeaderGoodProb: tailNextLeaderGood,
    nextLakeGoodProb: lakeGoodProb,
    hasFutureLake,
  });
  const vFailFlow = evaluateTerminalValue91({
    bluePasses,
    redFails: redFails + 1,
    nextRound,
    playerCount: obs.playerCount,
    pCleanNext: baseCleanNext,
    nextLeaderGoodProb: tailNextLeaderGood,
    nextLakeGoodProb: lakeGoodProb,
    hasFutureLake,
  });
  const evReject = pPassFlow * vPassFlow + (1 - pPassFlow) * vFailFlow;

  const diff = evApprove - evReject;
  const onTeam = team.includes(obs.myPlayerId);
  // 以本局勝敗價值落差 `spread` 正規化門檻，確保 0:2 與 2:2 具備一致的決策尺度
  const spread = Math.max(0.08, vPassNow - vFailNow);
  const approveMargin = spread * (cfg.mode === 2 ? (onTeam ? 0.04 : 0.08) : (onTeam ? 0.06 : 0.14));
  const rejectMargin = spread * (cfg.mode === 2 ? (onTeam ? 0.08 : 0.05) : (onTeam ? 0.14 : 0.09));

  if (diff >= approveMargin && !merlinHasSeenRed) {
    round91Stats.voteOverridden++;
    return {
      vote: true,
      evApprove,
      evReject,
      reason: `lookahead91: approve EV ${evApprove.toFixed(3)} > reject EV ${evReject.toFixed(3)}`,
    };
  }
  if (diff <= -rejectMargin) {
    round91Stats.voteOverridden++;
    return {
      vote: false,
      evApprove,
      evReject,
      reason: `lookahead91: reject EV ${evReject.toFixed(3)} > approve EV ${evApprove.toFixed(3)}`,
    };
  }
  return null;
}

// ── Spot 3: Lake of the Lady 2-Ply Lookahead ────────────────────

export interface Lookahead91LakeScore {
  id: string;
  ev: number;
  pGood: number;
  infoGain: number;
  ply2Bonus: number;
}

/**
 * 湖中女神 2 層前瞻選湖：
 * - 嚴格遵守 `INV-PL` 與 `INV-PL2`：派西維爾與「持有相同 knownWizards 資訊的忠臣」走完全相同的計算路徑。
 * - 第 1 層（A0 藍方照實宣告）：展開湖候選人 `c` 為好人／壞人後的條件世界後驗與下一輪最佳隊伍過關率。
 * - 第 2 層（對手拿湖後的潛在反制 vs 藍方信任鏈增益）：
 *   - 若 `c` 為好人且後續還有湖，`c` 將照實執行下一湖（額外資訊增益＋信任鏈保護）；
 *   - 若 `c` 為壞人且後續還有湖，壞人 `c` 取得下一湖可說謊反制（終端價值評估器自然扣分）；
 *   - 若無後續湖或紅方已兩敗，反制權重自然歸零，純粹極大化立即資訊增益與下一輪隊伍清晰度。
 */
export function analyzeLookahead91Lake(
  tuning: Readonly<Partial<AgentTuning>>,
  obs: PlayerObservation,
  candidates: readonly string[],
): Lookahead91LakeScore[] | null {
  const cfg = lookahead91Cfg(tuning);
  if (!cfg || !cfg.lake) return null;
  if (candidates.length === 0) return null;

  // INV-PL2 保證：派西維爾正規化為 loyal（保留 knownWizards），確保行為與同資訊忠臣完全一致
  const lakeView: PlayerObservation = obs.myRole === 'percival'
    ? { ...obs, myRole: 'loyal' }
    : obs;

  const opts = bayesOptionsOf(tuning);
  let dist = getWorldDist(lakeView, opts);
  if (!dist) {
    // 若貝氏層無一致世界，退回 GoodLakeInfo 的 L0 世界（與既有流程對齊）
    const fallback = buildWorlds(lakeView, true, false);
    if (fallback.length === 0) return null;
    const tot = fallback.reduce((s, x) => s + x.w, 0);
    if (!(tot > 0)) return null;
    const idxMap = new Map(lakeView.allPlayerIds.map((id, i) => [id, i]));
    dist = {
      worlds: fallback.map((x) => x.mask),
      wts: fallback.map((x) => x.w / tot),
      bitOf: (id: string): number => {
        const idx = idxMap.get(id);
        return idx === undefined ? 0 : 1 << idx;
      },
      allIds: lakeView.allPlayerIds,
      n: lakeView.allPlayerIds.length,
    };
  }

  round91Stats.lakeChecked++;

  const { bluePasses, redFails } = scoreCounts(obs);
  const round = obs.currentRound ?? 2;
  const nextRound = Math.min(5, round + 1);
  const hasNextLake = anotherLakeFollows(obs);
  const effectiveFutureLake = hasNextLake && redFails < 2;

  const { pRed } = redMarginalsFromDist(dist);
  const seatIdx = new Map(obs.allPlayerIds.map((id, i) => [id, i]));
  const holderIdx = seatIdx.get(obs.myPlayerId) ?? -1;
  const nextLeader = nextRoundLeaderId(obs, 0);
  const nextLeaderGoodProb = nextLeader ? 1 - (pRed[seatIdx.get(nextLeader) ?? 0] ?? 0.4) : 0.5;

  // 已被湖過／持過湖的座位，下一湖不可再選
  const usedSeats = new Set<string>([obs.myPlayerId]);
  for (const l of obs.lakeHistory ?? []) {
    usedSeats.add(l.holderId);
    usedSeats.add(l.targetId);
  }

  const baseUncertainty = pRed.reduce((s, p, i) => (i === holderIdx ? s : s + binaryEntropy(p)), 0);
  const infoWeight = cfg.mode === 2 ? 0.08 : 0.06;

  const scored: Lookahead91LakeScore[] = candidates.map((id) => {
    const idx = seatIdx.get(id);
    if (idx === undefined) {
      return { id, ev: 0, pGood: 0.5, infoGain: 0, ply2Bonus: 0 };
    }
    const bit = 1 << idx;
    const pEvil = pRed[idx];
    const pGood = 1 - pEvil;

    // Ply 1: c 為好人分支
    let vGoodBranch = 0;
    let infoGainGood = 0;
    let ply2Bonus = 0;
    if (pGood > 1e-9) {
      const mGood = redMarginalsFromDist(dist, (w) => (w & bit) === 0);
      const uGood = mGood.pRed.reduce((s, p, i) => (i === holderIdx ? s : s + binaryEntropy(p)), 0);
      infoGainGood = Math.max(0, baseUncertainty - uGood);
      const bestCleanGood = bestCleanProbForRound(dist, nextRound, obs.playerCount, (w) => (w & bit) === 0);

      // Ply 2: 若 c 是好人且後面還有湖，c 成為誠實持湖者，估計 c 下一湖可獲得的最大邊際資訊增益
      if (effectiveFutureLake) {
        let maxNextH = 0;
        for (let j = 0; j < obs.allPlayerIds.length; j++) {
          const otherId = obs.allPlayerIds[j];
          if (otherId === id || usedSeats.has(otherId)) continue;
          const h = binaryEntropy(mGood.pRed[j]);
          if (h > maxNextH) maxNextH = h;
        }
        ply2Bonus = 0.35 * maxNextH;
      }

      vGoodBranch = evaluateTerminalValue91({
        bluePasses,
        redFails,
        nextRound,
        playerCount: obs.playerCount,
        pCleanNext: bestCleanGood,
        nextLeaderGoodProb,
        nextLakeGoodProb: 1.0,
        hasFutureLake: effectiveFutureLake,
      }) + infoWeight * (infoGainGood + ply2Bonus);
    }

    // Ply 1 & 2: c 為壞人分支（A0 立即揭露一紅，但若後面還有湖則壞人拿湖取得反制權）
    let vEvilBranch = 0;
    let infoGainEvil = 0;
    if (pEvil > 1e-9) {
      const mEvil = redMarginalsFromDist(dist, (w) => (w & bit) !== 0);
      const uEvil = mEvil.pRed.reduce((s, p, i) => (i === holderIdx ? s : s + binaryEntropy(p)), 0);
      infoGainEvil = Math.max(0, baseUncertainty - uEvil);
      const bestCleanEvil = bestCleanProbForRound(dist, nextRound, obs.playerCount, (w) => (w & bit) !== 0);

      vEvilBranch = evaluateTerminalValue91({
        bluePasses,
        redFails,
        nextRound,
        playerCount: obs.playerCount,
        pCleanNext: bestCleanEvil,
        nextLeaderGoodProb,
        nextLakeGoodProb: 0.0, // 壞人拿湖 → 下一湖無藍方誠實檢驗且具反制風險
        hasFutureLake: effectiveFutureLake,
      }) + infoWeight * infoGainEvil;
    }

    const ev = pGood * vGoodBranch + pEvil * vEvilBranch;
    const expectedInfoGain = pGood * infoGainGood + pEvil * infoGainEvil;
    return { id, ev, pGood, infoGain: expectedInfoGain, ply2Bonus: pGood * ply2Bonus };
  });

  scored.sort((a, b) => {
    const diff = b.ev - a.ev;
    if (Math.abs(diff) > 1e-9) return diff;
    return (seatIdx.get(a.id) ?? 0) - (seatIdx.get(b.id) ?? 0);
  });

  return scored;
}

/** 湖中女神 2 層前瞻選湖目標；關閉或不適用時回傳 null。 */
export function lookahead91LakeTarget(
  tuning: Readonly<Partial<AgentTuning>>,
  obs: PlayerObservation,
  candidates: readonly string[],
): string | null {
  const scored = analyzeLookahead91Lake(tuning, obs, candidates);
  if (!scored || scored.length === 0) return null;
  round91Stats.lakePicked++;
  return scored[0].id;
}
