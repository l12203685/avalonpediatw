/**
 * LakePolicy — AgentTuning switches (2026-10-12):
 *   - `evilLakeClaimAlwaysGood`: evil holder always announces "good";
 *   - `goodLakeTargetMostSuspicious`: good holder inspects the most
 *     suspicious unknown-camp seat instead of the least suspicious;
 *   - `evilLakeHumanStrategy` (2026-10-13): red holder keeps the lake on a
 *     visible teammate and declares them good, with the framing / goodwill
 *     exceptions of Edward's ruling.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_EVIL_LAKE_HUMAN_OPTIONS,
  HUMAN_FRAME_RATE,
  decideEvilLakeClaimHuman,
  decideLakeClaimForTeam,
  declareLake,
  estimateSuspicionFromHistory,
  evilLakeHumanOptionsFromEnv,
  getEvilLakeHumanOptions,
  humanFrameRate,
  nextLakeExists,
  oberonTeammateEvidence,
  pickEvilLakeTargetHuman,
  pickLakeTarget,
  pickLakeTargetForTeam,
  setEvilLakeHumanOptions,
  type EvilLakeHumanOptions,
} from './LakePolicy';
import { withSeededRandom } from './benchmark/agreement';
import { LEGACY_AGENT_TUNING } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import type { PlayerObservation, QuestRecord, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

function obs(partial: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 'P1',
    myRole: 'loyal',
    myTeam: 'good',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: [],
    currentRound: 3,
    currentLeader: 'P1',
    failCount: 0,
    questResults: ['fail', 'success'],
    gamePhase: 'team_select',
    voteHistory: [],
    questHistory: [],
    proposedTeam: [],
    ...partial,
  };
}

const QUESTS: QuestRecord[] = [
  { round: 1, team: ['P2', 'P3', 'P4'], result: 'fail', failCount: 1 },
  { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
];
const VOTES: VoteRecord[] = [
  {
    round: 1, attempt: 1, leader: 'P2', team: ['P2', 'P3', 'P4'], approved: true,
    votes: Object.fromEntries(IDS.map((id) => [id, ['P2', 'P3', 'P4', 'P9', 'P10'].includes(id)])),
  },
];

describe('LakePolicy — goodLakeTargetMostSuspicious', () => {
  const o = obs({ questHistory: QUESTS, voteHistory: VOTES });
  const valid = IDS.filter((id) => id !== 'P1' && id !== 'P10');

  it('default (legacy) picks the least suspicious seat; the switch picks the most suspicious', () => {
    const legacy = pickLakeTargetForTeam('good', o, [...valid], { ...LEGACY_AGENT_TUNING });
    const tuned = pickLakeTargetForTeam('good', o, [...valid], { ...LEGACY_AGENT_TUNING, goodLakeTargetMostSuspicious: true });
    const score = (id: string): number => estimateSuspicionFromHistory(id, o);
    expect(score(legacy)).toBe(Math.min(...valid.map(score)));
    expect(score(tuned)).toBe(Math.max(...valid.map(score)));
    expect(['P2', 'P3', 'P4']).toContain(tuned);
    expect(legacy).not.toBe(tuned);
  });

  it('never inspects a known evil or a known wizard even with the switch on', () => {
    const merlin = obs({ myRole: 'merlin', questHistory: QUESTS, voteHistory: VOTES, knownEvils: ['P2', 'P3'] });
    const t = pickLakeTarget(merlin, valid, { ...LEGACY_AGENT_TUNING, goodLakeTargetMostSuspicious: true });
    expect(['P2', 'P3']).not.toContain(t);
    const percival = obs({ myRole: 'percival', questHistory: QUESTS, voteHistory: VOTES, knownWizards: ['P2', 'P4'] });
    const p = pickLakeTarget(percival, valid, { ...LEGACY_AGENT_TUNING, goodLakeTargetMostSuspicious: true });
    expect(['P2', 'P4']).not.toContain(p);
  });

  it('HeuristicAgent.pickLakeTarget honours its own tuning', () => {
    const tunedAgent = new HeuristicAgent('P1', undefined, undefined, { ...LEGACY_AGENT_TUNING, goodLakeTargetMostSuspicious: true });
    const legacyAgent = new HeuristicAgent('P1', undefined, undefined, { ...LEGACY_AGENT_TUNING });
    expect(tunedAgent.pickLakeTarget(o, valid)).toBe(
      pickLakeTargetForTeam('good', o, [...valid], { ...LEGACY_AGENT_TUNING, goodLakeTargetMostSuspicious: true }));
    expect(legacyAgent.pickLakeTarget(o, valid)).toBe(
      pickLakeTargetForTeam('good', o, [...valid], { ...LEGACY_AGENT_TUNING }));
  });
});

describe('LakePolicy — evilLakeClaimAlwaysGood', () => {
  const evil = obs({ myRole: 'assassin', myTeam: 'evil', knownEvils: ['P2', 'P3'], questHistory: QUESTS, voteHistory: VOTES });
  const on = { ...LEGACY_AGENT_TUNING, evilLakeClaimAlwaysGood: true };

  it('evil holder announces "good" for allies, clean opponents and Merlin-like opponents alike', () => {
    for (let i = 0; i < 20; i++) {
      expect(decideLakeClaimForTeam('evil', 'P2', evil, 'evil', on)).toBe('good');  // ally
      expect(decideLakeClaimForTeam('evil', 'P5', evil, 'good', on)).toBe('good');  // opponent
      expect(decideLakeClaimForTeam('evil', 'P9', evil, 'good', on)).toBe('good');  // approved a tainted team
      expect(declareLake(evil, 'P4', 'evil', on)).toBe('good');                     // hidden evil (Oberon)
    }
  });

  it('legacy still calls a non-Merlin-like good opponent "evil" (muddying)', () => {
    // P9 approved the tainted R1 team → merlinScore < 0 → legacy base
    // decision is "evil"; the EV-prior "lie" for a good target is also
    // "evil", so the legacy claim is deterministic here.
    for (let i = 0; i < 20; i++) {
      expect(decideLakeClaimForTeam('evil', 'P9', evil, 'good', { ...LEGACY_AGENT_TUNING })).toBe('evil');
    }
  });

  it('good holder is unaffected and keeps telling the truth', () => {
    const good = obs({});
    expect(decideLakeClaimForTeam('good', 'P5', good, 'evil', on)).toBe('evil');
    expect(decideLakeClaimForTeam('good', 'P5', good, 'good', on)).toBe('good');
  });

  it('HeuristicAgent.declareLake honours its own tuning', () => {
    const tuned = new HeuristicAgent('P1', undefined, undefined, on);
    expect(tuned.declareLake(evil, 'P5', 'good')).toBe('good');
    expect(tuned.declareLake(evil, 'P2', 'evil')).toBe('good');
  });
});

// ── evilLakeHumanStrategy (Edward 2026-10-13 ruling) ──────────
// 「紅方湖中應該是盡量留在隊友身上並說謊(湖紅方說藍方), 但看情況依據戰術
//  可以改變, 例如湖藍方說紅方 … 或是湖藍方說藍方說實話買取好感度」

describe('LakePolicy — evilLakeHumanStrategy', () => {
  const ON = { ...LEGACY_AGENT_TUNING, evilLakeHumanStrategy: true };
  // P1 assassin sees P2 (Morgana) + P3 (Mordred); P4 is the hidden Oberon.
  const R1_FAIL: QuestRecord = { round: 1, team: ['P2', 'P5', 'P6'], result: 'fail', failCount: 1 };
  const R2_OK: QuestRecord = { round: 2, team: ['P3', 'P7', 'P8', 'P9'], result: 'success', failCount: 0 };
  const firstLake = obs({
    myRole: 'assassin', myTeam: 'evil', knownEvils: ['P2', 'P3'],
    currentRound: 2, questResults: ['fail', 'success'], questHistory: [R1_FAIL, R2_OK],
  });
  const valid = IDS.filter((id) => id !== 'P1' && id !== 'P10');

  it('nextLakeExists: lakes after R2 / R3 have a successor, the one after R4 does not', () => {
    expect(nextLakeExists(obs({ currentRound: 2 }))).toBe(true);
    expect(nextLakeExists(obs({ currentRound: 3 }))).toBe(true);
    expect(nextLakeExists(obs({ currentRound: 4 }))).toBe(false);
  });

  it('a legal visible teammate is laked (most suspected first) and declared good', () => {
    const t = pickLakeTargetForTeam('evil', firstLake, [...valid], ON);
    expect(t).toBe('P2'); // on the failed R1 mission → more pressure than P3
    expect(decideLakeClaimForTeam('evil', t, firstLake, 'evil', ON)).toBe('good');
    // Only the clean teammate left → still the teammate (盡量).
    const onlyP3 = valid.filter((id) => id !== 'P2');
    expect(pickLakeTargetForTeam('evil', firstLake, onlyP3, ON)).toBe('P3');
  });

  it('no visible teammate legal → the most suspicious other seat, truthful "good" on a blue', () => {
    const noAlly = valid.filter((id) => id !== 'P2' && id !== 'P3');
    const t = pickLakeTargetForTeam('evil', firstLake, noAlly, ON);
    expect(t).toBe('P5'); // first failed-mission member in seat order
    expect(decideLakeClaimForTeam('evil', t, firstLake, 'good', ON)).toBe('good');
  });

  it('a red the holder could not see (the hidden Oberon) is covered with "good"', () => {
    expect(decideLakeClaimForTeam('evil', 'P4', firstLake, 'evil', ON)).toBe('good');
  });

  const R3_FAIL: QuestRecord = { round: 3, team: ['P1', 'P5', 'P7', 'P8'], result: 'fail', failCount: 1 };
  const R4_OK: QuestRecord = { round: 4, team: ['P3', 'P6', 'P7', 'P8', 'P9'], result: 'success', failCount: 0 };
  const lastLake = obs({
    myRole: 'assassin', myTeam: 'evil', knownEvils: ['P2', 'P3'],
    currentRound: 4, questResults: ['fail', 'success', 'fail', 'success'],
    questHistory: [R1_FAIL, R2_OK, R3_FAIL, R4_OK],
  });

  it('last lake: a pressured teammate is still washed; a clean one is skipped for a blue', () => {
    expect(pickLakeTargetForTeam('evil', lastLake, ['P2', 'P5', 'P6', 'P9'], ON)).toBe('P2');
    // P3 only on successful missions → suspicion ≤ 0 → lake a blue instead.
    const t = pickLakeTargetForTeam('evil', lastLake, ['P3', 'P6', 'P9'], ON);
    expect(t).toBe('P6');
    // `lastLake: always` keeps the teammate.
    expect(pickEvilLakeTargetHuman(lastLake, ['P3', 'P6', 'P9'], { ...DEFAULT_EVIL_LAKE_HUMAN_OPTIONS, lastLake: 'always' })).toBe('P3');
  });

  it('framing: red listening + a blue co-member of a failed mission → lake them and declare "evil"', () => {
    // P1 and P5 were both on the failed R3 mission; red has two fails.
    const t = pickLakeTargetForTeam('evil', lastLake, ['P3', 'P5', 'P6', 'P9'], ON);
    expect(t).toBe('P5');
    expect(decideLakeClaimForTeam('evil', 'P5', lastLake, 'good', ON)).toBe('evil');
    // A blue without a shared failed mission gets the truthful "good".
    expect(decideLakeClaimForTeam('evil', 'P6', lastLake, 'good', ON)).toBe('good');
    // Before red is listening the framing tactic does not fire.
    const notListening = obs({ ...lastLake, questResults: ['fail', 'success', 'success'], currentRound: 3 });
    expect(decideLakeClaimForTeam('evil', 'P5', notListening, 'good', ON)).toBe('good');
  });

  it('tactic-mix knobs: chaos never / always', () => {
    expect(decideEvilLakeClaimHuman(lastLake, 'P5', 'good', { ...DEFAULT_EVIL_LAKE_HUMAN_OPTIONS, chaos: 'never' })).toBe('good');
    expect(decideEvilLakeClaimHuman(lastLake, 'P6', 'good', { ...DEFAULT_EVIL_LAKE_HUMAN_OPTIONS, chaos: 'always' })).toBe('evil');
    // Teammates are always washed, whatever the chaos knob says.
    expect(decideEvilLakeClaimHuman(lastLake, 'P2', 'evil', { ...DEFAULT_EVIL_LAKE_HUMAN_OPTIONS, chaos: 'always' })).toBe('good');
  });

  it('vouch=consistent prefers the seat the holder kept on their own teams', () => {
    const led: VoteRecord[] = [{
      round: 2, attempt: 1, leader: 'P1', team: ['P1', 'P3', 'P7', 'P8'], approved: false,
      votes: Object.fromEntries(IDS.map((id) => [id, false])),
    }];
    const o2 = obs({ ...firstLake, voteHistory: led });
    const pressured = { ...DEFAULT_EVIL_LAKE_HUMAN_OPTIONS, vouch: 'pressured' as const };
    // The switch's default tactic mix is consistent vouching.
    expect(DEFAULT_EVIL_LAKE_HUMAN_OPTIONS.vouch).toBe('consistent');
    // First cut: P2 (more suspected). Consistent: P3 (P1 never left P3 off a team it led).
    expect(pickEvilLakeTargetHuman(o2, valid, pressured)).toBe('P2');
    expect(pickEvilLakeTargetHuman(o2, valid, DEFAULT_EVIL_LAKE_HUMAN_OPTIONS)).toBe('P3');
    expect(pickLakeTargetForTeam('evil', o2, [...valid], ON)).toBe('P3');
    // Goodwill blue pick (no teammate legal): P5 most suspicious, but P1 left
    // P5 off its team while it kept P7 → consistent vouches for P7.
    const noAlly = valid.filter((id) => id !== 'P2' && id !== 'P3');
    expect(pickEvilLakeTargetHuman(o2, noAlly, pressured)).toBe('P5');
    expect(pickEvilLakeTargetHuman(o2, noAlly, DEFAULT_EVIL_LAKE_HUMAN_OPTIONS)).toBe('P7');
    // Pure chaos claims 'evil' anyway → plain most-suspicious pick.
    expect(pickEvilLakeTargetHuman(o2, noAlly, { ...DEFAULT_EVIL_LAKE_HUMAN_OPTIONS, chaos: 'always' })).toBe('P5');
  });

  it('the variant env knob never reaches the strategy by itself; only a script call to setEvilLakeHumanOptions does', () => {
    vi.stubEnv('AVALON_EVIL_LAKE_HUMAN_VARIANT', 'chaos=always');
    try {
      // A server process with the variable set still uses the default mix.
      expect(getEvilLakeHumanOptions()).toEqual(DEFAULT_EVIL_LAKE_HUMAN_OPTIONS);
      expect(decideEvilLakeClaimHuman(lastLake, 'P6', 'good')).toBe('good');
      // The benchmark scripts opt in explicitly.
      setEvilLakeHumanOptions(evilLakeHumanOptionsFromEnv());
      expect(decideEvilLakeClaimHuman(lastLake, 'P6', 'good')).toBe('evil');
      expect(decideLakeClaimForTeam('evil', 'P6', lastLake, 'good', ON)).toBe('evil');
    } finally {
      setEvilLakeHumanOptions(undefined);
      vi.unstubAllEnvs();
    }
    expect(getEvilLakeHumanOptions()).toEqual(DEFAULT_EVIL_LAKE_HUMAN_OPTIONS);
    expect(decideEvilLakeClaimHuman(lastLake, 'P6', 'good')).toBe('good');
  });

  it('AVALON_EVIL_LAKE_HUMAN_VARIANT parses known knobs and ignores junk', () => {
    expect(evilLakeHumanOptionsFromEnv({})).toEqual(DEFAULT_EVIL_LAKE_HUMAN_OPTIONS);
    expect(evilLakeHumanOptionsFromEnv({ AVALON_EVIL_LAKE_HUMAN_VARIANT: 'lastLake=always,chaos=never,vouch=consistent' }))
      .toEqual({ ...DEFAULT_EVIL_LAKE_HUMAN_OPTIONS, lastLake: 'always', chaos: 'never', vouch: 'consistent' });
    expect(evilLakeHumanOptionsFromEnv({ AVALON_EVIL_LAKE_HUMAN_VARIANT: 'oberon=legacy,lastLake=legacy,target=legacy,claim=human' }))
      .toEqual({ ...DEFAULT_EVIL_LAKE_HUMAN_OPTIONS, oberon: 'legacy', lastLake: 'legacy', target: 'legacy' });
    expect(evilLakeHumanOptionsFromEnv({ AVALON_EVIL_LAKE_HUMAN_VARIANT: 'chaos=sometimes,foo=bar' }))
      .toEqual(DEFAULT_EVIL_LAKE_HUMAN_OPTIONS);
  });

  it('Oberon (sees nobody) takes the blue branch with the vouch order and covers a red find with "good"', () => {
    const oberon = obs({
      myPlayerId: 'P4', myRole: 'oberon', myTeam: 'evil', knownEvils: [],
      currentRound: 2, questResults: ['fail', 'success'], questHistory: [R1_FAIL, R2_OK],
    });
    const v = IDS.filter((id) => id !== 'P4' && id !== 'P10');
    // Never led a team → the vouch order reduces to most suspicious first.
    const t = pickLakeTargetForTeam('evil', oberon, v, ON);
    expect(t).toBe('P2'); // first failed-mission member in seat order (happens to be red)
    expect(decideLakeClaimForTeam('evil', 'P2', oberon, 'evil', ON)).toBe('good');
    expect(decideLakeClaimForTeam('evil', 'P5', oberon, 'good', ON)).toBe('good');
    // Oberon led P4 P7 P8 P9: the seats he never left off come first, so he
    // lakes clean P7 rather than the failed-mission members (not "most
    // suspicious" — documented in strength_benchmark.md 第 6 節).
    const led: VoteRecord[] = [{
      round: 2, attempt: 1, leader: 'P4', team: ['P4', 'P7', 'P8', 'P9'], approved: false,
      votes: Object.fromEntries(IDS.map((id) => [id, false])),
    }];
    expect(pickLakeTargetForTeam('evil', obs({ ...oberon, voteHistory: led }), v, ON)).toBe('P7');
  });

  it('diagnostic ablation knobs hand parts of the lake back to the pre-switch rule', () => {
    const legacyTarget = (o: PlayerObservation, v: string[]): string => pickLakeTargetForTeam('evil', o, [...v], { ...LEGACY_AGENT_TUNING });
    const oberon = obs({
      myPlayerId: 'P4', myRole: 'oberon', myTeam: 'evil', knownEvils: [],
      currentRound: 2, questResults: ['fail', 'success'], questHistory: [R1_FAIL, R2_OK],
    });
    const v = IDS.filter((id) => id !== 'P4' && id !== 'P10');
    const opt = (o: Partial<EvilLakeHumanOptions>): EvilLakeHumanOptions => ({ ...DEFAULT_EVIL_LAKE_HUMAN_OPTIONS, ...o });
    // oberon=legacy: Oberon's target and claim follow the old rule; other reds do not.
    expect(pickEvilLakeTargetHuman(oberon, v, opt({ oberon: 'legacy' }))).toBe(legacyTarget(oberon, v));
    expect(withSeededRandom('x', () => decideEvilLakeClaimHuman(oberon, 'P9', 'good', opt({ oberon: 'legacy' }))))
      .toBe(withSeededRandom('x', () => decideLakeClaimForTeam('evil', 'P9', oberon, 'good', { ...LEGACY_AGENT_TUNING })));
    expect(pickEvilLakeTargetHuman(firstLake, valid, opt({ oberon: 'legacy' }))).toBe('P2');
    // lastLake=legacy only touches the lake after R4.
    expect(pickEvilLakeTargetHuman(lastLake, ['P3', 'P5', 'P6', 'P9'], opt({ lastLake: 'legacy' })))
      .toBe(legacyTarget(lastLake, ['P3', 'P5', 'P6', 'P9']));
    expect(pickEvilLakeTargetHuman(firstLake, valid, opt({ lastLake: 'legacy' }))).toBe('P2');
    // target=legacy / claim=legacy split the two halves.
    expect(pickEvilLakeTargetHuman(firstLake, valid, opt({ target: 'legacy' }))).toBe(legacyTarget(firstLake, valid));
    expect(decideEvilLakeClaimHuman(lastLake, 'P5', 'good', opt({ target: 'legacy' }))).toBe('evil');
    expect(pickEvilLakeTargetHuman(firstLake, valid, opt({ claim: 'legacy' }))).toBe('P2');
  });

  it('evilLakeFrameHumanRate: no co-suspect hunting; blue claims framed at the human rate of the state', () => {
    const rate = { ...ON, evilLakeFrameHumanRate: true };
    // The frame-seeking target rule would take P5 (shared the failed R3 with P1, red listening);
    // the human-rate rule picks the blue by the vouch order instead (P1 led nothing → most suspicious, then seat).
    expect(pickLakeTargetForTeam('evil', lastLake, ['P3', 'P5', 'P6', 'P9'], ON)).toBe('P5');
    expect(pickLakeTargetForTeam('evil', lastLake, ['P6', 'P9'], rate)).toBe(pickEvilLakeTargetHuman(lastLake, ['P6', 'P9']));
    expect(humanFrameRate(lastLake, 'P5')).toBeCloseTo(HUMAN_FRAME_RATE.sharedListening);
    expect(humanFrameRate(lastLake, 'P6')).toBeCloseTo(HUMAN_FRAME_RATE.notSharedListening);
    expect(humanFrameRate(firstLake, 'P6')).toBeCloseTo(HUMAN_FRAME_RATE.notSharedNotListening);
    // Over many seeded draws the claim rate on a blue matches the table; teammates are always washed.
    let framed = 0;
    for (let i = 0; i < 2000; i++) {
      if (withSeededRandom(`f${i}`, () => decideLakeClaimForTeam('evil', 'P5', lastLake, 'good', rate)) === 'evil') framed++;
      expect(withSeededRandom(`f${i}`, () => decideLakeClaimForTeam('evil', 'P2', lastLake, 'evil', rate))).toBe('good');
    }
    expect(framed / 2000).toBeGreaterThan(HUMAN_FRAME_RATE.sharedListening - 0.04);
    expect(framed / 2000).toBeLessThan(HUMAN_FRAME_RATE.sharedListening + 0.04);
    // Without evilLakeHumanStrategy the switch does nothing (old evil branch).
    const onlyRate = { ...LEGACY_AGENT_TUNING, evilLakeFrameHumanRate: true };
    expect(pickLakeTargetForTeam('evil', lastLake, ['P3', 'P5', 'P6', 'P9'], onlyRate))
      .toBe(pickLakeTargetForTeam('evil', lastLake, ['P3', 'P5', 'P6', 'P9'], { ...LEGACY_AGENT_TUNING }));
  });

  it('oberonLakeSeeksTeammates: Oberon lakes the seat with the most fail cards he did not play', () => {
    const seek = { ...ON, oberonLakeSeeksTeammates: true };
    // Oberon P4 sat on the failed R1 with P5 (one fail = his own); P2 failed R2 without him.
    const quests: QuestRecord[] = [
      { round: 1, team: ['P4', 'P5', 'P6'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P2', 'P7', 'P8', 'P9'], result: 'fail', failCount: 1 },
    ];
    const oberon = obs({
      myPlayerId: 'P4', myRole: 'oberon', myTeam: 'evil', knownEvils: [],
      currentRound: 2, questResults: ['fail', 'fail'], questHistory: quests,
    });
    const v = IDS.filter((id) => id !== 'P4' && id !== 'P10');
    expect(oberonTeammateEvidence('P5', oberon)).toBe(0);
    expect(oberonTeammateEvidence('P2', oberon)).toBeCloseTo(0.25);
    // Default (vouch order) goes for P5 — the co-suspect of his own fail (framing, red listening).
    expect(pickLakeTargetForTeam('evil', oberon, [...v], ON)).toBe('P5');
    // Seeking teammates: a member of the failed R2 he was not on (P2 first by the vouch order tie-break).
    expect(['P2', 'P7', 'P8', 'P9']).toContain(pickLakeTargetForTeam('evil', oberon, [...v], seek));
    // A seeing red is unaffected by the switch.
    expect(pickLakeTargetForTeam('evil', firstLake, [...valid], seek)).toBe(pickLakeTargetForTeam('evil', firstLake, [...valid], ON));
  });

  it('evilLakeClaimAlwaysGood wins the claim when both switches are on (target still from the strategy)', () => {
    const both = { ...ON, evilLakeClaimAlwaysGood: true };
    expect(decideLakeClaimForTeam('evil', 'P5', lastLake, 'good', both)).toBe('good');
    expect(pickLakeTargetForTeam('evil', lastLake, ['P3', 'P5', 'P6', 'P9'], both)).toBe('P5');
  });

  it('good holders are untouched by the switch', () => {
    const good = obs({ questHistory: QUESTS, voteHistory: VOTES });
    expect(pickLakeTargetForTeam('good', good, [...valid], ON))
      .toBe(pickLakeTargetForTeam('good', good, [...valid], { ...LEGACY_AGENT_TUNING }));
    expect(decideLakeClaimForTeam('good', 'P5', good, 'evil', ON)).toBe('evil');
  });

  it('switch off → byte-identical legacy decisions under the same random stream', () => {
    const evil = obs({ myRole: 'morgana', myTeam: 'evil', knownEvils: ['P2', 'P3'], questHistory: QUESTS, voteHistory: VOTES });
    const off = { ...LEGACY_AGENT_TUNING, evilLakeHumanStrategy: false };
    for (let i = 0; i < 25; i++) {
      for (const target of ['P2', 'P5', 'P9', 'P4']) {
        for (const truth of ['good', 'evil'] as const) {
          const a = withSeededRandom(`s${i}`, () => [decideLakeClaimForTeam('evil', target, evil, truth, off), Math.random()]);
          const b = withSeededRandom(`s${i}`, () => [decideLakeClaimForTeam('evil', target, evil, truth, { ...LEGACY_AGENT_TUNING }), Math.random()]);
          expect(a).toEqual(b);
        }
      }
    }
    expect(pickLakeTargetForTeam('evil', evil, [...valid], off))
      .toBe(pickLakeTargetForTeam('evil', evil, [...valid], { ...LEGACY_AGENT_TUNING }));
  });

  it('the strategy itself never consumes Math.random', () => {
    let calls = 0;
    const original = Math.random;
    Math.random = () => { calls++; return original(); };
    try {
      pickLakeTargetForTeam('evil', lastLake, ['P3', 'P5', 'P6', 'P9'], ON);
      decideLakeClaimForTeam('evil', 'P5', lastLake, 'good', ON);
      decideLakeClaimForTeam('evil', 'P2', lastLake, 'evil', ON);
    } finally {
      Math.random = original;
    }
    expect(calls).toBe(0);
  });

  it('HeuristicAgent.pickLakeTarget / declareLake honour the switch', () => {
    const agent = new HeuristicAgent('P1', undefined, undefined, ON);
    expect(agent.pickLakeTarget(firstLake, valid)).toBe('P2');
    expect(agent.declareLake(firstLake, 'P2', 'evil')).toBe('good');
    expect(agent.declareLake(lastLake, 'P5', 'good')).toBe('evil');
  });
});
