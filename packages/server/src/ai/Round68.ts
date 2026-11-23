/**
 * 第 68 回合（藍方）：人類 PR 量尺逐決策拆到藍方局面格（`scripts/blueSideStudy68.ts`＋`.py`），第 56–67 回合沒做過的最大兩格。
 *
 * 1. **藍方持湖的目標**（量尺 −2.67 ± 0.23 pp／局，藍方負的格子裡最大；忠臣 −1.89、派西 −0.64、梅林 −0.13）。
 *    同一批真人持湖點，機器人湖「出過有失敗牌的任務的人」比真人多（第 2 湖 1-1：65% vs 44%），湖「沒出過失敗任務的藍方」比真人少（29% vs 46%）。
 *    裁判的表（同局面）裡湖到沒出過失敗任務的藍方 +5～+11pp、湖到出過失敗任務的紅 −13～−19pp：被湖的人拿下一次湖（湖中鏈），而且
 *    湖一個已經被任務結果點過的人，資訊多半是重複的。
 *    `lakeChain68 = w`（0 = 關）：`goodLakeInfoMax` 的湖中分數，對出過有失敗牌的任務的候選人扣 w ×（最好的資訊量 V）；
 *    `lakeChain68Good = g`：再加 g ×（1 − 2·P(紅)）× V（信任鏈那一項再加權）。
 *    `lakeChain68Scope`（位元；0 = 1）：1 = 後面還有湖、紅方還沒兩勝（現行的信任鏈本來就開的局面）；
 *    2 = 紅方已兩勝或最後一湖——**Edward 10/13 與專案負責人 11/12「紅方已兩勝只看資訊」的範圍，改它要站長決定，只量**。
 *    `lakeChain68Roles`（位元；0 = 3）：1 = 忠臣、2 = 派西（派西持湖 = 帶著拇指事實的忠臣，INV-PL2）、4 = 梅林。
 *    `lakeChain68Mix = p`（0 = 一律）：第 1C 節，照局面雜湊 < p 才用。
 *    同分照原本（座位序）；候選照現行的湖規則過濾（`goodLakeHumanPool`）。第 51 回合 `lakeUntainted51` 是同一個方向、不分局面的版本。
 *
 * 2. **任務牌模型分比分**（第 5 局 2-2、第 4 局成功之後的藍隊長：量尺 −0.51 ± 0.14 pp／局，機器人的隊會失敗 50% vs 真人 34%、
 *    整隊照派第 4 局的隊 35% vs 24%）。原因在信念：任務牌的概似 P(失敗張數 | 第幾局, 隊上紅數) 不分比分，但真人局（`games_cache.json` 10 人局）
 *    第 4 局（要兩張失敗）隊上只有一個紅時，紅方已兩勝（2-1）藏牌 91%（261／288），紅方一勝（1-2）只藏 21%（53／258）；第 3 局紅方已兩勝（2-0）
 *    一個紅幾乎都出失敗（375／379）。混在一起的表把「2-1 第 4 局零張失敗」讀得太乾淨，所以第 5 局照派第 4 局的隊。
 *    `missionScore68`（位元；0 = 關）：藍方座位的任務概似乘上真人的「同局、同紅數、紅方已兩勝與否」比例 P_h(f | 局, 已兩勝, k) ÷ P_h(f | 局, k)
 *    （各 +1 平滑、在 0..k 重新正規化；同第 56 回合 `missionRole56` 的做法，兩個可以一起開）。1 = 第 4 局、2 = 第 3 局。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { AVALON_CONFIG } from '@avalon/shared';

// ── 1. 藍方持湖 ───────────────────────────────────────────

/** 診斷計數（研究腳本用；不影響決策）。 */
export const round68Stats = { lakeChecked: 0, lakeChanged: 0 };

function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/** 這一湖是不是信任鏈的局面（後面還有湖、紅方還沒兩勝）。 */
export function lakeTrustRegime68(obs: PlayerObservation): boolean {
  // 同 `GoodLakeInfo.anotherLakeFollows`（湖在第 2 局到倒數第 2 局之後）；這裡不 import 它，避免 BayesBelief → Round68 → GoodLakeInfo 的循環。
  const rounds = AVALON_CONFIG[obs.playerCount]?.questTeams.length ?? 5;
  return obs.currentRound + 2 <= rounds && obs.questResults.filter((r) => r === 'fail').length < 2;
}

/** 出過有失敗牌的任務的座位（照張數讀：第 4 局一張失敗的成功任務也算；只用公開的任務紀錄）。 */
export function taintedSeats68(obs: PlayerObservation): Set<string> {
  return new Set(obs.questHistory.filter((q) => (q.failCount ?? 0) > 0).flatMap((q) => q.team));
}

/**
 * `lakeChain68` 的挑法；不適用回 null（呼叫端照原本）。`analyze` = `GoodLakeInfo.analyzeGoodLake`（傳進來，測試可以換）。
 */
export function lakeChain68Pick(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  pool: readonly string[],
  analyze: (obs: PlayerObservation, candidates: readonly string[]) => { candidates: ReadonlyArray<{ id: string; score: number; infoGain: number; pEvil: number }> } | null,
): string | null {
  const w = tuning.lakeChain68 ?? 0;
  const g = tuning.lakeChain68Good ?? 0;
  if (!(w > 0) && !(g > 0)) return null;
  if (obs.myTeam !== 'good' || pool.length === 0) return null;
  const roles = (tuning.lakeChain68Roles ?? 0) || 3;
  const bit = obs.myRole === 'loyal' ? 1 : obs.myRole === 'percival' ? 2 : obs.myRole === 'merlin' ? 4 : 0;
  if ((roles & bit) === 0) return null;
  const scope = (tuning.lakeChain68Scope ?? 0) || 1;
  const trust = lakeTrustRegime68(obs);
  if (!((trust && (scope & 1) !== 0) || (!trust && (scope & 2) !== 0))) return null;
  // 第 1C 節「中性改測 50%」：照局面雜湊（持湖者、第幾局、候選）< p 才用，同一局面每次一樣。0 = 一律。
  const mix = tuning.lakeChain68Mix ?? 0;
  if (mix > 0 && hash01(`${obs.myPlayerId}|${obs.currentRound}|${[...pool].sort().join(',')}|lake68`) >= mix) return null;
  const an = analyze(obs, pool);
  if (!an || an.candidates.length === 0) return null;
  round68Stats.lakeChecked++;
  const tainted = taintedSeats68(obs);
  const value = Math.max(0, ...an.candidates.map((c) => c.infoGain));
  const order = new Map(obs.allPlayerIds.map((id, i) => [id, i]));
  const rank = (adj: boolean): Array<{ id: string; s: number }> => an.candidates
    .map((c) => ({ id: c.id, s: c.score + (adj ? g * (1 - 2 * c.pEvil) * value - (tainted.has(c.id) ? w * value : 0) : 0) }))
    .sort((a, b) => (Math.abs(b.s - a.s) > 1e-9 ? b.s - a.s : (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)));
  const pick = rank(true)[0]?.id ?? null;
  if (pick !== null && pick !== rank(false)[0]?.id) round68Stats.lakeChanged++;
  return pick;
}

// ── 2. 任務牌模型分比分 ────────────────────────────────────

/**
 * 真人 10 人局（`games_cache.json`，嚴格重播 2,250 局；本回合 `scripts/blueSideStudy68.ts` 同一批）任務的失敗張數，
 * 依 `局|紅方開局前已兩勝(1/0)|隊上紅數`（索引 = 失敗張數）。第 5 局一定是 2-2（不分），第 1、2 局紅方不可能已兩勝。
 */
export const MISSION_SCORE_68: Readonly<Record<string, readonly number[]>> = {
  '3|1|1': [4, 375],
  '3|1|2': [0, 39, 112],
  '3|1|3': [0, 3, 0, 43],
  '3|1|4': [0, 3, 0, 94],
  '3|0|1': [45, 339],
  '3|0|2': [30, 131, 52],
  '3|0|3': [9, 20, 11, 2],
  '3|0|4': [0, 0, 1, 0],
  '4|1|1': [261, 27],
  '4|1|2': [35, 13, 66],
  '4|1|3': [0, 0, 14, 32],
  '4|1|4': [0, 0, 0, 36],
  '4|0|1': [53, 205],
  '4|0|2': [1, 6, 49],
  '4|0|3': [0, 1, 8, 5],
  '4|0|4': [0, 0, 0, 3],
};

/** `missionScore68` 在這一局適用嗎（位元 1 = 第 4 局、2 = 第 3 局）。 */
export function missionScoreApplies68(bits: number, round: number): boolean {
  return (round === 4 && (bits & 1) !== 0) || (round === 3 && (bits & 2) !== 0);
}

/**
 * 分比分的任務概似：base(f) × P_h(f | 局, 已兩勝, k) ÷ P_h(f | 局, k)，在 f ∈ 0..k 重新正規化。表裡沒有這一格就回 base(fails)。
 * `base` = 原本的任務概似（混合表，或第 56 回合分奧伯倫的版本）。
 */
export function missionProbScore68(round: number, redAtTwo: boolean, reds: number, fails: number, base: (f: number) => number): number {
  if (fails > reds) return 0;
  const a = MISSION_SCORE_68[`${round}|${redAtTwo ? 1 : 0}|${reds}`];
  const b = MISSION_SCORE_68[`${round}|${redAtTwo ? 0 : 1}|${reds}`];
  if (!a || reds === 0) return base(fails);
  const k = reds + 1;
  const na = a.reduce((x, y) => x + y, 0);
  const nb = b ? b.reduce((x, y) => x + y, 0) : 0;
  let tot = 0;
  let mine = 0;
  for (let f = 0; f <= reds; f++) {
    const pa = ((a[f] ?? 0) + 1) / (na + k);
    const pm = ((a[f] ?? 0) + (b ? b[f] ?? 0 : 0) + 1) / (na + nb + k);
    const x = base(f) * (pa / pm);
    tot += x;
    if (f === fails) mine = x;
  }
  return tot > 0 ? mine / tot : 0;
}
