/**
 * Invariant catalog (logic-first plan §5.3, 2026-10-14; docs/ai/logic_first.md).
 *
 * One entry per rule the bots must never break, with the constraint IDs of
 * logic_audit.md §2 it rests on. `status` says where the rule stands:
 *   - `enforced`    — must be 0 violations now (the CI test fails otherwise);
 *   - `pending:X`   — known violations at the 2026-10-14 baseline; batch X of
 *                     Stage 1 brings it to 0. Until then the CI test only
 *                     checks the count does not grow (ratchet).
 * `kind`:
 *   - `hard`        — a decision checked against what the deciding seat can
 *                     prove from its own observation;
 *   - `policy`      — a registered exception, a pure log, or a tier-2
 *                     (human-likeness) behaviour rule: not a logical
 *                     constraint; when `enforced` the CI keeps it at 0 only so
 *                     the switch that implements it stays wired (INV-A2);
 *   - `metamorphic` — change an input that must not matter, compare;
 *   - `structural`  — a property of the code path itself;
 *   - `static`      — a source-code scan.
 * Registered exemptions (counted, never violations): the forced fifth
 * proposal (no vote is held), the R1–R2 normal-vote table rule (owner ruling
 * 2026-04-30, confirmed final 2026-10-14 — D3: no exception, no alternative
 * flag), Percival's R1 no-thumb owner ruling (for the hard-exclusion rule),
 * the L1-empty fallback to L0, and — for INV-B1 — a declared-blue pair with a
 * seat the certainty layer pins (the order of two pinned or half-pinned seats
 * is the certainty layer's, not the probability layer's).
 *
 * Batch 1C (2026-10-22, docs/ai/logic_first.md 第 1C 節) brought INV-B1, B2,
 * B3, H3a, H3b and F0 to 0 on all 1970 replays and 2000 self-play games;
 * they are enforced from then on. Batch 1D (2026-10-22, 第 7 節, the
 * decision gates `teamDominanceGate` / `mustFailGate`, `LogicGates.ts`)
 * brought INV-T1, V1, K1, K2, P3, L1 and the new INV-K1V to 0 on the
 * replays, the probe and the self-play games — and INV-Pe1 with them (both
 * thumbs on a one-fail team is a must-fail team; batch 1E still owns the
 * Percival rules themselves); all enforced from then on. Batches 1E / 1F
 * (2026-10-26, 第 8 節: Percival = a loyal + "exactly one thumb is red" —
 * `percivalLoyalVote`, `percivalCertainExclusion`, `percivalBlueLake` — and
 * the red possible-claim guard `redPossibleClaimsOnly`) brought INV-Pe2,
 * PL and R1 to 0 on the replays and the self-play games; every rule of the
 * catalog is enforced from then on. Batch 1G (2026-10-26, 第 9 節, practice
 * report (b): `assassinVisibleRedTier`) added INV-A2 and brought it to 0 on
 * the replays and the self-play games. The same day's review reclassified it:
 * a tier-2 (human-likeness) rule, kind `policy` — human Merlins carry the
 * flag in 10.5% of the assassinations, so it is a strong regularity, not a
 * constraint — still kept at 0 (enforced) so the switch stays wired, and
 * classified by the harness's own brute force (not the agent's function).
 * The review also added INV-PL2 (the behavioural twin of INV-PL).
 *
 * Which checks are independent of the code the bots decide with: INV-W1
 * (the true red set is always among the L0 worlds), INV-OBS, INV-A2 (own
 * classifier since 2026-10-26) and the metamorphic rules. INV-T1, V1, K1,
 * K1V call the same `provablyFailable` / `strictlyDominated` as
 * `LogicGates.ts`, and INV-PL reads the avoid set the agent used: on their
 * own, 0 violations there show the gate is switched on; their correctness
 * rests on INV-W1 and the certainty layer's unit tests.
 */

export type InvariantKind = 'hard' | 'policy' | 'metamorphic' | 'structural' | 'static';

export interface InvariantSpec {
  id: string;
  /** Constraint IDs (logic_audit.md §2 / critique.md). */
  refs: readonly string[];
  kind: InvariantKind;
  /** `enforced` or `pending:<batch>` (the Stage 1 batch that fixes it). */
  status: string;
  /** Who the rule binds. */
  side: 'good' | 'red' | 'all';
  /**
   * The adoption tier of the behaviour the rule checks (owner 2026-10-14):
   * 1 = logical correctness (an absolutely-true constraint or an owner
   * ruling; the default), 2 = human-likeness (a measured human regularity).
   */
  tier?: 1 | 2;
  rule: string;
}

export const INVARIANTS: readonly InvariantSpec[] = [
  { id: 'INV-W1', refs: ['C2', 'C5'], kind: 'hard', status: 'enforced', side: 'all',
    rule: 'every world the certainty layer keeps satisfies every fail count, the role sight and the own lake results; the true red set is always among the L0 worlds' },
  { id: 'INV-W2', refs: ['X3'], kind: 'policy', status: 'enforced', side: 'all',
    rule: 'games where some good seat\'s L1 (A0) is empty and the layer falls back to L0 are logged (one record per game; the fallback is an exemption, never a violation)' },
  { id: 'INV-Q1', refs: ['rule'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'a good player never plays a fail card' },
  { id: 'INV-T1', refs: ['C2', 'C4', 'C6', 'P1', 'P2', 'K2'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'a good leader never proposes a team that must fail (minReds at L1* >= fails required)' },
  { id: 'INV-V1', refs: ['C2', 'C4', 'C6', 'P1', 'P2', 'K2'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'a good voter never approves a must-fail team on a non-forced proposal (R1-R2 = the normal-vote table rule, registered exemption; owner ruling on D3 final; Merlin on the team voting as a loyal = 正常票內白, owner 2026-10-30)' },
  { id: 'INV-K1', refs: ['K1′', 'K3', 'X4'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'a good leader never proposes a strictly dominated team (A in, B out, A declared B blue, someone else can be the only red), pairwise so chains close; a declaration the leader itself saw contradicted binds nothing' },
  { id: 'INV-K1V', refs: ['K1′', 'K3', 'X4'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'a good voter never approves a strictly dominated team on a non-forced R3+ proposal (硬1 for votes; batch 1D, new)' },
  { id: 'INV-K2', refs: ['K2'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'a good leader never puts both members of a declared-red pair on a team when one fail suffices (subsumed by INV-T1)' },
  { id: 'INV-B1', refs: ['K1', 'K3', 'K5'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'suspicion along a declared-blue pair: score(B) <= score(A) unless a certainty pins one of them (then exempt)' },
  { id: 'INV-B2', refs: ['C2', 'P1', 'P2', 'P3', 'M2', 'Pe1'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'certRed => score >= 1-eps; certGood => score <= eps (eps = 0.01; deduced reds only, sighted reds are pinned already)' },
  { id: 'INV-B3', refs: ['C5'], kind: 'static', status: 'enforced', side: 'all',
    rule: 'no agent code reads a mission result without its fail count (the outcome read lives in missionFacts.ts only)' },
  { id: 'INV-H3a', refs: ['T1', 'T3'], kind: 'metamorphic', status: 'enforced', side: 'good',
    rule: 'removing the pre-lake leader records of a declared-blue holder does not change the rule-3 score' },
  { id: 'INV-H3b', refs: ['T1', 'X2'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'an honest blue holder is flagged by the rule-3 marker only for a team it led after its lake without its declared-blue seat' },
  { id: 'INV-F0', refs: ['T4', 'M1'], kind: 'metamorphic', status: 'enforced', side: 'good',
    rule: 'flipping the synthetic votes of forced fifth proposals changes no suspicion score' },
  { id: 'INV-P3', refs: ['P3'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'a good voter never approves a non-forced team holding its accuser when one fail suffices' },
  { id: 'INV-L1', refs: ['P2'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'a good holder never approves a non-forced team holding its own declared red when one fail suffices' },
  { id: 'INV-Pe1', refs: ['Pe1'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'Percival never approves a non-forced R3+ team holding both thumbs when one fail suffices (R1-R2 = the table rule; at 0 since batch 1D: such a team must fail; batch 1E: Percival\'s own vote rule)' },
  { id: 'INV-Pe2', refs: ['Pe1', 'C3'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'Percival never hard-excludes a seat that is not certRed (the R1 no-thumb owner ruling is exempt)' },
  { id: 'INV-R1NT', refs: ['owner 2026-10-14', 'D5'], kind: 'hard', status: 'enforced', side: 'good',
    rule: '6-10p Percival captain with two thumbs, no mission result yet: no thumb on the team, except the D5 thumb-on-thumb exception' },
  { id: 'INV-PL', refs: ['owner 2026-10-14'], kind: 'structural', status: 'enforced', side: 'good',
    rule: 'Percival\'s lake candidate set equals a loyal\'s (no thumb avoid list; checked on the avoid set the deciding agent used)' },
  { id: 'INV-PL2', refs: ['owner 2026-10-14', 'D4'], kind: 'metamorphic', status: 'enforced', side: 'good',
    rule: 'Percival lakes the seat the same lake policy picks for a loyal holding Percival\'s built-in fact (same observation, role loyal, the thumbs kept as "exactly one is red"; same draws) — the behavioural check of INV-PL (2026-10-26 review)' },
  { id: 'INV-M1', refs: ['M1'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'Merlin never proposes, and from R3 never approves, a team holding a visible red (R1-R2 votes = policy; a doomed non-forced R1-R2 proposal is exempt: 派拇指躲刺, Edward 2026-10-28; on the team the loyal-style approve is 正常票內白 — exempt, Edward 2026-10-30)' },
  { id: 'INV-A1', refs: ['A1'], kind: 'hard', status: 'enforced', side: 'red',
    rule: 'the assassin never targets a known red' },
  { id: 'INV-A2', refs: ['player report (b)', 'human data 第 9.1 節'], kind: 'policy', status: 'enforced', side: 'red', tier: 2,
    rule: 'TIER 2 (human-likeness; a strong human regularity, LR 0.27 — not an absolutely-true constraint): the assassinator does not prefer a candidate who, as captain on any proposal (the forced fifth too, Edward 2026-10-26), certainly put a red Merlin sees on the team (the assassinator unless Mordred, Oberon, or more seen teammates than could all be Mordred, from the lobby roles) over a candidate who never did (every candidate did = exempt). Kept at 0 so the switch stays wired; classified by the harness\'s own brute force over the lobby\'s role assignments' },
  { id: 'INV-R1', refs: ['C8', 'K5'], kind: 'hard', status: 'enforced', side: 'red',
    rule: 'a red holder never makes a claim that cannot be true for a good holder (public L1)' },
  { id: 'INV-R2', refs: ['K5'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'after an impossible declaration every blue has the holder in certRed (L1; the L0 fallback is counted as exempt)' },
  { id: 'INV-OBS', refs: ['T1'], kind: 'metamorphic', status: 'enforced', side: 'all',
    rule: 'no private field (role sight, own lake results, the assassin roster) reaches a seat that may not see it' },
];

export function invariantById(id: string): InvariantSpec {
  const spec = INVARIANTS.find((s) => s.id === id);
  if (!spec) throw new Error(`unknown invariant ${id}`);
  return spec;
}
