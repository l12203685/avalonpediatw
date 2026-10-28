/**
 * Logic-first batch 1G (2026-10-26, docs/ai/logic_first.md 第 9 節; practice
 * report (b)): at the assassination, a candidate who as captain on a
 * non-forced proposal certainly put a red Merlin sees on the team (the
 * assassin, Oberon, or both seen teammates) is ranked below every candidate
 * who never did — `assassinVisibleRedTier`, both assassin paths (the
 * assassination model the ForwardAgent delegates to, and the legacy
 * heuristic) — and a lead with one seen teammate (Morgana or Mordred, the
 * assassin cannot tell) carries the measured soft likelihood
 * (`assassinVisibleRedLikelihood`). INV-A2. The 2026-10-26 review made the
 * tier a tier-2 (human-likeness) rule, the soft factor the ratio of the
 * measured rates, model path only and off by default, and Mordred's presence
 * a lobby-role fact.
 *
 * Fake 10-player game, seat ids only: assassin P1 sees teammates P2 / P3
 * (Morgana and Mordred, roles unknown to it); Oberon P4; candidates P5..P10.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { ASSASSIN_FEATURE_NAMES, type AssassinModelWeights } from './assassin/AssassinModel';
import {
  AMBIGUOUS_LEAD_RATES,
  ambiguousLeadMultiplier,
  classifyTeamForAssassin,
  merlinSightFromAssassin,
  pickWithVisibleRed,
  tierCandidates,
  visibleRedEvidence,
} from './assassin/VisibleRedProposals';
import { explainAssassination } from './explain';
import { checkDecision } from './invariants/checks';
import { Ledger } from './invariants/ledger';
import type { PlayerObservation, QuestRecord, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
const CANDIDATES = ['P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
const ON: AgentTuning = { ...DEFAULT_AGENT_TUNING };
const TIER_OFF: AgentTuning = { ...DEFAULT_AGENT_TUNING, assassinVisibleRedTier: false, assassinVisibleRedLikelihood: false };

function vote(round: number, attempt: number, leader: string, team: string[], approvers: string[], approved: boolean): VoteRecord {
  return { round, attempt, leader, team, approved, votes: Object.fromEntries(IDS.map((id) => [id, approvers.includes(id)])) };
}

function quest(round: number, team: string[]): QuestRecord {
  return { round, team, failCount: 0, result: 'success' };
}

/**
 * Three blue missions; the leader of `oberonTeam` (P7 by default) led it as a
 * non-forced R3 proposal: it holds Oberon (P4), a red Merlin surely sees.
 */
function assassinationObs(extra: VoteRecord[] = [], oberonTeam = ['P7', 'P4', 'P9', 'P10']): PlayerObservation {
  const everyone = IDS;
  const voteHistory: VoteRecord[] = [
    vote(1, 1, 'P5', ['P5', 'P6', 'P8'], everyone, true),
    vote(2, 1, 'P6', ['P6', 'P5', 'P8', 'P9'], everyone, true),
    vote(3, 1, oberonTeam[0], oberonTeam, [], false),
    ...extra,
    vote(3, 4, 'P8', ['P8', 'P5', 'P6', 'P9'], everyone, true),
  ];
  return {
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS,
    knownEvils: ['P2', 'P3'], allEvilIds: ['P1', 'P2', 'P3', 'P4'],
    currentRound: 4, currentLeader: 'P9', failCount: 0, questResults: ['success', 'success', 'success'],
    gamePhase: 'assassination', proposedTeam: [], lakeHistory: [],
    voteHistory,
    questHistory: [quest(1, ['P5', 'P6', 'P8']), quest(2, ['P6', 'P5', 'P8', 'P9']), quest(3, ['P8', 'P5', 'P6', 'P9'])],
  };
}

/**
 * Model weights that depend on the seat only, so the probabilities over the
 * six candidates are exactly `probs` (the report: the chosen seat on top of
 * the model, three seats close together at 0.14).
 */
function seatOnlyWeights(probs: Record<string, number>): AssassinModelWeights {
  const weights = ASSASSIN_FEATURE_NAMES.map(() => 0);
  for (const [id, p] of Object.entries(probs)) {
    weights[ASSASSIN_FEATURE_NAMES.indexOf(`seat${id.slice(1)}`)] = Math.log(p);
  }
  return { version: 'test', features: ASSASSIN_FEATURE_NAMES, weights };
}

const REPORT_PROBS = { P5: 0.14, P6: 0.14, P7: 0.36, P8: 0.16, P9: 0.14, P10: 0.06 };

function forwardAssassinate(o: PlayerObservation, tuning: AgentTuning, weights?: AssassinModelWeights): string {
  const base = new HeuristicAgent('P1', undefined, undefined, tuning, weights);
  const fwd = new ForwardAgent('P1', base);
  fwd.onGameStart(o);
  base._ingestForTesting(o);
  const { action, reasoningTrace } = fwd.decide(o);
  expect(reasoningTrace.usedFallback).toBe(false);
  if (action.type !== 'assassinate') throw new Error(`expected assassinate, got ${action.type}`);
  return action.targetId;
}

describe('batch 1G — what Merlin surely sees, from the assassin', () => {
  it('classifies teams: assassin / Oberon / both teammates are certain, one teammate is ambiguous', () => {
    const sight = merlinSightFromAssassin(assassinationObs());
    expect([...sight.certain].sort()).toEqual(['P1', 'P4']);
    expect([...sight.ambiguous].sort()).toEqual(['P2', 'P3']);
    expect(classifyTeamForAssassin(['P5', 'P4', 'P6'], sight)).toBe('certain'); // Oberon
    expect(classifyTeamForAssassin(['P5', 'P1', 'P6'], sight)).toBe('certain'); // the assassin itself
    expect(classifyTeamForAssassin(['P5', 'P2', 'P3'], sight)).toBe('certain'); // one of them is Morgana
    expect(classifyTeamForAssassin(['P5', 'P2', 'P6'], sight)).toBe('ambiguous'); // Morgana or Mordred
    expect(classifyTeamForAssassin(['P5', 'P6', 'P7'], sight)).toBe('none');
  });

  it('with the reds\' cards shown (刺殺階段開牌相認, Edward 2026-10-26) Merlin\'s sight is exact: every red but Mordred', () => {
    const o: PlayerObservation = {
      ...assassinationObs([
        vote(2, 2, 'P5', ['P5', 'P2', 'P6', 'P8'], [], false), // Morgana alone on it: seen → flagged
        vote(2, 3, 'P8', ['P8', 'P3', 'P6', 'P9'], [], false), // Mordred alone on it: unseen → clean
      ]),
      allEvilRoles: { P1: 'assassin', P2: 'morgana', P3: 'mordred', P4: 'oberon' },
    };
    const sight = merlinSightFromAssassin(o);
    expect([...sight.certain].sort()).toEqual(['P1', 'P2', 'P4']);
    expect(sight.ambiguous).toEqual([]);
    const ev = visibleRedEvidence(o, CANDIDATES);
    expect(ev.get('P5')).toMatchObject({ tier: 1, certainRounds: [2], ambiguousRounds: [] });
    expect(ev.get('P8')).toMatchObject({ tier: 0, certainRounds: [] });
    expect(tierCandidates(CANDIDATES, ev)).toEqual(['P6', 'P8', 'P9', 'P10']); // P7 led Oberon, P5 Morgana
  });

  it('counts every proposal from R1 on, the forced fifth too (Edward 2026-10-26); the soft factor only non-forced ones', () => {
    const o = assassinationObs([
      vote(1, 2, 'P9', ['P9', 'P1', 'P5'], [], false), // R1, non-forced, the assassin on it → counts (R1 is not exempt)
      vote(2, 5, 'P10', ['P10', 'P4', 'P5', 'P6'], IDS, true), // forced fifth with Oberon on it → counts
      vote(2, 2, 'P5', ['P5', 'P2', 'P6', 'P8'], [], false), // one teammate only: ambiguous
      vote(3, 5, 'P8', ['P8', 'P2', 'P6', 'P9'], IDS, true), // forced fifth, ambiguous: no soft factor
    ]);
    const ev = visibleRedEvidence(o, CANDIDATES);
    expect(ev.get('P7')).toMatchObject({ tier: 1, certainRounds: [3] });
    expect(ev.get('P9')).toMatchObject({ tier: 1, certainRounds: [1] });
    expect(ev.get('P10')).toMatchObject({ tier: 1, certainRounds: [2] });
    expect(ev.get('P5')).toMatchObject({ tier: 0, ambiguousRounds: [2] });
    expect(ev.get('P5')?.logLikelihood).toBeCloseTo(Math.log(ambiguousLeadMultiplier(2, 0.5)), 12);
    expect(ev.get('P8')).toMatchObject({ tier: 0, ambiguousRounds: [], logLikelihood: 0 });
    expect(tierCandidates(CANDIDATES, ev)).toEqual(['P5', 'P6', 'P8']);
  });

  it('the tier is never a hard exclusion: when every candidate did it, the scores decide', () => {
    const o = assassinationObs(CANDIDATES.map((id) => vote(4, 1, id, [id, 'P4', 'P5', 'P6', 'P7'], [], false)));
    const ev = visibleRedEvidence(o, CANDIDATES);
    expect(CANDIDATES.every((id) => ev.get(id)?.tier === 1)).toBe(true);
    expect(tierCandidates(CANDIDATES, ev)).toEqual(CANDIDATES);
    const scores = new Map(Object.entries(REPORT_PROBS).map(([id, p]) => [id, Math.log(p)]));
    expect(pickWithVisibleRed(o, CANDIDATES, scores, { tier: true, likelihood: false })).toBe('P7');
  });

  it('the soft multiplier is the ratio of the mixed rates — the measured LR of the ambiguous class at p = 1/2 (review fix)', () => {
    // The study's "ambiguous" rows (scripts/assassinVisibleRedStudy.ts (a)); the
    // batch-1G formula 1/2 LR(visible) + 1/2 LR(not visible) gave 1.18 / 1.17 /
    // 0.98 / 1.00 / 0.70 instead.
    const measured: Record<number, number> = { 1: 1.25, 2: 1.64, 3: 1.03, 4: 1.51, 5: 1.01 };
    for (const r of [1, 2, 3, 4, 5]) {
      const t = AMBIGUOUS_LEAD_RATES[r];
      expect(ambiguousLeadMultiplier(r, 0.5)).toBeCloseTo(measured[r], 2);
      expect(ambiguousLeadMultiplier(r, 0.5)).toBeCloseTo(
        ((t.merlin.seen + t.merlin.unseen) / t.merlin.n) / ((t.other.seen + t.other.unseen) / t.other.n), 12);
      // Seen for sure (Morgana): human Merlins avoid it; unseen for sure (Mordred): they do not.
      expect(ambiguousLeadMultiplier(r, 1)).toBeLessThan(1);
      expect(ambiguousLeadMultiplier(r, 0)).toBeGreaterThan(1);
    }
    expect(ambiguousLeadMultiplier(5, 0.5)).toBeGreaterThan(1); // R5 was penalised x0.70 by the withdrawn formula
    expect(ambiguousLeadMultiplier(9, 0.5)).toBe(1);
  });

  it('Mordred presence comes from the lobby roles (review fix): Mordred off → both seen teammates are certain', () => {
    const lobbyOff = ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'minion', 'oberon'] as PlayerObservation['lobbyRoles'];
    const o = { ...assassinationObs([vote(2, 2, 'P5', ['P5', 'P2', 'P6', 'P8'], [], false)]), lobbyRoles: lobbyOff };
    const sight = merlinSightFromAssassin(o);
    expect([...sight.certain].sort()).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(sight.ambiguous).toEqual([]);
    expect(classifyTeamForAssassin(['P5', 'P2', 'P6'], sight)).toBe('certain');
    expect(visibleRedEvidence(o, CANDIDATES).get('P5')).toMatchObject({ tier: 1, certainRounds: [2], ambiguousRounds: [] });
    // The standard lobby (Mordred dealt), given or from the table: one teammate stays ambiguous.
    const std = ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'] as PlayerObservation['lobbyRoles'];
    for (const lobbyRoles of [std, undefined]) {
      const s2 = merlinSightFromAssassin({ ...o, lobbyRoles });
      expect(classifyTeamForAssassin(['P5', 'P2', 'P6'], s2)).toBe('ambiguous');
    }
  });

  it('a Mordred assassinator (7 players) is not seen; Morgana and Oberon are', () => {
    const IDS7 = IDS.slice(0, 7);
    const o: PlayerObservation = {
      ...assassinationObs(), myPlayerId: 'P1', myRole: 'mordred', playerCount: 7, allPlayerIds: IDS7,
      knownEvils: ['P2'], allEvilIds: ['P1', 'P2', 'P3'],
      lobbyRoles: ['merlin', 'percival', 'loyal', 'loyal', 'morgana', 'mordred', 'oberon'],
      voteHistory: [
        vote(1, 1, 'P4', ['P4', 'P1'], [], false), // holds only the Mordred: Merlin could do it
        vote(1, 2, 'P5', ['P5', 'P3'], [], false), // Oberon
        vote(1, 3, 'P6', ['P6', 'P2'], [], false), // Morgana
      ].map((v) => ({ ...v, votes: Object.fromEntries(IDS7.map((id) => [id, false])) })),
    };
    const sight = merlinSightFromAssassin(o);
    expect([...sight.certain].sort()).toEqual(['P2', 'P3']);
    const ev = visibleRedEvidence(o, ['P4', 'P5', 'P6', 'P7']);
    expect(['P4', 'P5', 'P6', 'P7'].map((id) => ev.get(id)?.tier)).toEqual([0, 1, 1, 0]);
  });
});

describe('batch 1G — the practice report (b) fixture', () => {
  // The report: six candidates; the bot killed a seat its review listed at
  // 0.08 while three seats stood at 0.14, and that seat had led a team with a
  // red Merlin sees. The review's list was the ToM number; the pick was the
  // assassination model's top. Here the model puts the visible-red captain
  // (P7) on top, as it did in the report.
  it('model path (ForwardAgent → assassination model): the visible-red captain is chosen with the switch off, never with it on', () => {
    const o = assassinationObs();
    const weights = seatOnlyWeights(REPORT_PROBS);
    expect(forwardAssassinate(o, TIER_OFF, weights)).toBe('P7');
    const target = forwardAssassinate(o, ON, weights);
    expect(target).not.toBe('P7');
    expect(target).toBe('P8'); // the best of the candidates who never did
  });

  it('legacy heuristic path (assassination model off): the same', () => {
    // Every candidate has a certain "mistake" in the old heuristic's sense
    // (P7 / P9 / P10 approved the assassin's team off-team, P6 / P8 rejected
    // a team surely free of seen reds that they were on, P5 led the Oberon
    // team), so its unmistaken-first filter keeps all six, and P5 has the
    // best score: the heuristic kills the visible-red captain.
    const o = assassinationObs([
      vote(3, 2, 'P1', ['P1', 'P2', 'P5', 'P6'], ['P1', 'P2', 'P7', 'P9', 'P10'], false),
      vote(3, 3, 'P9', ['P9', 'P5', 'P6', 'P8'], ['P9', 'P7', 'P10', 'P1', 'P2'], false),
    ], ['P5', 'P4', 'P7', 'P8']);
    expect(visibleRedEvidence(o, CANDIDATES).get('P5')?.tier).toBe(1);
    expect(forwardAssassinate(o, { ...TIER_OFF, assassinModel: false })).toBe('P5');
    expect(forwardAssassinate(o, { ...ON, assassinModel: false })).not.toBe('P5');
    // The soft factor never touches the heuristic score (no fitted scale; review fix).
    expect(forwardAssassinate(o, { ...ON, assassinModel: false, assassinVisibleRedLikelihood: true }))
      .toBe(forwardAssassinate(o, { ...ON, assassinModel: false, assassinVisibleRedLikelihood: false }));
  });

  it('the soft factor is off by default and, when on, adds ln LR to the model score only (review fix: double counting)', () => {
    expect(ON.assassinVisibleRedLikelihood).toBe(false);
    // P5 and P8 tie on the model; P5 led one ambiguous R3 team (LR 1.03 > 1). (An R2 non-forced lead no longer
    // counts: Edward 2026-10-28, `assassinIgnoreDoomed`.)
    const o = assassinationObs([vote(3, 2, 'P5', ['P5', 'P2', 'P6', 'P8'], [], false)]);
    const weights = seatOnlyWeights({ P5: 0.16, P6: 0.14, P7: 0.36, P8: 0.16, P9: 0.14, P10: 0.04 });
    expect(forwardAssassinate(o, ON, weights)).toBe('P5'); // tie → seat order
    const o2 = assassinationObs([vote(3, 2, 'P8', ['P8', 'P2', 'P6', 'P9'], [], false)]);
    expect(forwardAssassinate(o2, ON, weights)).toBe('P5'); // off: the ambiguous lead changes nothing
    expect(forwardAssassinate(o2, { ...ON, assassinVisibleRedLikelihood: true }, weights)).toBe('P8');
  });

  it('Edward 2026-10-28 (assassinIgnoreDoomed): a non-forced R1–R2 lead no longer counts; the forced fifth still does', () => {
    expect(ON.assassinIgnoreDoomed).toBe(true);
    const weights = seatOnlyWeights({ P5: 0.16, P6: 0.14, P7: 0.36, P8: 0.16, P9: 0.14, P10: 0.04 });
    const withLead = (attempt: number): PlayerObservation => {
      const o = assassinationObs();
      // P7's visible-red lead (Oberon P4 on the team) moved from R3 to R2.
      return { ...o, voteHistory: o.voteHistory.map((v) => (v.leader === 'P7' ? { ...v, round: 2, attempt } : v)) };
    };
    expect(forwardAssassinate(withLead(2), ON, weights)).toBe('P7'); // doomed proposal: the model decides
    expect(forwardAssassinate(withLead(2), { ...ON, assassinIgnoreDoomed: false }, weights)).not.toBe('P7'); // the 10/26 rule
    expect(forwardAssassinate(withLead(5), ON, weights)).not.toBe('P7'); // forced fifth: still counts
  });

  it('the practice review states the reason when the tier applies', () => {
    const o = assassinationObs();
    const ex = explainAssassination(o, 'P8', undefined, ON);
    expect(ex.reason).toContain('7家當隊長時把梅林一定看得到的紅');
    expect(ex.reason).toContain('排在其餘 5 人之後');
    expect(ex.rule).toMatch(/^刺殺（像真人的規則）：當隊長時確定把梅林看得到的紅放進自己隊的人排在後面/);
    expect(ex.reason).toContain('真人梅林很少這樣派');
    expect(ex.suspectsLabel).toBe('刺殺模型機率');
    const off = explainAssassination(o, 'P7', undefined, TIER_OFF);
    expect(off.reason).not.toContain('一定看得到的紅');
    expect(off.rule).toBeUndefined();
  });

  it('INV-A2 flags a pick of the visible-red captain and passes the tiered pick', () => {
    const o = assassinationObs();
    const tally = (target: string): { violations: number; opportunities: number } => {
      const L = new Ledger();
      checkDecision({ kind: 'assassinate', obs: o, action: { type: 'assassinate', targetId: target } } as never, L);
      const t = L.tallies.get('INV-A2');
      return { violations: t?.violations ?? -1, opportunities: t?.opportunities ?? -1 };
    };
    expect(tally('P7')).toEqual({ violations: 1, opportunities: 1 });
    expect(tally('P8')).toEqual({ violations: 0, opportunities: 1 });
  });
});
