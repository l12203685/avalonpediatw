import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning, type AgentTuning } from './AgentTuning';
import { earlyGo84, earlyGoEval84, inRedCell84, innerBlackBar84, redMatchPoint84, redMatchWhite84, sixWhiteEstimate84, tailSendsClean84 } from './Round84';
import { bayesOptionsOf } from './belief/BayesBelief';
import { bayesVoteCriteria } from './BlueRound33';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { OPPONENT_TYPES, tuningForOpponent } from './humanProfile';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votes = (yes: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, yes.includes(id)]));
const KEYS = ['earlyGo84', 'earlyGoOn84', 'earlyGoNear84', 'earlyGoScope84', 'innerBlackBar84', 'redTailWhite84', 'redSixWhite84', 'redWhiteScope84'] as const;

/**
 * R3 at 0:2 (red has two fails). Reds: P2 assassin, P3 Morgana, P7 Mordred, P9 Oberon.
 * R1 P2 P3 P4 failed; R2 P2 P3 P7 P9 failed. Third proposal of R3 (failCount 2), P1 leads; the later captains are P2 (4th) and P3 (forced) — both red.
 */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  const r1 = ['P2', 'P3', 'P4'];
  const r2 = ['P2', 'P3', 'P7', 'P9'];
  return {
    myPlayerId: 'P5', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: ids, knownEvils: [],
    currentRound: 3, currentLeader: 'P1', failCount: 2, questResults: ['fail', 'fail'], gamePhase: 'team_vote',
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P2', team: r1, approved: true, votes: votes(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']) },
      { round: 2, attempt: 1, leader: 'P7', team: r2, approved: true, votes: votes(['P2', 'P7', 'P3', 'P9', 'P8', 'P10']) },
      { round: 3, attempt: 1, leader: 'P9', team: ['P9', 'P2', 'P3', 'P8'], approved: false, votes: votes(['P9', 'P2', 'P3']) },
      { round: 3, attempt: 2, leader: 'P10', team: ['P10', 'P1', 'P5', 'P6'], approved: false, votes: votes(['P10', 'P1', 'P5', 'P6']) },
    ],
    questHistory: [
      { round: 1, team: r1, result: 'fail', failCount: 1 }, { round: 2, team: r2, result: 'fail', failCount: 1 },
    ],
    proposedTeam: ['P1', 'P6', 'P10', 'P4'], myLakeResults: [], lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

const tun = (over: Partial<AgentTuning>): AgentTuning => resolveAgentTuning(over);

describe('round 84 switches', () => {
  it('default off in the default and legacy tables and at every opponent type; flags parse', () => {
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) for (const k of KEYS) expect(t[k]).toBe(0);
    for (const o of OPPONENT_TYPES) for (const k of KEYS) expect(tuningForOpponent(o)[k]).toBe(0);
    expect(parseTuningFlag('earlyGo84')).toEqual({ earlyGo84: 0.3 });
    expect(parseTuningFlag('earlyGoOn84=0.2')).toEqual({ earlyGoOn84: 0.2 });
    expect(parseTuningFlag('earlyGoNear84')).toEqual({ earlyGoNear84: 0.9 });
    expect(parseTuningFlag('innerBlackBar84')).toEqual({ innerBlackBar84: 0.85 });
    expect(parseTuningFlag('redTailWhite84')).toEqual({ redTailWhite84: 0.5 });
    expect(parseTuningFlag('redSixWhite84=1')).toEqual({ redSixWhite84: 1 });
    expect(parseTuningFlag('earlyGoScope84=31')).toEqual({ earlyGoScope84: 31 });
    expect(parseTuningFlag('redWhiteScope84=5')).toEqual({ redWhiteScope84: 5 });
    expect(() => parseTuningFlag('earlyGo84=1.5')).toThrow();
    expect(() => parseTuningFlag('earlyGoScope84=32')).toThrow();
    expect(() => parseTuningFlag('redWhiteScope84=8')).toThrow();
  });

  it('red match point: red has two fails, R3+, non-forced team vote', () => {
    expect(redMatchPoint84(obs())).toBe(true);
    expect(redMatchPoint84(obs({ failCount: 4 }))).toBe(false);
    expect(redMatchPoint84(obs({ questResults: ['fail', 'success'] }))).toBe(false);
    expect(redMatchPoint84(obs({ gamePhase: 'team_select' }))).toBe(false);
    expect(redMatchPoint84(obs({ currentRound: 5, questResults: ['fail', 'fail', 'success', 'success'] }))).toBe(true);
  });
});

describe('earlyGo84 / earlyGoOn84 (blue)', () => {
  const opts = bayesOptionsOf(DEFAULT_AGENT_TUNING);

  it('the eval: later captains both red-leaning, the product is a probability, the team is compared with the later captains and the whole table', () => {
    const e = earlyGoEval84(obs(), opts);
    expect(e).not.toBeNull();
    if (!e) return;
    for (const x of [e.p, e.laterRed, e.alt, e.best]) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
    expect(e.best).toBeGreaterThanOrEqual(e.p);
    expect(e.laterRed).toBeGreaterThan(0);
    // The voter is a later captain → no later all-red.
    expect(earlyGoEval84(obs({ myPlayerId: 'P3', proposedTeam: ['P1', 'P6', 'P10', 'P4'] }), opts)?.laterRed).toBe(0);
  });

  it('fires exactly when the three conditions hold (loyal, off the team)', () => {
    const e = earlyGoEval84(obs(), opts);
    if (!e) throw new Error('no eval');
    const ok = e.p > 0 && e.p >= e.alt && e.p >= 0.9 * e.best;
    expect(earlyGo84(tun({ earlyGo84: Math.max(0.001, e.laterRed - 1e-6) }), obs())).toBe(ok);
    expect(earlyGo84(tun({ earlyGo84: Math.min(1, e.laterRed + 1e-6) }), obs())).toBe(false);
    // Bit 16: no later-all-red check.
    expect(earlyGo84(tun({ earlyGo84: 1, earlyGoScope84: 16 }), obs())).toBe(ok);
    // ν = tiny and bit 16: only "no later captain sends a cleaner team".
    expect(earlyGo84(tun({ earlyGo84: 1, earlyGoScope84: 16, earlyGoNear84: 0.001 }), obs())).toBe(e.p > 0 && e.p >= e.alt);
    // Off-team switch does not fire on the team, and the reverse.
    const onTeam = obs({ proposedTeam: ['P1', 'P6', 'P10', 'P5'] });
    expect(earlyGo84(tun({ earlyGo84: 0.001, earlyGoScope84: 16, earlyGoNear84: 0.001 }), onTeam)).toBe(false);
    expect(earlyGo84(tun({ earlyGoOn84: 0.001, earlyGoScope84: 16, earlyGoNear84: 0.001 }), obs())).toBe(false);
  });

  it('scope: not at red match point, leader, red seat, nested loyal views, Merlin with a seen red or on the team, role and round bits', () => {
    const t = tun({ earlyGo84: 0.001, earlyGoOn84: 0.001, earlyGoScope84: 16, earlyGoNear84: 0.001 });
    const base = earlyGo84(t, obs());
    expect(earlyGo84(DEFAULT_AGENT_TUNING, obs())).toBe(false);
    expect(earlyGo84(t, obs({ questResults: ['fail', 'success'] }))).toBe(false);
    expect(earlyGo84(t, obs({ failCount: 4 }))).toBe(false);
    expect(earlyGo84(t, obs({ myPlayerId: 'P1' }))).toBe(false); // leader
    expect(earlyGo84(t, obs({ myTeam: 'evil', myRole: 'assassin', myPlayerId: 'P2', knownEvils: ['P3', 'P7'] }))).toBe(false);
    expect(earlyGo84(t, { ...obs(), publicLoyalView: true } as PlayerObservation)).toBe(false);
    expect(earlyGo84(t, { ...obs(), redLoyalView: true } as PlayerObservation)).toBe(false);
    const merlin = obs({ myRole: 'merlin', knownEvils: ['P2', 'P3', 'P7', 'P9'] });
    expect(earlyGo84(t, { ...merlin, proposedTeam: ['P1', 'P6', 'P10', 'P2'] } as PlayerObservation)).toBe(false); // seen red on the team
    expect(earlyGo84(t, { ...merlin, proposedTeam: ['P1', 'P6', 'P10', 'P5'] } as PlayerObservation)).toBe(false); // Merlin on the team
    expect(earlyGo84(tun({ earlyGo84: 0.001, earlyGoScope84: 17, earlyGoNear84: 0.001 }), merlin)).toBe(false); // bit 1
    expect(earlyGo84(tun({ earlyGo84: 0.001, earlyGoScope84: 18, earlyGoNear84: 0.001 }), obs({ myRole: 'percival' }))).toBe(false); // bit 2
    expect(earlyGo84(tun({ earlyGo84: 0.001, earlyGoScope84: 20, earlyGoNear84: 0.001 }), obs({ currentRound: 4, questResults: ['fail', 'fail', 'success'] }))).toBe(false); // bit 4
    expect(earlyGo84(tun({ earlyGo84: 0.001, earlyGoScope84: 20, earlyGoNear84: 0.001 }), obs())).toBe(base);
    // Bit 8: half the spots, the same spot the same way every time.
    let hit = 0;
    let total = 0;
    for (const seat of ['P4', 'P5', 'P6', 'P8', 'P10']) for (let fc = 0; fc < 4; fc++) {
      const o = obs({ myPlayerId: seat, failCount: fc, currentLeader: 'P1', proposedTeam: ['P1', 'P2', 'P3', 'P7'].filter((x) => x !== seat).slice(0, 4) });
      const half = tun({ earlyGo84: 0.001, earlyGoScope84: 24, earlyGoNear84: 0.001 });
      const a = earlyGo84(half, o);
      expect(earlyGo84(half, o)).toBe(a);
      if (a) expect(earlyGo84(tun({ earlyGo84: 0.001, earlyGoScope84: 16, earlyGoNear84: 0.001 }), o)).toBe(true);
      hit += a ? 1 : 0;
      total++;
    }
    expect(hit).toBeLessThan(total);
  });

  it('innerBlackBar84 replaces the on-team bar only at red match point; bayesVoteCriteria follows it', () => {
    expect(innerBlackBar84(DEFAULT_AGENT_TUNING, obs())).toBeNull();
    expect(innerBlackBar84(tun({ innerBlackBar84: 0.85 }), obs())).toBe(0.85);
    expect(innerBlackBar84(tun({ innerBlackBar84: 0.85 }), obs({ questResults: ['fail', 'success'] }))).toBeNull();
    expect(innerBlackBar84(tun({ innerBlackBar84: 0.85, earlyGoScope84: 4 }), obs({ currentRound: 4, questResults: ['fail', 'fail', 'success'] }))).toBeNull();
    // A team holding both suspects of R1: the default inner-blacks at the 0.7 bar; a bar of 1 never does.
    const dirty = obs({ proposedTeam: ['P5', 'P2', 'P3', 'P6'], currentLeader: 'P6' });
    const def = bayesVoteCriteria(DEFAULT_AGENT_TUNING, dirty);
    const high = bayesVoteCriteria(tun({ innerBlackBar84: 1 }), dirty);
    expect(def).not.toBeNull();
    if (def && def.reason === 'bad') expect(high?.vote).toBe(true);
  });

  it('ForwardAgent: the switch on approves where the conditions hold; off = the path as before', () => {
    const decide = (tuning: AgentTuning, o: PlayerObservation): boolean | null => {
      const base = new HeuristicAgent(o.myPlayerId, undefined, undefined, tuning);
      base.onGameStart(obs({ gamePhase: 'team_select', currentRound: 1, questResults: [], questHistory: [], voteHistory: [] }));
      const a = new ForwardAgent(o.myPlayerId, base).decide({ ...o, seatTeam: 'good' } as PlayerObservation).action;
      return a.type === 'team_vote' ? a.vote : null;
    };
    const t = tun({ earlyGo84: 0.001, earlyGoScope84: 16, earlyGoNear84: 0.001 });
    // Every team P8 (the least suspected seat) could lead without the voter P5: where the switch fires the agent approves; it fires somewhere.
    const others = ids.filter((id) => id !== 'P8' && id !== 'P5');
    let fired = 0;
    for (let a = 0; a < others.length; a++) for (let b = a + 1; b < others.length; b++) for (let c = b + 1; c < others.length; c++) {
      const o = obs({ currentLeader: 'P8', proposedTeam: ['P8', others[a], others[b], others[c]] });
      if (!earlyGo84(t, o)) continue;
      fired++;
      expect(decide(t, o)).toBe(true);
    }
    expect(fired).toBeGreaterThan(0);
    expect(typeof decide(resolveAgentTuning({}), obs())).toBe('boolean');
  });
});

describe('redTailWhite84 / redSixWhite84 (red)', () => {
  /** The assassin P2, off a team with Morgana P3 on it; R3 at 0:2, third proposal, P1 leads, P2 is the 4th captain, P3 the forced one. */
  const red = (over: Partial<PlayerObservation> = {}): PlayerObservation => obs({ myPlayerId: 'P2', myRole: 'assassin', myTeam: 'evil', knownEvils: ['P3', 'P7'], proposedTeam: ['P1', 'P3', 'P6', 'P10'], ...over });

  it('the cell: recognised red, red match point, off the team, not the leader, enough seen teammates on it', () => {
    const t = tun({ redTailWhite84: 1 });
    expect(inRedCell84(t, red())).toBe(true);
    expect(inRedCell84(t, red({ proposedTeam: ['P1', 'P4', 'P6', 'P10'] }))).toBe(false); // no teammate
    expect(inRedCell84(t, red({ proposedTeam: ['P1', 'P2', 'P3', 'P10'] }))).toBe(false); // on it
    expect(inRedCell84(t, red({ currentLeader: 'P2' }))).toBe(false);
    expect(inRedCell84(t, red({ myRole: 'oberon', myPlayerId: 'P9', knownEvils: [] }))).toBe(false);
    expect(inRedCell84(t, red({ questResults: ['fail', 'success'] }))).toBe(false);
    // R4 at 1:2 needs two fails: one seen teammate is not enough.
    const r4 = red({ currentRound: 4, questResults: ['fail', 'fail', 'success'], proposedTeam: ['P1', 'P3', 'P6', 'P10', 'P4'] });
    expect(inRedCell84(t, r4)).toBe(false);
    expect(inRedCell84(t, { ...r4, proposedTeam: ['P1', 'P3', 'P7', 'P10', 'P4'] } as PlayerObservation)).toBe(true);
    expect(inRedCell84(tun({ redTailWhite84: 1, redWhiteScope84: 2 }), { ...r4, proposedTeam: ['P1', 'P3', 'P7', 'P10', 'P4'] } as PlayerObservation)).toBe(false);
  });

  it('R1: the forced captain is a seen red → never; otherwise white iff his public team has no seen red (q = 1)', () => {
    // P3 (Morgana) is the forced captain here.
    expect(tailSendsClean84(DEFAULT_AGENT_TUNING, red())).toBe(false);
    expect(redMatchWhite84(tun({ redTailWhite84: 1 }), red())).toBe(false);
    // First proposal led by P8: the forced captain is P2 + ... → the voter himself at offset 4? P8 + 4 = P2 (the voter) → never.
    expect(tailSendsClean84(DEFAULT_AGENT_TUNING, red({ currentLeader: 'P8', failCount: 0 }))).toBe(false);
    // Second proposal led by P4: forced captain P7 (Mordred) → never. Third led by P5: forced captain P7 too.
    // A blue forced captain: fourth proposal led by P5 → forced P6.
    const blueTail = red({ currentLeader: 'P5', failCount: 3 });
    const clean = tailSendsClean84(DEFAULT_AGENT_TUNING, blueTail);
    expect(redMatchWhite84(tun({ redTailWhite84: 1 }), blueTail)).toBe(clean);
    expect(redMatchWhite84(DEFAULT_AGENT_TUNING, blueTail)).toBe(false);
  });

  it('R2: whites only when the estimate reaches the majority; bit 1 also needs R1; bit 4 only the needed reds', () => {
    const blueTail = red({ currentLeader: 'P5', failCount: 3 });
    const e = sixWhiteEstimate84(DEFAULT_AGENT_TUNING, blueTail);
    expect(e.majority).toBe(6);
    expect(e.offReds).toEqual(['P2', 'P7']);
    const reach = e.othersYes + e.offReds.length >= e.majority;
    expect(redMatchWhite84(tun({ redSixWhite84: 1 }), blueTail)).toBe(reach);
    if (!tailSendsClean84(DEFAULT_AGENT_TUNING, blueTail)) expect(redMatchWhite84(tun({ redSixWhite84: 1, redWhiteScope84: 1 }), blueTail)).toBe(false);
    const needed = Math.max(0, e.majority - e.othersYes);
    expect(redMatchWhite84(tun({ redSixWhite84: 1, redWhiteScope84: 4 }), blueTail)).toBe(reach && needed > 0 && e.offReds.indexOf('P2') < needed);
  });

  it('ForwardAgent: R1 on with a clean blue tail → white; off → the path as before', () => {
    const decide = (tuning: AgentTuning, o: PlayerObservation): boolean | null => {
      const base = new HeuristicAgent('P2', undefined, undefined, tuning);
      base.onGameStart(obs({ myPlayerId: 'P2', myRole: 'assassin', myTeam: 'evil', knownEvils: ['P3', 'P7'], gamePhase: 'team_select', currentRound: 1, questResults: [], questHistory: [], voteHistory: [] }));
      const a = new ForwardAgent('P2', base).decide({ ...o, seatTeam: 'evil' } as PlayerObservation).action;
      return a.type === 'team_vote' ? a.vote : null;
    };
    const blueTail = red({ currentLeader: 'P5', failCount: 3 });
    expect(tailSendsClean84(DEFAULT_AGENT_TUNING, { ...blueTail, seatTeam: 'evil' } as PlayerObservation)).toBe(true);
    expect(decide(tun({ redTailWhite84: 1 }), blueTail)).toBe(true);
    expect(typeof decide(resolveAgentTuning({}), blueTail)).toBe('boolean');
  });
});
