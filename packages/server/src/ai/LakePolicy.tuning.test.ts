/**
 * LakePolicy — AgentTuning switches (2026-10-12):
 *   - `evilLakeClaimAlwaysGood`: evil holder always announces "good";
 *   - `goodLakeTargetMostSuspicious`: good holder inspects the most
 *     suspicious unknown-camp seat instead of the least suspicious.
 */
import { describe, it, expect } from 'vitest';
import {
  decideLakeClaimForTeam,
  declareLake,
  estimateSuspicionFromHistory,
  pickLakeTarget,
  pickLakeTargetForTeam,
} from './LakePolicy';
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
