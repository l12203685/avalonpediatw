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
import { recursiveLogs } from '../infl/recursiveRead';

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
   * information in the world). 1 = votes and proposals, 2 = votes only, 3 = proposals only. Replaces the vote / proposal cells it covers.
   */
  recursive?: number;
  /** With `recursive`: the level-0 options j's own posterior is computed with (the same options without `recursive`). */
  recursiveLevel0?: BayesOptions;
  /** Round 33 `beliefLeadRecursive`: the recursive mode while the viewer picks a team (`gamePhase` team_select) only. */
  leadRecursive?: number;
  /** Round 34 `beliefRecursiveNoLead`: with `recursive`, a team pick (`gamePhase` team_select) still reads with the level-0 posterior. */
  recursiveNoLead?: boolean;
}

/** Near-impossible event under the strict-Merlin model. */
const STRICT_EPS = 0.03;

function posterior(obs: PlayerObservation, opts: Readonly<BayesOptions>): Posterior {
  const strong = opts.strongTables === true || (opts.leadStrongTables === true && obs.gamePhase === 'team_select');
  const prev = mixArgs;
  useMix(Math.min(Math.max(opts.botTables ?? 0, 0), 1), opts.botTablesNext === true, opts.botMissionNext === true, strong, opts.strongParts ?? 15);
  try {
    return posteriorWith(obs, opts);
  } finally {
    useMix(...prev);
  }
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
  const rec = opts.recursive !== undefined ? (opts.recursiveNoLead === true && picking ? 0 : opts.recursive)
    : ((opts.leadRecursive ?? 0) > 0 && picking ? opts.leadRecursive! : 0);
  const recVotes = rec === 1 || rec === 2;
  const recProps = rec === 1 || rec === 3;
  // Without tempering every term goes straight into lp in record order (the same floating-point sums as before round 26).
  const tempered = temperV < 1 || temperP < 1;
  const key = `${rec > 0 ? `R${rec}` : ''}${policy ? 'Pv' : ''}${temperV < 1 ? `V${temperV}` : ''}${temperP < 1 ? `P${temperP}` : ''}${biteMode > 0 ? `B${biteMode}` : ''}${aloneCells ? 'A' : ''}${morganaR1 ? 'g' : ''}${thumbs.length > 0 ? 't' : ''}${strict.length > 0 ? 's' : ''}${mixMode > 0 ? `m${mixMode}` : ''}${zone ? 'z' : ''}${early ? 'e' : ''}${earlyMix < 1 ? `q${earlyMix}r${mixRound}` : ''}${keyCells ? 'k' : ''}${mix > 0 ? `b${mix}${TB === TB_NEXT ? 'n' : TBM === TB_NEXT ? 'M' : ''}` : ''}${partsKey > 0 ? `S${partsKey}` : ''}${mixV !== mix || mixP !== mix ? `v${mixV}p${mixP}m${mixM}l${mixL}` : ''}`;
  let store = caches.get(key);
  if (!store) { store = new WeakMap(); caches.set(key, store); }
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
  const pre = obs.voteHistory.map((v) => {
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
  const mixPre = mixMode > 0 ? merlinMixturePre(obs, view, mixMode, zone, early, earlyMix, mixRound, policy || recVotes) : null;
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
      } else if (v.leader !== me && p.leaderOn && (!recProps || (strictMask & p.leaderBit) !== 0)) {
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
      lp += Math.log(l.evil ? p : 1 - p);
    }
    return lp;
  });
  let wts: number[] = [];
  if (worlds.length > 0) {
    const max = Math.max(...logW);
    const raw = logW.map((x) => Math.exp(x - max));
    const tot = raw.reduce((a, b) => a + b, 0);
    wts = raw.map((x) => x / tot);
  }
  const out: Posterior = { worlds, wts, bitOf: bit, maskOf: (t) => view.maskOf(t) };
  store.set(obs, out);
  return out;
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
    ...((t.beliefRecursive ?? 0) > 0 ? { recursive: t.beliefRecursive, recursiveLevel0: bayesOptionsOf({ ...t, beliefRecursive: 0, beliefLeadRecursive: 0 }), ...(t.beliefRecursiveNoLead === true ? { recursiveNoLead: true } : {}) } : {}),
    ...((t.beliefRecursive ?? 0) <= 0 && (t.beliefLeadRecursive ?? 0) > 0
      ? { leadRecursive: t.beliefLeadRecursive, recursiveLevel0: bayesOptionsOf({ ...t, beliefRecursive: 0, beliefLeadRecursive: 0 }) } : {}),
    ...temperOf(t.beliefTemper ?? 0),
    ...leadTemperOf(t.beliefLeadTemper ?? 0),
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
