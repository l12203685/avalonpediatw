/**
 * LogicGates — decision gates for good seats on top of the corrected
 * beliefs (logic-first batch 1D, 2026-10-22; docs/ai/logic_first.md 第 7 節,
 * plan §2.1 S1-3 team gate, S1-4, S1-5).
 *
 * Every gate reads only the deciding seat's own observation through the
 * certainty layer (`belief/Certainty.ts`) — the very functions the
 * invariant harness checks with (`invariants/checks.ts`), so a gated
 * decision cannot breach the rule it gates.
 *
 *   - `teamDominanceGate` (S1-3 team gate; INV-K1): a good leader never
 *     proposes, and a good voter (R3+, non-forced) never approves, a team
 *     that is *strictly dominated* in its own L1 view (A0 hard, GM decision
 *     D1): it holds A but not B, A declared B blue (directly or along a
 *     declared-blue chain — K1′ / K3, the owner's "choosing A ⇒ must choose
 *     B ⇒ must choose C, for everyone"), and some member X ≠ A is the only
 *     red of the team in a consistent world, so swapping X for B raises
 *     P(team all good) strictly (critique X4). Not applied when A0 leaves no
 *     world (the L0 fallback).
 *   - `mustFailGate` (S1-4 + S1-5; INV-T1, V1, K2, P3, L1): a team *must
 *     fail* when every consistent world (level L1*: L1, or L0 when L1 is
 *     empty) puts at least the round's fails-required reds on it (X1 / GM
 *     decision D2 — R4 of 7+ players needs two certain reds). A good leader
 *     never proposes one (any round, the forced fifth proposal included —
 *     the leader still chooses); a good voter never approves one on a
 *     non-forced R3+ proposal, before any role shortcut (Percival's and
 *     Morgana's "on the team ⇒ approve" included). R1–R2 votes keep the
 *     normal-vote table rule: the owner's final ruling on D3 (2026-10-14) —
 *     no exception, no alternative flag (in R1 a loyal cannot know a team
 *     must fail; Percival's only R1–R2 certainty is both thumbs on one team,
 *     and rejecting it would sell Merlin). P2: a holder on the team rejects
 *     it when one fail decides and it holds a seat the holder itself
 *     declared red (`GoodLakeFollowUp.ownDeclaredRedOnTeam`). S1-5: the
 *     accuser (a seat that declared me red) is certainly red at L1 (pinned
 *     by batch 1C), so a team holding it must fail when one fail decides.
 *
 * Existence (why the gate can always be met): let T* maximise P(team all
 * good) over the self-inclusive teams under the uniform belief on the
 * L1* worlds. Some world leaves enough good seats for a team, so
 * P(T* all good) > 0 and some world puts no red on T* — it is not a
 * must-fail team. A strict dominance of T* at L1 would give a better team
 * under that same full-support belief (X ≠ self, since the viewer is never
 * red in its own worlds, so the better team still holds self) — so T* is
 * not dominated either. `compliantTeams` therefore never comes back empty
 * (it falls back to T* explicitly, defensively).
 *
 * Pure functions; no `Math.random`.
 */

import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentTuning } from './AgentTuning';
import { buildCertainty, popcount, type CertaintyView } from './belief/Certainty';
import { analyzeLakeChain, findTeamHardRuleViolations } from './baseline/lakeChainTracker';
import { ownDeclaredRedOnTeam } from './GoodLakeFollowUp';
import type { PlayerObservation } from './types';

export interface GateOptions {
  /** S1-3 team gate (`AgentTuning.teamDominanceGate`). */
  teamDominance: boolean;
  /** S1-4 / S1-5 must-fail gate (`AgentTuning.mustFailGate`). */
  mustFail: boolean;
}

export type GateTuning = Pick<AgentTuning, 'teamDominanceGate' | 'mustFailGate'>;

/** The gates of an agent tuning. */
export function gateOptionsFrom(tuning: GateTuning): GateOptions {
  return { teamDominance: tuning.teamDominanceGate, mustFail: tuning.mustFailGate };
}

/** True when some gate is on (the gates bind good seats only). */
export function anyGate(opts: Readonly<GateOptions>): boolean {
  return opts.teamDominance || opts.mustFail;
}

const viewCache = new WeakMap<PlayerObservation, CertaintyView>();

/** The seat's own certainty view, cached per observation object. */
export function certaintyFor(obs: PlayerObservation): CertaintyView {
  let v = viewCache.get(obs);
  if (!v) {
    v = buildCertainty(obs);
    viewCache.set(obs, v);
  }
  return v;
}

export type TeamGateBreach = 'mustFail' | 'dominated';

/**
 * Why `team` is barred for a good seat with certainty view `view` in
 * `round` (`null` = it passes). Must-fail first (the stronger fact).
 */
export function teamGateBreach(
  obs: PlayerObservation,
  view: CertaintyView,
  team: readonly string[],
  round: number,
  opts: Readonly<GateOptions>,
): TeamGateBreach | null {
  if (opts.mustFail && view.provablyFailable(team, round)) return 'mustFail';
  if (opts.teamDominance && !view.l1Empty) {
    const strict = findTeamHardRuleViolations(analyzeLakeChain(obs), team, { view, round });
    if (strict.some((v) => v.rule === 1)) return 'dominated';
  }
  return null;
}

export type VoteGateReason = TeamGateBreach | 'ownDeclaredRed';

/**
 * The vote gate of a good seat: `'reject'` reasons for the proposed team,
 * `null` when no gate applies. Never on the forced fifth proposal (no vote
 * is held) nor in R1–R2 (the owner's normal-vote table rule, D3).
 */
export function goodVoteGate(obs: PlayerObservation, opts: Readonly<GateOptions>): VoteGateReason | null {
  if (obs.myTeam !== 'good' || !anyGate(opts)) return null;
  if (obs.failCount >= 4) return null;
  const round = obs.currentRound ?? 1;
  if (round <= 2) return null;
  const team = obs.proposedTeam ?? [];
  if (team.length === 0) return null;
  const breach = teamGateBreach(obs, certaintyFor(obs), team, round, opts);
  if (breach) return breach;
  if (opts.mustFail && failsRequiredIn(obs, round) === 1 && ownDeclaredRedOnTeam(obs, team)) return 'ownDeclaredRed';
  return null;
}

function failsRequiredIn(obs: PlayerObservation, round: number): number {
  return AVALON_CONFIG[obs.playerCount]?.questFailsRequired[round - 1] ?? 1;
}

/** Team size of the current round (undefined for an unknown player count). */
export function teamSizeFor(obs: PlayerObservation): number | undefined {
  return AVALON_CONFIG[obs.playerCount]?.questTeams[(obs.currentRound ?? 1) - 1];
}

export interface CompliantTeamOptions {
  /** Lower = better; compared lexicographically, then the sum of `score`, then seat order. */
  rank?: (team: readonly string[]) => number;
  /** A seat's suspicion (lower = preferred); 0.5 when unknown. */
  score: (id: string) => number;
  /** Teams the caller cannot propose at all (e.g. the R1-P1 banned seat combinations). */
  allowed?: (team: readonly string[]) => boolean;
}

/**
 * Every self-inclusive legal team of size `teamSize` that passes the gates,
 * best first (`rank`, then the sum of suspicion, then seat order). Never
 * empty while the certainty layer has a consistent world: the uniform
 * P(all good) maximiser is added when nothing else passes (see the module
 * doc for why it passes).
 */
export function compliantTeams(
  obs: PlayerObservation,
  view: CertaintyView,
  teamSize: number,
  opts: Readonly<GateOptions>,
  choose: Readonly<CompliantTeamOptions>,
): string[][] {
  const self = obs.myPlayerId;
  const others = obs.allPlayerIds.filter((id) => id !== self);
  const round = obs.currentRound ?? 1;
  const all: string[][] = [];
  const k = teamSize - 1;
  if (k < 0 || k > others.length) return [];
  const rec = (start: number, acc: string[]): void => {
    if (acc.length === k) { all.push([self, ...acc]); return; }
    for (let i = start; i <= others.length - (k - acc.length); i++) rec(i + 1, [...acc, others[i]]);
  };
  rec(0, []);
  const sum = (t: readonly string[]): number => t.reduce((s, id) => s + choose.score(id), 0);
  const order = (t: readonly string[]): number => t.reduce((s, id) => s + obs.allPlayerIds.indexOf(id), 0);
  const keyed = all
    .filter((t) => (choose.allowed ? choose.allowed(t) : true))
    .filter((t) => teamGateBreach(obs, view, t, round, opts) === null)
    .map((t) => ({ t, r: choose.rank ? choose.rank(t) : 0, s: sum(t), o: order(t) }));
  keyed.sort((a, b) => (a.r - b.r) || (a.s - b.s) || (a.o - b.o));
  if (keyed.length > 0) return keyed.map((x) => x.t);
  const best = bestUniformTeam(view, all);
  return best ? [best] : [];
}

/** The team with the most consistent L1* worlds that put no red on it (ties: first). */
function bestUniformTeam(view: CertaintyView, teams: readonly string[][]): string[] | null {
  const worlds = view.worlds('L1*');
  let best: string[] | null = null;
  let bestN = -1;
  for (const t of teams) {
    const m = view.maskOf(t);
    let n = 0;
    for (const w of worlds) if (popcount(w & m) === 0) n++;
    if (n > bestN) { bestN = n; best = t; }
  }
  return best;
}
