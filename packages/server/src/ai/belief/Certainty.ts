/**
 * Certainty — the shared 0/1 world filter of the logic-first plan (S1-0,
 * 2026-10-14; docs/ai/logic_first.md, plan §2.0).
 *
 * A *world* is a set of red seats (a bitmask over `obs.allPlayerIds`; with
 * 10 players and 4 reds there are C(10,4) = 210). A world is *consistent*
 * with what a seat knows when it violates none of the facts below; a fact
 * is certain when it holds in every consistent world. No likelihoods here —
 * this layer only removes worlds (the probability layer lives elsewhere;
 * `GoodLakeInfo` weights these same worlds).
 *
 * Levels:
 *   L0 — game rules + the viewer's own view, nothing else:
 *        - own camp (a good viewer is not red, a red viewer is);
 *        - role sight: `knownEvils` are red (Merlin sees every red but
 *          Mordred, a seeing red sees its teammates but Oberon); Percival's
 *          two thumbs hold exactly one red (one thumb = Morgana is off in
 *          the lobby → the lone thumb is Merlin, certainly good);
 *        - C2: a mission with x fail cards had at least x reds on it — this
 *          reads `failCount`, so an R4 success with a fail card still
 *          proves a red (C5);
 *        - the viewer's own private lake results (`myLakeResults`; P2).
 *   L1 — L0 + axiom A0 "a good lake holder declares the truth", hard
 *        (GM decision D1): for every public declaration (holder H, target
 *        T, claim c), worlds where H is good must have T's camp = c. An
 *        undeclared lake (`declaredClaim: 'none'`) adds nothing here.
 *        When A0 leaves no world (a human good holder lied, or the record
 *        is wrong; about 0.8% of the 牌譜 games) the caller falls back to
 *        L0 (`l1Empty`, level `'L1*'`) and the invariant harness logs it.
 *        Two more table conventions live at L1 (Edward 2026-10-26):
 *        - A1 "no stalling": once two missions have failed, reds who can
 *          fail a mission do (the third fail wins), so a later success
 *          holds fewer reds than that round's fails required (one-fail
 *          rounds: no red at all);
 *        - A2 "return the lake" (還湖): a holder the previous lake declared
 *          red, who could lake a publicly certain-good seat and lakes
 *          someone else, admits being red (認壞). It says nothing about
 *          the accuser (`returnLakeOptions`).
 *
 * Parameters (critique M8): player count, number of reds (the lobby's role
 * setup — `obs.evilCount` when the server provides it, otherwise the
 * standard table), fails required per round (10p: 1/1/1/2/1), and
 * Percival's `knownWizards.length` (Morgana on / off). Nothing assumes a
 * 10-player game.
 *
 * Outputs: `worlds(level)`, `certRed` / `certGood`, `minReds(team)`,
 * `failsRequired(round)`, `provablyFailable(team)` (minReds at L1* ≥ fails
 * required — X1: R4 needs two certain reds), `strictlyDominated(team)` (K1′
 * with the strictness of X4, applied pairwise so chains close: A→B→C), and
 * `entropyBits(level)` = log2 |worlds| (logic_audit.md §2.6).
 *
 * Pure and deterministic; a few µs per observation (210 masks × the
 * missions and lakes).
 */

import { AVALON_CONFIG } from '@avalon/shared';
import type { LakePublicRecord, PlayerObservation } from '../types';
import { evilCountFor, popcount } from '../worlds';

// ── Parameters ─────────────────────────────────────────────────

// evilCountFor / popcount 住在 ../worlds.ts（模擬瓦與確定性層共用）；這裡轉出口，
// 讓既有的 import 不用改。
export { evilCountFor, popcount };

/**
 * ε of the probability layer (GM decision D1, 2026-10-14): a fact that
 * holds only under A0 ("a good lake holder tells the truth") is pinned to
 * 1 − ε / ε in the beliefs (S1-1), and INV-B2 requires certain reds at
 * ≥ 1 − ε and certain goods at ≤ ε. One constant, so the pin and the check
 * are bit-identical.
 */
export const CERTAINTY_EPS = 0.01;

export interface CertaintyParams {
  playerCount: number;
  /** Reds in this game (public lobby setup). */
  evilCount: number;
  /** failsRequired[round - 1]. */
  failsRequired: readonly number[];
}

/** Parameters of the game `obs` belongs to. */
export function certaintyParamsFor(obs: PlayerObservation): CertaintyParams {
  return {
    playerCount: obs.playerCount,
    evilCount: obs.evilCount ?? evilCountFor(obs.playerCount),
    failsRequired: AVALON_CONFIG[obs.playerCount]?.questFailsRequired ?? [1, 1, 1, 1, 1],
  };
}

/** Fail cards needed to fail `round` (1 when unknown). */
export function failsRequiredFor(params: CertaintyParams, round: number): number {
  return params.failsRequired[round - 1] ?? 1;
}

// ── Bits ───────────────────────────────────────────────────────

/** Lake records that carry a claim (undeclared lakes say nothing about camps). */
export function declaredLakes(
  lakes: readonly LakePublicRecord[] | undefined,
): Array<LakePublicRecord & { declaredClaim: 'good' | 'evil' }> {
  return (lakes ?? []).filter(
    (l): l is LakePublicRecord & { declaredClaim: 'good' | 'evil' } =>
      l.declaredClaim === 'good' || l.declaredClaim === 'evil',
  );
}

// ── Enumeration ────────────────────────────────────────────────

export interface WorldOptions {
  /**
   * The viewer's own seat: `'own'` = its real camp (`obs.myTeam`), `'good'`
   * = assumed good (GoodLakeInfo's holder pictures), `'free'` = no
   * constraint (the public picture).
   */
  self: 'own' | 'good' | 'free';
  /** Role sight: `knownEvils` are red; Percival's thumbs. */
  sight: boolean;
  /** The viewer's own private lake results (`obs.myLakeResults`). */
  ownLakeResults: boolean;
  /** Public lake declarations under A0 (level L1). */
  lakes: boolean;
}

function combinations(pool: readonly number[], k: number, base: number): number[] {
  const out: number[] = [];
  if (k < 0 || k > pool.length) return out;
  const rec = (start: number, left: number, mask: number): void => {
    if (left === 0) { out.push(mask); return; }
    for (let i = start; i <= pool.length - left; i++) rec(i + 1, left - 1, mask | (1 << pool[i]));
  };
  rec(0, k, base);
  return out;
}

/**
 * Consistent worlds for `obs` under `opts`, as bitmasks over
 * `obs.allPlayerIds`. Order: lexicographic combinations of the seats left
 * after the self constraint (for `self: 'good'` exactly the order the
 * pre-2026-10-14 `GoodLakeInfo.buildWorlds` used, so its floating-point
 * sums are unchanged). Empty for more than 30 players.
 */
export function enumerateWorlds(
  obs: PlayerObservation,
  opts: Readonly<WorldOptions>,
  params: CertaintyParams = certaintyParamsFor(obs),
): number[] {
  const ids = obs.allPlayerIds;
  if (ids.length > 30) return [];
  const idx = new Map(ids.map((id, i) => [id, i]));
  const bit = (id: string): number => {
    const i = idx.get(id);
    return i === undefined ? 0 : 1 << i;
  };
  const selfIdx = idx.get(obs.myPlayerId);
  const nEvil = params.evilCount;

  let selfMode: 'red' | 'good' | 'free' = 'free';
  if (opts.self === 'good') selfMode = 'good';
  else if (opts.self === 'own') selfMode = obs.myTeam === 'evil' ? 'red' : 'good';
  if (selfIdx === undefined) selfMode = 'free';

  let candidates: number[];
  if (selfMode === 'free') {
    candidates = combinations(ids.map((_, i) => i), nEvil, 0);
  } else {
    const pool = ids.map((_, i) => i).filter((i) => i !== selfIdx);
    candidates = selfMode === 'good'
      ? combinations(pool, nEvil, 0)
      : combinations(pool, nEvil - 1, 1 << (selfIdx as number));
  }

  let requiredMask = 0;
  let wizardMask = 0;
  let wizardCount = 0;
  if (opts.sight) {
    for (const id of obs.knownEvils) requiredMask |= bit(id);
    for (const id of obs.knownWizards ?? []) { wizardMask |= bit(id); wizardCount++; }
  }
  const quests = obs.questHistory
    .map((q) => ({ mask: q.team.reduce((m, id) => m | bit(id), 0), fails: q.failCount ?? 0 }))
    .filter((q) => q.fails > 0);
  const own = opts.ownLakeResults
    ? (obs.myLakeResults ?? [])
      .map((r) => ({ target: bit(r.targetId), evil: r.result === 'evil', round: r.round, targetId: r.targetId }))
      .filter((r) => r.target !== 0)
    : [];
  const ownLakeKeys = new Set(own.map((r) => `${r.round}|${r.targetId}`));
  const lakes = opts.lakes
    ? declaredLakes(obs.lakeHistory)
      // The viewer's own declaration is superseded by its private result.
      .filter((l) => !(l.holderId === obs.myPlayerId && ownLakeKeys.has(`${l.round}|${l.targetId}`)))
      .map((l) => ({ holder: bit(l.holderId), target: bit(l.targetId), saysEvil: l.declaredClaim === 'evil' }))
      .filter((l) => l.holder !== 0 && l.target !== 0)
    : [];

  // A1 / A2 (L1, Edward 2026-10-26): caps on successful missions after two fails; admitted reds.
  const caps = opts.lakes ? noStallCaps(obs, params).map((c) => ({ mask: c.team.reduce((m, id) => m | bit(id), 0), max: c.max })) : [];
  // A2 is the table's inference: a good viewer it would name knows better (a human holder who did not
  // return the lake), so it never applies to the viewer's own good seat.
  if (opts.lakes) {
    for (const id of admittedReds(obs)) if (!(selfMode === 'good' && id === obs.myPlayerId)) requiredMask |= bit(id);
  }

  const out: number[] = [];
  for (const mask of candidates) {
    if ((mask & requiredMask) !== requiredMask) continue;
    if (caps.some((c) => popcount(mask & c.mask) > c.max)) continue;
    // Percival: two thumbs = Merlin + Morgana → exactly one red; one thumb
    // (Morgana off in the lobby) = Merlin → good.
    if (wizardCount >= 2 && popcount(mask & wizardMask) !== 1) continue;
    if (wizardCount === 1 && (mask & wizardMask) !== 0) continue;
    let ok = true;
    for (const q of quests) {
      if (popcount(mask & q.mask) < q.fails) { ok = false; break; }
    }
    if (!ok) continue;
    for (const r of own) {
      if (((mask & r.target) !== 0) !== r.evil) { ok = false; break; }
    }
    if (!ok) continue;
    for (const l of lakes) {
      if ((mask & l.holder) !== 0) continue; // a red holder's claim proves nothing
      if (((mask & l.target) !== 0) !== l.saysEvil) { ok = false; break; }
    }
    if (ok) out.push(mask);
  }
  return out;
}

/**
 * A1 "no stalling" (Edward 2026-10-26「任務已經兩局失敗 … 因為不會刻意拖延遊戲, CDEF 必為四好」): every
 * successful mission played after two failed ones holds at most `failsRequired − 1` reds.
 */
export function noStallCaps(
  obs: Pick<PlayerObservation, 'questHistory'>,
  params: Pick<CertaintyParams, 'failsRequired'>,
): Array<{ team: readonly string[]; max: number }> {
  const out: Array<{ team: readonly string[]; max: number }> = [];
  let failed = 0;
  for (const q of [...obs.questHistory].sort((a, b) => a.round - b.round)) {
    // Failed = enough fail cards for its round (INV-B3: never the result field alone; R4 needs two).
    const required = params.failsRequired[q.round - 1] ?? 1;
    const didFail = (q.failCount ?? 0) >= required;
    if (!didFail && failed >= 2) out.push({ team: q.team, max: required - 1 });
    if (didFail) failed += 1;
  }
  return out;
}

/** What the table publicly knew right before lake `k` (missions up to its round, the lakes before it). */
function publicObsBeforeLake(obs: PlayerObservation, k: number): PlayerObservation {
  const lakes = obs.lakeHistory ?? [];
  const round = lakes[k].round;
  return {
    ...obs,
    knownEvils: [],
    knownWizards: undefined,
    myLakeResults: [],
    allEvilIds: undefined,
    allEvilRoles: undefined,
    questHistory: obs.questHistory.filter((q) => q.round <= round),
    lakeHistory: lakes.slice(0, k),
  };
}

/**
 * 還湖 (Edward 2026-10-26): when the holder about to choose was declared red by the previous lake,
 * the publicly certain-good seats it may lake (`validTargets`); empty = nothing to return the lake to.
 */
export function returnLakeOptions(obs: PlayerObservation, holderId: string, validTargets: readonly string[]): string[] {
  const lakes = obs.lakeHistory ?? [];
  const last = lakes[lakes.length - 1];
  if (!last || last.declaredClaim !== 'evil' || last.targetId !== holderId) return [];
  const good = new Set(buildPublicCertainty(obs).certGood('L1*'));
  return validTargets.filter((id) => good.has(id));
}

/**
 * A2: holders who did not return the lake when they could (the previous lake declared them red and a
 * publicly certain-good seat was a valid target) — red at L1.
 */
export function admittedReds(obs: PlayerObservation): string[] {
  const lakes = obs.lakeHistory ?? [];
  const out: string[] = [];
  for (let k = 1; k < lakes.length; k += 1) {
    const prev = lakes[k - 1];
    const cur = lakes[k];
    if (prev.declaredClaim !== 'evil' || prev.targetId !== cur.holderId) continue;
    const used = new Set(lakes.slice(0, k).flatMap((l) => [l.holderId, l.targetId]));
    const valid = obs.allPlayerIds.filter((id) => id !== cur.holderId && !used.has(id));
    const options = returnLakeOptions(publicObsBeforeLake(obs, k), cur.holderId, valid);
    if (options.length > 0 && !options.includes(cur.targetId)) out.push(cur.holderId);
  }
  return out;
}

// ── View ───────────────────────────────────────────────────────

export type CertaintyLevel = 'L0' | 'L1' | 'L1*';

/** A K1′ breach: the team holds `holder` (who declared `target` blue) but not `target`. */
export interface DominanceWitness {
  holder: string;
  target: string;
  /** A member whose swap for `target` strictly raises P(team all good). */
  swap: string;
}

export class CertaintyView {
  readonly params: CertaintyParams;
  readonly ids: readonly string[];
  readonly l0: readonly number[];
  readonly l1: readonly number[];
  /** A0 left no world: level L1* falls back to L0. */
  readonly l1Empty: boolean;
  private readonly index: Map<string, number>;
  private readonly declaredBlue: Array<{ holder: string; target: string }>;
  private readonly allDeclaredBlue: Set<string>;
  /** `holder>target` of the viewer's own red declarations its private lake result contradicts. */
  private readonly ownRedContradicted: Set<string>;
  private readonly cache = new Map<string, { and: number; or: number }>();

  constructor(obs: PlayerObservation, l0: number[], l1: number[], params: CertaintyParams) {
    this.params = params;
    this.ids = obs.allPlayerIds;
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    this.l0 = l0;
    this.l1 = l1;
    this.l1Empty = l1.length === 0;
    // A declared-blue pair binds ("A good ⇒ B good") only where L1 enforces
    // it. The viewer's own declaration is superseded by its private result
    // (`enumerateWorlds`): a seat it declared blue but saw red (a lie, or a
    // wrong record — A0 broken by the viewer itself) vouches for nothing.
    this.allDeclaredBlue = new Set(declaredLakes(obs.lakeHistory)
      .filter((l) => l.declaredClaim === 'good')
      .map((l) => `${l.holderId}>${l.targetId}`));
    const sawRed = new Set((obs.myLakeResults ?? [])
      .filter((r) => r.result === 'evil')
      .map((r) => `${r.round}|${r.targetId}`));
    this.declaredBlue = declaredLakes(obs.lakeHistory)
      .filter((l) => l.declaredClaim === 'good')
      .filter((l) => !(l.holderId === obs.myPlayerId && sawRed.has(`${l.round}|${l.targetId}`)))
      .map((l) => ({ holder: l.holderId, target: l.targetId }));
    // The same for a declared-red pair ("A good ⇒ B red", 2026-10-26 review):
    // the viewer's own red declaration of a seat it privately saw blue binds nothing.
    const sawBlue = new Set((obs.myLakeResults ?? [])
      .filter((r) => r.result === 'good')
      .map((r) => `${r.round}|${r.targetId}`));
    this.ownRedContradicted = new Set(declaredLakes(obs.lakeHistory)
      .filter((l) => l.declaredClaim === 'evil' && l.holderId === obs.myPlayerId && sawBlue.has(`${l.round}|${l.targetId}`))
      .map((l) => `${l.holderId}>${l.targetId}`));
  }

  /**
   * Whether `holder` declaring `target` red binds in this view (L1: holder
   * good ⇒ target red). False only for the viewer's own declaration that its
   * private lake result contradicts (the declared-red twin of `vouches`).
   */
  redPairBinds(holder: string, target: string): boolean {
    return !this.ownRedContradicted.has(`${holder}>${target}`);
  }

  /**
   * Whether `holder` declaring `target` blue binds in this view (L1: holder
   * good ⇒ target good). False only for the viewer's own declaration that
   * its private lake result contradicts; true for every other declared-blue
   * pair (and for pairs that were never declared — callers pass declared ones).
   */
  vouches(holder: string, target: string): boolean {
    return this.declaredBlue.some((p) => p.holder === holder && p.target === target)
      || !this.allDeclaredBlue.has(`${holder}>${target}`);
  }

  worlds(level: CertaintyLevel = 'L1*'): readonly number[] {
    if (level === 'L0') return this.l0;
    if (level === 'L1') return this.l1;
    return this.l1Empty ? this.l0 : this.l1;
  }

  bitOf(id: string): number {
    const i = this.index.get(id);
    return i === undefined ? 0 : 1 << i;
  }

  maskOf(ids: readonly string[]): number {
    return ids.reduce((m, id) => m | this.bitOf(id), 0);
  }

  idsOf(mask: number): string[] {
    return this.ids.filter((_, i) => (mask & (1 << i)) !== 0);
  }

  private andOr(level: CertaintyLevel): { and: number; or: number } {
    const hit = this.cache.get(level);
    if (hit) return hit;
    const ws = this.worlds(level);
    let and = (1 << this.ids.length) - 1;
    let or = 0;
    for (const w of ws) { and &= w; or |= w; }
    const out = ws.length === 0 ? { and: 0, or: 0 } : { and, or };
    this.cache.set(level, out);
    return out;
  }

  /** Seats red in every consistent world (none when no world is consistent). */
  certRedMask(level: CertaintyLevel = 'L1*'): number {
    return this.andOr(level).and;
  }

  /** Seats red in no consistent world (none when no world is consistent). */
  certGoodMask(level: CertaintyLevel = 'L1*'): number {
    if (this.worlds(level).length === 0) return 0;
    return ((1 << this.ids.length) - 1) & ~this.andOr(level).or;
  }

  certRed(level: CertaintyLevel = 'L1*'): string[] { return this.idsOf(this.certRedMask(level)); }
  certGood(level: CertaintyLevel = 'L1*'): string[] { return this.idsOf(this.certGoodMask(level)); }
  isCertRed(id: string, level: CertaintyLevel = 'L1*'): boolean { return (this.certRedMask(level) & this.bitOf(id)) !== 0; }
  isCertGood(id: string, level: CertaintyLevel = 'L1*'): boolean { return (this.certGoodMask(level) & this.bitOf(id)) !== 0; }

  /** min over consistent worlds of |reds on the team|; −1 when no world is consistent. */
  minReds(team: readonly string[], level: CertaintyLevel = 'L1*'): number {
    const ws = this.worlds(level);
    if (ws.length === 0) return -1;
    const t = this.maskOf(team);
    let best = Number.POSITIVE_INFINITY;
    for (const w of ws) {
      const r = popcount(w & t);
      if (r < best) { best = r; if (best === 0) break; }
    }
    return best;
  }

  failsRequired(round: number): number {
    return failsRequiredFor(this.params, round);
  }

  /**
   * The team must fail if its reds play fail: every consistent world (L1*)
   * puts at least `failsRequired(round)` reds on it (X1 — R4 needs two).
   */
  provablyFailable(team: readonly string[], round: number): boolean {
    return this.minReds(team, 'L1*') >= this.failsRequired(round);
  }

  /** Fraction of consistent worlds in which `id` is red (uniform; diagnostics only). */
  uniformRedShare(id: string, level: CertaintyLevel = 'L1*'): number {
    const ws = this.worlds(level);
    if (ws.length === 0) return 0;
    const b = this.bitOf(id);
    let n = 0;
    for (const w of ws) if (w & b) n++;
    return n / ws.length;
  }

  /** log2 |worlds| — the logic-only uncertainty in bits (0 when empty). */
  entropyBits(level: CertaintyLevel = 'L1*'): number {
    const n = this.worlds(level).length;
    return n > 0 ? Math.log2(n) : 0;
  }

  /**
   * K1′ / K3 with X4's strictness, at L1 only (the K rules are certain only
   * under A0; empty L1 → never dominated): the team holds A but not B, A
   * declared B blue, and some member X ≠ A can be red while the rest of the
   * team is good — then swapping X for B strictly raises P(all good) under
   * every belief supported on L1 (A good ⇒ B good). Pairs are checked one by
   * one, so a chain A→B→C closes automatically (a team with A and B but not
   * C breaches B→C). Only pairs that bind in this view count (`vouches`: the
   * viewer's own declaration contradicted by its own lake result does not —
   * batch 1D). `null` when the team is not dominated.
   */
  strictlyDominated(team: readonly string[]): DominanceWitness | null {
    if (this.l1Empty) return null;
    const teamMask = this.maskOf(team);
    for (const { holder, target } of this.declaredBlue) {
      const h = this.bitOf(holder);
      const b = this.bitOf(target);
      if (h === 0 || b === 0) continue;
      if ((teamMask & h) === 0 || (teamMask & b) !== 0) continue;
      for (const x of team) {
        const xb = this.bitOf(x);
        if (xb === 0 || xb === h) continue;
        const rest = teamMask & ~xb;
        if (this.l1.some((w) => (w & xb) !== 0 && (w & rest) === 0)) {
          return { holder, target, swap: x };
        }
      }
    }
    return null;
  }
}

/** The viewer's own certainty view (L0 / L1; private knowledge included). */
export function buildCertainty(obs: PlayerObservation): CertaintyView {
  const params = certaintyParamsFor(obs);
  const l0 = enumerateWorlds(obs, { self: 'own', sight: true, ownLakeResults: true, lakes: false }, params);
  const l1 = enumerateWorlds(obs, { self: 'own', sight: true, ownLakeResults: true, lakes: true }, params);
  return new CertaintyView(obs, l0, l1, params);
}

/**
 * The public picture: no private knowledge and no assumption about the
 * viewer's camp (what every seat can conclude from the table alone).
 */
export function buildPublicCertainty(obs: PlayerObservation): CertaintyView {
  const params = certaintyParamsFor(obs);
  const l0 = enumerateWorlds(obs, { self: 'free', sight: false, ownLakeResults: false, lakes: false }, params);
  const l1 = enumerateWorlds(obs, { self: 'free', sight: false, ownLakeResults: false, lakes: true }, params);
  return new CertaintyView(obs, l0, l1, params);
}

/**
 * C8 / K5 (S1-10, INV-R1): can a lake claim be true *if the holder is good*?
 * False when no public L1 world (L0 when L1 is empty) has the holder good
 * and the target's camp equal to the claim — such a claim proves the holder
 * red.
 */
export function claimPossibleForGoodHolder(
  obs: PlayerObservation,
  holderId: string,
  targetId: string,
  claim: 'good' | 'evil',
): boolean {
  const view = buildPublicCertainty(obs);
  const h = view.bitOf(holderId);
  const t = view.bitOf(targetId);
  return view.worlds('L1*').some((w) => (w & h) === 0 && ((w & t) !== 0) === (claim === 'evil'));
}
