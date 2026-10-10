/**
 * LakePolicy — agent-level Lady-of-the-Lake API (extracted from
 * SelfPlayEngine 2026-10-10). The policy itself is covered by
 * SelfPlayEngine.lake.test.ts (which now exercises it through the
 * SelfPlayEngine delegates); these tests pin the new entry points:
 *   - HeuristicAgent.pickLakeTarget / declareLake agree with SelfPlayEngine
 *   - deriveValidLakeTargets reads the used-set from public lake history
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SelfPlayEngine } from './SelfPlayEngine';
import { HeuristicAgent } from './HeuristicAgent';
import { deriveValidLakeTargets, pickLakeTarget, declareLake } from './LakePolicy';
import type { PlayerObservation, QuestRecord, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

function obsFor(partial: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 'P10',
    myRole: 'loyal',
    myTeam: 'good',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: [],
    currentRound: 2,
    currentLeader: 'P10',
    failCount: 0,
    questResults: ['success', 'fail'],
    gamePhase: 'team_select',
    voteHistory: [],
    questHistory: [],
    proposedTeam: [],
    lakeHistory: [],
    ...partial,
  };
}

const QUESTS: QuestRecord[] = [
  { round: 1, team: ['P1', 'P4', 'P7'], result: 'success', failCount: 0 },
  { round: 2, team: ['P3', 'P5', 'P8', 'P9'], result: 'fail', failCount: 1 },
];
const VOTES: VoteRecord[] = [
  {
    round: 2, attempt: 1, leader: 'P6', team: ['P3', 'P5', 'P8', 'P9'], approved: true,
    votes: Object.fromEntries(IDS.map((id) => [id, id !== 'P2' && id !== 'P4'])),
  },
];

describe('LakePolicy — agent-level API', () => {
  beforeEach(() => {
    delete process.env.AVALON_USE_SMART_LAKE;
    delete process.env.AVALON_EVIL_LAKE_BRING_FRIEND;
  });

  it('deriveValidLakeTargets excludes self and every past holder / target', () => {
    expect(deriveValidLakeTargets(obsFor({}))).toEqual(IDS.slice(0, 9));
    const obs = obsFor({
      myPlayerId: 'P4',
      currentRound: 3,
      lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P4', declaredClaim: 'good' }],
    });
    expect(deriveValidLakeTargets(obs)).toEqual(['P1', 'P2', 'P3', 'P5', 'P6', 'P7', 'P8', 'P9']);
    // Undeclared lakes are invisible in lakeHistory → caller supplies them.
    expect(deriveValidLakeTargets(obs, ['P2'])).not.toContain('P2');
  });

  it('HeuristicAgent.pickLakeTarget matches SelfPlayEngine.pickLadyTarget (good + evil)', () => {
    const engine = new SelfPlayEngine();
    const cases: PlayerObservation[] = [
      obsFor({ questHistory: QUESTS, voteHistory: VOTES }),
      obsFor({ myRole: 'merlin', knownEvils: ['P3', 'P8'], questHistory: QUESTS, voteHistory: VOTES }),
      obsFor({ myRole: 'percival', knownWizards: ['P1', 'P2'], questHistory: QUESTS, voteHistory: VOTES }),
      obsFor({ myRole: 'assassin', myTeam: 'evil', knownEvils: ['P3', 'P5'], questHistory: QUESTS, voteHistory: VOTES }),
      obsFor({ myRole: 'morgana', myTeam: 'evil', knownEvils: ['P1', 'P2'], questHistory: QUESTS, voteHistory: VOTES }),
    ];
    for (const obs of cases) {
      const valid = deriveValidLakeTargets(obs);
      const agent = new HeuristicAgent(obs.myPlayerId);
      const expected = engine.pickLadyTarget(obs.myTeam, obs, valid);
      expect(agent.pickLakeTarget(obs)).toBe(expected);
      expect(agent.pickLakeTarget(obs, valid)).toBe(expected);
      expect(pickLakeTarget(obs)).toBe(expected);
      expect(valid).toContain(expected);
    }
  });

  it('good holder declares the truth; evil holder washes an ally as good', () => {
    const agent = new HeuristicAgent('P10');
    const good = obsFor({});
    expect(agent.declareLake(good, 'P3', 'evil')).toBe('evil');
    expect(agent.declareLake(good, 'P3', 'good')).toBe('good');
    expect(agent.declareLake(good, 'P3', undefined)).toBeNull();
    const evil = obsFor({ myRole: 'assassin', myTeam: 'evil', knownEvils: ['P3', 'P5'] });
    expect(agent.declareLake(evil, 'P3', 'evil')).toBe('good');
    expect(declareLake(evil, 'P5', 'evil')).toBe('good');
  });

  it('declareLake matches SelfPlayEngine.decideLakeAnnouncement under the same random stream', () => {
    const engine = new SelfPlayEngine();
    const agent = new HeuristicAgent('P10');
    // Morgana close call → EV lie prior consumes Math.random; pin it.
    const obs = obsFor({ myRole: 'morgana', myTeam: 'evil', knownEvils: ['P1'] });
    const realRandom = Math.random;
    try {
      for (const r of [0.01, 0.5, 0.99]) {
        Math.random = () => r;
        const viaEngine = engine.decideLakeAnnouncement('evil', 'P4', obs, 'good');
        Math.random = () => r;
        expect(agent.declareLake(obs, 'P4', 'good')).toBe(viaEngine);
      }
    } finally {
      Math.random = realRandom;
    }
  });
});
