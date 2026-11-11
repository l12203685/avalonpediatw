/**
 * 貝氏信念（優化迴圈第 1 回合・第三階段信念引擎，2026-10-28）。
 *
 * 從確定性層的世界（L1*：規則、約定、自己的視野與湖結果）出發，每個世界乘上「在這個身分分配下，大家先前的動作會
 * 這樣發生」的機率，正規化後得到每個人是紅的後驗機率。機率表（`likelihoods.json`）是真人牌譜的彙總統計
 * （`scripts/fitBeliefLikelihoods.ts`）：
 *   - 黑白球：P(贊成 | 投票者陣營, 在不在隊上, 隊上有沒有紅, 回合段)；強制提議不算（沒有投票）；
 *   - 派隊：P(隊上有 k 個紅 | 隊長陣營, 回合段) ÷ 那個世界裡「隊長加 k 紅」的隊伍數（隊長在自己隊上的提議）；
 *   - 任務：P(失敗牌張數 | 回合, 隊上紅數)——紅方會出成功牌藏身，成功的任務也有資訊；
 *   - 湖：紅方持湖者的宣告 P(宣告 | 目標陣營)；好人持湖者說實話已經在 L1 的世界裡。
 * 自己的動作不算（自己知道自己為什麼這樣做）。每個動作用的是那個世界裡當時的身分，事件依時間逐一累加（資訊流）。
 */
import type { PlayerObservation } from '../types';
import type { AgentTuning } from '../AgentTuning';
import { buildCertainty } from './Certainty';
import { zoneTeamLogProb, type PriorProposal } from './ZoneModel';
import TABLE from './likelihoods.json';
import BOT_TABLE from './likelihoods_bot.json';
import BOT_TABLE_NEXT from './likelihoods_bot_next.json';
import STRONG_TABLE from './likelihoods_strong.json';
// Round 26 `beliefPolicyVotes`: the INFL vote reader. A circular import (its vote features call this module's posterior inside methods only).
import { policyVoteLog } from '../infl/policyRead';
// Round 33 `beliefRecursive`: the level-1 recursive reader (its level-0 seat views call this module's posterior: `useMix` restores its state).
import { recursiveLogs, recursiveRoleShares, type RoleShare } from '../infl/recursiveRead';
import { percivalRead39 } from '../BlueRound39Percival';

interface Table {
  vote: Record<string, [number, number]>;
  proposal: Record<string, number>;
  voteRole: Record<string, [number, number]>;
  proposalRole: Record<string, number>;
  mission: Record<string, number[]>;
  redLake: Record<string, [number, number]>;
  /** Key-round votes (R3+, red has two wins; `camp|on|red`), bot tables fitted from round 17 on (`BayesOptions.keyVoteCells`). */
  voteKey?: Record<string, [number, number]>;
  /** Round 24: a red's R3+ on-team votes split by another red on the team (`evil|alone|r3`, `evil|ally|r3`, `…|key`; `BayesOptions.redAloneCells`). */
  voteAlone?: Record<string, [number, number]>;
  /** Round 24: the 鐵咬 vote — the one member of the last failed mission a team drops (`good` / `evil`; `BayesOptions.biteCell`). */
  voteBite?: Record<string, [number, number]>;
}
const T = TABLE as unknown as Table;
/** The same tables fitted on bot self-play (`scripts/fitBeliefLikelihoods.ts --bots`; `BayesOptions.botTables`). */
const TB_CURRENT = BOT_TABLE as unknown as Table;
/** The refit candidate (`BayesOptions.botTablesNext`): fitted on the latest defaults, measured against the current table. */
const TB_NEXT = BOT_TABLE_NEXT as unknown as Table;
let TB = TB_CURRENT;
/**
 * Round 26 `beliefStrongTables` (Edward 2026-11-04「一套讀人模型」): the tables fitted on the strong-facet players' actions, backed off to
 * all humans (`scripts/fitBeliefLikelihoods.ts --strong`). When on it replaces the human table and the bot-table weight is not used.
 */
const TS = STRONG_TABLE as unknown as Table;
/**
 * The human-side table the posterior being computed reads per component (`T`, or `TS` with `BayesOptions.strongTables`): votes,
 * proposals, missions, red lake; and the bot-table weight of each (0 where the strong table is read). `BayesOptions.strongParts`
 * narrows the strong table to some components (a diagnostic of which bot-table reads carry self-play).
 */
let TH = T;
let THP = T;
let THM = T;
let THL = T;
let mixV = 0;
let mixP = 0;
let mixM = 0;
let mixL = 0;
let partsKey = 0;
/** The bot table the mission cells are read from (`TB`, or the refit one alone: `BayesOptions.botMissionNext`). */
let TBM = TB_CURRENT;
/**
 * The bot-table weight of the posterior being computed (`BayesOptions.botTables`; 0 = the human tables alone). Set by
 * `posterior()` for the duration of one synchronous computation, so the helpers below read it without threading it.
 */
let mix = 0;
const blend = (human: number, bot: number): number => (mix > 0 ? (1 - mix) * human + mix * bot : human);
const blendW = (m: number, human: number, bot: number): number => (m > 0 ? (1 - m) * human + m * bot : human);

/**
 * Memo of the blended table lookups for the current `mix` (the posterior asks the same few hundred cells millions of
 * times per game; building the string keys was ~40% of a game's CPU). Pure cache: same numbers as the uncached path.
 */
interface ProbMemo { vote: Float64Array; voteLog: Float64Array; proposal: Float64Array; mission: Float64Array }
const memos = new Map<number, ProbMemo>();
const newMemo = (): ProbMemo => ({ vote: new Float64Array(64).fill(NaN), voteLog: new Float64Array(128).fill(NaN), proposal: new Float64Array(48).fill(NaN), mission: new Float64Array(216).fill(NaN) });
let memo: ProbMemo = newMemo();
memos.set(0, memo);
const memosNext = new Map<number, ProbMemo>();
const memosStrong = new Map<number, ProbMemo>();
const memosMissionNext = new Map<number, ProbMemo>();
/** The arguments of the last `useMix` (round 33: a posterior computed inside another — the recursive reader's level-0 seat views — restores them). */
type MixArgs = [number, boolean, boolean, boolean, number];
let mixArgs: MixArgs = [0, false, false, false, 15];
function useMix(m: number, next = false, missionNext = false, strong = false, parts = 15): void {
  mixArgs = [m, next, missionNext, strong, parts];
  const sp = strong ? (parts > 0 ? parts & 15 : 15) : 0;
  partsKey = sp;
  mix = sp === 15 ? 0 : m;
  TH = sp & 1 ? TS : T; mixV = sp & 1 ? 0 : m;
  THP = sp & 2 ? TS : T; mixP = sp & 2 ? 0 : m;
  THM = sp & 4 ? TS : T; mixM = sp & 4 ? 0 : m;
  THL = sp & 8 ? TS : T; mixL = sp & 8 ? 0 : m;
  TB = next ? TB_NEXT : TB_CURRENT;
  TBM = next || missionNext ? TB_NEXT : TB_CURRENT;
  const store = sp > 0 ? memosStrong : next ? memosNext : missionNext ? memosMissionNext : memos;
  const mk = sp > 0 ? m * 100 + sp : m;
  let x = store.get(mk);
  if (!x) { x = newMemo(); store.set(mk, x); }
  memo = x;
}
const CAMP_INDEX: Record<string, number> = { good: 0, evil: 1, merlin: 2, morgana: 3 };

const bucket = (round: number): string => (round <= 2 ? 'r12' : 'r3');
const smooth = (hit: number, n: number): number => (hit + 1) / (n + 2);

/**
 * `camp` = 'good' | 'evil', or a role key 'merlin' | 'morgana' (the role tables, Percival's thumbs). `keyRound`: a key-round vote
 * (R3+, red has two wins) read from the table's `voteKey` cells when it has them (`BayesOptions.keyVoteCells`; camps only).
 */
function voteProbIn(t: Table, camp: string, on: boolean, hasRed: boolean, round: number, keyRound = false): number {
  if (keyRound && camp !== 'merlin' && camp !== 'morgana') {
    const kc = t.voteKey?.[`${camp}|${on ? 'on' : 'off'}|${hasRed ? 'red' : 'clean'}`];
    if (kc) return smooth(kc[0], kc[1]);
  }
  const key = `${camp}|${on ? 'on' : 'off'}|${hasRed ? 'red' : 'clean'}|${bucket(round)}`;
  const c = (camp === 'merlin' || camp === 'morgana' ? t.voteRole[key] : t.vote[key]) ?? [1, 2];
  return smooth(c[0], c[1]);
}

const CAMP_NAMES = ['good', 'evil', 'merlin', 'morgana'] as const;
/** log P(vote) by camp index (good 0, evil 1, merlin 2, morgana 3) — the memoized form of `Math.log(voteProb(…))`. */
function voteLogIx(ci: number, on: boolean, hasRed: boolean, r3: boolean, approve: boolean, keyRound = false): number {
  const idx = (keyRound ? 64 : 0) | (ci << 4) | (on ? 8 : 0) | (hasRed ? 4 : 0) | (r3 ? 2 : 0) | (approve ? 1 : 0);
  let lp = memo.voteLog[idx];
  if (Number.isNaN(lp)) {
    lp = Math.log(voteProb(CAMP_NAMES[ci], on, hasRed, r3 ? 3 : 1, approve, keyRound));
    memo.voteLog[idx] = lp;
  }
  return lp;
}

function proposalProbIx(ci: number, r3: boolean, k: number): number {
  return proposalProb(CAMP_NAMES[ci], r3 ? 3 : 1, k);
}

function voteProb(camp: string, on: boolean, hasRed: boolean, round: number, approve: boolean, keyRound = false): number {
  const ci = CAMP_INDEX[camp];
  const idx = ci === undefined ? -1 : (keyRound ? 32 : 0) | (ci << 3) | (on ? 4 : 0) | (hasRed ? 2 : 0) | (round <= 2 ? 0 : 1);
  let p = idx >= 0 ? memo.vote[idx] : NaN;
  if (Number.isNaN(p)) {
    p = blendW(mixV, voteProbIn(TH, camp, on, hasRed, round, keyRound), voteProbIn(TB, camp, on, hasRed, round, keyRound));
    if (idx >= 0) memo.vote[idx] = p;
  }
  return approve ? p : 1 - p;
}

/** log P(vote) of the bitten seat (`biteCell`): 1 = bot table (human if missing), 2 = human table; null when no cell. */
const biteMemo = new Map<string, number | null>();
function biteVoteLog(mode: number, red: boolean, approve: boolean): number | null {
  const k = `${TH === TS ? 'S' : ''}${TB === TB_NEXT ? 'n' : 'c'}|${mode}|${red ? 1 : 0}|${approve ? 1 : 0}`;
  if (biteMemo.has(k)) return biteMemo.get(k)!;
  const cell = red ? 'evil' : 'good';
  const c = (mode === 1 && TH !== TS ? TB.voteBite?.[cell] : undefined) ?? TH.voteBite?.[cell];
  const v = c ? Math.log(approve ? smooth(c[0], c[1]) : 1 - smooth(c[0], c[1])) : null;
  biteMemo.set(k, v);
  return v;
}

/** log P(vote) of a red on the team, R3+, from the `voteAlone` cells (bot table only); null when the cell is missing (`redAloneCells`). */
const aloneMemo = new Map<string, number | null>();
function redAloneVoteLog(alone: boolean, keyRound: boolean, approve: boolean): number | null {
  const k = `${TH === TS ? 'S' : ''}${TB === TB_NEXT ? 'n' : 'c'}|${mixV}|${alone ? 'alone' : 'ally'}|${keyRound ? 'key' : 'r3'}|${approve ? 1 : 0}`;
  if (aloneMemo.has(k)) return aloneMemo.get(k)!;
  // The strong table carries its own `voteAlone` cells (round 26); otherwise only the bot table has them.
  const src = TH === TS ? TS : mixV > 0 ? TB : undefined;
  const c = src ? src.voteAlone?.[`evil|${alone ? 'alone' : 'ally'}|${keyRound ? 'key' : 'r3'}`] ?? (keyRound ? src.voteAlone?.[`evil|${alone ? 'alone' : 'ally'}|r3`] : undefined) : undefined;
  let v: number | null = null;
  if (c) {
    const pBot = smooth(c[0], c[1]);
    const p = TH === TS ? pBot : blendW(mixV, voteProbIn(T, 'evil', true, true, 3, keyRound), pBot);
    v = Math.log(approve ? p : 1 - p);
  }
  aloneMemo.set(k, v);
  return v;
}

function proposalProbIn(t: Table, camp: string, round: number, k: number): number {
  const tab = camp === 'merlin' || camp === 'morgana' ? t.proposalRole : t.proposal;
  let total = 0;
  for (let j = 0; j <= 5; j++) total += (tab[`${camp}|${bucket(round)}|${j}`] ?? 0) + 1;
  return ((tab[`${camp}|${bucket(round)}|${k}`] ?? 0) + 1) / total;
}

function proposalProb(camp: string, round: number, k: number): number {
  const ci = CAMP_INDEX[camp];
  const idx = ci === undefined || k < 0 || k > 5 ? -1 : ci * 12 + (round <= 2 ? 0 : 6) + k;
  let p = idx >= 0 ? memo.proposal[idx] : NaN;
  if (Number.isNaN(p)) {
    p = blendW(mixP, proposalProbIn(THP, camp, round, k), proposalProbIn(TB, camp, round, k));
    if (idx >= 0) memo.proposal[idx] = p;
  }
  return p;
}

function missionProbIn(t: Table, round: number, reds: number, fails: number): number {
  const d = t.mission[`${round}|${reds}`];
  if (!d) return fails === reds ? 0.9 : 0.1;
  const n = d.slice(0, reds + 1).reduce((a, b) => a + b + 1, 0);
  return ((d[fails] ?? 0) + 1) / n;
}

function missionProb(round: number, reds: number, fails: number): number {
  if (fails > reds) return 0;
  const idx = round >= 1 && round <= 6 && reds >= 0 && reds <= 5 && fails >= 0 && fails <= 5 ? ((round - 1) * 6 + reds) * 6 + fails : -1;
  let p = idx >= 0 ? memo.mission[idx] : NaN;
  if (Number.isNaN(p)) {
    p = blendW(mixM, missionProbIn(THM, round, reds, fails), missionProbIn(TBM, round, reds, fails));
    if (idx >= 0) memo.mission[idx] = p;
  }
  return p;
}

function redLakeProb(targetRed: boolean): number {
  const at = (t: Table): number => { const c = t.redLake[targetRed ? 'evil' : 'good'] ?? [1, 2]; return smooth(c[0], c[1]); };
  return blendW(mixL, at(THL), at(TB));
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

interface Posterior {
  worlds: readonly number[];
  /** Normalized weight of each world (sums to 1); empty when there is no world. */
  wts: number[];
  bitOf: (id: string) => number;
  maskOf: (ids: readonly string[]) => number;
}

const caches = new Map<string, WeakMap<PlayerObservation, Posterior>>();
/** Round 39 review: a stable signature of the recursive reader's level-0 options (memoized per options object). */
const level0Sigs = new WeakMap<BayesOptions, string>();
const level0SigIds = new Map<string, string>();
function level0Signature(o: BayesOptions | undefined): string {
  if (!o) return '-';
  let sig = level0Sigs.get(o);
  if (sig === undefined) {
    const json = JSON.stringify(o, (_k, v: unknown) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v));
    let id = level0SigIds.get(json);
    if (id === undefined) { id = String(level0SigIds.size); level0SigIds.set(json, id); }
    sig = id;
    level0Sigs.set(o, sig);
  }
  return sig;
}

export interface BayesOptions {
  /**
   * `beliefBotTables` (Edward 2026-10-30): weight of the likelihood tables fitted on bot self-play (`likelihoods_bot.json`)
   * against the human ones — the blues read what their current opponents actually do (bot reds vote off-team for a team
   * with a teammate 95% and almost never otherwise, which the human tables read as nearly nothing). 0 = human only.
   */
  botTables?: number;
  /** Read with the refit bot table (`likelihoods_bot_next.json`) instead of the current one (`beliefBotTablesNext`). */
  botTablesNext?: boolean;
  /**
   * Read only the mission cells (fail cards | round, reds on the team) from the refit bot table, the votes / proposals / lake
   * from the current one (`beliefBotMissionNext`, round 15: the reds hide on R1 since round 14, which the current table — fitted
   * before that — reads as all but impossible).
   */
  botMissionNext?: boolean;
  /**
   * `bayesThumbRoles` (optimization loop round 3): for Percival, in every world the good thumb is Merlin and
   * the red one Morgana — their actions are read with the role tables (`voteRole`, `proposalRole`), so the
   * posterior tells the thumbs apart.
   */
  thumbRoles?: boolean;
  /**
   * `percivalThumbLogic` (round 3, Edward 2026-10-29): Percival's two thumbs are exactly one Merlin and one Morgana,
   * and Merlin's information is right while Morgana's need not be. In a world where a thumb is Merlin, its proposals
   * (R3+ or the forced fifth; the doomed R1–R2 ones are skipped: 派拇指躲刺) come from the players Merlin sees as
   * clean (the blues and the unseen Mordred) — two or more reds on them is all but impossible, exactly one red must
   * be Mordred — and from R3 on it does not approve a team holding a red it sees. In a world where the thumb is
   * Morgana, the usual red tables.
   */
  strictMerlin?: boolean;
  /**
   * `loyalMerlinRead` (round 5, loyals): in every world one of the blues is Merlin (who, averaged over; and which
   * red is the Mordred he cannot see, averaged over). From R3 that blue's votes follow a Merlin model on "the team
   * holds a red Merlin sees": 1 = the human Merlin table (approves such a team 25.7%), 2 = strict (all but never;
   * its proposals from the seen-clean pool too). 0 = off. Loyal viewers only (Percival: `strictMerlin`).
   */
  merlinMixture?: number;
  /**
   * `merlinZoneSignal` (round 5, Edward 2026-10-29): Merlin cuts zones with its R1–R2 non-forced proposals (no seen red
   * on the team, the thumbs in the gaps; `ZoneModel.ts`) instead of 派拇指躲刺. With it on, the strict Percival model and
   * the loyal Merlin mixture read those proposals with the zone model (averaged over which red is the unseen Mordred).
   */
  zoneMerlin?: boolean;
  /**
   * `merlinLoyalStyle` (round 5, Edward 2026-10-29): Merlin proposes like a loyal but never with a red it sees, in every
   * round — so the R1–R2 non-forced proposals of the Merlin candidate read with the strict model too (no seen red;
   * uniform over the clean picks), instead of being skipped as 派拇指躲刺.
   */
  merlinEarlyStrict?: boolean;
  /**
   * `merlinDoomedPublicHalf` (round 22, with `merlinEarlyStrict`): the share of the Merlin candidate's R1–R2 non-forced proposals that come
   * from the seen-clean pool (the rest follow the public loyal view, read as a generic blue's): those proposals read with the mixture
   * q · strict + (1 − q) · generic. Absent / 1 = all strict.
   */
  merlinEarlyMix?: number;
  /** With `merlinEarlyMix`: only this round's doomed proposals are mixed (the other round's stay strict); 0 / absent = both (round 22 `merlinDoomedPublic` 3 / 4). */
  merlinEarlyMixRound?: number;
  /**
   * `beliefKeyVoteCells` (round 17): key-round votes (R3+, red has two wins) read from the bot table's `voteKey` cells — since
   * round 16 the reds white a key team off the team only when it can pass, so key-round votes differ from the other R3+ votes.
   */
  keyVoteCells?: boolean;
  /**
   * `percivalMorganaR1` (round 17, Percival): since round 16 only the assassin (and Mordred) hide on R1 — a lone Morgana fails. In
   * Percival's worlds the red thumb is Morgana: an R1 mission whose only red is that thumb all but never succeeds.
   */
  morganaR1?: boolean;
  /**
   * Round 24 `beliefRedAloneCells`: a red's R3+ on-team vote reads from the bot table's `voteAlone` cells — split by whether another red
   * is on the team (in this world) — instead of the pooled `evil|on|red` cell (Mordred alone on a team mostly rejects; the others never do).
   */
  redAloneCells?: boolean;
  /**
   * Round 24 `beliefBiteCell`: 鐵咬 — on a non-forced proposal that keeps every member of the last failed mission but one (X, off the
   * team, not the leader), X's vote reads from the `voteBite` cells by camp (an innocent X knows the fail came from the others;
   * white = 認壞) instead of the generic off-team cell. 1 = the bot table's cells, 2 = the human table's.
   */
  biteCell?: number;
  /**
   * Round 26 `beliefStrongTables`: read every action with the strong-player tables (`likelihoods_strong.json`: strong-facet top-5 seats,
   * backed off to all humans) instead of the human / bot tables — the one reading model for everyone (Edward 2026-11-04). The bot-table
   * weight is ignored; the key-round, red-alone and bite cells come from the strong table.
   */
  strongTables?: boolean;
  /** With `strongTables`: which components read the strong table (1 votes, 2 proposals, 4 missions, 8 red lake; the rest the usual tables). Absent = all. */
  strongParts?: number;
  /**
   * Round 26 `beliefPolicyVotes` (Edward 2026-11-04: read each vote as the voter's own function of the INFL he had then): every vote reads
   * from the strong-fitted INFL policy model (`infl/policyRead.ts`, `policy_strong.json`) — roles decided jointly per world, its own Merlin
   * layer — instead of the vote cells; the loyal Merlin layer keeps only Merlin's proposals.
   */
  policyVotes?: boolean;
  /** Round 26 `beliefTemper`: the power (0, 1] on the vote terms (incl. the loyal Merlin layer); absent / 1 = none. */
  voteTemper?: number;
  /** Round 26 `beliefTemper`: the power (0, 1] on the proposal terms; absent / 1 = none. */
  proposalTemper?: number;
  /** Round 28 `beliefLeadTemper`: the vote / proposal powers while the viewer picks a team (`gamePhase` team_select); absent = the ones above. */
  leadVoteTemper?: number;
  leadProposalTemper?: number;
  /** Round 28 `beliefLeadStrong`: while the viewer picks a team, read with the strong tables (`strongTables`) — votes and proposals keep their powers. */
  leadStrongTables?: boolean;
  /**
   * Round 33 `beliefRecursive` (Edward 2026-11-09「資訊流遞迴調整與修正」): the level-1 recursive reader (`infl/recursiveRead.ts`) — each vote
   * and proposal of j reads as the output of j's own decision function on j's level-0 posterior at that moment (public prefix + j's private
   * information in the world). 1 = votes and proposals, 2 = votes only, 3 = proposals only; 4 = the round-34 role mixture (every player's whole
   * record read under one role — loyal, Percival, Merlin, the reds — decided jointly per world; the loyal Merlin layer is not used). Replaces the
   * vote / proposal cells it covers.
   */
  recursive?: number;
  /** With `recursive`: the level-0 options j's own posterior is computed with (the same options without `recursive`). */
  recursiveLevel0?: BayesOptions;
  /** Round 33 `beliefLeadRecursive`: the recursive mode while the viewer picks a team (`gamePhase` team_select) only. */
  leadRecursive?: number;
  /** Round 34 `beliefRecursiveNoLead`: with `recursive`, a team pick (`gamePhase` team_select) still reads with the level-0 posterior. */
  recursiveNoLead?: boolean;
  /** Round 35 `beliefRecursiveLeadScope`: where a team pick reads the recursive posterior (0 all, 1 none, 2 R2 after an R1 fail, 3 R1–R2, 4 R2, 5 R3+, 6 = 2 for Percival only). */
  recursiveLeadScope?: number;
  /** Round 36 `beliefLeadBlend`: with `leadRecursive`, the weight of the recursive posterior in a team pick (0 = off: the recursive posterior alone). */
  leadBlend?: number;
  /**
   * Round 38 `ownView` (Edward 2026-11-10: a loyal picks among the few teams consistent with his own earlier thinking and the information flow):
   * while the viewer picks a non-forced team, his posterior starts from his own prior — a per-seat log-odds offset on each other player
   * (`sigma`; fixed from the game's first proposal on, and a separate random draw on that first proposal itself, see `ownViewOffsets`),
   * lower for the players he proposed earlier (`keep`) — instead of the same flat prior every loyal shares. The record then
   * updates it as usual, so the offsets decide only where the record says little. `scope`: 1 loyal, 2 + Percival, 3 + Merlin's public-view pick.
   */
  ownView?: { sigma: number; keep: number; scope: number; maxRound?: number };
  /**
   * Round 38 `beliefPendingProposal` (checklist BL-01): while the viewer votes, the proposal on the table is read as a proposal too (it enters
   * `voteHistory` only after the vote, so the vote rules scored the team on a posterior that had not read it).
   */
  pendingProposal?: boolean;
  /** Round 40 `beliefLakeCal40`: power on another holder's lake declaration term (blue seats only; 1 = as before). */
  lakeCal?: number;
  /** Round 41 `beliefLakeIso41` (BL-cal): per-lake isotonic recalibration of P(another holder is red) (loyal / Percival seats only). */
  lakeIso?: boolean;
  /**
   * Round 38 `beliefThumbNoStain`: for Percival, a failed R1–R3 mission with exactly one thumb on it says nothing about which thumb is Merlin
   * (human records: that thumb is Merlin 43–52%; self-play 44–52%) — the mission term is averaged over the two thumb assignments.
   */
  thumbNoStain?: boolean;
  /**
   * Round 40 `percivalRead39=1`: Percival's posterior takes its thumb split from the round-39 fitted read (`percivalRead39`). The split is set
   * before the round-38 `ownView` offsets; at his own team picks where `ownView` applies, those offsets act on top of it, so there the thumb
   * split is the read's only before Percival's own prior (at votes it is the read's exactly).
   */
  thumbRead39?: boolean;
}

/** Near-impossible event under the strict-Merlin model. */
const STRICT_EPS = 0.03;

// Keyed by the blend value plus every option that changes the team_select posterior below this branch and is not otherwise in the observation
// (`lakeCal`, the pending-proposal flag), so a candidate and the default evaluated on one observation object never share an entry.
const blendCaches = new Map<string, WeakMap<PlayerObservation, Posterior>>();

// Keyed by the base posterior (itself cached per observation and per every option that changes it), so a cached result is reused only for the
// same base: the round-38 readers that sit on top of it (`ownView`, `beliefThumbNoStain`) cannot hand one option set's result to another.
const ownViewCache = new WeakMap<Posterior, Map<string, Posterior>>();

/** Round 38 `ownView`: does the viewer's own prior apply to this team pick, and how strongly (0 = not at all). */
export function ownViewStrength(obs: PlayerObservation, scope: number, maxRound = 0): number {
  if (maxRound > 0 && (obs.currentRound ?? 1) > maxRound) return 0;
  if (obs.gamePhase !== 'team_select' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return 0;
  if (!(obs.myRole === 'loyal' || (scope >= 2 && obs.myRole === 'percival'))) return 0;
  const fc = obs.failCount ?? 0;
  if (fc >= 4) return 0;
  // The likelier this proposal goes on a mission (human records, `PROPOSAL_GO_RATE`), the less the own prior counts: weight 1 − go/0.3, so
  // about 0.7–1 on the R1–R2 proposals (0.5–8%), part weight on the R3–R5 proposals below 30% (R3 second 0.80, third 0.63; R3 first 25% → 0.17),
  // none from 30% up (R3 fourth 36%, R4 first 55%) and none on the forced fifth.
  const go = OWN_VIEW_GO_RATE[obs.currentRound ?? 1]?.[fc] ?? 0.3;
  return Math.max(0, 1 - go / 0.3);
}

/** Share of proposals that went on a mission (human records; the same table as `BlueRound37.PROPOSAL_GO_RATE`). */
const OWN_VIEW_GO_RATE: Readonly<Record<number, readonly number[]>> = {
  1: [0.005, 0.005, 0.005, 0.005], 2: [0.015, 0.018, 0.036, 0.082], 3: [0.25, 0.06, 0.11, 0.36], 4: [0.55, 0.21, 0.31, 0.53], 5: [0.43, 0.29, 0.32, 0.53],
};

function hash01(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) >>> 0;
  // one more avalanche round: FNV alone leaves the low bits of near-identical strings correlated
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return ((h >>> 0) + 0.5) / 4294967296;
}

/**
 * Round 38 `ownView`: the viewer's own log-odds offsets (positive = more suspicious) on the other players for this pick, or null when it does
 * not apply. From the game's first proposal on they are a hash of that (public) proposal and the seat, so every later pick of the seat starts
 * from the same view. The very first proposal of the game (no record yet) draws them from the decision's random numbers instead: a separate
 * draw, unrelated to the later offsets and not reproducible without a seeded random source (one draw per observation object). The players the viewer proposed
 * earlier in the game count `keep` less suspicious: his later picks stay with his earlier ones until the record speaks against them.
 */
export function ownViewOffsets(obs: PlayerObservation, cfg: { sigma: number; keep: number; scope: number; maxRound?: number }): Map<string, number> | null {
  const f = ownViewStrength(obs, cfg.scope, cfg.maxRound ?? 0);
  if (!(f > 0) || !(cfg.sigma > 0 || cfg.keep > 0)) return null;
  // One draw per observation (the first proposal of a game draws from the decision's random numbers).
  const ck = `${cfg.sigma}|${cfg.keep}|${cfg.scope}|${cfg.maxRound ?? 0}`;
  let memo = ownViewOffsetCache.get(obs);
  if (!memo) { memo = new Map(); ownViewOffsetCache.set(obs, memo); }
  const had = memo.get(ck);
  if (had) return had;
  const made = ownViewOffsetsOf(obs, cfg, f);
  memo.set(ck, made);
  return made;
}

const ownViewOffsetCache = new WeakMap<PlayerObservation, Map<string, Map<string, number>>>();

function ownViewOffsetsOf(obs: PlayerObservation, cfg: { sigma: number; keep: number; scope: number; maxRound?: number }, f: number): Map<string, number> {
  const me = obs.myPlayerId;
  const first = obs.voteHistory[0];
  const seedStr = first ? `${first.leader}:${first.team.join(',')}` : null;
  const mine = new Set(obs.voteHistory.filter((v) => v.leader === me).flatMap((v) => v.team));
  const out = new Map<string, number>();
  for (const id of obs.allPlayerIds) {
    if (id === me) continue;
    const u1 = seedStr ? hash01(`ov1|${seedStr}|${me}|${id}`) : Math.max(1e-9, Math.random());
    const u2 = seedStr ? hash01(`ov2|${seedStr}|${me}|${id}`) : Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.set(id, f * (cfg.sigma * z - (mine.has(id) ? cfg.keep : 0)));
  }
  return out;
}

function posterior(obs: PlayerObservation, opts: Readonly<BayesOptions>): Posterior {
  // Round 38 `ownView`: the pick's posterior from the viewer's own prior — the world weights times exp(Σ offsets of the reds in the world).
  const ov = opts.ownView;
  if (ov && ownViewStrength(obs, ov.scope, ov.maxRound ?? 0) > 0) {
    const base = posterior(obs, { ...opts, ownView: undefined });
    const key = `ov|${ov.sigma}|${ov.keep}|${ov.scope}|${ov.maxRound ?? 0}`;
    let store = ownViewCache.get(base);
    if (!store) { store = new Map(); ownViewCache.set(base, store); }
    const hit = store.get(key);
    if (hit) return hit;
    const off = ownViewOffsets(obs, ov);
    let out = base;
    if (off && base.worlds.length > 0) {
      const bits = [...off].map(([id, d]) => ({ b: base.bitOf(id), d }));
      const raw = base.worlds.map((w, i) => { let s = 0; for (const x of bits) if ((w & x.b) !== 0) s += x.d; return base.wts[i] * Math.exp(s); });
      const tot = raw.reduce((a, b) => a + b, 0);
      if (tot > 0) out = { ...base, wts: raw.map((x) => x / tot) };
    }
    store.set(key, out);
    return out;
  }
  // Round 38 `beliefThumbNoStain` (Percival): see `thumbNoStainPosterior`.
  if (opts.thumbNoStain === true && obs.myRole === 'percival' && (obs.knownWizards ?? []).length === 2) {
    const base = posterior(obs, { ...opts, thumbNoStain: false });
    let store = ownViewCache.get(base);
    if (!store) { store = new Map(); ownViewCache.set(base, store); }
    const hit = store.get('ns');
    if (hit) return hit;
    const out = thumbNoStainPosterior(obs, opts);
    store.set('ns', out);
    return out;
  }
  // Round 40 `percivalRead39=1` (Percival): the share of "thumb A is the red one" is set to the fitted read's 1 − P(A is Merlin); within each thumb
  // assignment the worlds keep their weights, so every Percival decision that reads the posterior (the cleanest team, his votes) uses the read.
  // This runs below the `ownView` branch: at team picks where `ownView` applies, its offsets multiply on top of the tilted weights.
  if (opts.thumbRead39 === true && obs.myRole === 'percival' && (obs.knownWizards ?? []).length === 2 && (obs.seatTeam ?? obs.myTeam) === 'good'
    && obs.publicLoyalView !== true) {
    const base = posterior(obs, { ...opts, thumbRead39: false });
    let store = ownViewCache.get(base);
    if (!store) { store = new Map(); ownViewCache.set(base, store); }
    const hit = store.get('r40');
    if (hit) return hit;
    const out = thumbRead39Posterior(obs, base);
    store.set('r40', out);
    return out;
  }
  // Round 36 `beliefLeadBlend`: where the lead-only recursive reader applies, mix its world weights with the level-0 posterior's
  // (λ·recursive + (1 − λ)·level 0; same L1* worlds) — the pick stays near the current one and only leans toward the recursive read.
  const blend = opts.leadBlend ?? 0;
  if (blend > 0 && blend < 1 && (opts.leadRecursive ?? 0) > 0 && obs.gamePhase === 'team_select' && recursiveLeadInScope(obs, opts.recursiveLeadScope ?? 0)) {
    const blendKey = `${blend}|${opts.lakeCal ?? 1}|${opts.lakeIso === true ? 1 : 0}|${opts.pendingProposal === true ? 1 : 0}`;
    let store = blendCaches.get(blendKey);
    if (!store) { store = new WeakMap(); blendCaches.set(blendKey, store); }
    const hit = store.get(obs);
    if (hit) return hit;
    const p1 = posterior(obs, { ...opts, leadBlend: 0 });
    const p0 = posterior(obs, { ...opts, leadBlend: 0, leadRecursive: 0 });
    const out = p0.wts.length === p1.wts.length ? { ...p1, wts: p1.wts.map((w, i) => blend * w + (1 - blend) * p0.wts[i]) } : p1;
    store.set(obs, out);
    return out;
  }
  const strong = opts.strongTables === true || (opts.leadStrongTables === true && obs.gamePhase === 'team_select');
  const prev = mixArgs;
  useMix(Math.min(Math.max(opts.botTables ?? 0, 0), 1), opts.botTablesNext === true, opts.botMissionNext === true, strong, opts.strongParts ?? 15);
  try {
    return posteriorWith(obs, opts);
  } finally {
    useMix(...prev);
  }
}

/**
 * Round 38 `beliefThumbNoStain`: Percival's posterior with the fail of an R1–R3 mission that held exactly one of his thumbs made silent about
 * which thumb is Merlin. The share of "thumb A is the red one" is taken from the same record without those missions (as if their result were
 * unknown); within each thumb assignment the worlds keep their weights, so every other read still uses the missions.
 */
function thumbNoStainPosterior(obs: PlayerObservation, opts: Readonly<BayesOptions>): Posterior {
  const base = posterior(obs, { ...opts, thumbNoStain: false });
  const thumbs = obs.knownWizards ?? [];
  if (base.worlds.length === 0 || thumbs.length !== 2) return base;
  const results = obs.questResults ?? [];
  const stained = (q: PlayerObservation['questHistory'][number]): boolean => q.round <= 3 && results[q.round - 1] === 'fail' && (q.team.includes(thumbs[0]) !== q.team.includes(thumbs[1]));
  if (!obs.questHistory.some(stained)) return base;
  const without = posterior({ ...obs, questHistory: obs.questHistory.filter((q) => !stained(q)) }, { ...opts, thumbNoStain: false });
  if (without.worlds.length === 0) return base;
  const ta = base.bitOf(thumbs[0]);
  const share = (p: Posterior, bit: number): number => p.worlds.reduce((acc, w, i) => acc + ((w & bit) !== 0 ? p.wts[i] : 0), 0);
  const pa = share(base, ta);
  const qa = share(without, without.bitOf(thumbs[0]));
  if (!(pa > 0 && pa < 1)) return base;
  const fa = qa / pa;
  const fb = (1 - qa) / (1 - pa);
  const raw = base.worlds.map((w, i) => base.wts[i] * ((w & ta) !== 0 ? fa : fb));
  const tot = raw.reduce((x, y) => x + y, 0);
  return tot > 0 ? { ...base, wts: raw.map((x) => x / tot) } : base;
}

/** Round 40: `base` tilted so that P(thumb A is red) = 1 − the fitted read's P(A is Merlin) (`percivalRead39`), before any `ownView` offsets. */
function thumbRead39Posterior(obs: PlayerObservation, base: Posterior): Posterior {
  const read = percivalRead39(obs);
  if (!read || base.worlds.length === 0) return base;
  const ta = base.bitOf(read.thumbs[0]);
  const pa = base.worlds.reduce((acc, w, i) => acc + ((w & ta) !== 0 ? base.wts[i] : 0), 0);
  if (!(pa > 0 && pa < 1)) return base;
  const qa = Math.min(Math.max(1 - read.pFirst, 0), 1);
  const fa = qa / pa;
  const fb = (1 - qa) / (1 - pa);
  const raw = base.worlds.map((w, i) => base.wts[i] * ((w & ta) !== 0 ? fa : fb));
  const tot = raw.reduce((x, y) => x + y, 0);
  return tot > 0 ? { ...base, wts: raw.map((x) => x / tot) } : base;
}

function posteriorWith(obs: PlayerObservation, opts: Readonly<BayesOptions>): Posterior {
  const percival = obs.myRole === 'percival' && (obs.knownWizards ?? []).length === 2;
  const thumbs = opts.thumbRoles && percival ? obs.knownWizards ?? [] : [];
  const strict = opts.strictMerlin && percival ? obs.knownWizards ?? [] : [];
  const mixMode = obs.myRole === 'loyal' && obs.myTeam === 'good' ? opts.merlinMixture ?? 0 : 0;
  const zone = opts.zoneMerlin === true;
  const early = opts.merlinEarlyStrict === true;
  const earlyMix = early ? Math.min(Math.max(opts.merlinEarlyMix ?? 1, 0), 1) : 1;
  const mixRound = earlyMix < 1 ? opts.merlinEarlyMixRound ?? 0 : 0;
  const keyCells = opts.keyVoteCells === true;
  const morganaR1 = opts.morganaR1 === true && percival;
  const aloneCells = opts.redAloneCells === true;
  const biteMode = opts.biteCell ?? 0;
  // Round 28 `beliefLeadTemper`: a team pick may read the record with other powers than the votes do.
  const lead = obs.gamePhase === 'team_select' && (opts.leadVoteTemper !== undefined || opts.leadProposalTemper !== undefined);
  const vT = lead ? opts.leadVoteTemper : opts.voteTemper;
  const pT = lead ? opts.leadProposalTemper : opts.proposalTemper;
  const temperV = vT !== undefined && vT > 0 ? Math.min(vT, 1) : 1;
  const temperP = pT !== undefined && pT > 0 ? Math.min(pT, 1) : 1;
  const policy = opts.policyVotes === true;
  const picking = obs.gamePhase === 'team_select';
  const leadOff = picking && (opts.recursiveNoLead === true || !recursiveLeadInScope(obs, opts.recursiveLeadScope ?? 0));
  const rec = opts.recursive !== undefined ? (leadOff ? 0 : opts.recursive)
    : ((opts.leadRecursive ?? 0) > 0 && picking && recursiveLeadInScope(obs, opts.recursiveLeadScope ?? 0) ? opts.leadRecursive! : 0);
  const recVotes = rec === 1 || rec === 2 || rec >= 4;
  const recProps = rec === 1 || rec === 3;
  // Round 34 `beliefRecursive=4`: the role mixture reads votes and proposals together (and its own Merlin / Percival roles).
  const recMix = rec >= 4;
  // Without tempering every term goes straight into lp in record order (the same floating-point sums as before round 26).
  const tempered = temperV < 1 || temperP < 1;
  const key = `${rec > 0 ? `R${rec}` : ''}${policy ? 'Pv' : ''}${temperV < 1 ? `V${temperV}` : ''}${temperP < 1 ? `P${temperP}` : ''}${biteMode > 0 ? `B${biteMode}` : ''}${aloneCells ? 'A' : ''}${morganaR1 ? 'g' : ''}${thumbs.length > 0 ? 't' : ''}${strict.length > 0 ? 's' : ''}${mixMode > 0 ? `m${mixMode}` : ''}${zone ? 'z' : ''}${early ? 'e' : ''}${earlyMix < 1 ? `q${earlyMix}r${mixRound}` : ''}${keyCells ? 'k' : ''}${mix > 0 ? `b${mix}${TB === TB_NEXT ? 'n' : TBM === TB_NEXT ? 'M' : ''}` : ''}${partsKey > 0 ? `S${partsKey}` : ''}${mixV !== mix || mixP !== mix ? `v${mixV}p${mixP}m${mixM}l${mixL}` : ''}`;
  // Round 38 `beliefPendingProposal`: the proposal being voted on, as one more proposal record without votes.
  // Round 39: blue seats only — a red seat's own reading, its loyal-view vote (`redLoyalView`) and the views it projects for other
  // seats (`seatTeam` stays the deciding seat's camp) stay as they were: red frozen. (An observation without `seatTeam` falls back to its
  // own camp; every decision enters through `HeuristicAgent.act` / `ForwardAgent.decide`, which set it.)
  const pending = opts.pendingProposal === true && obs.gamePhase === 'team_vote' && (obs.proposedTeam ?? []).length > 0
    && obs.currentLeader !== obs.myPlayerId && (obs.failCount ?? 0) < 4 && (obs.seatTeam ?? obs.myTeam) === 'good' && obs.redLoyalView !== true;
  // Round 40 `beliefLakeCal40` (BL-cal): blue seats only, like the pending proposal (red frozen).
  const lakeCal = opts.lakeCal !== undefined && opts.lakeCal > 0 && opts.lakeCal !== 1 && (obs.seatTeam ?? obs.myTeam) === 'good' && obs.redLoyalView !== true ? opts.lakeCal : 1;
  // The level-0 options of the recursive reader are part of the key too (two settings that differ only there must not share an entry).
  // Round 41 `beliefLakeIso41` (BL-cal): loyal / Percival seats only (the fitted population), blue seats only (red frozen).
  const lakeIso = opts.lakeIso === true && (obs.seatTeam ?? obs.myTeam) === 'good' && obs.redLoyalView !== true && (obs.myRole === 'loyal' || obs.myRole === 'percival');
  const fullKey = `${key}${rec > 0 ? `|L0${level0Signature(opts.recursiveLevel0)}` : ''}${pending ? '|pend' : ''}${lakeCal !== 1 ? `|lc${lakeCal}` : ''}${lakeIso ? '|iso' : ''}`;
  let store = caches.get(fullKey);
  if (!store) { store = new WeakMap(); caches.set(fullKey, store); }
  const hit = store.get(obs);
  if (hit) return hit;
  const view = buildCertainty(obs);
  const worlds = view.worlds('L1*');
  const ids = obs.allPlayerIds;
  const bitMap = new Map(ids.map((id) => [id, view.bitOf(id)] as const));
  const bit = (id: string): number => bitMap.get(id) ?? view.bitOf(id);
  const me = obs.myPlayerId;
  const sizeOf = (x: number): number => { let c = 0; while (x) { x &= x - 1; c++; } return c; };
  const all = view.maskOf(ids);
  const thumbMask = view.maskOf(thumbs);
  const strictMask = view.maskOf(strict);
  const wizardMask = morganaR1 ? view.maskOf(obs.knownWizards ?? []) : 0;
  // Everything that does not depend on the world, computed once (the world loop below runs it for every world).
  const results = obs.questResults ?? [];
  const records: PlayerObservation['voteHistory'] = pending
    ? [...obs.voteHistory, { round: obs.currentRound ?? 1, attempt: (obs.failCount ?? 0) + 1, leader: obs.currentLeader, team: [...(obs.proposedTeam ?? [])], approved: false, votes: {} } as PlayerObservation['voteHistory'][number]]
    : obs.voteHistory;
  const pre = records.map((v) => {
    const teamMask = view.maskOf(v.team);
    return {
      v,
      teamMask,
      leaderBit: bit(v.leader),
      leaderOn: v.team.includes(v.leader),
      doomed: v.round <= 2 && v.attempt < 5 && !early,
      earlyMixed: earlyMix < 1 && v.round <= 2 && v.attempt < 5 && (mixRound === 0 || v.round === mixRound),
      r3: v.round > 2,
      keyRound: keyCells && v.round > 2 && results.slice(0, v.round - 1).filter((r) => r === 'fail').length >= 2,
      biteBit: biteMode > 0 && v.attempt < 5 ? biteSeatBit(obs, v, bit) : 0,
      voters: v.attempt >= 5 || policy || recVotes ? [] : ids.filter((id) => id !== me && v.votes[id] !== undefined)
        .map((id) => ({ b: bit(id), on: v.team.includes(id), yes: v.votes[id] === true, raw: v.votes[id] })),
    };
  });
  const quests = obs.questHistory.map((q) => ({ round: q.round, mask: view.maskOf(q.team), fails: q.failCount ?? 0 }));
  const lakes = (obs.lakeHistory ?? []).filter((l) => l.declaredClaim !== 'none' && l.holderId !== me)
    .map((l) => ({ hb: bit(l.holderId), tb: bit(l.targetId), evil: l.declaredClaim === 'evil' }));
  const mixPre = mixMode > 0 && !recMix ? merlinMixturePre(obs, view, mixMode, zone, early, earlyMix, mixRound, policy || recVotes) : null;
  // Round 33: the recursive reader (Percival's strict-Merlin thumbs keep their own proposal model).
  const recLogs = rec > 0 ? recursiveLogs(obs, opts.recursiveLevel0 ?? {}, rec, (leader) => strict.includes(leader)) : null;
  const policyLog = recVotes ? recLogs?.votes ?? null : policy ? policyVoteLog(obs) : null;
  const recPropLog = recProps ? recLogs?.proposals ?? null : null;
  const logW = worlds.map((w) => {
    const red = (id: string): boolean => (w & bit(id)) !== 0;
    // Percival's thumbs: the good one is Merlin, the red one Morgana (in this world). Camp index: good 0, evil 1, merlin 2, morgana 3.
    const campIx = (b: number): number => ((thumbMask & b) !== 0 ? ((w & b) !== 0 ? 3 : 2) : (w & b) !== 0 ? 1 : 0);
    let lp = 0;
    // Round 26 `beliefTemper`: the proposal and vote terms are summed apart and tempered (α ≤ 1) — votes and proposals react to the same
    // public record, so treating them as independent given the world counts that record many times over (infl_research.md §1.2).
    let lpp = 0;
    let lv = 0;
    for (const p of pre) {
      const { v, teamMask } = p;
      const hasRed = (w & teamMask) !== 0;
      // Strict Merlin (Percival's good thumb in this world): proposals from its seen-clean pool.
      if ((strictMask & p.leaderBit) !== 0 && (w & p.leaderBit) === 0 && p.leaderOn) {
        if (p.doomed && zone) {
          // Zone-cutting Merlin (R1–R2 non-forced): averaged over which red is the unseen Mordred.
          const reds = ids.filter((id) => red(id));
          let zs = 0;
          const prior = priorOf(obs, v);
          for (const d of reds) zs += Math.exp(zoneLog(ids, v.leader, v.team, new Set(reds.filter((r) => r !== d)), prior));
          if (tempered) lpp += Math.log(zs / Math.max(1, reds.length)); else lp += Math.log(zs / Math.max(1, reds.length));
        } else if (!p.doomed) {
          const k = sizeOf(w & teamMask);
          const reds = sizeOf(w & all);
          const pool = ids.length - 1 - (reds - 1); // the blues + the unseen Mordred
          const n = choose(pool, v.team.length - 1);
          // Probabilities of this exact team: ε spread over every possible team when Merlin could not pick it.
          const any = choose(ids.length - 1, v.team.length - 1);
          const strictP = k >= 2 || n === 0 ? STRICT_EPS / any : (k === 1 ? 1 / reds : 1) / n;
          if (p.earlyMixed) {
            // `merlinEarlyMix`: a share 1 − q of the doomed proposals follow the public view (the generic proposal table).
            const others = all & ~p.leaderBit;
            const redsAvail = sizeOf(w & others);
            const kk = sizeOf(w & teamMask & ~p.leaderBit);
            const ng = choose(redsAvail, kk) * choose(sizeOf(others) - redsAvail, v.team.length - 1 - kk);
            const genericP = ng > 0 ? proposalProbIx(campIx(p.leaderBit), p.r3, kk) / ng : 0;
            if (tempered) lpp += Math.log(earlyMix * strictP + (1 - earlyMix) * genericP); else lp += Math.log(earlyMix * strictP + (1 - earlyMix) * genericP);
          } else if (tempered) {
            lpp += Math.log(strictP);
          } else lp += Math.log(strictP);
        }
      } else if (v.leader !== me && p.leaderOn && (!(recProps || recMix) || (strictMask & p.leaderBit) !== 0)) {
        // Proposal (the leader on its own team; not the viewer's own).
        const others = all & ~p.leaderBit;
        const redsAvail = sizeOf(w & others);
        const goodsAvail = sizeOf(others) - redsAvail;
        const k = sizeOf(w & teamMask & ~p.leaderBit);
        const n = choose(redsAvail, k) * choose(goodsAvail, v.team.length - 1 - k);
        if (n > 0) {
          if (tempered) lpp += Math.log(proposalProbIx(campIx(p.leaderBit), p.r3, k) / n); else lp += Math.log(proposalProbIx(campIx(p.leaderBit), p.r3, k) / n);
        }
      }
      // Votes (no vote on the forced fifth proposal: `voters` is empty there).
      for (const x of p.voters) {
        if ((strictMask & x.b) !== 0 && (w & x.b) === 0 && p.r3) {
          // Strict Merlin: approves a team with a red it sees all but never (one red: Mordred with 1/reds).
          const k = sizeOf(w & teamMask);
          const pClean = voteProb('good', x.on, false, 3, true);
          const pYes = k === 0 ? pClean : k === 1 ? pClean / sizeOf(w & all) + STRICT_EPS : STRICT_EPS;
          if (tempered) lv += Math.log(x.raw ? Math.min(pYes, 1 - STRICT_EPS) : 1 - Math.min(pYes, 1 - STRICT_EPS)); else lp += Math.log(x.raw ? Math.min(pYes, 1 - STRICT_EPS) : 1 - Math.min(pYes, 1 - STRICT_EPS));
          continue;
        }
        if (p.biteBit !== 0 && x.b === p.biteBit) {
          const lb = biteVoteLog(biteMode, (w & x.b) !== 0, x.yes);
          if (lb !== null) { if (tempered) lv += lb; else lp += lb; continue; }
        }
        if (aloneCells && x.on && p.r3 && campIx(x.b) === 1) {
          const la = redAloneVoteLog(sizeOf(w & teamMask) === 1, p.keyRound, x.yes);
          if (la !== null) { if (tempered) lv += la; else lp += la; continue; }
        }
        if (tempered) lv += voteLogIx(campIx(x.b), x.on, hasRed, p.r3, x.yes, p.keyRound); else lp += voteLogIx(campIx(x.b), x.on, hasRed, p.r3, x.yes, p.keyRound);
      }
    }
    for (const q of quests) {
      const reds = sizeOf(w & q.mask);
      if (morganaR1 && q.round === 1 && reds === 1 && (w & q.mask & wizardMask) !== 0) {
        // The only red on the R1 team is the Morgana thumb (this world): she fails (the human rule; round 16).
        lp += Math.log(q.fails === 0 ? STRICT_EPS : 1 - STRICT_EPS);
        continue;
      }
      const p = missionProb(q.round, reds, q.fails);
      lp += p > 0 ? Math.log(p) : -1e9;
    }
    if (mixPre) { if (tempered) lv += merlinMixtureLog(mixPre, w); else lp += merlinMixtureLog(mixPre, w); }
    if (policyLog) { if (tempered) lv += policyLog(w); else lp += policyLog(w); }
    if (recPropLog) { if (tempered) lpp += recPropLog(w); else lp += recPropLog(w); }
    if (tempered) lp += temperP * lpp + temperV * lv;
    for (const l of lakes) {
      if ((w & l.hb) === 0) continue;
      const p = redLakeProb((w & l.tb) !== 0);
      lp += lakeCal * Math.log(l.evil ? p : 1 - p);
    }
    return lp;
  });
  let wts: number[] = [];
  if (worlds.length > 0) {
    const max = Math.max(...logW);
    const raw = logW.map((x) => Math.exp(x - max));
    const tot = raw.reduce((a, b) => a + b, 0);
    wts = raw.map((x) => x / tot);
    if (lakeIso) wts = lakeIsoReweight(obs, worlds, wts, bit);
  }
  const out: Posterior = { worlds, wts, bitOf: bit, maskOf: (t) => view.maskOf(t) };
  store.set(obs, out);
  return out;
}

/**
 * Round 41 `beliefLakeIso41` (lp39 BL-cal): the posterior's P(another holder is red) recalibrated per lake by an isotonic map fitted on the
 * human records (loyal / Percival viewers at every team vote after that lake, 69,452 points; lakes 1–2 out of sample: four-band mean gap
 * 1.6–2.5pp, every band within 4pp; lake 3 mean gap about 7pp — few games). The map moves the holder's marginal; the worlds where the holder is red are scaled by one odds factor, so
 * every other seat's share moves with it through the joint. Lakes in record order; a certain holder (0 or 1) stays certain.
 */
export const LAKE_ISO_41: Readonly<Record<number, ReadonlyArray<readonly [number, number]>>> = {
  1: [[0.000, 0.000], [0.010, 0.071], [0.065, 0.166], [0.125, 0.211], [0.181, 0.244], [0.232, 0.295], [0.282, 0.332], [0.331, 0.376], [0.378, 0.401], [0.425, 0.442], [0.468, 0.474], [0.512, 0.480], [0.556, 0.511], [0.603, 0.537], [0.654, 0.566], [0.706, 0.622], [0.759, 0.668], [0.813, 0.724], [0.889, 0.777], [0.978, 0.850], [1.000, 1.000]],
  2: [[0.000, 0.000], [0.001, 0.034], [0.005, 0.072], [0.011, 0.084], [0.030, 0.160], [0.061, 0.232], [0.085, 0.267], [0.117, 0.298], [0.166, 0.366], [0.229, 0.432], [0.312, 0.508], [0.416, 0.559], [0.544, 0.620], [0.672, 0.660], [0.783, 0.707], [0.877, 0.752], [0.948, 0.852], [0.992, 0.935], [1.000, 1.000]],
  3: [[0.000, 0.000], [0.001, 0.028], [0.013, 0.091], [0.063, 0.174], [0.217, 0.310], [0.519, 0.659], [0.803, 0.749], [0.956, 0.829], [0.996, 0.930], [1.000, 1.000]],
};

export function lakeIso41Map(lake: number, p: number): number {
  const K = LAKE_ISO_41[Math.min(Math.max(lake, 1), 3)];
  if (p <= K[0][0]) return K[0][1];
  for (let i = 1; i < K.length; i++) {
    const [x0, y0] = K[i - 1];
    const [x1, y1] = K[i];
    if (p <= x1) return y0 + ((y1 - y0) * (p - x0)) / Math.max(1e-9, x1 - x0);
  }
  return K[K.length - 1][1];
}

function lakeIsoReweight(obs: PlayerObservation, worlds: readonly number[], wts: number[], bit: (id: string) => number): number[] {
  let out = wts;
  (obs.lakeHistory ?? []).forEach((l, li) => {
    if (l.declaredClaim === 'none' || l.holderId === obs.myPlayerId) return;
    const hb = bit(l.holderId);
    if (hb === 0) return;
    let p = 0;
    for (let i = 0; i < worlds.length; i++) if ((worlds[i] & hb) !== 0) p += out[i];
    if (p <= 1e-9 || p >= 1 - 1e-9) return;
    const q = Math.min(Math.max(lakeIso41Map(li + 1, p), 1e-6), 1 - 1e-6);
    const m = (q / (1 - q)) / (p / (1 - p));
    let tot = 0;
    const nw = out.map((w, i) => { const x = (worlds[i] & hb) !== 0 ? w * m : w; tot += x; return x; });
    out = nw.map((x) => x / tot);
  });
  return out;
}

/** Round 35 `beliefRecursiveLeadScope`: does this team pick read the recursive posterior. */
function recursiveLeadInScope(obs: PlayerObservation, scope: number): boolean {
  if (scope <= 0) return true;
  const round = obs.currentRound ?? 1;
  if (scope === 1) return false;
  if (scope === 2) return round === 2 && (obs.questResults ?? [])[0] === 'fail';
  if (scope === 3) return round <= 2;
  if (scope === 5) return round >= 3;
  // 6 = 2，只有派西（第 35 回合量尺：第 1 局失敗之後的第 2 局，派西用遞迴後驗挑隊 +0.06、忠臣 −0.25）。
  if (scope === 6) return obs.myRole === 'percival' && round === 2 && (obs.questResults ?? [])[0] === 'fail';
  return round === 2;
}

/** 鐵咬: the bit of the one member of the last failed mission before `v`'s round that `v`'s team drops (off the team, not the leader); 0 = none. */
function biteSeatBit(obs: PlayerObservation, v: PlayerObservation['voteHistory'][number], bit: (id: string) => number): number {
  const failed = obs.questHistory.filter((q) => q.round < v.round && obs.questResults[q.round - 1] === 'fail');
  const last = failed[failed.length - 1];
  if (!last) return 0;
  const out = last.team.filter((id) => !v.team.includes(id));
  if (out.length !== 1 || out[0] === v.leader || out[0] === obs.myPlayerId) return 0;
  return bit(out[0]);
}

const shareCache = new WeakMap<Posterior, Map<string, number>>();

/**
 * How the blues read the Merlin candidate's doomed R1–R2 proposals: strictly (`merlinLoyalStyle`: from the seen-clean pool), or —
 * round 22 `merlinDoomedPublic` ≥ 2, where Merlin follows the public view there — as a generic blue's (2), half and half
 * (2 + `merlinDoomedPublicHalf`), or generic in R1 only (3) / R2 only (4).
 */
function merlinEarlyOptions(t: Readonly<Partial<AgentTuning>>): Pick<BayesOptions, 'merlinEarlyStrict' | 'merlinEarlyMix' | 'merlinEarlyMixRound'> {
  const strict = t.merlinLoyalStyle === true;
  const m = t.merlinDoomedPublic ?? 0;
  // Round 24 `merlinDoomedAvoidMix`: a share q strict, 1 − q generic (Merlin's `merlinDoomedAvoid` teams sometimes hold a seen red).
  const q = t.merlinDoomedAvoidMix ?? 0;
  if (strict && m === 0 && q > 0 && q < 1) return { merlinEarlyStrict: true, merlinEarlyMix: q };
  if (!strict || m < 2) return { merlinEarlyStrict: strict, merlinEarlyMix: 1 };
  if (m >= 3) return { merlinEarlyStrict: true, merlinEarlyMix: t.merlinDoomedPublicHalf === true ? 0.5 : 0, merlinEarlyMixRound: m === 3 ? 1 : 2 };
  if (t.merlinDoomedPublicHalf === true) return { merlinEarlyStrict: true, merlinEarlyMix: 0.5 };
  return { merlinEarlyStrict: false, merlinEarlyMix: 1 };
}

/**
 * Round 26 `beliefTemper`: α in (0, 1] tempers the vote terms; a value ≥ 10 is two digits — tens = vote α × 10, ones = proposal α × 10
 * (57 = votes 0.5, proposals 0.7; a 0 digit = 1). 0 = off.
 */
function temperOf(x: number): Pick<BayesOptions, 'voteTemper' | 'proposalTemper'> {
  if (!(x > 0)) return {};
  if (x <= 1) return { voteTemper: x };
  const v = Math.floor(x / 10) / 10;
  const pp = (Math.round(x) % 10) / 10;
  return { voteTemper: v > 0 ? v : 1, proposalTemper: pp > 0 ? pp : 1 };
}

/** The posterior options a seat's tuning asks for (one place for every caller). */
export function bayesOptionsOf(t: Readonly<Partial<AgentTuning>>): BayesOptions {
  return {
    thumbRoles: t.bayesThumbRoles === true,
    strictMerlin: t.percivalThumbLogic === true,
    merlinMixture: t.loyalMerlinRead ?? 0,
    zoneMerlin: t.merlinZoneSignal === true,
    ...merlinEarlyOptions(t),
    botTables: t.beliefBotTables ?? 0,
    botTablesNext: t.beliefBotTablesNext === true,
    botMissionNext: t.beliefBotMissionNext === true,
    keyVoteCells: t.beliefKeyVoteCells === true,
    morganaR1: t.percivalMorganaR1 === true,
    redAloneCells: t.beliefRedAloneCells === true,
    biteCell: t.beliefBiteCell ?? 0,
    strongTables: t.beliefStrongTables === true,
    ...(t.beliefLeadStrong === true ? { leadStrongTables: true } : {}),
    ...((t.beliefStrongParts ?? 0) > 0 ? { strongParts: t.beliefStrongParts } : {}),
    policyVotes: t.beliefPolicyVotes === true,
    // Level 0 of the recursive reader never reads the pending proposal (round 39 review): its voter views (`infl/flow.ts`
    // `seatViewObs`) carry no `seatTeam`, so the blue-only gate would pass for every voter, red seats' readings included, and the
    // recursive vote model was fitted on level-0 features without it.
    ...((t.beliefRecursive ?? 0) > 0 ? { recursive: t.beliefRecursive, recursiveLevel0: bayesOptionsOf({ ...t, beliefRecursive: 0, beliefLeadRecursive: 0, ownView: 0, ownViewKeep: 0, beliefPendingProposal: false, beliefLakeCal40: 0, beliefLakeIso41: 0 }), ...(t.beliefRecursiveNoLead === true ? { recursiveNoLead: true } : {}), ...((t.beliefRecursiveLeadScope ?? 0) > 0 ? { recursiveLeadScope: t.beliefRecursiveLeadScope } : {}) } : {}),
    ...((t.beliefRecursive ?? 0) <= 0 && (t.beliefLeadRecursive ?? 0) > 0
      ? { leadRecursive: t.beliefLeadRecursive, recursiveLevel0: bayesOptionsOf({ ...t, beliefRecursive: 0, beliefLeadRecursive: 0, ownView: 0, ownViewKeep: 0, beliefPendingProposal: false, beliefLakeCal40: 0, beliefLakeIso41: 0 }), ...((t.beliefRecursiveLeadScope ?? 0) > 0 ? { recursiveLeadScope: t.beliefRecursiveLeadScope } : {}), ...((t.beliefLeadBlend ?? 0) > 0 ? { leadBlend: t.beliefLeadBlend } : {}) } : {}),
    ...temperOf(t.beliefTemper ?? 0),
    ...leadTemperOf(t.beliefLeadTemper ?? 0),
    ...((t.ownView ?? 0) > 0 || (t.ownViewKeep ?? 0) > 0 ? { ownView: { sigma: t.ownView ?? 0, keep: t.ownViewKeep ?? 0, scope: Math.max(1, t.ownViewScope ?? 0), maxRound: t.ownViewRounds ?? 0 } } : {}),
    // Retired in round 39: not combined with `percivalRead39` (the round-39 read keeps the two-fail-card evidence it erased).
    ...(t.beliefThumbNoStain === true && !((t.percivalRead39 ?? 0) > 0) ? { thumbNoStain: true } : {}),
    ...(t.percivalRead39 === 1 ? { thumbRead39: true } : {}),
    ...(t.beliefPendingProposal === true ? { pendingProposal: true } : {}),
    ...((t.beliefLakeCal40 ?? 0) > 0 && t.beliefLakeCal40 !== 1 ? { lakeCal: t.beliefLakeCal40 } : {}),
    ...((t.beliefLakeIso41 ?? 0) > 0 ? { lakeIso: true } : {}),
  };
}

/** Round 28 `beliefLeadTemper`: the same encoding as `beliefTemper` (1 = untempered) for team picks; 0 = off (the team pick reads as the votes do). */
function leadTemperOf(x: number): Pick<BayesOptions, 'leadVoteTemper' | 'leadProposalTemper'> {
  if (!(x > 0)) return {};
  const t = temperOf(x);
  return { leadVoteTemper: t.voteTemper ?? 1, leadProposalTemper: t.proposalTemper ?? 1 };
}

/**
 * Round 30 `goodLakeEntropy`: the posterior's worlds (red-set bitmasks over the viewer's seats) and their weights, plus the
 * probability a RED holder declares "evil" about a target (the red-lake cell the posterior reads; a good holder is truthful).
 */
export function bayesWorlds(obs: PlayerObservation, opts: Readonly<BayesOptions> = {}): { worlds: readonly number[]; wts: readonly number[]; bitOf: (id: string) => number; redLakeEvil: (targetRed: boolean) => number } {
  const post = posterior(obs, opts);
  const strong = opts.strongTables === true;
  const redLakeEvil = (targetRed: boolean): number => {
    const prev = mixArgs;
    useMix(Math.min(Math.max(opts.botTables ?? 0, 0), 1), opts.botTablesNext === true, opts.botMissionNext === true, strong, opts.strongParts ?? 15);
    try { return redLakeProb(targetRed); } finally { useMix(...prev); }
  };
  return { worlds: post.worlds, wts: post.wts, bitOf: post.bitOf, redLakeEvil };
}

/**
 * Round 35: every seat's role posterior under the role-mixture reader (`recursive` ≥ 4): P(Merlin), P(Percival), P(red), P(Oberon) — the
 * posterior's world weights times the role assignments inside each world. null when the options do not use the role mixture.
 */
export function bayesRoleShares(obs: PlayerObservation, opts: Readonly<BayesOptions>): Map<string, RoleShare> | null {
  const rec = opts.recursive ?? 0;
  if (rec < 4) return null;
  const post = posterior(obs, opts);
  const percival = obs.myRole === 'percival' && (obs.knownWizards ?? []).length === 2;
  const strict = opts.strictMerlin && percival ? obs.knownWizards ?? [] : [];
  return recursiveRoleShares(obs, opts.recursiveLevel0 ?? {}, rec, post.worlds, post.wts, (leader) => strict.includes(leader));
}

/** Posterior P(red) of every seat (the viewer included: 0 or 1). Uniform over L1* when nothing else is known. */
export function bayesRedShare(obs: PlayerObservation, opts: Readonly<BayesOptions> = {}): Map<string, number> {
  const post = posterior(obs, opts);
  const hit = shareCache.get(post);
  if (hit) return hit;
  const out = new Map<string, number>();
  const me = obs.myPlayerId;
  for (const id of obs.allPlayerIds) {
    if (post.worlds.length === 0) { out.set(id, id === me ? (obs.myTeam === 'evil' ? 1 : 0) : 0.5); continue; }
    const b = post.bitOf(id);
    let s = 0;
    post.worlds.forEach((w, i) => { if (w & b) s += post.wts[i]; });
    out.set(id, s);
  }
  shareCache.set(post, out);
  return out;
}

/**
 * Posterior P(no red on `team`) (optimization loop round 3, `goodCleanVote`): the summed weight of the worlds
 * with no red seat on the team. null when there is no world.
 */
export function bayesTeamClean(obs: PlayerObservation, team: readonly string[], opts: Readonly<BayesOptions> = {}): number | null {
  const post = posterior(obs, opts);
  if (post.worlds.length === 0) return null;
  const mask = post.maskOf(team);
  let s = 0;
  post.worlds.forEach((w, i) => { if ((w & mask) === 0) s += post.wts[i]; });
  return s;
}

/** Posterior P(the team holds fewer than `k` reds) — round 24 `goodR4TwoFail` (R4 at 7+ players needs two fail cards). */
export function bayesTeamRedsBelow(obs: PlayerObservation, team: readonly string[], k: number, opts: Readonly<BayesOptions> = {}): number | null {
  const post = posterior(obs, opts);
  if (post.worlds.length === 0) return null;
  const mask = post.maskOf(team);
  let s = 0;
  post.worlds.forEach((w, i) => {
    let x = w & mask;
    let c = 0;
    while (x) { x &= x - 1; c++; }
    if (c < k) s += post.wts[i];
  });
  return s;
}

/**
 * log Σ_{Merlin m, Mordred d} P(m) P(d) Π (Merlin model / generic blue model) over m's R3+ votes (and, strict, its
 * R3+ proposals) — the factor by which "one of the blues is Merlin" re-weighs world `w` (`merlinMixture`).
 */
interface MixPre {
  ids: readonly string[];
  me: string;
  all: number;
  mode: number;
  bits: { id: string; b: number }[];
  late: { v: PlayerObservation['voteHistory'][number]; teamMask: number; leaderBit: number; r3: boolean; voted: boolean; votes: Record<string, boolean> }[];
  early: { v: PlayerObservation['voteHistory'][number]; teamMask: number; prior: PriorProposal[] }[];
  anyByLen: Map<number, number>;
  earlyMix: number;
  mixRound: number;
}

function merlinMixturePre(obs: PlayerObservation, view: ReturnType<typeof buildCertainty>, mode: number, zone: boolean, earlyStrict: boolean, earlyMix = 1, mixRound = 0, skipVotes = false): MixPre {
  const ids = obs.allPlayerIds;
  const me = obs.myPlayerId;
  // With `merlinEarlyStrict` the R1–R2 proposals of the Merlin candidate read with the strict model as well.
  const late = obs.voteHistory.filter((v) => v.round >= 3 || (earlyStrict && mode >= 2 && v.attempt < 5 && v.leader !== me))
    .map((v) => ({ v, teamMask: view.maskOf(v.team), leaderBit: view.bitOf(v.leader), r3: v.round > 2, voted: !skipVotes && v.round >= 3 && v.attempt < 5, votes: v.votes }));
  const early = zone ? obs.voteHistory.filter((v) => v.round <= 2 && v.attempt < 5).map((v) => ({ v, teamMask: view.maskOf(v.team), prior: priorOf(obs, v) })) : [];
  const anyByLen = new Map<number, number>();
  for (const v of obs.voteHistory) anyByLen.set(v.team.length, choose(ids.length - 1, v.team.length - 1));
  return { ids, me, all: view.maskOf(ids), mode, bits: ids.map((id) => ({ id, b: view.bitOf(id) })), late, early, anyByLen, earlyMix, mixRound };
}

/**
 * log Σ_{Merlin m, Mordred d} P(m) P(d) Π (Merlin model / generic blue model) over m's R3+ votes (and, strict, its
 * R3+ proposals) — the factor by which "one of the blues is Merlin" re-weighs world `w` (`merlinMixture`).
 */
function merlinMixtureLog(pre: MixPre, w: number): number {
  const { ids, me, all, mode } = pre;
  const sizeOf = (x: number): number => { let c = 0; while (x) { x &= x - 1; c++; } return c; };
  const blues = pre.bits.filter((x) => x.id !== me && (w & x.b) === 0);
  const reds = pre.bits.filter((x) => (w & x.b) !== 0);
  if (blues.length === 0 || reds.length === 0) return 0;
  let sum = 0;
  for (const m of blues) {
    const others = all & ~m.b;
    const redsAvail = sizeOf(w & others);
    const goodsAvail = sizeOf(others) - redsAvail;
    for (const d of reds) {
      let lr = 0;
      // Zone-cutting Merlin's R1–R2 non-forced proposals vs the generic blue proposal.
      for (const e of pre.early) {
        const v = e.v;
        if (v.leader !== m.id || (e.teamMask & m.b) === 0) continue;
        const k = sizeOf(w & e.teamMask & ~m.b);
        const n = choose(redsAvail, k) * choose(goodsAvail, v.team.length - 1 - k);
        if (n <= 0) continue;
        const generic = proposalProb('good', v.round, k) / n;
        lr += zoneLog(ids, m.id, v.team, new Set(reds.filter((r) => r.id !== d.id).map((r) => r.id)), e.prior) - Math.log(generic);
      }
      for (const x of pre.late) {
        const v = x.v;
        const teamMask = x.teamMask;
        const seenRed = (w & teamMask & ~d.b) !== 0;
        const hasRed = (w & teamMask) !== 0;
        const on = (teamMask & m.b) !== 0;
        const vote = x.votes[m.id];
        if (x.voted && vote !== undefined) {
          const pg = voteProb('good', on, hasRed, v.round, true);
          let pm: number;
          if (mode >= 2) {
            pm = seenRed ? STRICT_EPS : voteProb('good', on, false, v.round, true);
          } else {
            pm = voteProb('merlin', on, seenRed, v.round, true);
          }
          pm = Math.min(Math.max(pm, STRICT_EPS), 1 - STRICT_EPS);
          lr += Math.log(vote ? pm / pg : (1 - pm) / (1 - pg));
        }
        if (mode >= 2 && v.leader === m.id && on) {
          // Generic blue proposal vs the strict Merlin pick from the seen-clean pool (the blues + Mordred d).
          const k = sizeOf(w & teamMask & ~m.b);
          const n = choose(redsAvail, k) * choose(goodsAvail, v.team.length - 1 - k);
          if (n <= 0) continue;
          const generic = proposalProb('good', v.round, k) / n;
          const pool = goodsAvail + 1;
          const strict = seenRed ? STRICT_EPS / (pre.anyByLen.get(v.team.length) ?? choose(ids.length - 1, v.team.length - 1)) : 1 / choose(pool, v.team.length - 1);
          // `merlinEarlyMix`: the doomed R1–R2 proposals mix the strict pick with the generic one.
          const mixed = pre.earlyMix < 1 && v.round <= 2 && v.attempt < 5 && (pre.mixRound === 0 || v.round === pre.mixRound);
          lr += Math.log(mixed ? pre.earlyMix * strict / generic + (1 - pre.earlyMix) : strict / generic);
        }
      }
      sum += Math.exp(lr);
    }
  }
  return Math.log(sum / (blues.length * reds.length));
}

/**
 * Round 33 `loyalR1Spread=3`: P(approve | camp, on the team, the team holds a red, round) from the vote cells the posterior `opts` reads
 * (strong tables when on) — the information-value pick of an R1 talk proposal asks how the table's votes would split in each world.
 */
export function bayesVoteCell(opts: Readonly<BayesOptions>, camp: 'good' | 'evil', on: boolean, hasRed: boolean, round: number): number {
  const prev = mixArgs;
  useMix(Math.min(Math.max(opts.botTables ?? 0, 0), 1), opts.botTablesNext === true, opts.botMissionNext === true, opts.strongTables === true, opts.strongParts ?? 15);
  try { return voteProb(camp, on, hasRed, round, true); } finally { useMix(...prev); }
}

/** P(vote) of a generic blue voter (the human vote table), for callers outside the posterior (the assassin). */
export function genericGoodVoteProb(on: boolean, hasRed: boolean, round: number, approve: boolean): number {
  return voteProb('good', on, hasRed, round, approve);
}

/** The proposals on the table before `v` by other leaders (R1–R2, for 延伸／修正). */
function priorOf(obs: PlayerObservation, v: PlayerObservation['voteHistory'][number]): PriorProposal[] {
  const at = obs.voteHistory.indexOf(v);
  return obs.voteHistory.slice(0, Math.max(0, at)).filter((p) => p.round <= 2 && p.leader !== v.leader).map((p) => ({ leader: p.leader, team: p.team }));
}

/** Memoized `zoneTeamLogProb` (the same leader / team / seen set / prior recurs across worlds and Merlin candidates). */
const zoneMemo = new Map<string, number>();
function zoneLog(order: readonly string[], leader: string, team: readonly string[], seen: ReadonlySet<string>, prior: readonly PriorProposal[] = []): number {
  const priorKey = prior.map((p) => `${p.leader}:${[...p.team].sort().join('.')}`).join(';');
  const key = `${order.length}|${leader}|${[...team].sort().join(',')}|${[...seen].sort().join(',')}|${priorKey}`;
  let v = zoneMemo.get(key);
  if (v === undefined) {
    v = zoneTeamLogProb(order, leader, team, seen, prior);
    if (zoneMemo.size > 200000) zoneMemo.clear();
    zoneMemo.set(key, v);
  }
  return v;
}
