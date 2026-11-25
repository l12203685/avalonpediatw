/**
 * 第 76 回合：忠臣、派西第 4 局在隊上的票（`onTeamR4Key76`／`onTeamR4Open76` 照比分分開的門檻、`onTeamR4Soft76` 門檻附近的漸進；Round76.ts）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamRedsBelow } from './belief/BayesBelief';
import { bayesVoteCriteria } from './BlueRound33';
import { onTeamBar59 } from './Round59';
import { onTeamBar76, provReq76, round76On } from './Round76';
import { buildCertainty } from './belief/Certainty';
import { OPPONENT_TYPES, tuningForOpponent } from './humanProfile';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;

// 比分 2:1 的第 4 局（同 Round59.test）：第 1 局 P1 P2 P3 失敗一張、第 2 局 P5 P6 P7 P8 成功、第 3 局 P4 P5 P9 P10 成功。P4 派第 4 局第 1 次提議。
const r4 = (me: string, team: string[], extra: object = {}) => asObs({
  myPlayerId: me, myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 4, currentLeader: 'P4', failCount: 0, questResults: ['fail', 'success', 'success'], gamePhase: 'team_vote',
  questHistory: [
    { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 },
    { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
    { round: 3, team: ['P4', 'P5', 'P9', 'P10'], result: 'success', failCount: 0 },
  ],
  voteHistory: [], proposedTeam: team, lakeHistory: [], myLakeResults: [], ...extra,
});
// 比分 1:2 的第 4 局：第 1 局失敗、第 2 局成功、第 3 局 P4 P5 P9 P10 失敗一張。
const r4Key = (me: string, team: string[], extra: object = {}) => asObs({
  ...(r4(me, team) as unknown as object),
  questResults: ['fail', 'success', 'fail'],
  questHistory: [
    { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 },
    { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
    { round: 3, team: ['P4', 'P5', 'P9', 'P10'], result: 'fail', failCount: 1 },
  ],
  ...extra,
});

const TEAM = ['P4', 'P6', 'P7', 'P8', 'P10'];
const on = (over: Partial<AgentTuning>): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const p2Of = (o: PlayerObservation, team: string[]): number => 1 - (bayesTeamRedsBelow(o, team, 2, bayesOptionsOf(DEFAULT_AGENT_TUNING)) ?? 1);

describe('round 76 tuning fields', () => {
  it('off by default, in the legacy table and on every opponent profile; flags parse and describe', () => {
    for (const k of ['onTeamR4Key76', 'onTeamR4Open76', 'onTeamR4Soft76', 'onTeamR4Prov76'] as const) {
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
    }
    expect(round76On(DEFAULT_AGENT_TUNING)).toBe(false);
    for (const t of OPPONENT_TYPES) expect(round76On(tuningForOpponent(t, DEFAULT_AGENT_TUNING))).toBe(false);
    expect(parseTuningFlag('onTeamR4Key76')).toEqual({ onTeamR4Key76: 0.5 });
    expect(parseTuningFlag('onTeamR4Open76=0.65')).toEqual({ onTeamR4Open76: 0.65 });
    expect(parseTuningFlag('onTeamR4Soft76')).toEqual({ onTeamR4Soft76: 0.3 });
    expect(() => parseTuningFlag('onTeamR4Key76=1.2')).toThrow();
    expect(() => parseTuningFlag('onTeamR4Soft76=0.6')).toThrow();
    expect(parseTuningFlag('onTeamR4Prov76')).toEqual({ onTeamR4Prov76: 1 });
    expect(() => parseTuningFlag('onTeamR4Prov76=2')).toThrow();
    expect(describeAgentTuning(on({ onTeamR4Key76: 0.5 }))).toContain('onTeamR4Key76=0.5');
  });
});

describe('onTeamBar76: which bar applies', () => {
  it('null when every switch is off (round 59 keeps deciding)', () => {
    expect(onTeamBar76(DEFAULT_AGENT_TUNING, r4('P10', TEAM), 2, TEAM)).toBeNull();
    expect(onTeamBar76(on({ onTeamVote59: 0.8 }), r4Key('P10', TEAM), 2, TEAM)).toBeNull();
  });
  it('the bar follows the score: Key at 1:2, Open at 2:1; the other score falls back to round 59', () => {
    const t = on({ onTeamVote59: 0.8, onTeamR4Key76: 0.5 });
    expect(onTeamBar76(t, r4Key('P10', TEAM), 2, TEAM)).toEqual({ req: 2, bar: 0.5 });
    expect(onTeamBar76(t, r4('P10', TEAM), 2, TEAM)).toBeNull();
    expect(onTeamBar59(t, r4('P10', TEAM), 2)).toEqual({ req: 2, bar: 0.8 });
    const u = on({ onTeamR4Open76: 0.65 });
    expect(onTeamBar76(u, r4('P10', TEAM), 2, TEAM)).toEqual({ req: 2, bar: 0.65 });
    expect(onTeamBar76(u, r4Key('P10', TEAM), 2, TEAM)).toBeNull();
  });
  it('only mission 4 with two fails required; Merlin\'s public view is skipped', () => {
    const t = on({ onTeamR4Key76: 0.5, onTeamR4Open76: 0.5, onTeamR4Soft76: 0.3 });
    expect(onTeamBar76(t, asObs({ ...(r4('P10', TEAM) as unknown as object), currentRound: 3 }), 1, TEAM)).toBeNull();
    expect(onTeamBar76(t, asObs({ ...(r4('P10', TEAM) as unknown as object), currentRound: 5 }), 1, TEAM)).toBeNull();
    expect(onTeamBar76(t, r4('P10', TEAM), 1, TEAM)).toBeNull();
    expect(onTeamBar76(t, asObs({ ...(r4('P10', TEAM) as unknown as object), publicLoyalView: true }), 2, TEAM)).toBeNull();
  });
  it('Soft: the bar moves inside θ ± w, the same spot always gets the same bar, and it needs a θ', () => {
    const t = on({ onTeamVote59: 0.8, onTeamR4Soft76: 0.3 });
    const a = onTeamBar76(t, r4('P10', TEAM), 2, TEAM);
    expect(a).not.toBeNull();
    expect(a!.bar).toBeGreaterThanOrEqual(0.5);
    expect(a!.bar).toBeLessThanOrEqual(1.1);
    expect(onTeamBar76(t, r4('P10', [...TEAM].reverse()), 2, [...TEAM].reverse())).toEqual(a);
    const bars = new Set<number>();
    for (const me of ['P6', 'P7', 'P8', 'P10']) for (const fc of [0, 1, 2, 3]) bars.add(onTeamBar76(t, r4(me, TEAM, { failCount: fc }), 2, TEAM)!.bar);
    expect(bars.size).toBeGreaterThan(8);
    expect(onTeamBar76(on({ onTeamR4Soft76: 0.3 }), r4('P10', TEAM), 2, TEAM)).toBeNull();
    const k = onTeamBar76(on({ onTeamVote59: 0.8, onTeamR4Key76: 0.5, onTeamR4Soft76: 0.2 }), r4Key('P10', TEAM), 2, TEAM)!;
    expect(k.bar).toBeGreaterThanOrEqual(0.3);
    expect(k.bar).toBeLessThanOrEqual(0.7);
  });
});

describe('the vote: mission 4 on the team', () => {
  const open = r4('P10', TEAM);
  const key = r4Key('P10', TEAM);
  const pOpen = p2Of(open, TEAM);
  const pKey = p2Of(key, TEAM);
  it('the fixtures: P(≥ 2 reds) is strictly between 0 and 0.8 at both scores', () => {
    for (const p of [pOpen, pKey]) {
      expect(p).toBeGreaterThan(0.02);
      expect(p).toBeLessThan(0.8);
    }
  });
  it('1:2 — the human-table bar 0.8 approves; onTeamR4Key76 just below P rejects, just above approves', () => {
    expect(bayesVoteCriteria(on({ onTeamVote59: 0.8 }), key)).toEqual({ vote: true, reason: 'onDefault' });
    expect(bayesVoteCriteria(on({ onTeamVote59: 0.8, onTeamR4Key76: pKey - 0.01 }), key)).toEqual({ vote: false, reason: 'bad' });
    expect(bayesVoteCriteria(on({ onTeamVote59: 0.8, onTeamR4Key76: Math.min(1, pKey + 0.01) }), key)).toEqual({ vote: true, reason: 'onDefault' });
  });
  it('onTeamR4Key76 does not touch 2:1, onTeamR4Open76 does not touch 1:2', () => {
    const base = on({ onTeamVote59: 0.8 });
    expect(bayesVoteCriteria(on({ onTeamVote59: 0.8, onTeamR4Key76: 0.01 }), open)).toEqual(bayesVoteCriteria(base, open));
    expect(bayesVoteCriteria(on({ onTeamVote59: 0.8, onTeamR4Open76: 0.01 }), key)).toEqual(bayesVoteCriteria(base, key));
    expect(bayesVoteCriteria(on({ onTeamVote59: 0.8, onTeamR4Open76: pOpen - 0.01 }), open)).toEqual({ vote: false, reason: 'bad' });
  });
  it('works without round 59 too (baseline layer): the literal two-fail reading with its own bar', () => {
    expect(bayesVoteCriteria(DEFAULT_AGENT_TUNING, key)).toEqual({ vote: false, reason: 'bad' });
    expect(bayesVoteCriteria(on({ onTeamR4Key76: Math.min(1, pKey + 0.01) }), key)).toEqual({ vote: true, reason: 'onDefault' });
  });
  it('Soft: certain approve below θ − w, certain reject above θ + w', () => {
    expect(bayesVoteCriteria(on({ onTeamR4Key76: Math.min(1, pKey + 0.25), onTeamR4Soft76: 0.2 }), key)).toEqual({ vote: true, reason: 'onDefault' });
    expect(bayesVoteCriteria(on({ onTeamR4Key76: Math.max(0.01, pKey - 0.25), onTeamR4Soft76: 0.2 }), key)).toEqual({ vote: false, reason: 'bad' });
  });
  it('unchanged: proven-fail teams, off-team votes, the leader, missions 3 and 5, Merlin', () => {
    const all = on({ onTeamVote59: 0.8, onTeamR4Key76: 0.99, onTeamR4Open76: 0.99, onTeamR4Soft76: 0.01 });
    const proven = ['P1', 'P2', 'P3', 'P4', 'P10'];
    expect(bayesVoteCriteria(all, r4('P10', proven))?.vote).toBe(false);
    const low = on({ onTeamVote59: 0.8, onTeamR4Key76: 0.01, onTeamR4Open76: 0.01 });
    const base = on({ onTeamVote59: 0.8 });
    const off = r4Key('P9', TEAM);
    expect(bayesVoteCriteria(low, off)).toEqual(bayesVoteCriteria(base, off));
    const lead = r4Key('P4', TEAM);
    expect(bayesVoteCriteria(low, lead)).toEqual(bayesVoteCriteria(base, lead));
    const r3 = asObs({ ...(r4('P10', ['P4', 'P5', 'P9', 'P10']) as unknown as object), currentRound: 3, questResults: ['fail', 'success'], questHistory: (r4('P10', []) as unknown as { questHistory: unknown[] }).questHistory.slice(0, 2) });
    expect(bayesVoteCriteria(low, r3)).toEqual(bayesVoteCriteria(base, r3));
    const merlin = asObs({ ...(key as unknown as object), publicLoyalView: true });
    expect(bayesVoteCriteria(low, merlin)).toEqual(bayesVoteCriteria(base, merlin));
  });
});

describe('onTeamR4Prov76: a proven fail on mission 4 needs two certain reds', () => {
  // P1 P2 P3 failed R1 with one card: the public logic proves a red among them. A mission-4 team holding all three holds a certain red — one, not two.
  const proven = ['P1', 'P2', 'P3', 'P4', 'P10'];
  const o = r4('P10', proven);
  const k = r4Key('P10', proven);
  it('the fixture: exactly one red is certain on the team', () => {
    expect(buildCertainty(o).minReds(proven)).toBe(1);
  });
  it('provReq76: the literal count only on mission 4, with the switch, where a literal bar applies; never for Merlin\'s public view', () => {
    expect(provReq76(on({ onTeamVote59: 0.8, onTeamR4Prov76: 1 }), o, 2, 1)).toBe(2);
    expect(provReq76(on({ onTeamVote59: 0.8 }), o, 2, 1)).toBe(1);
    expect(provReq76(on({ onTeamR4Prov76: 1 }), o, 2, 1)).toBe(1);
    expect(provReq76(on({ onTeamR4Key76: 0.5, onTeamR4Prov76: 1 }), k, 2, 1)).toBe(2);
    expect(provReq76(on({ onTeamR4Key76: 0.5, onTeamR4Prov76: 1 }), o, 2, 1)).toBe(1);
    expect(provReq76(on({ onTeamVote59: 0.8, onTeamR4Prov76: 1 }), asObs({ ...(o as unknown as object), currentRound: 3 }), 1, 1)).toBe(1);
    expect(provReq76(on({ onTeamVote59: 0.8, onTeamR4Prov76: 1 }), asObs({ ...(o as unknown as object), publicLoyalView: true }), 2, 1)).toBe(1);
  });
  it('without the switch one certain red is an outright reject; with it the vote goes to the P(≥ 2 reds) bar', () => {
    expect(bayesVoteCriteria(on({ onTeamVote59: 0.99 }), o)).toEqual({ vote: false, reason: 'provFail' });
    const p = p2Of(o, proven);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.99);
    expect(bayesVoteCriteria(on({ onTeamVote59: 0.99, onTeamR4Prov76: 1 }), o)).toEqual({ vote: true, reason: 'onDefault' });
    expect(bayesVoteCriteria(on({ onTeamVote59: Math.max(0.01, p - 0.01), onTeamR4Prov76: 1 }), o)).toEqual({ vote: false, reason: 'bad' });
  });
  it('the baseline layer (no literal reading) is untouched by the switch alone', () => {
    expect(bayesVoteCriteria(on({ onTeamR4Prov76: 1 }), o)).toEqual(bayesVoteCriteria(DEFAULT_AGENT_TUNING, o));
  });
});
