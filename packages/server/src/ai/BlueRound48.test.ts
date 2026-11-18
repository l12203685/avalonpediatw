/**
 * 優化迴圈第 48 回合・藍方信念：分回合的再校準（`beliefRecalib`）與桌上慣例的顫抖（`beliefConventionTremble`），
 * docs/ai/methods_backlog.md 第 1、2 項。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { RECALIB_48, bayesOptionsOf, bayesRedShare, bayesWorlds } from './belief/BayesBelief';
import { buildCertainty, conventionCounter } from './belief/Certainty';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});
const base = {
  myPlayerId: 'P10', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [], evilCount: 4,
  lakeHistory: [], myLakeResults: [], proposedTeam: [], failCount: 0,
};
const HISTORY = [
  vote(1, 1, 'P1', ['P1', 'P2', 'P3'], ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']),
  vote(2, 1, 'P2', ['P2', 'P4', 'P6', 'P7'], ['P2', 'P4', 'P6', 'P7', 'P8', 'P9']),
  vote(3, 1, 'P3', ['P3', 'P5', 'P8', 'P9'], ['P3', 'P5', 'P8', 'P9', 'P1', 'P10']),
];
const QUESTS = [
  { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail', failCount: 1 },
  { round: 2, team: ['P2', 'P4', 'P6', 'P7'], result: 'fail', failCount: 1 },
  { round: 3, team: ['P3', 'P5', 'P8', 'P9'], result: 'success', failCount: 0 },
];
/** Round 4, two fails then a success (A1 caps the R3 team at zero reds), a lake declaration P1 → P5 evil (A0). */
const r4 = (over: object = {}) => asObs({
  ...base, currentRound: 4, gamePhase: 'team_vote', currentLeader: 'P4', proposedTeam: ['P4', 'P6', 'P7', 'P10', 'P1'],
  questResults: ['fail', 'fail', 'success'], voteHistory: HISTORY, questHistory: QUESTS,
  lakeHistory: [{ round: 3, holderId: 'P1', targetId: 'P5', declaredClaim: 'evil' }], ...over,
});
const entropy = (w: readonly number[]): number => -w.reduce((s, x) => s + (x > 0 ? x * Math.log(x) : 0), 0);
const T = (over: object) => ({ ...DEFAULT_AGENT_TUNING, ...over });

describe('round 48 tuning fields', () => {
  it('off in the legacy table and the default; flags parse; the description names them', () => {
    for (const k of ['beliefRecalib', 'beliefConventionTremble'] as const) {
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
    }
    expect(parseTuningFlag('beliefRecalib')).toEqual({ beliefRecalib: 1 });
    expect(parseTuningFlag('beliefRecalib=3')).toEqual({ beliefRecalib: 3 });
    expect(parseTuningFlag('beliefConventionTremble')).toEqual({ beliefConventionTremble: 0.01 });
    expect(parseTuningFlag('beliefConventionTremble=0.03')).toEqual({ beliefConventionTremble: 0.03 });
    expect(() => parseTuningFlag('beliefRecalib=4')).toThrow();
    expect(() => parseTuningFlag('beliefConventionTremble=1')).toThrow();
    expect(describeAgentTuning(T({ beliefRecalib: 1, beliefConventionTremble: 0.03 }))).toContain('beliefRecalib=1,beliefConventionTremble=0.03');
  });
  it('off adds nothing to the posterior options (the default reads exactly as before), the recursive level 0 never gets them', () => {
    const def = bayesOptionsOf(DEFAULT_AGENT_TUNING);
    for (const k of ['recalibPower', 'recalibTemper', 'recalibNoVote', 'conventionTremble'] as const) expect(def[k]).toBeUndefined();
    const on = bayesOptionsOf(T({ beliefRecalib: 1, beliefConventionTremble: 0.03 }));
    expect(on.recalibPower).toEqual(RECALIB_48[1].power);
    expect(on.conventionTremble).toBe(0.03);
    expect(on.recursiveLevel0?.recalibPower).toBeUndefined();
    expect(on.recursiveLevel0?.conventionTremble).toBeUndefined();
    expect(JSON.stringify(on.recursiveLevel0)).toBe(JSON.stringify(def.recursiveLevel0));
  });
});

describe('beliefRecalib: per-round recalibration of the blue posterior', () => {
  it('the fitted tables: round 1 untouched, later rounds pulled harder', () => {
    const p = RECALIB_48[1].power!;
    expect(p[0]).toBe(1);
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeLessThanOrEqual(p[i - 1]);
    expect(RECALIB_48[3].power).toEqual(p);
    expect(RECALIB_48[3].noVote).toBe(true);
  });
  it('=1 at round 4: the world weights are the default ones to the power b_4 (flatter), same worlds', () => {
    const obs = r4();
    const d = bayesWorlds(obs, bayesOptionsOf(DEFAULT_AGENT_TUNING));
    const c = bayesWorlds(obs, bayesOptionsOf(T({ beliefRecalib: 1 })));
    expect(c.worlds).toEqual(d.worlds);
    expect(entropy(c.wts)).toBeGreaterThan(entropy(d.wts));
    const b = RECALIB_48[1].power![3];
    const raw = d.wts.map((w) => w ** b);
    const tot = raw.reduce((s, x) => s + x, 0);
    c.wts.forEach((w, i) => expect(w).toBeCloseTo(raw[i] / tot, 9));
  });
  it('=2 multiplies the vote / proposal powers by m_r (round 4: 0.7 → 0.7·m, 0.3 → 0.3·m)', () => {
    const obs = r4();
    const m = RECALIB_48[2].temper![3];
    const def = bayesOptionsOf(DEFAULT_AGENT_TUNING);
    const manual = bayesWorlds(obs, { ...def, voteTemper: def.voteTemper! * m, proposalTemper: def.proposalTemper! * m });
    const c = bayesWorlds(obs, bayesOptionsOf(T({ beliefRecalib: 2 })));
    expect(c.worlds).toEqual(manual.worlds);
    c.wts.forEach((w, i) => expect(w).toBeCloseTo(manual.wts[i], 12));
    const d = bayesWorlds(obs, def);
    expect(c.wts.some((w, i) => Math.abs(w - d.wts[i]) > 1e-6)).toBe(true);
  });
  it('round 1 (b = 1) and red seats read exactly as the default', () => {
    const r1 = asObs({ ...base, currentRound: 1, gamePhase: 'team_vote', currentLeader: 'P2', proposedTeam: ['P2', 'P3', 'P4'], questResults: [], voteHistory: [HISTORY[0]], questHistory: [] });
    expect([...bayesRedShare(r1, bayesOptionsOf(T({ beliefRecalib: 1 })))]).toEqual([...bayesRedShare(r1, bayesOptionsOf(DEFAULT_AGENT_TUNING))]);
    const red = r4({ myRole: 'assassin', myTeam: 'evil', seatTeam: 'evil', knownEvils: ['P2', 'P3', 'P6'] });
    expect([...bayesRedShare(red, bayesOptionsOf(T({ beliefRecalib: 1, beliefConventionTremble: 0.03 })))]).toEqual([...bayesRedShare(red, bayesOptionsOf(DEFAULT_AGENT_TUNING))]);
    const redView = r4({ redLoyalView: true });
    expect([...bayesRedShare(redView, bayesOptionsOf(T({ beliefRecalib: 1 })))]).toEqual([...bayesRedShare(redView, bayesOptionsOf(DEFAULT_AGENT_TUNING))]);
  });
  it('=3 leaves the viewer\'s own votes on the default posterior and recalibrates its team picks', () => {
    const vote4 = r4();
    expect([...bayesRedShare(vote4, bayesOptionsOf(T({ beliefRecalib: 3 })))]).toEqual([...bayesRedShare(vote4, bayesOptionsOf(DEFAULT_AGENT_TUNING))]);
    const pick = r4({ gamePhase: 'team_select', currentLeader: 'P10', proposedTeam: [] });
    const d = bayesWorlds(pick, bayesOptionsOf(DEFAULT_AGENT_TUNING));
    const c = bayesWorlds(pick, bayesOptionsOf(T({ beliefRecalib: 3 })));
    expect(entropy(c.wts)).toBeGreaterThan(entropy(d.wts));
  });
});

describe('beliefConventionTremble: the table conventions as soft facts', () => {
  it('conventionCounter: A0 (a good holder lying), A1 (a red on a success after two fails), A2 counted per world', () => {
    const obs = r4();
    const count = conventionCounter(obs);
    const mask = (ids: string[]): number => ids.reduce((m, id) => m | (1 << IDS.indexOf(id)), 0);
    // P1 red: its claim binds nothing; R3 team clean → nothing broken.
    expect(count(mask(['P1', 'P2', 'P4', 'P6']))).toEqual({ broken: 0, kept: 0 });
    // P1 good, P5 good: A0 broken; P5 on the R3 success after two fails would be A1 — here P5 is blue.
    expect(count(mask(['P2', 'P4', 'P6', 'P7']))).toEqual({ broken: 1, kept: 0 });
    expect(count(mask(['P2', 'P3', 'P4', 'P6']))).toEqual({ broken: 2, kept: 0 });
    // P1 good, P5 red: A0 kept, but P5 sat on the R3 success after two fails → A1 broken.
    expect(count(mask(['P2', 'P4', 'P5', 'P6']))).toEqual({ broken: 1, kept: 1 });
  });
  it('the hard L1 world set misses worlds the soft posterior keeps at a small weight; the certainty layer is unchanged', () => {
    const obs = r4();
    const view = buildCertainty(obs);
    const hard = bayesWorlds(obs, bayesOptionsOf(DEFAULT_AGENT_TUNING));
    const soft = bayesWorlds(obs, bayesOptionsOf(T({ beliefConventionTremble: 0.03 })));
    expect(hard.worlds.length).toBe(view.worlds('L1*').length);
    expect(soft.worlds.length).toBe(view.worlds('L0').length);
    expect(soft.worlds.length).toBeGreaterThan(hard.worlds.length);
    const hardSet = new Set(hard.worlds);
    const extra = soft.worlds.reduce((s, w, i) => s + (hardSet.has(w) ? 0 : soft.wts[i]), 0);
    expect(extra).toBeGreaterThan(0);
    expect(extra).toBeLessThan(0.5);
    // R3 team members are certainly blue at L1 (A1): hard posterior 0, soft posterior small but > 0.
    const hp = bayesRedShare(obs, bayesOptionsOf(DEFAULT_AGENT_TUNING));
    const sp = bayesRedShare(obs, bayesOptionsOf(T({ beliefConventionTremble: 0.03 })));
    expect(view.isCertGood('P8')).toBe(true);
    expect(hp.get('P8')).toBe(0);
    expect(sp.get('P8')!).toBeGreaterThan(0);
    expect(sp.get('P8')!).toBeLessThan(0.5);
    expect(buildCertainty(obs).certGood('L1*')).toEqual(view.certGood('L1*'));
  });
  it('a smaller ε keeps the broken worlds lighter', () => {
    const obs = r4();
    const a = bayesRedShare(obs, bayesOptionsOf(T({ beliefConventionTremble: 0.003 })));
    const b = bayesRedShare(obs, bayesOptionsOf(T({ beliefConventionTremble: 0.1 })));
    expect(a.get('P8')!).toBeLessThan(b.get('P8')!);
  });
});
