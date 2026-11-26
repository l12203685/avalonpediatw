/**
 * 第 83 回合（藍方・梅林）：站長 2026-11-26 對第 82 回合「梅林偶爾帶一個看得到的紅」的裁定（原話）：
 *
 * > 82的梅林 如果依局勢判斷 有機會靠著任務加湖中找到五好 並且自己能被好人認下 那就可以派拇指 並且導向任務三藍並躲刺
 *
 * 只在下面兩件事**同時**成立時，梅林可以在自己的提議裡放一個他看得到的紅（拇指）；兩件事都只用梅林當時看得到的東西算（公開紀錄＋湖＋他的視野）：
 *
 * (a) **任務＋湖還找得到五好**（`pathProb`）：假設這一隊出任務、出一張失敗（最壞的情況），之後好人還有多大機會拿到三次成功。
 *     1. 在公開紀錄後面接上「這一隊被通過、出了一張失敗」，用每一個好人座位的公開視角（自己是好人、只看公開紀錄）算每個人是紅的機率，
 *        按梅林估的「這個座位是好人」加權平均 → 好人那一側的共同看法。
 *     2. 之後每一局，好人會派共同看法裡最乾淨的那幾個人（那一局的人數）。這隊真的會成功的機率用梅林自己的視野算：
 *        有他看得到的紅就看那局要幾張失敗，看不到的紅（莫德雷德）用他自己的後驗。
 *     3. 那一局之前還會有幾次湖（第 2、3、4 局任務之後各一次、還沒用過的），每一次湖讓「派錯人」的機率乘上 (1 − λ)（`merlinGatedThumbLake83`，預設 0.5）。
 *     4. 從這一局之後的比數往下推：還要幾次成功、還能失敗幾次 → 好人先拿到三次成功的機率。
 * (b) **梅林自己能被好人認下**（`trustAfter`）：同一個「出了一張失敗」之後的紀錄上，其他好人座位（公開視角）平均認為梅林是好人的機率；
 *     或者他被湖過、宣告是好人、持湖的人不是他看得到的紅（`lakeCert`）。
 *
 * `merlinGatedThumb83 = q`（0–1，0 = 關）：梅林當隊長、範圍內（預設第 3、4 局非強制）、這一次他本來要派的隊沒有看得到的紅時，以比例 q
 * （照座位、局、第幾次提議雜湊）在「坐在他位置、只看公開紀錄的忠臣說得通的隊」（第 80 回合的範圍，公開的「這隊沒有紅」≥ 最高的一半）裡，
 * 照公開分數由高到低找**剛好帶一個看得到的紅**、而且 (a)、(b) 都過門檻的那一支。找不到就照舊。
 *   - `merlinGatedThumbA83`：(a) 的門檻（0 = 預設 `GATE_A_DEFAULT`）；`merlinGatedThumbB83`：(b) 的門檻（0 = 預設 `GATE_B_DEFAULT`）。
 *   - `merlinGatedThumbScope83`（位元）：1 = 第 2 局也做；2 = 強制局（第 5 次提議）也做；4 = 只有第 1–3 次提議；8 = 一局最多一次（之前第 2 局起已經派過看得到的紅就不做）。
 * 範圍外、門檻外照舊（INV-M1／INV-T1 在門檻外照樣是 0；門檻內是登記的例外，`gatedThumb83Exempt`）。
 * A0（好人持湖說實話）、A1（紅方已兩勝必出失敗）不相干：只改梅林自己當隊長的提議，紅方已兩勝時 (a) 一定是 0。開關關時逐局相同。
 *
 * 第 83 回合採用：基準線（機器人互打）`merlinGatedThumb83 = 1`、門檻用預設（a 0.5、b 0.6、λ 0.5）；三種真人桌明寫 0（人類 PR 量尺梅林每一層兩半都是負的）。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesRedShare, bayesTeamRedsBelow, type BayesOptions } from './belief/BayesBelief';
import { merlinPublicScoring } from './MerlinLoyalStyle';
import { loyalFree80Set } from './Round80';

/** (a) 的預設門檻：「出了一張失敗之後好人還拿得到三次成功」的機率（真人局校準，第 83 回合第 1 節）。 */
export const GATE_A_DEFAULT = 0.5;
/** (b) 的預設門檻：其他好人座位平均認為梅林是好人的機率（真人局校準，第 83 回合第 1 節）。 */
export const GATE_B_DEFAULT = 0.6;
/** 每一次還沒用的湖讓「派錯人」的機率乘上 (1 − λ) 的 λ 預設值。 */
export const GATE_LAKE_DEFAULT = 0.5;

/** 診斷計數（研究腳本用；不影響決策）。 */
export const round83Stats = { applies: 0, rolled: 0, evaluated: 0, gateA: 0, gateB: 0, thumbed: 0, noTeam: 0 };

function hash01(key: string): number {
  let h = 0x811c9dc5;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

export interface GatedThumb83Eval {
  /** (a)：假設這一隊出了一張失敗，好人之後拿到三次成功的機率。 */
  pathProb: number;
  /** (b)：現在其他好人座位平均認為梅林是好人的機率（只回報）。 */
  trustNow: number;
  /** (b)：同一個「出了一張失敗」之後，其他好人座位平均認為梅林是好人的機率。 */
  trustAfter: number;
  /** 梅林被湖過、宣告好人、持湖的人不是他看得到的紅。 */
  lakeCert: boolean;
  /** 之後好人共同看法裡最乾淨、人數最多那一局的隊上，梅林看得到的紅有幾個（只回報）。 */
  topReds: number;
}

export interface GatedThumb83Config { a: number; b: number; lake: number }

export function gatedThumb83Config(tuning: Readonly<Partial<AgentTuning>>): GatedThumb83Config {
  const a = tuning.merlinGatedThumbA83 ?? 0;
  const b = tuning.merlinGatedThumbB83 ?? 0;
  const lake = tuning.merlinGatedThumbLake83 ?? 0;
  return { a: a > 0 ? a : GATE_A_DEFAULT, b: b > 0 ? b : GATE_B_DEFAULT, lake: lake > 0 ? lake : GATE_LAKE_DEFAULT };
}

/** 兩個門檻都過（(b) 也可以由湖認下）。 */
export function gatedThumb83Passes(ev: GatedThumb83Eval, cfg: GatedThumb83Config): boolean {
  return ev.pathProb >= cfg.a && (ev.lakeCert || ev.trustAfter >= cfg.b);
}

/** 這一局之後還會有的湖（第 2、3、4 局任務之後各一次）裡，排在第 `m` 局任務之前的有幾次。 */
function lakesBefore(obs: PlayerObservation, round: number, m: number): number {
  if (obs.playerCount < 7) return 0;
  // 第 3 局起還沒有任何湖的紀錄 = 這一局沒有開湖（真人局可以關湖）。
  if (round >= 3 && (obs.lakeHistory?.length ?? 0) === 0) return 0;
  let n = 0;
  for (let j = round; j <= m - 1; j++) if (j >= 2 && j <= 4) n++;
  return n;
}

/** 在公開紀錄後面接上「這一隊被通過、出了一張失敗」（梅林當隊長的這一次提議）。 */
function afterFail(obs: PlayerObservation, team: readonly string[]): PlayerObservation {
  const round = obs.currentRound ?? 1;
  return {
    ...obs,
    currentRound: round + 1,
    failCount: 0,
    questResults: [...obs.questResults, 'fail'],
    questHistory: [...obs.questHistory, { round, team: [...team], result: 'fail', failCount: 1 }],
    voteHistory: [...obs.voteHistory, { round, attempt: (obs.failCount ?? 0) + 1, leader: obs.myPlayerId, team: [...team], approved: true, votes: {} }],
    proposedTeam: [],
    gamePhase: 'team_select',
  };
}

/** 坐在 `seat`、只看公開紀錄的好人視角（`merlinPublicScoring` 的公開視角，換一個座位）。 */
function seatView(obs: PlayerObservation, seat: string): PlayerObservation {
  return {
    ...obs, myPlayerId: seat, myRole: 'loyal', myTeam: 'good', seatTeam: 'good', knownEvils: [], knownWizards: undefined,
    allEvilIds: undefined, allEvilRoles: undefined, myLakeResults: [], publicLoyalView: true,
  } as PlayerObservation;
}

/** 好人那一側的共同看法：每一個可能是好人的座位（梅林看得到的紅以外）的公開視角，照梅林估的「他是好人」加權，每個人是紅的平均機率。 */
function goodSideShares(obs: PlayerObservation, rec: PlayerObservation, pubOpts: Readonly<BayesOptions>, own: ReadonlyMap<string, number>): Map<string, number> {
  const me = obs.myPlayerId;
  const seen = new Set(obs.knownEvils);
  const acc = new Map<string, number>(obs.allPlayerIds.map((id) => [id, 0]));
  let wsum = 0;
  for (const g of obs.allPlayerIds) {
    if (g === me || seen.has(g)) continue;
    const w = 1 - (own.get(g) ?? 0);
    if (!(w > 1e-9)) continue;
    const share = bayesRedShare(seatView(rec, g), pubOpts);
    for (const id of obs.allPlayerIds) acc.set(id, (acc.get(id) ?? 0) + w * (share.get(id) ?? 0.5));
    wsum += w;
  }
  if (wsum > 0) for (const id of obs.allPlayerIds) acc.set(id, (acc.get(id) ?? 0) / wsum);
  return acc;
}

/** 好人先拿到 `need` 次成功（還能再失敗 `slack` 次）的機率；`p[i]` = 之後第 i 局成功的機率。 */
export function reachProb(p: readonly number[], need: number, slack: number): number {
  const go = (i: number, n: number, s: number): number => {
    if (n <= 0) return 1;
    if (s < 0 || i >= p.length) return 0;
    return p[i] * go(i + 1, n - 1, s) + (1 - p[i]) * go(i + 1, n, s - 1);
  };
  return go(0, need, slack);
}

/**
 * (a)、(b) 的量（梅林的視角；`team` = 帶拇指的那一支）。紅方已兩勝、或不是梅林時 null。
 * `pubOpts`／`ownOpts` 不給就照 `tuning` 算（同梅林挑隊用的公開視角、他自己的讀法）。
 */
export function gatedThumb83Eval(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  team: readonly string[],
  opts: { pubOpts?: BayesOptions; ownOpts?: BayesOptions } = {},
): GatedThumb83Eval | null {
  if (obs.myRole !== 'merlin') return null;
  const cfg = AVALON_CONFIG[obs.playerCount];
  if (!cfg) return null;
  const round = obs.currentRound ?? 1;
  const fails = obs.questResults.filter((r) => r === 'fail').length;
  const succ = obs.questResults.length - fails;
  if (fails >= 2) return null;
  const me = obs.myPlayerId;
  const seen = new Set(obs.knownEvils);
  const pubOpts = opts.pubOpts ?? merlinPublicScoring(tuning, obs).pubOpts;
  const ownOpts = opts.ownOpts ?? bayesOptionsOf(tuning);
  const own = bayesRedShare(obs, ownOpts);
  const rec = afterFail(obs, team);
  const shares = goodSideShares(obs, rec, pubOpts, own);
  const nowShares = goodSideShares(obs, obs, pubOpts, own);
  const trustAfter = 1 - (shares.get(me) ?? 0.5);
  const trustNow = 1 - (nowShares.get(me) ?? 0.5);
  const lakeCert = (obs.lakeHistory ?? []).some((l) => l.targetId === me && l.declaredClaim === 'good' && !seen.has(l.holderId));
  // 之後每一局：好人共同看法裡最乾淨的那幾個人；成功的機率用梅林自己的視野。
  const order = [...obs.allPlayerIds].sort((x, y) => (shares.get(x) ?? 0) - (shares.get(y) ?? 0) || (x < y ? -1 : 1));
  const p: number[] = [];
  let topReds = 0;
  let biggest = 0;
  for (let m = round + 1; m <= cfg.questTeams.length; m++) {
    const size = cfg.questTeams[m - 1];
    const need = cfg.questFailsRequired[m - 1] ?? 1;
    const top = order.slice(0, size);
    const visible = top.filter((id) => seen.has(id)).length;
    if (size >= biggest) { biggest = size; topReds = visible; }
    const unseen = top.filter((id) => id !== me && !seen.has(id));
    const clean = visible >= need ? 0 : (bayesTeamRedsBelow(obs, unseen, need - visible, ownOpts) ?? 0);
    const lakes = lakesBefore(obs, round, m);
    p.push(1 - (1 - clean) * Math.pow(1 - gatedThumb83Config(tuning).lake, lakes));
  }
  const pathProb = reachProb(p, 3 - succ, 2 - (fails + 1));
  return { pathProb, trustNow, trustAfter, lakeCert, topReds };
}

/** 這一次梅林的提議在不在 `merlinGatedThumb83` 的範圍裡（不含比例、不含門檻）。 */
export function gatedThumb83InScope(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation): boolean {
  if (obs.myRole !== 'merlin' || obs.gamePhase !== 'team_select') return false;
  const bits = tuning.merlinGatedThumbScope83 ?? 0;
  const round = obs.currentRound ?? 1;
  const fc = obs.failCount ?? 0;
  if (round < ((bits & 1) !== 0 ? 2 : 3) || round > 4) return false;
  if (fc >= 4 && (bits & 2) === 0) return false;
  if ((bits & 4) !== 0 && fc >= 3) return false;
  if (obs.questResults.filter((r) => r === 'fail').length >= 2) return false;
  if ((bits & 8) !== 0) {
    const seen = new Set(obs.knownEvils);
    const me = obs.myPlayerId;
    if (obs.voteHistory.some((v) => v.leader === me && v.round >= 2 && v.team.some((id) => seen.has(id)))) return false;
  }
  return true;
}

/** 開關開著、範圍內（不含比例）。 */
export function gatedThumb83Applies(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation): boolean {
  return (tuning.merlinGatedThumb83 ?? 0) > 0 && gatedThumb83InScope(tuning, obs);
}

/**
 * `merlinGatedThumb83` 的挑法：`cur` = 現行這一次會派的隊；`publicAllowed` = 公開視角的邏輯閘門；`barred` = 梅林不放的人
 * （第 54 回合擋的看得到的紅、他自己確定但看不到的紅、湖的規則擋下的人）。回傳要派的隊（不改就是 `cur` 本身）。
 */
export function gatedThumb83Team(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  cur: readonly string[],
  publicAllowed: (team: readonly string[]) => boolean,
  barred: readonly string[],
): readonly string[] {
  if (cur.length === 0 || !gatedThumb83Applies(tuning, obs)) return cur;
  const seen = new Set(obs.knownEvils);
  if (cur.some((id) => seen.has(id))) return cur;
  round83Stats.applies++;
  const q = tuning.merlinGatedThumb83 ?? 0;
  if (hash01(`${obs.myPlayerId}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|gate83`) >= q) return cur;
  round83Stats.rolled++;
  const set = loyalFree80Set(tuning, obs, cur.length, 0.5, publicAllowed, barred);
  if (!set) { round83Stats.noTeam++; return cur; }
  const cands = set.teams.filter((t) => t.plausible && t.thumbs === 1).sort((a, b) => b.score - a.score).slice(0, 3);
  if (cands.length === 0) { round83Stats.noTeam++; return cur; }
  const cfg = gatedThumb83Config(tuning);
  const pubOpts = merlinPublicScoring(tuning, obs).pubOpts;
  const ownOpts = bayesOptionsOf(tuning);
  for (const c of cands) {
    const ev = gatedThumb83Eval(tuning, obs, c.team, { pubOpts, ownOpts });
    round83Stats.evaluated++;
    if (!ev) continue;
    if (ev.pathProb >= cfg.a) round83Stats.gateA++;
    if (ev.lakeCert || ev.trustAfter >= cfg.b) round83Stats.gateB++;
    if (gatedThumb83Passes(ev, cfg)) { round83Stats.thumbed++; return c.team; }
  }
  return cur;
}

/**
 * 不變量（INV-M1、INV-T1）登記的例外：開關開著、範圍內、隊上剛好一個看得到的紅、(a)、(b) 都過門檻（不看比例——比例只決定做不做）。
 * 門檻外的拇指照樣算違反。
 */
export function gatedThumb83Exempt(tuning: Readonly<AgentTuning>, obs: PlayerObservation, team: readonly string[]): boolean {
  if (!gatedThumb83Applies(tuning, obs)) return false;
  const seen = new Set(obs.knownEvils);
  if (team.filter((id) => seen.has(id)).length !== 1) return false;
  const ev = gatedThumb83Eval(tuning, obs, team);
  return ev !== null && gatedThumb83Passes(ev, gatedThumb83Config(tuning));
}

/** 不變量量具（`invariantHarness.ts`）設定這一次跑的開關，`checks.ts` 用它判斷登記的例外；沒設定 = 沒有例外。 */
let invariantTuning: Readonly<AgentTuning> | null = null;
export function setGatedThumb83InvariantTuning(t: Readonly<AgentTuning> | null): void { invariantTuning = t; }
export function gatedThumb83InvariantExempt(obs: PlayerObservation, team: readonly string[]): boolean {
  return invariantTuning !== null && gatedThumb83Exempt(invariantTuning, obs, team);
}
