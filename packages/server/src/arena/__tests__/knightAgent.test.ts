/**
 * 正式對局也套殘差層（站長 2026-11-27）：練習台、房間、補位機器人用的 `createKnightAgent` 和擂台的座位是同一個 KnightAgent，
 * 同一個局面做一樣的決定；硬規則照舊；殘差層出錯照引擎；`KNIGHT_RESIDUAL_LIVE=off` 只套開關。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerObservation } from '../../ai/types';
import { HeuristicAgent } from '../../ai/HeuristicAgent';
import { createKnightAgent, getKnight, DEFAULT_KNIGHT_ID } from '../knights';
import { KnightAgent, applyResidualAction, liveResidualEnabled, residualFallbackCounter } from '../knightAgent';
import { resolveProfileTuning } from '../profile';
import { ResidualPolicy } from '../residual';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P1', myRole: 'loyal' as PlayerObservation['myRole'], myTeam: 'good', playerCount: 10, allPlayerIds: IDS,
    knownEvils: [], currentRound: 1, currentLeader: 'P1', failCount: 0, questResults: [], gamePhase: 'team_select',
    voteHistory: [], questHistory: [], proposedTeam: [], lakeHistory: [], myLakeResults: [],
    ...over,
  };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('createKnightAgent (live games)', () => {
  it('a knight with residual weights becomes a KnightAgent; 百科 / unknown stay plain', () => {
    expect(getKnight('knight-ed-01')?.profile?.residual).toBeDefined();
    const ed = createKnightAgent('BOT-1', 'knight-ed-01', 'loyal', 'good');
    expect(ed).toBeInstanceOf(KnightAgent);
    expect(ed.tuning.goodBayesBad).toBe(0.99);
    expect(createKnightAgent('BOT-2', DEFAULT_KNIGHT_ID, 'loyal', 'good')).not.toBeInstanceOf(KnightAgent);
    expect(createKnightAgent('BOT-3', 'no-such-knight', 'loyal', 'good')).not.toBeInstanceOf(KnightAgent);
    // 策略層（base）先、騎士的開關蓋上去。
    const based = createKnightAgent('BOT-4', 'knight-ed-01', 'loyal', 'good', { goodBayesBad: 0.6, redNormalVote: 0.4 });
    expect(based.tuning.goodBayesBad).toBe(0.99);
    expect(based.tuning.redNormalVote).toBe(0.4);
  });

  it('KNIGHT_RESIDUAL_LIVE=off keeps only the knobs (as before #222 went live)', () => {
    vi.stubEnv('KNIGHT_RESIDUAL_LIVE', 'off');
    expect(liveResidualEnabled()).toBe(false);
    const ed = createKnightAgent('BOT-1', 'knight-ed-01', 'loyal', 'good');
    expect(ed).toBeInstanceOf(HeuristicAgent);
    expect(ed).not.toBeInstanceOf(KnightAgent);
    expect(ed.tuning.goodBayesBad).toBe(0.99);
    vi.stubEnv('KNIGHT_RESIDUAL_LIVE', '');
    expect(liveResidualEnabled()).toBe(true);
  });

  it('makes the same decisions as the arena seat (engine + knobs, then the residual layer)', () => {
    const profile = getKnight('knight-ed-01')!.profile!;
    const spots: PlayerObservation[] = [
      obs({ myRole: 'loyal' as PlayerObservation['myRole'], currentLeader: 'P1', gamePhase: 'team_select' }),
      obs({ myRole: 'loyal' as PlayerObservation['myRole'], gamePhase: 'team_vote', currentLeader: 'P3', proposedTeam: ['P3', 'P4', 'P5'] }),
    ];
    for (const o of spots) {
      const tuning = resolveProfileTuning(profile, 'loyal', 'good');
      const engine = new HeuristicAgent('P1', undefined, undefined, tuning);
      engine.onGameStart(o);
      const expected = applyResidualAction(new ResidualPolicy(profile.residual!, engine.tuning), o, engine.act(o));
      const live = createKnightAgent('P1', 'knight-ed-01', 'loyal', 'good', tuning);
      live.onGameStart(o);
      expect(live.act(o)).toEqual(expected);
    }
  });

  it('keeps the hard rules: blue plays success, a team has the right size', () => {
    const blue = createKnightAgent('P1', 'knight-ed-01', 'loyal', 'good');
    const q = obs({ gamePhase: 'quest_vote', proposedTeam: ['P1', 'P2', 'P3'] });
    blue.onGameStart(q);
    expect(blue.act(q)).toEqual({ type: 'quest_vote', vote: 'success' });
    const t = obs({ gamePhase: 'team_select' });
    blue.onGameStart(t);
    const a = blue.act(t);
    expect(a.type).toBe('team_select');
    if (a.type === 'team_select') {
      expect(a.teamIds).toHaveLength(3);
      expect(new Set(a.teamIds).size).toBe(3);
      for (const id of a.teamIds) expect(IDS).toContain(id);
    }
  });

  it('falls back to the engine decision when the residual layer throws', () => {
    const agent = createKnightAgent('P1', 'knight-ed-01', 'loyal', 'good') as KnightAgent;
    const o = obs({ gamePhase: 'team_vote', currentLeader: 'P3', proposedTeam: ['P3', 'P4', 'P5'] });
    agent.onGameStart(o);
    const engine = HeuristicAgent.prototype.act.call(agent, o);
    const spy = vi.spyOn(agent.residualPolicy, 'vote').mockImplementation(() => { throw new Error('boom'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = residualFallbackCounter.errors;
    expect(agent.act(o)).toEqual(engine);
    expect(residualFallbackCounter.errors).toBe(before + 1);
    spy.mockRestore();
    warn.mockRestore();
  });
});
