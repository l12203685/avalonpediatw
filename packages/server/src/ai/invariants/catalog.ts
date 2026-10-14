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
 *   - `policy`      — counted and logged, not a violation (a registered
 *                     exception or a pure log);
 *   - `metamorphic` — change an input that must not matter, compare;
 *   - `structural`  — a property of the code path itself;
 *   - `static`      — a source-code scan.
 * Registered exemptions (counted, never violations): the forced fifth
 * proposal (no vote is held), the R1–R2 normal-vote table rule (owner ruling
 * 2026-04-30; D3 pending), Percival's R1 no-thumb owner ruling (for the
 * hard-exclusion rule), and the L1-empty fallback to L0.
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
  rule: string;
}

export const INVARIANTS: readonly InvariantSpec[] = [
  { id: 'INV-W1', refs: ['C2', 'C5'], kind: 'hard', status: 'enforced', side: 'all',
    rule: 'every world the certainty layer keeps satisfies every fail count, the role sight and the own lake results; the true red set is always among the L0 worlds' },
  { id: 'INV-W2', refs: ['X3'], kind: 'policy', status: 'enforced', side: 'all',
    rule: 'games where some good seat\'s L1 (A0) is empty and the layer falls back to L0 are logged' },
  { id: 'INV-Q1', refs: ['rule'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'a good player never plays a fail card' },
  { id: 'INV-T1', refs: ['C2', 'C4', 'C6', 'P1', 'P2', 'K2'], kind: 'hard', status: 'pending:1D', side: 'good',
    rule: 'a good leader never proposes a team that must fail (minReds at L1* >= fails required)' },
  { id: 'INV-V1', refs: ['C2', 'C4', 'C6', 'P1', 'P2', 'K2'], kind: 'hard', status: 'pending:1D', side: 'good',
    rule: 'a good voter never approves a must-fail team on a non-forced proposal (R1-R2 = policy until D3)' },
  { id: 'INV-K1', refs: ['K1′', 'K3', 'X4'], kind: 'hard', status: 'pending:1D', side: 'good',
    rule: 'a good leader never proposes a strictly dominated team (A in, B out, A declared B blue, someone else can be the only red), pairwise so chains close' },
  { id: 'INV-K2', refs: ['K2'], kind: 'hard', status: 'pending:1D', side: 'good',
    rule: 'a good leader never puts both members of a declared-red pair on a team when one fail suffices (subsumed by INV-T1)' },
  { id: 'INV-B1', refs: ['K1', 'K3', 'K5'], kind: 'hard', status: 'pending:1C', side: 'good',
    rule: 'suspicion along a declared-blue pair: score(B) <= score(A) unless a certainty pins one of them' },
  { id: 'INV-B2', refs: ['C2', 'P1', 'P2', 'P3', 'M2', 'Pe1'], kind: 'hard', status: 'pending:1C', side: 'good',
    rule: 'certRed => score >= 1-eps; certGood => score <= eps (eps = 0.01; deduced reds only, sighted reds are pinned already)' },
  { id: 'INV-B3', refs: ['C5'], kind: 'static', status: 'pending:1C', side: 'all',
    rule: 'no belief code reads a mission result without its fail count' },
  { id: 'INV-H3a', refs: ['T1', 'T3'], kind: 'metamorphic', status: 'pending:1C', side: 'good',
    rule: 'removing the pre-lake leader records of a declared-blue holder does not change the rule-3 score' },
  { id: 'INV-H3b', refs: ['T1', 'X2'], kind: 'hard', status: 'pending:1C', side: 'good',
    rule: 'an honest blue holder is flagged (>= 0.85) only by a team it led after its lake without its declared-blue seat' },
  { id: 'INV-F0', refs: ['T4', 'M1'], kind: 'metamorphic', status: 'pending:1C', side: 'good',
    rule: 'flipping the synthetic votes of forced fifth proposals changes no suspicion score' },
  { id: 'INV-P3', refs: ['P3'], kind: 'hard', status: 'pending:1D', side: 'good',
    rule: 'a good voter never approves a non-forced team holding its accuser when one fail suffices' },
  { id: 'INV-L1', refs: ['P2'], kind: 'hard', status: 'pending:1D', side: 'good',
    rule: 'a good holder never approves a non-forced team holding its own declared red when one fail suffices' },
  { id: 'INV-Pe1', refs: ['Pe1'], kind: 'hard', status: 'pending:1E', side: 'good',
    rule: 'Percival never approves a non-forced R3+ team holding both thumbs when one fail suffices (R1-R2 = policy)' },
  { id: 'INV-Pe2', refs: ['Pe1', 'C3'], kind: 'hard', status: 'pending:1E', side: 'good',
    rule: 'Percival never hard-excludes a seat that is not certRed (the R1 no-thumb owner ruling is exempt)' },
  { id: 'INV-R1NT', refs: ['owner 2026-10-14', 'D5'], kind: 'hard', status: 'enforced', side: 'good',
    rule: '6-10p Percival captain with two thumbs, no mission result yet: no thumb on the team, except the D5 thumb-on-thumb exception' },
  { id: 'INV-PL', refs: ['owner 2026-10-14'], kind: 'structural', status: 'pending:1E', side: 'good',
    rule: 'Percival\'s lake candidate set equals a loyal\'s (no thumb avoid list)' },
  { id: 'INV-M1', refs: ['M1'], kind: 'hard', status: 'enforced', side: 'good',
    rule: 'Merlin never proposes, and from R3 never approves, a team holding a visible red (R1-R2 votes = policy)' },
  { id: 'INV-A1', refs: ['A1'], kind: 'hard', status: 'enforced', side: 'red',
    rule: 'the assassin never targets a known red' },
  { id: 'INV-R1', refs: ['C8', 'K5'], kind: 'hard', status: 'pending:1F', side: 'red',
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
