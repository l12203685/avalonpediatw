/**
 * 優化迴圈第 36 回合・藍方：只在挑隊時的遞迴後驗和第 0 層後驗混合（`beliefLeadBlend`）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});
const base = {
  myPlayerId: 'P3', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 1, currentLeader: 'P3', failCount: 2, questResults: [], evilCount: 4,
  questHistory: [], lakeHistory: [], myLakeResults: [], proposedTeam: [],
  voteHistory: [vote(1, 1, 'P1', ['P1', 'P4', 'P7'], ['P1', 'P4', 'P7']), vote(1, 2, 'P2', ['P2', 'P6', 'P10'], ['P2', 'P6', 'P10', 'P5'])],
};

describe('beliefLeadBlend (round 36)', () => {
  it('mixes the recursive and level-0 world weights in a team pick; off outside the pick', () => {
    const pick = asObs({ ...base, gamePhase: 'team_select' });
    const t0 = { ...DEFAULT_AGENT_TUNING };
    const t1 = { ...DEFAULT_AGENT_TUNING, beliefLeadRecursive: 1 };
    const tb = { ...t1, beliefLeadBlend: 0.5 };
    const s0 = bayesRedShare(pick, bayesOptionsOf(t0));
    const s1 = bayesRedShare(pick, bayesOptionsOf(t1));
    const sb = bayesRedShare(pick, bayesOptionsOf(tb));
    let moved = 0;
    for (const id of IDS) {
      expect(sb.get(id)!).toBeCloseTo(0.5 * s1.get(id)! + 0.5 * s0.get(id)!, 9);
      moved += Math.abs(s1.get(id)! - s0.get(id)!);
    }
    expect(moved).toBeGreaterThan(0);
    // A vote reads the level-0 posterior either way.
    const v = asObs({ ...base, gamePhase: 'team_vote', proposedTeam: ['P1', 'P2', 'P3'] });
    const v0 = bayesRedShare(v, bayesOptionsOf(t0));
    const vb = bayesRedShare(v, bayesOptionsOf(tb));
    for (const id of IDS) expect(vb.get(id)!).toBeCloseTo(v0.get(id)!, 12);
    expect(parseTuningFlag('beliefLeadBlend=0.3')).toEqual({ beliefLeadBlend: 0.3 });
  });
});
