/**
 * Logic-first batches 1E / 1F (2026-10-26, docs/ai/logic_first.md 第 8 節):
 *   - S1-6 Percival = a loyal with one more fact ("exactly one of my two
 *     thumbs is red"): `percivalLoyalVote` (vote) and
 *     `percivalCertainExclusion` (team: hard-exclude certain reds only);
 *   - S1-8 Percival's lake is a blue lake: `percivalBlueLake`;
 *   - S1-10 a red holder never makes a claim that cannot be true for a good
 *     holder: `redPossibleClaimsOnly`.
 * Fake 10-player games only (seats P1..P10, standard roles; R4 needs two
 * fail cards). Each fixture first shows the old behaviour with the switch
 * off, then the new one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withSeededRandom } from './benchmark/agreement';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent, inferRedsFromTaskFails, percivalSignalsWithoutTie } from './forward/ForwardAgent';
import type { RoleSignals } from './forward/RoleStrategy';
import { buildCertainty, claimPossibleForGoodHolder } from './belief/Certainty';
import { decideLakeClaimForTeam, goodLakeAvoidSet, pickLakeTargetForTeam } from './LakePolicy';
import { pickGoodLakeTargetInfoMax } from './GoodLakeInfo';
import { percivalBothThumbsReject } from './PercivalThumbs';
import { replayRule } from './explain';
import type { LakePublicRecord, PlayerObservation, QuestRecord, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
// `goodCleanVote` (round 3) rejects ahead of the rules tested here: off.
const ON: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodCleanVote: 0 };
/** Percival's batch-1E vote rule off (the 1D production default for votes). */
const VOTE_OFF: AgentTuning = { ...DEFAULT_AGENT_TUNING, goodCleanVote: 0, percivalLoyalVote: false };

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
  team?: 'good' | 'evil';
  phase: PlayerObservation['gamePhase'];
  round: number;
  quests: QuestRecord[];
  leader: string;
  proposed?: string[];
  failCount?: number;
  lakes?: LakePublicRecord[];
  myLakeResults?: PlayerObservation['myLakeResults'];
  knownWizards?: string[];
  knownEvils?: string[];
}): PlayerObservation {
  return {
    myPlayerId: p.me,
    myRole: p.role,
    myTeam: p.team ?? 'good',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: p.knownEvils ?? [],
    knownWizards: p.knownWizards,
    currentRound: p.round,
    currentLeader: p.leader,
    failCount: p.failCount ?? 0,
    questResults: p.quests.map((q) => q.result),
    gamePhase: p.phase,
    voteHistory: p.quests.map((q) => passed(q.round, q.team[0], q.team)),
    questHistory: p.quests,
    proposedTeam: p.proposed ?? [],
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

afterEach(() => {
  vi.restoreAllMocks();
});

// ── S1-6: Percival's vote ───────────────────────────────────────

describe('S1-6 Percival votes as a loyal (percivalLoyalVote)', () => {
  // Modelled on the 2026-10 practice report (a), seat ids only: 10 players,
  // R4 attempt 1 (not forced), the bot Percival on the team. Percival P10
  // (thumbs P8 / P9) held the first lake after R2, saw P2 good and said so;
  // P2 held the next lake after R3 and declared P1 good. R1 {P1, P2, P3} had
  // one fail card. At L1 (a good holder tells the truth — P2 is certainly
  // good to Percival, so its word binds) P1 is good, hence P3 is the red of
  // R1: certainly red at L1 (not at L0 — only through the declaration). The
  // R4 team {P1, P2, P3, P9, P10} (leader P4, off the team) holds P3 and one
  // thumb; R4 needs two fails and only one seat is certain, so the 1D
  // must-fail gate does not apply, and it keeps both declared-blue seats
  // with their holders, so the lake-chain gate does not either.
  const practice = (): PlayerObservation => obsOf({
    me: 'P10', role: 'percival', phase: 'team_vote', round: 4, leader: 'P4',
    proposed: ['P1', 'P2', 'P3', 'P9', 'P10'], knownWizards: ['P8', 'P9'],
    quests: [quest(1, ['P1', 'P2', 'P3'], 1), quest(2, ['P4', 'P5', 'P6', 'P7'], 0), quest(3, ['P2', 'P4', 'P5', 'P10'], 0)],
    lakes: [
      { round: 2, holderId: 'P10', targetId: 'P2', declaredClaim: 'good' },
      { round: 3, holderId: 'P2', targetId: 'P1', declaredClaim: 'good' },
    ],
    myLakeResults: [{ round: 2, targetId: 'P2', result: 'good' }],
  });

  it('practice report (a): the team holds a seat certainly red at L1 — the shortcut approved, Percival now rejects', () => {
    const o = practice();
    const view = buildCertainty(o);
    expect(view.isCertRed('P3', 'L1')).toBe(true);
    expect(view.isCertRed('P3', 'L0')).toBe(false);
    expect(view.provablyFailable(o.proposedTeam, 4)).toBe(false); // R4: two fails, one certain red
    expect(view.strictlyDominated(o.proposedTeam)).toBeNull();
    expect(vote(o, VOTE_OFF)).toBe(true); // the breach: "Percival on the team ⇒ approve"
    expect(decide(o, VOTE_OFF).reasoningTrace.summary).toMatch(/percival on-team approve hard rule/);
    expect(vote(o, ON)).toBe(false);
    expect(decide(o, ON).reasoningTrace.summary).not.toMatch(/on-team approve/);
  });

  it('the fallback path (HeuristicAgent) drops the shortcut too', () => {
    const o = practice();
    // The baseline vote carries a noise flip (`applyNoise`, about 6% here: not a finish-line decision, R4
    // needs two fails), so the draws are seeded — unseeded, 1 run in ~17 approved (a main CI run, 2026-10-28).
    const legacy = new HeuristicAgent('P10', undefined, undefined, VOTE_OFF);
    legacy._ingestForTesting(o);
    const a0 = withSeededRandom('1EF-fallback-legacy', () => legacy.actDirect(o));
    expect(a0).toEqual({ type: 'team_vote', vote: true });
    const now = new HeuristicAgent('P10', undefined, undefined, ON);
    now._ingestForTesting(o);
    expect(withSeededRandom('1EF-fallback-now', () => now.actDirect(o))).toEqual({ type: 'team_vote', vote: false });
  });

  // Both thumbs on the team: exactly one is red, so the team holds a certain
  // red. With the 1D gates off the rule stands on its own.
  const thumbs = (round: number, attempt = 0): PlayerObservation => obsOf({
    me: 'P6', role: 'percival', phase: 'team_vote', round, leader: 'P2', failCount: attempt,
    proposed: round === 3 ? ['P2', 'P6', 'P1', 'P9'] : ['P2', 'P6', 'P1', 'P9', 'P5'],
    knownWizards: ['P1', 'P9'],
    quests: [quest(1, ['P2', 'P3', 'P4'], 0), quest(2, ['P2', 'P5', 'P7', 'P8'], 0), quest(3, ['P2', 'P5', 'P7', 'P8'], 0)].slice(0, round - 1),
  });
  const NO_GATES: AgentTuning = { ...ON, mustFailGate: false, teamDominanceGate: false };

  it('both thumbs on a one-fail R3 team: rejected by Percival\'s own rule (gates off); the old shortcut approved', () => {
    const o = thumbs(3);
    expect(percivalBothThumbsReject(ON, o)).toBe(true);
    expect(vote(o, { ...NO_GATES, percivalLoyalVote: false })).toBe(true);
    expect(vote(o, NO_GATES)).toBe(false);
    expect(decide(o, NO_GATES).reasoningTrace.summary).toMatch(/percival both thumbs reject/);
  });

  it('R4 (two fails) and the forced fifth proposal are not this rule; R1–R2 keep the table rule (D3)', () => {
    expect(percivalBothThumbsReject(ON, thumbs(4))).toBe(false);
    expect(percivalBothThumbsReject(ON, thumbs(3, 4))).toBe(false);
    const r2 = obsOf({
      me: 'P6', role: 'percival', phase: 'team_vote', round: 2, leader: 'P2',
      proposed: ['P2', 'P6', 'P1', 'P9'], knownWizards: ['P1', 'P9'], quests: [quest(1, ['P2', 'P3', 'P4'], 0)],
    });
    expect(percivalBothThumbsReject(ON, r2)).toBe(false);
    expect(vote(r2, ON)).toBe(true); // on the team in R2: the normal vote
    expect(percivalBothThumbsReject({ percivalLoyalVote: false }, thumbs(3))).toBe(false);
  });

  it('a team with no thumb is not rejected for that reason (it says nothing about camps)', () => {
    // R3, Percival P6 on a clean team with no thumb; nothing failed so far.
    const o = obsOf({
      me: 'P6', role: 'percival', phase: 'team_vote', round: 3, leader: 'P2',
      proposed: ['P2', 'P6', 'P3', 'P4'], knownWizards: ['P1', 'P9'],
      quests: [quest(1, ['P2', 'P3', 'P4'], 0), quest(2, ['P2', 'P3', 'P4', 'P6'], 0)],
    });
    const legacy = new HeuristicAgent('P6', undefined, undefined, VOTE_OFF);
    legacy._ingestForTesting(o);
    expect(legacy.actDirect(o)).toEqual({ type: 'team_vote', vote: false }); // the old "no thumb ⇒ reject"
    expect(vote(o, ON)).toBe(true);
  });

  it('the post-game review no longer names an on-team auto-approve for Percival; Morgana keeps hers', () => {
    const o = practice();
    const agent = new HeuristicAgent('P10', undefined, undefined, ON);
    const r = replayRule(o, agent, { type: 'team_vote', vote: false }, { forwardActive: true });
    expect(r?.rule ?? '').not.toMatch(/派西.*一律贊成|在隊上一律贊成/);
    const m = obsOf({
      me: 'P5', role: 'morgana', team: 'evil', phase: 'team_vote', round: 3, leader: 'P2',
      proposed: ['P2', 'P5', 'P3', 'P4'], knownEvils: ['P7', 'P8'],
      quests: [quest(1, ['P2', 'P3', 'P4'], 0), quest(2, ['P2', 'P3', 'P4', 'P6'], 0)],
    });
    expect(vote(m, ON)).toBe(true);
    const rm = replayRule(m, new HeuristicAgent('P5', undefined, undefined, ON), { type: 'team_vote', vote: true }, { forwardActive: true });
    expect(rm?.rule).toBe('莫甘娜在隊上一律贊成（紅方規則）');
  });
});

// ── S1-6: Percival's team (hard exclusions) ─────────────────────

describe('S1-6 Percival hard-excludes certain reds only (percivalCertainExclusion, INV-Pe2)', () => {
  // Percival P6 leads R3 (4 seats). R1 {P1, P2, P3} had one fail card: the
  // old attribution ("on every failed mission" = red) excluded all three.
  const lead = (extra: Partial<Parameters<typeof obsOf>[0]> = {}): PlayerObservation => obsOf({
    me: 'P6', role: 'percival', phase: 'team_select', round: 3, leader: 'P6', knownWizards: ['P8', 'P9'],
    quests: [quest(1, ['P1', 'P2', 'P3'], 1), quest(2, ['P4', 'P5', 'P6', 'P7'], 0)],
    ...extra,
  });

  it('inferRedsFromTaskFails flags the whole failed team; none of it is certain', () => {
    const o = lead();
    expect(inferRedsFromTaskFails(o).sort()).toEqual(['P1', 'P2', 'P3']);
    expect(buildCertainty(o).certRed()).toEqual([]);
    const fwd = new ForwardAgent('P6', new HeuristicAgent('P6', undefined, undefined, { ...ON, percivalCertainExclusion: false }));
    fwd.decide(o);
    expect([...fwd.lastTeamExclusions().keys()].sort()).toEqual(expect.arrayContaining(['P1', 'P2', 'P3']));
    const now = new ForwardAgent('P6', new HeuristicAgent('P6', undefined, undefined, ON));
    const d = now.decide(o);
    expect(d.reasoningTrace.usedFallback).toBe(false);
    expect([...now.lastTeamExclusions().keys()]).toEqual([]);
  });

  it('a thumb that is certainly red is hard-excluded (the other thumb is then certainly Merlin)', () => {
    // R1 {P8, P1, P2} had two fail cards and R2 {P9, P1, P2, P3} two as well…
    // simpler: Percival's own lake saw P9 red → P9 certain red, P8 certain good.
    const o = lead({
      quests: [quest(1, ['P1', 'P2', 'P3'], 0), quest(2, ['P4', 'P5', 'P6', 'P7'], 0)],
      lakes: [{ round: 2, holderId: 'P6', targetId: 'P9', declaredClaim: 'evil' }],
      myLakeResults: [{ round: 2, targetId: 'P9', result: 'evil' }],
    });
    const view = buildCertainty(o);
    expect(view.isCertRed('P9')).toBe(true);
    expect(view.isCertGood('P8')).toBe(true);
    const fwd = new ForwardAgent('P6', new HeuristicAgent('P6', undefined, undefined, ON));
    const d = fwd.decide(o);
    expect([...fwd.lastTeamExclusions().keys()]).toEqual(['P9']);
    if (d.action.type === 'team_select') expect(d.action.teamIds).not.toContain('P9');
  });

  it('鐵咬 on an uncertain thumb: the old rule excluded the higher-scored thumb; now both stay candidates', () => {
    const o = lead({ quests: [quest(1, ['P1', 'P2', 'P9'], 1), quest(2, ['P4', 'P5', 'P6', 'P7'], 0)] });
    const old = new ForwardAgent('P6', new HeuristicAgent('P6', undefined, undefined, { ...ON, percivalCertainExclusion: false }));
    old.decide(o);
    expect([...old.lastTeamExclusions().keys()].some((id) => id === 'P8' || id === 'P9')).toBe(true);
    const now = new ForwardAgent('P6', new HeuristicAgent('P6', undefined, undefined, ON));
    now.decide(o);
    expect([...now.lastTeamExclusions().keys()]).toEqual([]);
  });

  it('a tie between the thumbs names neither as Merlin / Morgana (no seat-order split)', () => {
    const tied: RoleSignals = {
      knownWizardSuspicions: new Map(),
      merlinHidingFromAssassin: false,
      oberonMissionParticipatedBefore: false,
      oberonFailedInMission: false,
      mordredR1Leader: false,
      knownAllyCount: 0,
      wizardMerlinScores: new Map([['P8', 0.4], ['P9', 0.4]]),
      percivalA: 'P8',
      percivalB: 'P9',
      morganaBetrayal: true,
    };
    const out = percivalSignalsWithoutTie(tied);
    expect(out.percivalA).toBeUndefined();
    expect(out.percivalB).toBeUndefined();
    expect(out.morganaBetrayal).toBe(false);
    const ordered = { ...tied, wizardMerlinScores: new Map([['P8', 0.6], ['P9', 0.4]]) };
    expect(percivalSignalsWithoutTie(ordered)).toBe(ordered);
  });
});

// ── S1-8: Percival's lake = a blue lake ─────────────────────────

describe('S1-8 Percival\'s lake is a blue lake (percivalBlueLake, INV-PL)', () => {
  const holder = (): PlayerObservation => obsOf({
    me: 'P10', role: 'percival', phase: 'quest_vote', round: 3, leader: 'P10', knownWizards: ['P8', 'P9'],
    quests: [quest(1, ['P1', 'P8', 'P3'], 1), quest(2, ['P4', 'P5', 'P9', 'P7'], 1)],
  });

  it('the avoid set is a loyal\'s (known reds only); the old one held both thumbs', () => {
    const o = holder();
    expect([...goodLakeAvoidSet(o, { percivalBlueLake: false })].sort()).toEqual(['P8', 'P9']);
    expect([...goodLakeAvoidSet(o, { percivalBlueLake: true })]).toEqual([]);
    const merlin = { ...o, myRole: 'merlin' as const, knownWizards: undefined, knownEvils: ['P1', 'P4', 'P9'] };
    expect([...goodLakeAvoidSet(merlin, { percivalBlueLake: true })].sort()).toEqual(['P1', 'P4', 'P9']);
  });

  it('the target is GoodLakeInfo\'s pick over every legal seat, thumbs included', () => {
    const o = holder();
    const valid = IDS.filter((id) => id !== 'P10');
    expect(pickLakeTargetForTeam('good', o, valid, ON)).toBe(pickGoodLakeTargetInfoMax(o, valid));
    const old = pickLakeTargetForTeam('good', o, valid, { ...ON, percivalBlueLake: false });
    expect(['P8', 'P9']).not.toContain(old);
  });

  it('after a thumb lake the certainty layer solves both thumbs for Percival (own result)', () => {
    const o = { ...holder(), myLakeResults: [{ round: 3, targetId: 'P8', result: 'good' as const }] };
    const view = buildCertainty(o);
    expect(view.isCertGood('P8')).toBe(true);
    expect(view.isCertRed('P9')).toBe(true);
  });
});

// ── S1-10: red holders make possible claims only ────────────────

describe('S1-10 red holders never make a claim that cannot be true for a good holder (redPossibleClaimsOnly, INV-R1)', () => {
  // R1 {P1, P2, P3} had three fail cards: all three are red (public). R2
  // {P4, P5, P6, P7} had one: the fourth red is among them, so P8, P9 and
  // P10 are certainly good for everyone. Red holder P4 (assassin; sees the
  // others as teammates) laked P8.
  const lake = (target: string): PlayerObservation => obsOf({
    me: 'P4', role: 'assassin', team: 'evil', phase: 'lady_of_the_lake' as PlayerObservation['gamePhase'], round: 3, leader: 'P4',
    knownEvils: ['P1', 'P2', 'P3'],
    quests: [quest(1, ['P1', 'P2', 'P3'], 3), quest(2, ['P4', 'P5', 'P6', 'P7'], 1)],
  });

  it('framing a publicly certain-good seat: the old rule could; now the claim is "good"', () => {
    const o = lake('P8');
    expect(claimPossibleForGoodHolder(o, 'P4', 'P8', 'evil')).toBe(false);
    expect(claimPossibleForGoodHolder(o, 'P4', 'P8', 'good')).toBe(true);
    vi.spyOn(Math, 'random').mockReturnValue(0); // the human-rate frame always fires
    const old = decideLakeClaimForTeam('evil', 'P8', o, 'good', { ...ON, redPossibleClaimsOnly: false });
    const now = decideLakeClaimForTeam('evil', 'P8', o, 'good', ON);
    expect(old).toBe('evil');
    expect(now).toBe('good');
  });

  it('vouching for a publicly certain red teammate: the wash is impossible, so the claim is "evil"', () => {
    const o = lake('P1');
    expect(claimPossibleForGoodHolder(o, 'P4', 'P1', 'good')).toBe(false);
    expect(decideLakeClaimForTeam('evil', 'P1', o, 'evil', { ...ON, redPossibleClaimsOnly: false })).toBe('good');
    expect(decideLakeClaimForTeam('evil', 'P1', o, 'evil', ON)).toBe('evil');
  });

  it('a holder already publicly certain red has no possible claim: it declares nothing', () => {
    const o = { ...lake('P8'), myPlayerId: 'P1', myRole: 'morgana' as const, knownEvils: ['P2', 'P3', 'P4'] };
    expect(claimPossibleForGoodHolder(o, 'P1', 'P8', 'good')).toBe(false);
    expect(claimPossibleForGoodHolder(o, 'P1', 'P8', 'evil')).toBe(false);
    const always = { ...ON, evilLakeClaimAlwaysGood: true };
    expect(decideLakeClaimForTeam('evil', 'P8', o, 'good', { ...always, redPossibleClaimsOnly: false })).toBe('good');
    expect(decideLakeClaimForTeam('evil', 'P8', o, 'good', always)).toBeNull();
  });

  it('when such a claim is made anyway (a human), every blue pins the holder red (INV-R2, automatic at L1)', () => {
    const loyal = obsOf({
      me: 'P9', role: 'loyal', phase: 'team_select', round: 3, leader: 'P9',
      quests: [quest(1, ['P1', 'P2', 'P3'], 3), quest(2, ['P4', 'P5', 'P6', 'P7'], 1)],
      lakes: [{ round: 2, holderId: 'P4', targetId: 'P8', declaredClaim: 'evil' }],
    });
    expect(buildCertainty(loyal).isCertRed('P4', 'L1')).toBe(true);
  });
});
