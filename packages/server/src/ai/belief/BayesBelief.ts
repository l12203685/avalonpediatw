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

interface Table {
  vote: Record<string, [number, number]>;
  proposal: Record<string, number>;
  voteRole: Record<string, [number, number]>;
  proposalRole: Record<string, number>;
  mission: Record<string, number[]>;
  redLake: Record<string, [number, number]>;
}
const T = TABLE as unknown as Table;
/** The same tables fitted on bot self-play (`scripts/fitBeliefLikelihoods.ts --bots`; `BayesOptions.botTables`). */
const TB = BOT_TABLE as unknown as Table;
/**
 * The bot-table weight of the posterior being computed (`BayesOptions.botTables`; 0 = the human tables alone). Set by
 * `posterior()` for the duration of one synchronous computation, so the helpers below read it without threading it.
 */
let mix = 0;
const blend = (human: number, bot: number): number => (mix > 0 ? (1 - mix) * human + mix * bot : human);

/**
 * Memo of the blended table lookups for the current `mix` (the posterior asks the same few hundred cells millions of
 * times per game; building the string keys was ~40% of a game's CPU). Pure cache: same numbers as the uncached path.
 */
interface ProbMemo { vote: Float64Array; voteLog: Float64Array; proposal: Float64Array; mission: Float64Array }
const memos = new Map<number, ProbMemo>();
const newMemo = (): ProbMemo => ({ vote: new Float64Array(32).fill(NaN), voteLog: new Float64Array(64).fill(NaN), proposal: new Float64Array(48).fill(NaN), mission: new Float64Array(216).fill(NaN) });
let memo: ProbMemo = newMemo();
memos.set(0, memo);
function useMix(m: number): void {
  mix = m;
  let x = memos.get(m);
  if (!x) { x = newMemo(); memos.set(m, x); }
  memo = x;
}
const CAMP_INDEX: Record<string, number> = { good: 0, evil: 1, merlin: 2, morgana: 3 };

const bucket = (round: number): string => (round <= 2 ? 'r12' : 'r3');
const smooth = (hit: number, n: number): number => (hit + 1) / (n + 2);

/** `camp` = 'good' | 'evil', or a role key 'merlin' | 'morgana' (the role tables, Percival's thumbs). */
function voteProbIn(t: Table, camp: string, on: boolean, hasRed: boolean, round: number): number {
  const key = `${camp}|${on ? 'on' : 'off'}|${hasRed ? 'red' : 'clean'}|${bucket(round)}`;
  const c = (camp === 'merlin' || camp === 'morgana' ? t.voteRole[key] : t.vote[key]) ?? [1, 2];
  return smooth(c[0], c[1]);
}

const CAMP_NAMES = ['good', 'evil', 'merlin', 'morgana'] as const;
/** log P(vote) by camp index (good 0, evil 1, merlin 2, morgana 3) — the memoized form of `Math.log(voteProb(…))`. */
function voteLogIx(ci: number, on: boolean, hasRed: boolean, r3: boolean, approve: boolean): number {
  const idx = (ci << 4) | (on ? 8 : 0) | (hasRed ? 4 : 0) | (r3 ? 2 : 0) | (approve ? 1 : 0);
  let lp = memo.voteLog[idx];
  if (Number.isNaN(lp)) {
    lp = Math.log(voteProb(CAMP_NAMES[ci], on, hasRed, r3 ? 3 : 1, approve));
    memo.voteLog[idx] = lp;
  }
  return lp;
}

function proposalProbIx(ci: number, r3: boolean, k: number): number {
  return proposalProb(CAMP_NAMES[ci], r3 ? 3 : 1, k);
}

function voteProb(camp: string, on: boolean, hasRed: boolean, round: number, approve: boolean): number {
  const ci = CAMP_INDEX[camp];
  const idx = ci === undefined ? -1 : (ci << 3) | (on ? 4 : 0) | (hasRed ? 2 : 0) | (round <= 2 ? 0 : 1);
  let p = idx >= 0 ? memo.vote[idx] : NaN;
  if (Number.isNaN(p)) {
    p = blend(voteProbIn(T, camp, on, hasRed, round), voteProbIn(TB, camp, on, hasRed, round));
    if (idx >= 0) memo.vote[idx] = p;
  }
  return approve ? p : 1 - p;
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
    p = blend(proposalProbIn(T, camp, round, k), proposalProbIn(TB, camp, round, k));
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
    p = blend(missionProbIn(T, round, reds, fails), missionProbIn(TB, round, reds, fails));
    if (idx >= 0) memo.mission[idx] = p;
  }
  return p;
}

function redLakeProb(targetRed: boolean): number {
  const at = (t: Table): number => { const c = t.redLake[targetRed ? 'evil' : 'good'] ?? [1, 2]; return smooth(c[0], c[1]); };
  return blend(at(T), at(TB));
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
}

/** Near-impossible event under the strict-Merlin model. */
const STRICT_EPS = 0.03;

function posterior(obs: PlayerObservation, opts: Readonly<BayesOptions>): Posterior {
  useMix(Math.min(Math.max(opts.botTables ?? 0, 0), 1));
  try {
    return posteriorWith(obs, opts);
  } finally {
    useMix(0);
  }
}

function posteriorWith(obs: PlayerObservation, opts: Readonly<BayesOptions>): Posterior {
  const percival = obs.myRole === 'percival' && (obs.knownWizards ?? []).length === 2;
  const thumbs = opts.thumbRoles && percival ? obs.knownWizards ?? [] : [];
  const strict = opts.strictMerlin && percival ? obs.knownWizards ?? [] : [];
  const mixMode = obs.myRole === 'loyal' && obs.myTeam === 'good' ? opts.merlinMixture ?? 0 : 0;
  const zone = opts.zoneMerlin === true;
  const early = opts.merlinEarlyStrict === true;
  const key = `${thumbs.length > 0 ? 't' : ''}${strict.length > 0 ? 's' : ''}${mixMode > 0 ? `m${mixMode}` : ''}${zone ? 'z' : ''}${early ? 'e' : ''}${mix > 0 ? `b${mix}` : ''}`;
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
  // Everything that does not depend on the world, computed once (the world loop below runs it for every world).
  const pre = obs.voteHistory.map((v) => {
    const teamMask = view.maskOf(v.team);
    return {
      v,
      teamMask,
      leaderBit: bit(v.leader),
      leaderOn: v.team.includes(v.leader),
      doomed: v.round <= 2 && v.attempt < 5 && !early,
      r3: v.round > 2,
      voters: v.attempt >= 5 ? [] : ids.filter((id) => id !== me && v.votes[id] !== undefined)
        .map((id) => ({ b: bit(id), on: v.team.includes(id), yes: v.votes[id] === true, raw: v.votes[id] })),
    };
  });
  const quests = obs.questHistory.map((q) => ({ round: q.round, mask: view.maskOf(q.team), fails: q.failCount ?? 0 }));
  const lakes = (obs.lakeHistory ?? []).filter((l) => l.declaredClaim !== 'none' && l.holderId !== me)
    .map((l) => ({ hb: bit(l.holderId), tb: bit(l.targetId), evil: l.declaredClaim === 'evil' }));
  const mixPre = mixMode > 0 ? merlinMixturePre(obs, view, mixMode, zone, early) : null;
  const logW = worlds.map((w) => {
    const red = (id: string): boolean => (w & bit(id)) !== 0;
    // Percival's thumbs: the good one is Merlin, the red one Morgana (in this world). Camp index: good 0, evil 1, merlin 2, morgana 3.
    const campIx = (b: number): number => ((thumbMask & b) !== 0 ? ((w & b) !== 0 ? 3 : 2) : (w & b) !== 0 ? 1 : 0);
    let lp = 0;
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
          lp += Math.log(zs / Math.max(1, reds.length));
        } else if (!p.doomed) {
          const k = sizeOf(w & teamMask);
          const reds = sizeOf(w & all);
          const pool = ids.length - 1 - (reds - 1); // the blues + the unseen Mordred
          const n = choose(pool, v.team.length - 1);
          // Probabilities of this exact team: ε spread over every possible team when Merlin could not pick it.
          const any = choose(ids.length - 1, v.team.length - 1);
          lp += Math.log(k >= 2 || n === 0 ? STRICT_EPS / any : (k === 1 ? 1 / reds : 1) / n);
        }
      } else if (v.leader !== me && p.leaderOn) {
        // Proposal (the leader on its own team; not the viewer's own).
        const others = all & ~p.leaderBit;
        const redsAvail = sizeOf(w & others);
        const goodsAvail = sizeOf(others) - redsAvail;
        const k = sizeOf(w & teamMask & ~p.leaderBit);
        const n = choose(redsAvail, k) * choose(goodsAvail, v.team.length - 1 - k);
        if (n > 0) lp += Math.log(proposalProbIx(campIx(p.leaderBit), p.r3, k) / n);
      }
      // Votes (no vote on the forced fifth proposal: `voters` is empty there).
      for (const x of p.voters) {
        if ((strictMask & x.b) !== 0 && (w & x.b) === 0 && p.r3) {
          // Strict Merlin: approves a team with a red it sees all but never (one red: Mordred with 1/reds).
          const k = sizeOf(w & teamMask);
          const pClean = voteProb('good', x.on, false, 3, true);
          const pYes = k === 0 ? pClean : k === 1 ? pClean / sizeOf(w & all) + STRICT_EPS : STRICT_EPS;
          lp += Math.log(x.raw ? Math.min(pYes, 1 - STRICT_EPS) : 1 - Math.min(pYes, 1 - STRICT_EPS));
          continue;
        }
        lp += voteLogIx(campIx(x.b), x.on, hasRed, p.r3, x.yes);
      }
    }
    for (const q of quests) {
      const p = missionProb(q.round, sizeOf(w & q.mask), q.fails);
      lp += p > 0 ? Math.log(p) : -1e9;
    }
    if (mixPre) lp += merlinMixtureLog(mixPre, w);
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

const shareCache = new WeakMap<Posterior, Map<string, number>>();

/** The posterior options a seat's tuning asks for (one place for every caller). */
export function bayesOptionsOf(t: Readonly<Partial<AgentTuning>>): BayesOptions {
  return {
    thumbRoles: t.bayesThumbRoles === true,
    strictMerlin: t.percivalThumbLogic === true,
    merlinMixture: t.loyalMerlinRead ?? 0,
    zoneMerlin: t.merlinZoneSignal === true,
    merlinEarlyStrict: t.merlinLoyalStyle === true,
    botTables: t.beliefBotTables ?? 0,
  };
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
}

function merlinMixturePre(obs: PlayerObservation, view: ReturnType<typeof buildCertainty>, mode: number, zone: boolean, earlyStrict: boolean): MixPre {
  const ids = obs.allPlayerIds;
  const me = obs.myPlayerId;
  // With `merlinEarlyStrict` the R1–R2 proposals of the Merlin candidate read with the strict model as well.
  const late = obs.voteHistory.filter((v) => v.round >= 3 || (earlyStrict && mode >= 2 && v.attempt < 5 && v.leader !== me))
    .map((v) => ({ v, teamMask: view.maskOf(v.team), leaderBit: view.bitOf(v.leader), r3: v.round > 2, voted: v.round >= 3 && v.attempt < 5, votes: v.votes }));
  const early = zone ? obs.voteHistory.filter((v) => v.round <= 2 && v.attempt < 5).map((v) => ({ v, teamMask: view.maskOf(v.team), prior: priorOf(obs, v) })) : [];
  const anyByLen = new Map<number, number>();
  for (const v of obs.voteHistory) anyByLen.set(v.team.length, choose(ids.length - 1, v.team.length - 1));
  return { ids, me, all: view.maskOf(ids), mode, bits: ids.map((id) => ({ id, b: view.bitOf(id) })), late, early, anyByLen };
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
          lr += Math.log(strict / generic);
        }
      }
      sum += Math.exp(lr);
    }
  }
  return Math.log(sum / (blues.length * reds.length));
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
