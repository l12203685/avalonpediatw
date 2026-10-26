/**
 * Logic-first batch 1B (2026-10-14, docs/ai/logic_first.md): the plumbing
 * (S1-9b own lake results, S1-9c undeclared lakes) and the guards (S1-11).
 * Fake games only.
 */
import { describe, expect, it } from 'vitest';
import type { LadyOfTheLakeRecord, Room } from '@avalon/shared';
import { privateLakeResults, publicLakeHistory } from './lakeRecords';
import { deriveValidLakeTargets } from './LakePolicy';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { goodBotQuestCard } from '../socket/GameServer';
import type { PlayerObservation, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

function room(history: LadyOfTheLakeRecord[], state: Room['state']): Pick<Room, 'ladyOfTheLakeHistory' | 'state'> {
  return { ladyOfTheLakeHistory: history, state };
}

describe('S1-9b / S1-9c — lake records in the observation', () => {
  const declared: LadyOfTheLakeRecord = { round: 2, holderId: 'P10', targetId: 'P3', result: 'evil', declared: true, declaredClaim: 'good' };
  const skipped: LadyOfTheLakeRecord = { round: 3, holderId: 'P3', targetId: 'P6', result: 'good' };

  it('public history: declared claims, finished undeclared lakes as none, the pending lake hidden; never the private result', () => {
    // After R3 the lake phase ended without a declaration → 'none'.
    expect(publicLakeHistory(room([declared, skipped], 'voting'))).toEqual([
      { round: 2, holderId: 'P10', targetId: 'P3', declaredClaim: 'good' },
      { round: 3, holderId: 'P3', targetId: 'P6', declaredClaim: 'none' },
    ]);
    // While the R3 holder is still deciding what to declare, the record is pending → hidden.
    expect(publicLakeHistory(room([declared, skipped], 'lady_of_the_lake'))).toEqual([
      { round: 2, holderId: 'P10', targetId: 'P3', declaredClaim: 'good' },
    ]);
    for (const rec of publicLakeHistory(room([declared, skipped], 'voting'))) expect(rec).not.toHaveProperty('result');
  });

  it('own results: only the holder gets what it saw (INV-OBS)', () => {
    const r = room([declared, skipped], 'voting');
    expect(privateLakeResults(r, 'P10')).toEqual([{ round: 2, targetId: 'P3', result: 'evil' }]);
    expect(privateLakeResults(r, 'P3')).toEqual([{ round: 3, targetId: 'P6', result: 'good' }]);
    for (const other of ['P1', 'P2', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9']) expect(privateLakeResults(r, other)).toEqual([]);
  });

  it('an undeclared lake still counts for legality (its target cannot be laked again)', () => {
    const obs = {
      myPlayerId: 'P6', allPlayerIds: IDS,
      lakeHistory: publicLakeHistory(room([declared, skipped], 'voting')),
    } as unknown as PlayerObservation;
    const legal = deriveValidLakeTargets(obs);
    expect(legal).not.toContain('P3');
    expect(legal).not.toContain('P10');
    expect(legal).not.toContain('P6');
  });
});

describe('S1-11 — guards', () => {
  it('server bot path: a good bot never plays fail, a red bot keeps its card', () => {
    expect(goodBotQuestCard('good', 'fail')).toBe('success');
    expect(goodBotQuestCard('good', 'success')).toBe('success');
    expect(goodBotQuestCard('evil', 'fail')).toBe('fail');
    expect(goodBotQuestCard('evil', 'success')).toBe('success');
  });

  const questObs = (role: PlayerObservation['myRole'], team: 'good' | 'evil'): PlayerObservation => ({
    myPlayerId: 'P1', myRole: role, myTeam: team, playerCount: 10, allPlayerIds: IDS,
    knownEvils: team === 'evil' ? ['P2'] : [], currentRound: 2, currentLeader: 'P3', failCount: 0,
    questResults: ['fail'], gamePhase: 'quest_vote', voteHistory: [], questHistory: [
      { round: 1, team: ['P1', 'P2', 'P4'], result: 'fail', failCount: 1 },
    ],
    proposedTeam: ['P1', 'P2', 'P3', 'P4'], lakeHistory: [],
  });
  const decide = (o: PlayerObservation, tuning: AgentTuning): ReturnType<ForwardAgent['decide']> => {
    const base = new HeuristicAgent(o.myPlayerId, undefined, undefined, tuning);
    const fwd = new ForwardAgent(o.myPlayerId, base);
    fwd.onGameStart(o);
    return fwd.decide(o);
  };

  it('ForwardAgent: a good bot asked for a card plays success (goodQuestSuccessGuard), same card as before', () => {
    for (const role of ['loyal', 'merlin', 'percival'] as const) {
      const on = decide(questObs(role, 'good'), { ...DEFAULT_AGENT_TUNING });
      expect(on.action).toEqual({ type: 'quest_vote', vote: 'success' });
      expect(on.reasoningTrace.summary).toMatch(/good players only play success/);
      const off = decide(questObs(role, 'good'), { ...DEFAULT_AGENT_TUNING, goodQuestSuccessGuard: false });
      expect(off.action).toEqual(on.action);
    }
    // Red bots are untouched.
    const red = decide(questObs('assassin', 'evil'), { ...DEFAULT_AGENT_TUNING });
    expect(red.reasoningTrace.summary).not.toMatch(/good players only play success/);
  });

  it('legacy assassin heuristic (assassinHeuristicVisibility): only certain mistakes count, Mordred is not a thumb for sure', () => {
    // Assassin P1 sees teammates P2 / P3 (Morgana and Mordred, roles unknown); Oberon P4.
    const vote = (leader: string, team: string[], votes: Record<string, boolean>): VoteRecord =>
      ({ round: 1, attempt: 1, leader, team, approved: false, votes });
    const obs: PlayerObservation = {
      myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS,
      knownEvils: ['P2', 'P3'], allEvilIds: ['P1', 'P2', 'P3', 'P4'],
      currentRound: 5, currentLeader: 'P1', failCount: 0, questResults: ['success', 'success', 'success'],
      gamePhase: 'assassination', questHistory: [], proposedTeam: [], lakeHistory: [],
      voteHistory: [
        vote('P5', ['P5', 'P2', 'P7'], {}),            // one ambiguous teammate: maybe Mordred → not certain
        vote('P6', ['P6', 'P4', 'P8'], {}),            // Oberon is always visible to Merlin → certain
        vote('P9', ['P9', 'P2', 'P3'], {}),            // both teammates: one is Morgana → certain
        vote('P10', ['P10', 'P5', 'P6'], { P7: true }), // clean for sure; P7 off-team approve of a clean team: no mistake
      ],
    };
    const fixed = new HeuristicAgent('P1', undefined, undefined, { ...LEGACY_AGENT_TUNING, assassinHeuristicVisibility: true });
    const old = new HeuristicAgent('P1', undefined, undefined, { ...LEGACY_AGENT_TUNING });
    expect(fixed._getMistakeCountForTesting('P5', obs)).toBe(0);
    expect(fixed._getMistakeCountForTesting('P6', obs)).toBe(1);
    expect(fixed._getMistakeCountForTesting('P9', obs)).toBe(1);
    // The old reading: any teammate on the team counted (P5 a "mistake"), Oberon did not (P6 clean).
    expect(old._getMistakeCountForTesting('P5', obs)).toBe(1);
    expect(old._getMistakeCountForTesting('P6', obs)).toBe(0);
    // Percival-likeness: one teammate on a led team = ½ Morgana, both = certain.
    expect(fixed._getPercivalLikenessPenaltyForTesting('P5', obs)).toBeCloseTo(1.5 * 0.5, 9);
    expect(fixed._getPercivalLikenessPenaltyForTesting('P9', obs)).toBeCloseTo(1.5, 9);
  });
});
