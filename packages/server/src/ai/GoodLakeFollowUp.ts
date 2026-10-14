/**
 * Blue follow-up on the Lady of the Lake (2026-10-13 round 3,
 * docs/ai/strength_benchmark.md 第 10 節) — the blue counterpart of
 * `RedLakeFollowUp.ts` (`evilVouchFollowUp`).
 *
 * A good lake holder sees the target's real camp and the bots always
 * declare it truthfully, but the ForwardAgent pipeline (which makes every
 * R3+ team and vote) never looked at its own declaration: after declaring
 * a seat blue, a good holder put that seat on only about 45% of the teams
 * it led later (strength_benchmark.md 第 8.2 節) — while humans do it
 * 99.2% of the time (牌譜, `scripts/goodLakeFollowUpStudy.ts`). The good
 * bots' 硬3 rule (`findRule3Violators`) then flags the honest holder at
 * ≥ 0.85 suspicion ("blue self-harm", 第 8.2 節).
 *
 * `AgentTuning.goodVouchFollowUp` makes a good holder keep its word the way
 * the baseline `HeuristicAgent` already does through 硬1 / 硬2
 * (`fixupTeamHardRules`, `voteOnTeam`):
 *   - its own proposals include every seat it declared blue and leave out
 *     every seat it declared red (a filter on the usual ForwardAgent
 *     candidates; only when none keeps the word are teams built around the
 *     declared seats — same mechanics as `evilVouchFollowUp`);
 *   - off the proposed team (neither leader nor member) it rejects a team
 *     that leaves out a seat it declared blue or includes a seat it
 *     declared red; the forced fifth proposal is exempt (everyone approves).
 * By default the holder is also bound by what a seat it declared blue
 * declares later (the chain: humans put that seat on 98.5% of their teams,
 * a seat it declared red on 0/80), and Merlin never has a seat he sees as
 * red forced onto his team.
 *
 * In `DEFAULT_AGENT_TUNING` since 2026-10-13 round 3: against the
 * production default, as blue, +0.64pp [+0.31pp, +0.97pp] on the selection
 * seed 11111, +0.36pp / +0.68pp on the fresh seeds 22222 / 33333, pooled
 * +0.57pp [+0.38pp, +0.77pp]; team (R2+ Jaccard) and R3+ vote agreement
 * up or unchanged in every cohort (strength_benchmark.md 第 10 節).
 *
 * Pure functions over the public record (`obs.lakeHistory`) plus the
 * holder's role knowledge; no `Math.random`.
 */

import type { PlayerObservation } from './types';

/**
 * Tactic knobs of `goodVouchFollowUp`. The default is the policy behind the
 * switch; alternatives exist for the benchmark scripts only
 * (`AVALON_GOOD_VOUCH_VARIANT`, read by the scripts through
 * `goodVouchOptionsFromEnv` + `setGoodVouchOptions`; the server never reads
 * it).
 *   - `scope`: `'own'` — only the holder's own declarations; `'chain'` —
 *     also what a seat it declared blue later declared (recursively: the
 *     holder saw that seat is blue, so its truthful claims are as good as
 *     its own).
 *   - `merlin`: `'knowledge'` — a declared-blue seat Merlin sees as red
 *     (only possible through a lie in the chain) is never required and is
 *     treated as declared red; `'follow'` — Merlin follows the declarations
 *     like everyone else (his known reds stay off his teams anyway, the
 *     ForwardAgent pool drops them).
 *   - `onTeam`: `'off'` — the vote rule only applies off the team;
 *     `'reject'` — also when the holder sits on the team.
 */
export interface GoodVouchOptions {
  scope: 'own' | 'chain';
  merlin: 'knowledge' | 'follow';
  onTeam: 'off' | 'reject';
}

export const DEFAULT_GOOD_VOUCH_OPTIONS: Readonly<GoodVouchOptions> = Object.freeze({
  scope: 'chain',
  merlin: 'knowledge',
  onTeam: 'off',
});

let activeGoodVouchOptions: Readonly<GoodVouchOptions> = DEFAULT_GOOD_VOUCH_OPTIONS;

/** Benchmark scripts only (`undefined` restores the default). */
export function setGoodVouchOptions(options: GoodVouchOptions | undefined): void {
  activeGoodVouchOptions = Object.freeze({ ...(options ?? DEFAULT_GOOD_VOUCH_OPTIONS) });
}

export function getGoodVouchOptions(): Readonly<GoodVouchOptions> {
  return activeGoodVouchOptions;
}

/** Parses `AVALON_GOOD_VOUCH_VARIANT="scope=chain,onTeam=reject"` (scripts only). */
export function goodVouchOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): GoodVouchOptions {
  const out: GoodVouchOptions = { ...DEFAULT_GOOD_VOUCH_OPTIONS };
  for (const part of (env.AVALON_GOOD_VOUCH_VARIANT ?? '').split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (k === 'scope' && (v === 'own' || v === 'chain')) out.scope = v;
    if (k === 'merlin' && (v === 'knowledge' || v === 'follow')) out.merlin = v;
    if (k === 'onTeam' && (v === 'off' || v === 'reject')) out.onTeam = v;
  }
  return out;
}

export interface GoodVouchDeclarations {
  /** Seats the holder must keep on its own teams (declared blue). */
  blue: string[];
  /** Seats the holder must keep off its own teams (declared red). */
  red: string[];
  /** Of `blue` / `red`, the ones that come from the chain (not the holder's own claim). */
  chainBlue: string[];
  chainRed: string[];
}

/**
 * The declarations a good player is bound by (chronological, no
 * duplicates): its own public claims, and with `scope: 'chain'` the claims
 * of every seat it (transitively) declared blue. An earlier entry wins a
 * conflict (own claims come before the chain they start). `null` when the
 * player is not good.
 */
export function goodVouchDeclarations(
  obs: PlayerObservation,
  options: Readonly<GoodVouchOptions> = activeGoodVouchOptions,
): GoodVouchDeclarations | null {
  if (obs.myTeam !== 'good') return null;
  const me = obs.myPlayerId;
  const blue: string[] = [];
  const red: string[] = [];
  const chainBlue: string[] = [];
  const chainRed: string[] = [];
  const known = new Set<string>();
  for (const rec of obs.lakeHistory ?? []) {
    if (rec.declaredClaim === 'none') continue; // undeclared: no claim to keep
    if (rec.targetId === me) continue;
    const own = rec.holderId === me;
    if (!own && !(options.scope === 'chain' && blue.includes(rec.holderId))) continue;
    if (known.has(rec.targetId)) continue;
    known.add(rec.targetId);
    let claim = rec.declaredClaim;
    // Merlin sees every red but Mordred: a "blue" seat he knows is red can
    // only come from a lie; with `merlin: 'knowledge'` it counts as red.
    if (claim === 'good' && options.merlin === 'knowledge' && obs.knownEvils.includes(rec.targetId)) {
      claim = 'evil';
    }
    if (claim === 'good') {
      blue.push(rec.targetId);
      if (!own) chainBlue.push(rec.targetId);
    } else {
      red.push(rec.targetId);
      if (!own) chainRed.push(rec.targetId);
    }
  }
  return { blue, red, chainBlue, chainRed };
}

/**
 * Team constraint for a good leader's own proposal (`goodVouchFollowUp`):
 * seats that must be on it (declared blue) and seats that must stay off
 * (declared red). `null` when the rule does not apply (not good, or no
 * binding declaration).
 */
export function goodVouchTeamConstraint(
  obs: PlayerObservation,
): { required: string[]; banned: string[] } | null {
  const decl = goodVouchDeclarations(obs);
  if (!decl) return null;
  const seated = new Set(obs.allPlayerIds);
  const required = decl.blue.filter((id) => seated.has(id));
  const banned = decl.red.filter((id) => seated.has(id) && !required.includes(id));
  if (required.length === 0 && banned.length === 0) return null;
  return { required, banned };
}

/**
 * Vote rule (`goodVouchFollowUp`): a good player off the proposed team
 * rejects it when it leaves out a seat the player is bound to as blue or
 * includes one bound as red. Off on the forced fifth proposal (everyone
 * approves), on the player's own proposal (built to the constraint above),
 * and — with the default `onTeam: 'off'` — when the player sits on the team.
 */
export function goodVouchVoteRule(obs: PlayerObservation): 'reject' | null {
  if (obs.myTeam !== 'good') return null;
  if (obs.failCount >= 4) return null;
  if (obs.currentLeader === obs.myPlayerId) return null;
  const team = new Set(obs.proposedTeam ?? []);
  if (team.has(obs.myPlayerId) && activeGoodVouchOptions.onTeam === 'off') return null;
  const decl = goodVouchDeclarations(obs);
  if (!decl || (decl.blue.length === 0 && decl.red.length === 0)) return null;
  if (decl.blue.some((id) => !team.has(id))) return 'reject';
  if (decl.red.some((id) => team.has(id))) return 'reject';
  return null;
}
