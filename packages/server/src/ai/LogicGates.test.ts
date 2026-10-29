/**
 * Logic-first batch 1D (2026-10-22, docs/ai/logic_first.md 第 7 節): the
 * decision gates of good seats — S1-3 team gate (`teamDominanceGate`),
 * S1-4 must-fail gate and S1-5 accuser (`mustFailGate`). Fake 10-player
 * games only (seats P1..P10, standard roles; R4 needs two fail cards).
 *
 * Each fixture first shows the breach with the gate off (the regression),
 * then the gated decision.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import { withSeededRandom } from './benchmark/agreement';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { buildCertainty } from './belief/Certainty';
import { analyzeLakeChain, declaredBlueClosure, findTeamHardRuleViolations } from './baseline/lakeChainTracker';
import { compliantTeams, goodVoteGate, teamGateBreach } from './LogicGates';
import { goodVouchVoteRule, ownDeclaredRedOnTeam } from './GoodLakeFollowUp';
import type { LakePublicRecord, PlayerObservation, QuestRecord, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
// `goodCleanVote` (round 3) rejects ahead of the gates tested here: off.
const ON: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodCleanVote: 0 };
// Gates off — and Percival's own batch-1E vote rule off, so the old
// "Percival on the team ⇒ approve" shortcut is what the gate is shown against.
const OFF: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodCleanVote: 0, teamDominanceGate: false, mustFailGate: false, percivalLoyalVote: false };
const GATES = { teamDominance: true, mustFail: true };

function quest(round: number, team: string[], failCount: number): QuestRecord {
  const need = round === 4 ? 2 : 1;
  return { round, team, failCount, result: failCount >= need ? 'fail' : 'success' };
}

function passed(round: number, leader: string, team: string[]): VoteRecord {
  return { round, attempt: 1, leader, team, approved: true, votes: Object.fromEntries(IDS.map((id) => [id, team.includes(id)])) };
}

function obsOf(p: {
  me: string;
  role: PlayerObservation['myRole'];
  phase: PlayerObservation['gamePhase'];
  round: number;
  quests: QuestRecord[];
  leader: string;
  team?: string[];
  failCount?: number;
  lakes?: LakePublicRecord[];
  myLakeResults?: PlayerObservation['myLakeResults'];
  knownWizards?: string[];
  knownEvils?: string[];
}): PlayerObservation {
  const quests = p.quests;
  return {
    myPlayerId: p.me,
    myRole: p.role,
    myTeam: 'good',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: p.knownEvils ?? [],
    knownWizards: p.knownWizards,
    currentRound: p.round,
    currentLeader: p.leader,
    failCount: p.failCount ?? 0,
    questResults: quests.map((q) => q.result),
    gamePhase: p.phase,
    voteHistory: quests.map((q) => passed(q.round, q.team[0], q.team)),
    questHistory: quests,
    proposedTeam: p.team ?? [],
    lakeHistory: p.lakes ?? [],
    myLakeResults: p.myLakeResults,
  };
}

function decide(o: PlayerObservation, tuning: AgentTuning): ReturnType<ForwardAgent['decide']> {
  const base = new HeuristicAgent(o.myPlayerId, undefined, undefined, tuning);
  const fwd = new ForwardAgent(o.myPlayerId, base);
  fwd.onGameStart(o);
  base._ingestForTesting(o);
  return fwd.decide(o);
}

const vote = (o: PlayerObservation, tuning: AgentTuning): boolean => {
  const a = decide(o, tuning).action;
  if (a.type !== 'team_vote') throw new Error('not a vote');
  return a.vote;
};


/**
 * The r5_must_fail_reuse fixture with R1 turned into a success. In the recorded game R1 and R2 failed, so since
 * A1 (Edward 2026-10-26: no stalling after two fails) R3's four are certainly good, P5 is R4's red and the
 * gates-off bot no longer re-proposes the R4 team. With one failed mission before R3, A1 does not apply and the
 * fixture shows the breach the gates bar, as recorded.
 */
function withoutNoStall(o: PlayerObservation): PlayerObservation {
  const quests = o.questHistory.map((q, i) => (i === 0 ? { ...q, result: 'success' as const, failCount: 0 } : q));
  return { ...o, questHistory: quests, questResults: quests.map((q) => q.result) };
}

describe('S1-4 must-fail vote gate (INV-V1)', () => {
  // Practice report 2026-10 (a): Percival on an R4 team the missions already
  // prove failable. Percival P6 (thumbs P1 / P9) sat on R1 {P6, P3, P4} with
  // two fail cards → P3 and P4 are red (P1); exactly one thumb is red (Pe1).
  // The R4 team {P2, P6, P3, P1, P9} therefore holds two certain reds —
  // R4 needs two fails, so it must fail.
  const r4 = (team: string[]): PlayerObservation => obsOf({
    me: 'P6', role: 'percival', phase: 'team_vote', round: 4, leader: 'P2', team, knownWizards: ['P1', 'P9'],
    quests: [quest(1, ['P6', 'P3', 'P4'], 2), quest(2, ['P2', 'P5', 'P7', 'P8'], 0), quest(3, ['P2', 'P5', 'P7', 'P8'], 0)],
  });

  it('Percival on the team: the "on the team ⇒ approve" shortcut approved a must-fail R4 team; the gate rejects first', () => {
    const o = r4(['P2', 'P6', 'P3', 'P1', 'P9']);
    expect(buildCertainty(o).provablyFailable(o.proposedTeam, 4)).toBe(true);
    expect(vote(o, OFF)).toBe(true); // the breach (shortcut)
    expect(vote(o, ON)).toBe(false);
    expect(decide(o, ON).reasoningTrace.summary).toMatch(/logic gate reject \(mustFail/);
    expect(goodVoteGate(o, GATES)).toBe('mustFail');
  });

  it('R4 with a single certain red is the probability layer (D2): no gate', () => {
    const o = r4(['P2', 'P6', 'P5', 'P1', 'P9']); // the thumbs: exactly one red, two needed
    expect(buildCertainty(o).provablyFailable(o.proposedTeam, 4)).toBe(false);
    expect(goodVoteGate(o, GATES)).toBeNull();
  });

  // A team that must fail as a set with no single certain red: loyal P2
  // sat on R1 {P2, P5, P8} with one fail card → P5 or P8 is red (P1).
  const set = (p: { team: string[]; round?: number; failCount?: number; leader?: string }): PlayerObservation => obsOf({
    me: 'P2', role: 'loyal', phase: 'team_vote', round: p.round ?? 3, leader: p.leader ?? 'P1', team: p.team,
    failCount: p.failCount,
    quests: [quest(1, ['P2', 'P5', 'P8'], 1), quest(2, ['P1', 'P3', 'P4', 'P6'], 0)].slice(0, (p.round ?? 3) - 1),
  });

  it('a set that must fail (no single certain red) is rejected, on the team or off it', () => {
    const off = set({ team: ['P1', 'P5', 'P8', 'P10'] });
    const view = buildCertainty(off);
    expect(view.isCertRed('P5')).toBe(false);
    expect(view.isCertRed('P8')).toBe(false);
    expect(view.provablyFailable(off.proposedTeam, 3)).toBe(true);
    expect(vote(off, ON)).toBe(false);
    const onTeam = set({ team: ['P1', 'P2', 'P5', 'P8'] });
    expect(vote(onTeam, ON)).toBe(false);
  });

  it('exemptions: the forced fifth proposal holds no vote; R1–R2 keep the normal-vote table rule (D3)', () => {
    const forced = set({ team: ['P1', 'P2', 'P5', 'P8'], failCount: 4 });
    expect(goodVoteGate(forced, GATES)).toBeNull();
    expect(vote(forced, ON)).toBe(true);
    // R2, on the team: the table rule approves (owner's D3 ruling, final).
    const r2 = set({ team: ['P1', 'P2', 'P5', 'P8'], round: 2 });
    expect(buildCertainty(r2).provablyFailable(r2.proposedTeam, 2)).toBe(true);
    expect(goodVoteGate(r2, GATES)).toBeNull();
    expect(vote(r2, ON)).toBe(true);
  });

  it('the gate binds good seats only', () => {
    const red = { ...set({ team: ['P1', 'P2', 'P5', 'P8'] }), myTeam: 'evil' as const, myRole: 'assassin' as const, knownEvils: ['P5'] };
    expect(goodVoteGate(red, GATES)).toBeNull();
  });
});

describe('S1-5 accuser and P2 own declared red (INV-P3, INV-L1)', () => {
  const lakeR2 = (holder: string, target: string, claim: 'good' | 'evil'): LakePublicRecord =>
    ({ round: 2, holderId: holder, targetId: target, declaredClaim: claim });
  const base = (me: string, team: string[], round: number, lakes: LakePublicRecord[], extra: Partial<Parameters<typeof obsOf>[0]> = {}): PlayerObservation =>
    obsOf({
      me, role: 'loyal', phase: 'team_vote', round, leader: 'P1', team, lakes,
      quests: [quest(1, ['P1', 'P2', 'P3'], 0), quest(2, ['P1', 'P2', 'P3', 'P5'], 0), quest(3, ['P1', 'P2', 'P3', 'P5'], 0)].slice(0, round - 1),
      ...extra,
    });

  it('S1-5: the accuser is certainly red (L1) and a one-fail team holding it must fail', () => {
    const o = base('P4', ['P1', 'P4', 'P7', 'P9'], 3, [lakeR2('P7', 'P4', 'evil')]);
    const view = buildCertainty(o);
    expect(view.isCertRed('P7', 'L1')).toBe(true);
    expect(view.isCertRed('P7', 'L0')).toBe(false);
    expect(goodVoteGate(o, GATES)).toBe('mustFail');
    expect(vote(o, ON)).toBe(false);
  });

  it('P2: a holder on the team rejects a one-fail team with a seat it declared red; R4 is the probability layer', () => {
    const lakes = [lakeR2('P10', 'P3', 'evil')];
    const own = [{ round: 2, targetId: 'P3', result: 'evil' as const }];
    const r3 = base('P10', ['P1', 'P10', 'P3', 'P6'], 3, lakes, { myLakeResults: own });
    expect(ownDeclaredRedOnTeam(r3)).toBe(true);
    expect(goodVouchVoteRule(r3)).toBeNull(); // before 1D: no veto on the team
    expect(goodVouchVoteRule(r3, true)).toBe('reject');
    expect(vote(r3, ON)).toBe(false);
    const r4 = base('P10', ['P1', 'P10', 'P3', 'P6', 'P7'], 4, lakes, { myLakeResults: own });
    expect(goodVouchVoteRule(r4, true)).toBeNull();
    expect(goodVoteGate(r4, GATES)).toBeNull();
  });

  it('P2 keys on the declaration, not on A0 about others (a lying declaration still binds its holder)', () => {
    // The holder's private result says blue, its declaration said red: the
    // certainty layer trusts the private result, the vouch rule the word.
    const lakes = [lakeR2('P10', 'P3', 'evil')];
    const r3 = base('P10', ['P1', 'P10', 'P3', 'P6'], 3, lakes, { myLakeResults: [{ round: 2, targetId: 'P3', result: 'good' }] });
    expect(buildCertainty(r3).provablyFailable(r3.proposedTeam, 3)).toBe(false);
    expect(goodVoteGate(r3, GATES)).toBe('ownDeclaredRed');
  });
});

describe('S1-3 team gate: strict 硬1 / 硬2 with chain closure (INV-K1)', () => {
  // Loyal P5 leads R4 (team of five). Lakes: after R2 P10 declared P3 blue,
  // after R3 P3 declared P6 blue — choosing P10 ⇒ P3 ⇒ P6.
  const lakes: LakePublicRecord[] = [
    { round: 2, holderId: 'P10', targetId: 'P3', declaredClaim: 'good' },
    { round: 3, holderId: 'P3', targetId: 'P6', declaredClaim: 'good' },
  ];
  const leader = (round = 4, team: string[] = []): PlayerObservation => obsOf({
    me: 'P5', role: 'loyal', phase: 'team_select', round, leader: 'P5', team, lakes,
    quests: [quest(1, ['P1', 'P2', 'P4'], 0), quest(2, ['P1', 'P2', 'P4', 'P7'], 0), quest(3, ['P1', 'P2', 'P4', 'P7'], 0)].slice(0, round - 1),
  });

  it('the chain closes: a team with P10 needs P3 and P6, a team with P3 needs P6', () => {
    const o = leader();
    const chain = analyzeLakeChain(o);
    expect(declaredBlueClosure(chain, 'P10')).toEqual(['P3', 'P6']);
    const view = buildCertainty(o);
    const strict = (team: string[]): string[] => findTeamHardRuleViolations(chain, team, { view, round: 4 })
      .filter((v) => v.rule === 1).map((v) => `${v.holderId}>${v.targetId}`).sort();
    expect(strict(['P5', 'P10', 'P1', 'P2', 'P4'])).toEqual(['P10>P3', 'P10>P6']);
    expect(strict(['P5', 'P10', 'P3', 'P1', 'P2'])).toEqual(['P10>P6', 'P3>P6']);
    expect(strict(['P5', 'P10', 'P3', 'P6', 'P1'])).toEqual([]);
    expect(strict(['P5', 'P3', 'P6', 'P1', 'P2'])).toEqual([]);
    // The legacy reading (every member's declarations, no strictness) for comparison.
    expect(findTeamHardRuleViolations(chain, ['P5', 'P10', 'P1', 'P2', 'P4']).map((v) => v.targetId)).toEqual(['P3']);
  });

  it('strict 硬1 is non-empty exactly when the certainty layer calls the team strictly dominated', () => {
    const o = leader();
    const view = buildCertainty(o);
    const chain = analyzeLakeChain(o);
    const others = IDS.filter((id) => id !== 'P5');
    let checked = 0;
    for (let a = 0; a < others.length; a++) for (let b = a + 1; b < others.length; b++)
      for (let c = b + 1; c < others.length; c++) for (let d = c + 1; d < others.length; d++) {
        const team = ['P5', others[a], others[b], others[c], others[d]];
        const strict = findTeamHardRuleViolations(chain, team, { view, round: 4 }).some((v) => v.rule === 1);
        expect(strict).toBe(view.strictlyDominated(team) !== null);
        checked++;
      }
    expect(checked).toBe(126);
  });

  it('a declaration the viewer itself contradicts binds nothing (A0 broken by the viewer; probe edge case)', () => {
    // P10 declared P3 blue after R2 but privately saw P3 red (a lie or a
    // wrong record). For P10, "P10 good ⇒ P3 good" is false: leaving P3 out
    // is no breach, and P3 → P6 is not reached through P10 either.
    const o = obsOf({
      me: 'P10', role: 'loyal', phase: 'team_select', round: 4, leader: 'P10', lakes,
      myLakeResults: [{ round: 2, targetId: 'P3', result: 'evil' }],
      quests: [quest(1, ['P1', 'P2', 'P4'], 0), quest(2, ['P1', 'P2', 'P4', 'P7'], 0), quest(3, ['P1', 'P2', 'P4', 'P7'], 0)],
    });
    const view = buildCertainty(o);
    expect(view.isCertRed('P3')).toBe(true);
    expect(view.vouches('P10', 'P3')).toBe(false);
    expect(view.vouches('P3', 'P6')).toBe(true);
    const team = ['P10', 'P1', 'P2', 'P4', 'P5'];
    expect(view.strictlyDominated(team)).toBeNull();
    expect(findTeamHardRuleViolations(analyzeLakeChain(o), team, { view, round: 4 })).toEqual([]);
    // Without the private result the declaration binds as usual.
    const plain = buildCertainty({ ...o, myLakeResults: [] });
    expect(plain.strictlyDominated(team)).not.toBeNull();
  });

  it('a tie is not a breach (X4): every other member certainly good', () => {
    // Merlin P5 sees P2 / P7 / P9 red; R1 {P5, P1, P4} showed one fail card
    // with no red he sees on it → Mordred ∈ {P1, P4} (M2) and every other
    // seat he cannot see is certainly good. P10 declared P3 blue.
    const o = obsOf({
      me: 'P5', role: 'merlin', phase: 'team_select', round: 3, leader: 'P5', lakes: [lakes[0]],
      knownEvils: ['P2', 'P7', 'P9'],
      quests: [quest(1, ['P5', 'P1', 'P4'], 1), quest(2, ['P6', 'P8', 'P10', 'P3'], 0)],
    });
    const view = buildCertainty(o);
    for (const id of ['P3', 'P6', 'P8', 'P10']) expect(view.isCertGood(id)).toBe(true);
    // Leaving P3 out of a team of certain goods is a tie, not a breach.
    expect(view.strictlyDominated(['P5', 'P10', 'P6', 'P8'])).toBeNull();
    expect(teamGateBreach(o, view, ['P5', 'P10', 'P6', 'P8'], 3, GATES)).toBeNull();
    // With P1 on it (maybe Mordred, maybe not: not a must-fail team), leaving P3 out is dominated.
    expect(view.provablyFailable(['P5', 'P10', 'P6', 'P1'], 3)).toBe(false);
    expect(teamGateBreach(o, view, ['P5', 'P10', 'P6', 'P1'], 3, GATES)).toBe('dominated');
    // Both P1 and P4: Mordred is on it — must fail.
    expect(teamGateBreach(o, view, ['P5', 'P1', 'P4', 'P6'], 3, GATES)).toBe('mustFail');
  });
});

describe('S1-3 / S1-4 on proposals (INV-T1, INV-K1, INV-K2)', () => {
  it('regression (synthetic self-play): R5 re-proposal of the R4 team that succeeded with a fail card (C5)', () => {
    // A bot game from the invariant harness's self-play (seat ids only). The
    // R4 team {P2, P8, P9, P1, P5} "succeeded" with one fail card — R4 needs
    // two — so it holds a red, and in R5 (one fail decides) it must fail.
    const fx = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../__tests__/fixtures/logic_gates/r5_must_fail_reuse.json'), 'utf8')) as {
      seed: string; botTeamGatesOff: string[]; obs: PlayerObservation;
    };
    const o = withoutNoStall(fx.obs);
    const view = buildCertainty(o);
    const run = (tuning: AgentTuning): string[] => {
      const base = new HeuristicAgent(o.myPlayerId, undefined, undefined, tuning);
      const fwd = new ForwardAgent(o.myPlayerId, base);
      fwd.onGameStart(o);
      const d = withSeededRandom(fx.seed, () => { base._ingestForTesting(o); return fwd.decide(o); });
      if (d.action.type !== 'team_select') throw new Error('not a proposal');
      return d.action.teamIds;
    };
    // The fixture came from the pyramid scorer (`bayesBelief` off, 2026-10-28).
    const off = run({ ...OFF, bayesBelief: false });
    expect([...off].sort()).toEqual([...fx.botTeamGatesOff].sort());
    expect(view.provablyFailable(off, 5)).toBe(true); // the breach
    const on = run({ ...ON, bayesBelief: false });
    expect(view.provablyFailable(on, 5)).toBe(false);
    expect(view.strictlyDominated(on)).toBeNull();
    // The production default (Bayes posterior) proposes no must-fail or dominated team here either.
    const prod = run(ON);
    expect(view.provablyFailable(prod, 5)).toBe(false);
    expect(view.strictlyDominated(prod)).toBeNull();
  });

  it('compliantTeams: every team passes both gates, best first, never empty', () => {
    const lakes: LakePublicRecord[] = [
      { round: 2, holderId: 'P10', targetId: 'P3', declaredClaim: 'good' },
      { round: 2, holderId: 'P9', targetId: 'P8', declaredClaim: 'evil' },
    ];
    const o = obsOf({
      me: 'P2', role: 'loyal', phase: 'team_select', round: 3, leader: 'P2', lakes,
      quests: [quest(1, ['P2', 'P5', 'P7'], 1), quest(2, ['P1', 'P3', 'P4', 'P6'], 0)],
    });
    const view = buildCertainty(o);
    const teams = compliantTeams(o, view, 4, GATES, { score: () => 0.5 });
    expect(teams.length).toBeGreaterThan(0);
    for (const t of teams) {
      expect(t).toContain('P2');
      expect(t).toHaveLength(4);
      expect(view.provablyFailable(t, 3)).toBe(false);
      expect(view.strictlyDominated(t)).toBeNull();
      // K2 pair (P9 declared P8 red) never both on, P1 pair {P5, P7} never both on.
      expect(t.includes('P9') && t.includes('P8')).toBe(false);
      expect(t.includes('P5') && t.includes('P7')).toBe(false);
    }
  });

  it('ForwardAgent: a good leader never proposes a must-fail or dominated team, in any round or attempt', () => {
    // Percival P6 led R2 with both thumbs P1 / P9 on one team before any
    // gate (must fail: exactly one thumb is red). With the gates the leader
    // of every attempt of R2..R4 proposes a team that passes both.
    const lakes: LakePublicRecord[] = [{ round: 2, holderId: 'P10', targetId: 'P3', declaredClaim: 'good' }];
    for (const round of [2, 3, 4]) {
      for (const failCount of [0, 2, 4]) {
        for (const role of ['loyal', 'percival', 'merlin'] as const) {
          const o = obsOf({
            me: 'P6', role, phase: 'team_select', round, leader: 'P6', failCount,
            knownWizards: role === 'percival' ? ['P1', 'P9'] : undefined,
            knownEvils: role === 'merlin' ? ['P2', 'P7', 'P9'] : [],
            lakes: round >= 3 ? lakes : [],
            quests: [quest(1, ['P6', 'P5', 'P8'], 1), quest(2, ['P10', 'P3', 'P4', 'P1'], 0), quest(3, ['P10', 'P3', 'P4', 'P1'], 0)].slice(0, round - 1),
          });
          const a = decide(o, ON).action;
          expect(a.type).toBe('team_select');
          if (a.type !== 'team_select') continue;
          const view = buildCertainty(o);
          // 派拇指躲刺 (`merlinDoomedRed`): on a doomed R2 proposal Merlin puts one seen red on the team — the
          // only proposals it may; the R1–R2 normal votes reject them, so they never go on a mission.
          if (role === 'merlin' && round <= 2 && failCount < 4) {
            expect(a.teamIds.filter((id) => ['P2', 'P7', 'P9'].includes(id))).toHaveLength(1);
            continue;
          }
          expect({ round, failCount, role, mustFail: view.provablyFailable(a.teamIds, round) })
            .toEqual({ round, failCount, role, mustFail: false });
          expect({ round, failCount, role, dominated: view.strictlyDominated(a.teamIds) })
            .toEqual({ round, failCount, role, dominated: null });
        }
      }
    }
  });
});

