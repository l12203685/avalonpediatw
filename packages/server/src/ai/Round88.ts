/**
 * 第 88 回合（藍方・梅林；路線圖 Phase A 第 2 項 `merlinEvWithAssassinationCost`，Issue #215、`docs/ai/NEXT_GEN_AI_ROADMAP.md`）：
 * 梅林當隊長時，把「任務會不會過」和「自己會不會被刺」放進同一個分數，取代一條一條的硬規則：
 *
 *   分數(隊) = log P(三藍 | 派這一隊) + λ × log(1 − P(梅林被刺 | 派這一隊, 公開紀錄))
 *
 * λ = 1 就是 P(三藍) × P(三藍之後沒被刺) = P(藍方贏)。兩個機率都只用梅林當時看得到的東西（公開紀錄＋湖＋他的視野）。
 *
 * **P(梅林被刺)**（`merlinExposure88`）：拿刺客現行預設的世界線（`assassin/WorldLines75.ts`，刺殺時四個紅方開牌相認）當估計器。
 * 梅林看得到三個紅、看不到莫德雷德，也不知道三個紅各是誰：把「三個紅的角色 6 種排法 × 莫德雷德是誰（他自己的後驗最可能的 1–2 個座位）」
 * 每一種當成刺客開牌之後的視角，算世界線「他是梅林」的機率，照假設的權重平均（E）。候選隊只多一個「他當隊長、放了誰」的提議，
 * 票還沒投，所以只有他自己那一項派隊的分數變（`worldLines75LeaderProbe`，便宜）。
 * E 不是刺中率（現在的 E 之後還會被更多動作改），所以用真人局（或機器人局）三藍的局校準：P(被刺) = σ(a + b × logit(E))，
 * 係數在 `CAL_HUMAN`／`CAL_BOT`（`scripts/merlinEvStudy88.ts` 擬合，偶數局擬合、奇數局驗證，Brier／ECE 見 `docs/ai/gap/r88-merlin-ev.md`）。
 *
 * **P(三藍)**（`p3b88`）：這一隊出任務的機率 ρ（強制局 = 1；第 1–4 次提議用 `PROPOSAL_GO_RATE`；位元 8 = 第 1、2 局當成第 5 次，ρ = 1）×
 * [這一隊成功的機率 × 成功之後拿到三藍的機率 + 失敗的機率 × 失敗之後拿到三藍的機率] + (1 − ρ) × 這一隊沒過、下一任隊長派的機率。
 * 這一隊成功：他看得到的紅照那一局要幾張失敗、看不到的只有莫德雷德（他自己的後驗）。之後每一局：好人共同看法裡最乾淨的那幾個人
 * （第 83 回合 (a) 的同一個算法：每一個可能是好人的座位的公開視角，照梅林估的「他是好人」加權）、還沒用的湖讓派錯人的機率乘 0.5，
 * 從比數往下推（`reachProb`）。
 *
 * **候選隊**：坐在他位置、只看公開紀錄的忠臣說得通的隊（第 80 回合的範圍：公開的「這隊沒有紅」≥ 最高的一半、過公開閘門）＋現行這一次會派的隊。
 * 乾淨的隊（沒有他看得到的紅）也要過他自己的閘門與投票規則；帶一個看得到的紅的隊（看公開分數前 3 支）要過站長 11/26 的兩個條件
 * （第 83 回合的門檻 (a)、(b)），而且在不變量已經登記的例外裡：第 1、2 局非強制（派拇指躲刺，`doomedProposal`），或第 83 回合的範圍
 * （`gatedThumb83Exempt`）。所以 INV-M1／INV-T1 照舊是 0；強制局不帶（位元 16 兩樣都不看，研究用）。分數一樣時照舊（現行的那一支）。
 *
 * `merlinEvAssassin88 = λ`（0 = 關）；`merlinEvScope88`（位元，0 = 2）：1 = 第 1、2 局非強制；2 = 第 3、4 局非強制；4 = 強制局；
 * 8 = 第 1、2 局非強制當成第 5 次（ρ = 1）；16 = 帶看得到的紅不看第 83 回合的門檻（研究用）；32 = 只在乾淨的隊之間挑；64 = 用機器人局的校準。
 * 範圍內的第 3、4 局，第 83 回合的有條件拇指變成這裡的一個特例（`ForwardAgent` 不再另外走第 83 回合那一步）。
 *
 * A0（好人持湖說實話）、A1（紅方已兩勝必出失敗）不相干：只改梅林自己當隊長的提議。開關關時這個檔案不改任何決定（逐局相同）。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesRedShare, type BayesOptions } from './belief/BayesBelief';
import { merlinPublicScoring } from './MerlinLoyalStyle';
import { doomedProposal } from './MerlinCover';
import { PROPOSAL_GO_RATE } from './BlueRound37';
import { loyalFree80Set } from './Round80';
import { gatedThumb83Config, gatedThumb83Eval, gatedThumb83Exempt, gatedThumb83Passes, goodSideShares, lakesBefore, reachProb } from './Round83';
import { worldLines75LeaderProbe } from './assassin/WorldLines75';
import { worldLineTables75 } from './Round75';

/** 校準：P(被刺 | 三藍) = σ(a + b × logit(E))。真人局（強弱都算）三藍的局、梅林當隊長的每一個提議（`merlinEvStudy88.ts`）。 */
export const CAL_HUMAN = { a: 0.667, b: 0.801 } as const;
/** 同上，機器人局（現行預設、世界線刺客）。 */
export const CAL_BOT = { a: 1.862, b: 2.194 } as const;

/** 診斷計數（研究腳本、自我對打的拆解用；不影響決策）。 */
export const round88Stats = { applies: 0, cands: 0, changed: 0, toThumb: 0, fromThumb: 0, thumbEval: 0, thumbOk: 0, sumDeltaE: 0 };

const MORDRED_COVER = 0.8;
const MORDRED_MAX = 2;
const THUMB_TOP = 3;
const PERMS: readonly (readonly [number, number, number])[] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

const logit = (p: number): number => Math.log(Math.max(p, 1e-9) / Math.max(1 - p, 1e-9));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** 刺殺機率的校準。 */
export function assassinatedProb88(e: number, bot: boolean): number {
  const c = bot ? CAL_BOT : CAL_HUMAN;
  return sigmoid(c.a + c.b * logit(e));
}

/** 梅林自己的後驗裡，看不到的座位各自是莫德雷德的機率（加起來 = 1；只有莫德雷德看不到）。 */
export function mordredDist88(obs: PlayerObservation, own: ReadonlyMap<string, number>): Map<string, number> {
  const me = obs.myPlayerId;
  const seen = new Set(obs.knownEvils);
  const unseen = obs.allPlayerIds.filter((id) => id !== me && !seen.has(id));
  const out = new Map<string, number>();
  let tot = 0;
  for (const id of unseen) { const v = Math.max(own.get(id) ?? 0, 1e-6); out.set(id, v); tot += v; }
  for (const id of unseen) out.set(id, (out.get(id) ?? 0) / tot);
  return out;
}

export interface Exposure88 {
  /** 現在的紀錄上，刺客的世界線認他是梅林的機率（梅林的估計）。 */
  base: number;
  /** 每一支候選隊：多接這一個提議之後的同一個機率。 */
  after: number[];
}

/**
 * P(刺客的世界線認我是梅林)，梅林的估計（三個看得到的紅的角色排法 × 莫德雷德的假設平均）。不是 10 人局、看得到的紅不是 3 個時 null。
 */
export function merlinExposure88(obs: PlayerObservation, teams: readonly (readonly string[])[], own: ReadonlyMap<string, number>): Exposure88 | null {
  if (obs.myRole !== 'merlin' || obs.playerCount !== 10 || obs.allPlayerIds.length !== 10) return null;
  const me = obs.myPlayerId;
  const seen = obs.knownEvils.filter((id) => id !== me);
  if (seen.length !== 3) return null;
  const dist = [...mordredDist88(obs, own).entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  const picks: [string, number][] = [];
  let cover = 0;
  for (const [id, w] of dist) {
    if (picks.length >= MORDRED_MAX || (picks.length > 0 && cover >= MORDRED_COVER)) break;
    picks.push([id, w]);
    cover += w;
  }
  const tables = worldLineTables75();
  let wsum = 0;
  let base = 0;
  const after = teams.map(() => 0);
  for (const [d, wd] of picks) {
    for (const [ia, im, io] of PERMS) {
      const roles: Record<string, string> = { [seen[ia]]: 'assassin', [seen[im]]: 'morgana', [seen[io]]: 'oberon', [d]: 'mordred' };
      const hyp = { ...obs, allEvilRoles: roles } as PlayerObservation;
      const pr = worldLines75LeaderProbe(hyp, me, teams, tables);
      if (!pr) continue;
      const w = wd / PERMS.length;
      wsum += w;
      base += w * Math.exp(pr.base);
      pr.after.forEach((v, i) => { after[i] += w * Math.exp(v); });
    }
  }
  if (!(wsum > 0)) return null;
  return { base: base / wsum, after: after.map((v) => v / wsum) };
}

export interface P3B88 {
  /** 這一次提議出任務的機率。 */
  rho: number;
  /** 這一隊成功之後／失敗之後／沒出任務（下一任隊長派）拿到三藍的機率。 */
  vSucc: number;
  vFail: number;
  vNone: number;
}

/** P(三藍) 的三個分支（和候選隊無關的部分；`succ88` 給這一隊成功的機率）。 */
export function p3bParts88(tuning: Readonly<AgentTuning>, obs: PlayerObservation, own: ReadonlyMap<string, number>, pubOpts: Readonly<BayesOptions>, likeForced: boolean): P3B88 | null {
  const cfg = AVALON_CONFIG[obs.playerCount];
  if (!cfg) return null;
  const round = obs.currentRound ?? 1;
  const fc = obs.failCount ?? 0;
  const fails = obs.questResults.filter((r) => r === 'fail').length;
  const succ = obs.questResults.length - fails;
  if (fails >= 3 || succ >= 3) return null;
  const me = obs.myPlayerId;
  const seen = new Set(obs.knownEvils);
  const mord = mordredDist88(obs, own);
  const shares = goodSideShares(obs, obs, pubOpts, own);
  const order = [...obs.allPlayerIds].sort((x, y) => (shares.get(x) ?? 0) - (shares.get(y) ?? 0) || (x < y ? -1 : 1));
  const lake = gatedThumb83Config(tuning).lake;
  const pRound = (m: number): number => {
    const size = cfg.questTeams[m - 1];
    const need = cfg.questFailsRequired[m - 1] ?? 1;
    const top = order.slice(0, size);
    const clean = succ88(top, need, seen, mord, me);
    return 1 - (1 - clean) * Math.pow(1 - lake, lakesBefore(obs, round, m));
  };
  const fut: number[] = [];
  for (let m = round + 1; m <= cfg.questTeams.length; m++) fut.push(pRound(m));
  const vSucc = succ + 1 >= 3 ? 1 : reachProb(fut, 3 - (succ + 1), 2 - fails);
  const vFail = fails + 1 >= 3 ? 0 : reachProb(fut, 3 - succ, 2 - (fails + 1));
  const vNone = reachProb([pRound(round), ...fut], 3 - succ, 2 - fails);
  const rho = fc >= 4 || likeForced ? 1 : (PROPOSAL_GO_RATE[round]?.[fc] ?? 0.3);
  return { rho, vSucc, vFail, vNone };
}

/** 這一隊（梅林的視角）成功的機率：看得到的紅照那一局要幾張失敗，看不到的只有莫德雷德。 */
export function succ88(team: readonly string[], need: number, seen: ReadonlySet<string>, mord: ReadonlyMap<string, number>, me: string): number {
  const visible = team.filter((id) => seen.has(id)).length;
  if (visible >= need) return 0;
  if (need - visible >= 2) return 1;
  let pm = 0;
  for (const id of team) if (id !== me && !seen.has(id)) pm += mord.get(id) ?? 0;
  return Math.max(0, 1 - pm);
}

export function p3b88(parts: P3B88, pSucc: number): number {
  return parts.rho * (pSucc * parts.vSucc + (1 - pSucc) * parts.vFail) + (1 - parts.rho) * parts.vNone;
}

/** 範圍（不含 λ）。 */
export function ev88InScope(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation): boolean {
  if (obs.myRole !== 'merlin' || obs.gamePhase !== 'team_select' || obs.playerCount !== 10) return false;
  if (obs.publicLoyalView === true) return false;
  const raw = tuning.merlinEvScope88 ?? 0;
  const bits = raw === 0 ? 2 : raw;
  const round = obs.currentRound ?? 1;
  const fc = obs.failCount ?? 0;
  const fails = obs.questResults.filter((r) => r === 'fail').length;
  const succ = obs.questResults.length - fails;
  if (fails >= 3 || succ >= 3) return false;
  if (fc >= 4) return (bits & 4) !== 0;
  if (round <= 2) return (bits & (1 | 8)) !== 0;
  if (round <= 4) return (bits & 2) !== 0;
  return false;
}

export function ev88Applies(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation): boolean {
  return (tuning.merlinEvAssassin88 ?? 0) > 0 && ev88InScope(tuning, obs);
}

const keyOf = (team: readonly string[]): string => [...team].sort().join(',');

export interface Ev88Cand { team: readonly string[]; thumbs: number; pSucc: number; p3b: number; e: number; pa: number; score: number; cur: boolean }

/**
 * `merlinEvAssassin88` 的挑法：`cur` = 現行這一次會派的隊；`allowed` = 他自己的閘門與投票規則；`publicAllowed` = 公開視角的邏輯閘門；
 * `barred` = 他不放的人（第 54 回合擋的看得到的紅、他自己確定但看不到的紅、湖的規則擋下的人）。回傳要派的隊（不改就是 `cur` 本身）。
 * `trace` 給的話，每一支候選隊的分數放進去（研究腳本用）。
 */
export function ev88Team(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  cur: readonly string[],
  allowed: (team: readonly string[]) => boolean,
  publicAllowed: (team: readonly string[]) => boolean,
  barred: readonly string[],
  trace?: Ev88Cand[],
): readonly string[] {
  if (cur.length === 0 || !ev88Applies(tuning, obs)) return cur;
  const lambda = tuning.merlinEvAssassin88 ?? 0;
  const raw = tuning.merlinEvScope88 ?? 0;
  const bits = raw === 0 ? 2 : raw;
  const seen = new Set(obs.knownEvils);
  const me = obs.myPlayerId;
  const set = loyalFree80Set(tuning, obs, cur.length, 0.5, publicAllowed, barred);
  if (!set) return cur;
  round88Stats.applies++;
  const curKey = keyOf(cur);
  const plausible = set.teams.filter((t) => t.plausible && t.publicOk);
  const pool: { team: readonly string[]; thumbs: number; cur: boolean }[] = [{ team: cur, thumbs: cur.filter((id) => seen.has(id)).length, cur: true }];
  for (const t of plausible) {
    if (keyOf(t.team) === curKey || t.thumbs !== 0 || !allowed(t.team)) continue;
    pool.push({ team: t.team, thumbs: 0, cur: false });
  }
  if ((bits & 32) === 0) {
    // 帶一個看得到的紅：站長 11/26 的兩個條件（第 83 回合的門檻）要過，而且不變量已經登記了例外——第 1、2 局非強制（派拇指躲刺）
    // 或第 83 回合的範圍（`gatedThumb83Exempt`）。位元 16（研究用）兩樣都不看。
    const doomed = doomedProposal(obs);
    const ungated = (bits & 16) !== 0;
    const thumbs = plausible.filter((t) => t.thumbs === 1 && keyOf(t.team) !== curKey).sort((a, b) => b.score - a.score);
    const cfg83 = gatedThumb83Config(tuning);
    for (const t of ungated ? thumbs : thumbs.slice(0, THUMB_TOP)) {
      if (!ungated) {
        round88Stats.thumbEval++;
        if (doomed) {
          const ev = gatedThumb83Eval(tuning, obs, t.team);
          if (!ev || !gatedThumb83Passes(ev, cfg83)) continue;
        } else if (!gatedThumb83Exempt(tuning, obs, t.team)) continue;
        round88Stats.thumbOk++;
      }
      pool.push({ team: t.team, thumbs: 1, cur: false });
    }
  }
  if (pool.length <= 1) return cur;
  const ownOpts = bayesOptionsOf(tuning);
  const own = bayesRedShare(obs, ownOpts);
  const pubOpts = merlinPublicScoring(tuning, obs).pubOpts;
  const likeForced = (bits & 8) !== 0 && (obs.currentRound ?? 1) <= 2;
  const parts = p3bParts88(tuning, obs, own, pubOpts, likeForced);
  if (!parts) return cur;
  const exp = merlinExposure88(obs, pool.map((c) => c.team), own);
  if (!exp) return cur;
  const cfg = AVALON_CONFIG[obs.playerCount];
  const need = cfg?.questFailsRequired[(obs.currentRound ?? 1) - 1] ?? 1;
  const mord = mordredDist88(obs, own);
  const bot = (bits & 64) !== 0;
  round88Stats.cands += pool.length;
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  const scored: Ev88Cand[] = pool.map((c, i) => {
    const pSucc = succ88(c.team, need, seen, mord, me);
    const p3b = p3b88(parts, pSucc);
    const e = exp.after[i];
    const pa = assassinatedProb88(e, bot);
    const score = Math.log(Math.max(p3b, 1e-9)) + lambda * Math.log(Math.max(1 - pa, 1e-9));
    return { team: c.team, thumbs: c.thumbs, pSucc, p3b, e, pa, score, cur: c.cur };
  });
  scored.forEach((c, i) => {
    if (c.score > bestScore + 1e-12) { bestScore = c.score; best = i; }
  });
  if (trace) trace.push(...scored);
  if (best <= 0) return cur;
  const pick = scored[best];
  round88Stats.changed++;
  round88Stats.sumDeltaE += pick.e - scored[0].e;
  if (pick.thumbs > 0) round88Stats.toThumb++;
  if (scored[0].thumbs > 0) round88Stats.fromThumb++;
  return pick.team;
}
