/**
 * 位階法 in the production ForwardAgent path (Edward 2026-04-24 batch 10; `redRankOrder`): two recognised reds on an
 * R2/R3 mission — the assassin fails, Mordred plays success (the wiki audit 2026-10-29 found every red failing).
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

function card(role: 'assassin' | 'mordred', me: string, round: number, tuning = DEFAULT_AGENT_TUNING): string {
  const o = {
    myPlayerId: me, myRole: role, myTeam: 'evil', playerCount: 10, allPlayerIds: IDS,
    knownEvils: ['P1', 'P2', 'P3'].filter((x) => x !== me), currentRound: round, currentLeader: 'P5', failCount: 0,
    questResults: round === 3 ? ['fail', 'success'] : ['success'], gamePhase: 'quest_vote', proposedTeam: ['P1', 'P2', 'P5', 'P6'],
    lakeHistory: [], voteHistory: [{ round, attempt: 1, leader: 'P5', team: ['P1', 'P2', 'P5', 'P6'], approved: true, votes: {} }],
    questHistory: round === 3
      ? [{ round: 1, team: ['P5', 'P6', 'P7'], result: 'fail', failCount: 1 }, { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 }]
      : [{ round: 1, team: ['P5', 'P6', 'P7'], result: 'success', failCount: 0 }],
  } as unknown as PlayerObservation;
  const fa = new ForwardAgent(me, new HeuristicAgent(me, undefined, undefined, tuning));
  fa.onGameStart(o);
  const a = fa.decide(o).action;
  if (a.type !== 'quest_vote') throw new Error(a.type);
  return a.vote;
}

describe('redRankOrder', () => {
  it('assassin + Mordred on R2 / R3: one fail card (the assassin), Mordred plays success', () => {
    for (const round of [2, 3]) {
      expect(card('assassin', 'P1', round)).toBe('fail');
      expect(card('mordred', 'P2', round)).toBe('success');
    }
  });
  it('switch off: the old production behaviour (Mordred fails too)', () => {
    expect(card('mordred', 'P2', 3, { ...DEFAULT_AGENT_TUNING, redRankOrder: false })).toBe('fail');
  });
});
