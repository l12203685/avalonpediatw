import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import { NEED_TWO_LEAD_LR, needTwoParts73, needTwoSingleSeen73, needsTwoFails73 } from './Round73';
import { HeuristicAgent } from './HeuristicAgent';
import { OPPONENT_TYPES, tuningForOpponent } from './humanProfile';
import { tierCandidates, visibleRedEvidence } from './assassin/VisibleRedProposals';
import { merlinLeadLogRatio } from './assassin/MerlinLeadRead';
import { merlinVoteLogRatio } from './assassin/MerlinVoteRead';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votes = (yes: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, yes.includes(id)]));
const roles = { P2: 'assassin', P3: 'morgana', P7: 'mordred', P9: 'oberon' } as const;
const reds = ['P2', 'P3', 'P7', 'P9'];

/**
 * The assassination after 藍紅紅藍藍. Reds: P2 assassin, P3 Morgana, P7 Mordred, P9 Oberon.
 * R1 P1 P4 P5 passed; R2 P1 P4 P5 P9 and R3 P4 P6 P8 P2 failed; R4 (two fails needed) P1 led P1 P4 P5 P6 P3 — exactly one red
 * Merlin sees (Morgana), who cannot fail it alone: it passed; R5 P10 led P1 P4 P5 P6 P10 and it passed.
 * R3 P8's lead held the assassin (a one-fail round: tier evidence as always).
 */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  const r1 = ['P1', 'P4', 'P5'];
  const r2 = ['P1', 'P4', 'P5', 'P9'];
  const r3 = ['P4', 'P6', 'P8', 'P2'];
  const r4 = ['P1', 'P4', 'P5', 'P6', 'P3'];
  const r5 = ['P1', 'P4', 'P5', 'P6', 'P10'];
  return {
    myPlayerId: 'P2', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: ids, knownEvils: ['P3', 'P7'],
    allEvilIds: reds, allEvilRoles: { ...roles },
    currentRound: 5, currentLeader: 'P10', failCount: 0, questResults: ['success', 'fail', 'fail', 'success', 'success'], gamePhase: 'assassination',
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P4', team: r1, approved: true, votes: votes(['P1', 'P4', 'P5', 'P6', 'P8', 'P10']) },
      { round: 2, attempt: 1, leader: 'P5', team: r2, approved: true, votes: votes(['P1', 'P4', 'P5', 'P9', 'P2', 'P3']) },
      { round: 3, attempt: 1, leader: 'P8', team: r3, approved: true, votes: votes(['P4', 'P6', 'P8', 'P2', 'P3', 'P7']) },
      // R4: P4 and P5 approve on the team; P10 approves off it, P8 rejects off it.
      { round: 4, attempt: 1, leader: 'P1', team: r4, approved: true, votes: votes(['P1', 'P4', 'P5', 'P6', 'P3', 'P10']) },
      { round: 5, attempt: 1, leader: 'P10', team: r5, approved: true, votes: votes(['P1', 'P4', 'P5', 'P6', 'P10', 'P8']) },
    ],
    questHistory: [
      { round: 1, team: r1, result: 'success', failCount: 0 }, { round: 2, team: r2, result: 'fail', failCount: 1 },
      { round: 3, team: r3, result: 'fail', failCount: 1 }, { round: 4, team: r4, result: 'success', failCount: 1 },
      { round: 5, team: r5, result: 'success', failCount: 0 },
    ],
    proposedTeam: [], myLakeResults: [], lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

const blues = ['P1', 'P4', 'P5', 'P6', 'P8', 'P10'];
const seen = new Set(['P2', 'P3', 'P9']);

describe('round 73 assassinNeedTwo73', () => {
  it('default off in every table (baseline, legacy, each opponent type); the flag parses to bits 0–7', () => {
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) expect(t.assassinNeedTwo73).toBe(0);
    for (const k of OPPONENT_TYPES) expect(tuningForOpponent(k).assassinNeedTwo73).toBe(0);
    expect(parseTuningFlag('assassinNeedTwo73')).toEqual({ assassinNeedTwo73: 7 });
    expect(parseTuningFlag('assassinNeedTwo73=5')).toEqual({ assassinNeedTwo73: 5 });
    expect(() => parseTuningFlag('assassinNeedTwo73=8')).toThrow();
    expect(needTwoParts73(DEFAULT_AGENT_TUNING)).toEqual({ tier: false, lead: false, vote: false });
    expect(needTwoParts73(resolveAgentTuning({ assassinNeedTwo73: 5 }))).toEqual({ tier: true, lead: false, vote: true });
  });

  it('the cell: a two-fail round (10 players: R4 only) and exactly one red Merlin sees on the team', () => {
    expect([1, 2, 3, 4, 5].map((r) => needsTwoFails73(10, r))).toEqual([false, false, false, true, false]);
    expect(needsTwoFails73(5, 4)).toBe(false);
    expect(needTwoSingleSeen73(10, 4, ['P1', 'P4', 'P5', 'P6', 'P3'], seen)).toBe(true);
    // Mordred is not seen: Morgana + Mordred is still "exactly one seen"; Morgana + Oberon is two.
    expect(needTwoSingleSeen73(10, 4, ['P1', 'P4', 'P5', 'P7', 'P3'], seen)).toBe(true);
    expect(needTwoSingleSeen73(10, 4, ['P1', 'P4', 'P5', 'P9', 'P3'], seen)).toBe(false);
    expect(needTwoSingleSeen73(10, 4, ['P1', 'P4', 'P5', 'P6', 'P10'], seen)).toBe(false);
    expect(needTwoSingleSeen73(10, 3, ['P1', 'P4', 'P5', 'P3'], seen)).toBe(false);
  });

  it('bit 1 (tier): the R4 single-seen lead is no tier evidence; the R3 lead with a seen red still is', () => {
    const o = obs();
    const before = visibleRedEvidence(o, blues, true, true);
    expect(before.get('P1')?.tier).toBe(1);
    expect(before.get('P8')?.tier).toBe(1);
    expect(tierCandidates(blues, before)).toEqual(['P4', 'P5', 'P6', 'P10']);
    const after = visibleRedEvidence(o, blues, true, true, true);
    expect(after.get('P1')?.tier).toBe(0);
    expect(after.get('P8')?.tier).toBe(1);
    expect(tierCandidates(blues, after)).toEqual(['P1', 'P4', 'P5', 'P6', 'P10']);
    // Two seen reds on the R4 team: evidence as before.
    const two = obs();
    two.voteHistory[3] = { ...two.voteHistory[3], team: ['P1', 'P4', 'P5', 'P9', 'P3'] };
    expect(visibleRedEvidence(two, blues, true, true, true).get('P1')?.tier).toBe(1);
    // Without the shown cards (older observations) nothing changes.
    const blind = obs({ allEvilRoles: undefined });
    expect(visibleRedEvidence(blind, blues, true, true, true)).toEqual(visibleRedEvidence(blind, blues, true, true));
  });

  it('bit 2 (lead read): that lead reads with the measured ratio instead of ε; other leads are untouched', () => {
    const o = obs();
    const off = merlinLeadLogRatio(o, 'P1', reds, {}, true);
    const on = merlinLeadLogRatio(o, 'P1', reds, {}, true, undefined, NEED_TWO_LEAD_LR);
    expect(on).toBeCloseTo(Math.log(NEED_TWO_LEAD_LR), 9);
    expect(off).toBeLessThan(on);
    // P10's only lead is the clean R5 team; P8's is the R3 team with the assassin: both as before.
    for (const id of ['P10', 'P8']) expect(merlinLeadLogRatio(o, id, reds, {}, true, undefined, NEED_TWO_LEAD_LR)).toBe(merlinLeadLogRatio(o, id, reds, {}, true));
  });

  it('bit 4 (vote read): votes on the R4 single-seen team are not read, on the team or off it; R3 and R5 votes are', () => {
    const o = obs();
    // P10 approved the R4 team off it (the old read: a seen red bars Merlin's approve); P4 approved on it at red two wins (fatal in the old read).
    for (const id of ['P10', 'P4', 'P8']) {
      const off = merlinVoteLogRatio(o, id, reds, 'normalFit', 0);
      const on = merlinVoteLogRatio(o, id, reds, 'normalFit', 0, true);
      const noR4 = merlinVoteLogRatio({ ...o, voteHistory: o.voteHistory.filter((v) => v.round !== 4) }, id, reds, 'normalFit', 0);
      expect(on).toBeCloseTo(noR4, 9);
      expect(on).not.toBe(off);
    }
    expect(merlinVoteLogRatio(o, 'P10', reds, 'normalFit', 0, true)).toBeGreaterThan(merlinVoteLogRatio(o, 'P10', reds, 'normalFit', 0));
  });

  it('the agent: off = the current pick and scores; on, the R4 leader is back in the first tier with the softer lead term', () => {
    const o = obs();
    const base = new HeuristicAgent('P2', undefined, undefined, resolveAgentTuning({}));
    const zero = new HeuristicAgent('P2', undefined, undefined, resolveAgentTuning({ assassinNeedTwo73: 0 }));
    const all = new HeuristicAgent('P2', undefined, undefined, resolveAgentTuning({ assassinNeedTwo73: 7 }));
    const rb = base.assassinationReadout(o)!;
    const rz = zero.assassinationReadout(o)!;
    const ra = all.assassinationReadout(o)!;
    expect(rz.front).toEqual(rb.front);
    expect([...rz.scores]).toEqual([...rb.scores]);
    expect(rb.front).not.toContain('P1');
    expect(ra.front).toContain('P1');
    expect(ra.front).not.toContain('P8');
    expect(ra.terms.get('P1')!.lead).toBeGreaterThan(rb.terms.get('P1')!.lead);
    // The model term never changes.
    for (const id of blues) expect(ra.terms.get(id)!.model).toBe(rb.terms.get(id)!.model);
    const act = all.act(o);
    expect(act.type).toBe('assassinate');
    if (act.type === 'assassinate') expect(ra.front).toContain(act.targetId);
    expect(zero.act(o)).toEqual(base.act(o));
  });
});
