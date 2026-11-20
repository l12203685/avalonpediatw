/**
 * 第 56b 回合 C：對手類型的策略層（`humanProfile.ts`）——一條基準線、真人桌只加少數讀人的開關、機器人桌（自我對打）＝基準線。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import type { Player, Room } from '@avalon/shared';
import { DEFAULT_AGENT_TUNING, getDefaultAgentTuning, type AgentTuningKey } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import type { AvalonAgent, PlayerObservation } from './types';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import {
  OPPONENT_TYPES, PROFILE_KEYS, PROFILE_OVERRIDES, opponentTypeOfTable, parseOpponentType, strengthTierOfS, tuningForOpponent,
} from './humanProfile';
import { GameServer, opponentTypeForRoom } from '../socket/GameServer';
import { SIM_OPPONENT } from '../bots/simulation/aiRead';

afterEach(() => { vi.unstubAllEnvs(); });

describe('one baseline, small per-opponent adjustments', () => {
  it('ai (self-play) is the baseline itself', () => {
    expect(PROFILE_OVERRIDES.ai).toEqual({});
    expect(tuningForOpponent('ai', DEFAULT_AGENT_TUNING)).toEqual(DEFAULT_AGENT_TUNING);
  });
  it('human profiles only touch the listed belief keys, a few of them', () => {
    for (const type of OPPONENT_TYPES) {
      const keys = Object.keys(PROFILE_OVERRIDES[type]) as AgentTuningKey[];
      expect(keys.length).toBeLessThanOrEqual(3);
      for (const k of keys) expect(PROFILE_KEYS).toContain(k);
      const t = tuningForOpponent(type, DEFAULT_AGENT_TUNING);
      const changed = (Object.keys(DEFAULT_AGENT_TUNING) as AgentTuningKey[]).filter((k) => t[k] !== DEFAULT_AGENT_TUNING[k]);
      for (const k of changed) expect(PROFILE_KEYS).toContain(k);
    }
  });
  it('the baseline keeps the environment overrides (deploy-time switches still apply under a profile)', () => {
    vi.stubEnv('AVALON_TUNING_LOYAL_RATIONALITY_50', '0');
    const t = tuningForOpponent('avgHuman');
    expect(t.loyalRationality50).toBe(0);
    expect(getDefaultAgentTuning().loyalRationality50).toBe(0);
  });
});

describe('which opponent type', () => {
  it('no humans → ai; humans without S → avgHuman; S tiers follow the site cohort cuts (38 / 55)', () => {
    expect(opponentTypeOfTable({ humans: 0 })).toBe('ai');
    expect(opponentTypeOfTable({ humans: 0, tableS: 70 })).toBe('ai');
    expect(opponentTypeOfTable({ humans: 1 })).toBe('avgHuman');
    expect(opponentTypeOfTable({ humans: 9, tableS: null })).toBe('avgHuman');
    expect(opponentTypeOfTable({ humans: 9, tableS: 37.9 })).toBe('weakHuman');
    expect(opponentTypeOfTable({ humans: 9, tableS: 38 })).toBe('avgHuman');
    expect(opponentTypeOfTable({ humans: 9, tableS: 54.9 })).toBe('avgHuman');
    expect(opponentTypeOfTable({ humans: 9, tableS: 55 })).toBe('strongHuman');
    expect(strengthTierOfS(65)).toBe('strong');
  });
  it('parses the command-line names', () => {
    expect(parseOpponentType('ai')).toBe('ai');
    expect(parseOpponentType('weak')).toBe('weakHuman');
    expect(parseOpponentType('AVG')).toBe('avgHuman');
    expect(parseOpponentType('strongHuman')).toBe('strongHuman');
    expect(parseOpponentType('')).toBeNull();
    expect(parseOpponentType('x')).toBeNull();
  });
});

describe('the human reading changes blue seats only', () => {
  const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
  const v = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
    round, attempt, leader, team, approved: yes.length > 5, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
  });
  // R1 P4 P5 P7 succeeded; R2 the copies "P4 P5 P7 + one" were rejected three times, then P4 P5 P7 P10 failed.
  const history = [
    v(1, 1, 'P4', ['P4', 'P5', 'P7'], ['P4', 'P5', 'P7', 'P1', 'P2', 'P3']),
    v(2, 1, 'P1', ['P1', 'P4', 'P5', 'P7'], ['P1', 'P4', 'P5', 'P7', 'P2']),
    v(2, 2, 'P2', ['P2', 'P4', 'P5', 'P7'], ['P2', 'P4', 'P5', 'P7', 'P3']),
    v(2, 3, 'P3', ['P3', 'P4', 'P5', 'P7'], ['P3', 'P4', 'P5', 'P7', 'P1']),
    v(2, 4, 'P10', ['P10', 'P4', 'P5', 'P7'], ['P10', 'P4', 'P5', 'P7', 'P1', 'P2']),
  ];
  const obs = (over: object = {}) => ({
    myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', seatTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['success', 'fail'], gamePhase: 'team_select', proposedTeam: [],
    voteHistory: history,
    questHistory: [{ round: 1, team: ['P4', 'P5', 'P7'], result: 'success', failCount: 0 }, { round: 2, team: ['P4', 'P5', 'P7', 'P10'], result: 'fail', failCount: 1 }],
    lakeHistory: [], myLakeResults: [], ...over,
  } as unknown as PlayerObservation);
  it('a loyal reads the copied team as less clean at a human table; a red seat reads the same at every table', () => {
    const human = tuningForOpponent('avgHuman', DEFAULT_AGENT_TUNING);
    expect(human.viewpoint53).toBe(0); // the leader-viewpoint reading (V3P) is off at human tables
    const ai = bayesRedShare(obs(), bayesOptionsOf({ ...human, copyDiscount55: 0 }));
    const hu = bayesRedShare(obs(), bayesOptionsOf(human));
    const s = (m: Map<string, number>): number => ['P4', 'P5', 'P7'].reduce((a, id) => a + (m.get(id) ?? 0), 0);
    expect(s(hu)).toBeGreaterThan(s(ai));
    const red = obs({ myRole: 'assassin', myTeam: 'evil', seatTeam: 'evil', knownEvils: ['P2', 'P3', 'P10'] });
    expect([...bayesRedShare(red, bayesOptionsOf(tuningForOpponent('avgHuman', DEFAULT_AGENT_TUNING)))])
      .toEqual([...bayesRedShare(red, bayesOptionsOf(DEFAULT_AGENT_TUNING))]);
  });
});

describe('wiring', () => {
  const bot = (id: string, isBot: boolean): Player => ({ id, name: id, role: null, team: null, status: 'active', isBot } as unknown as Player);
  const room = (humans: number): Room => {
    const players: Record<string, Player> = {};
    for (let i = 1; i <= 10; i++) players[`p${i}`] = bot(`p${i}`, i > humans);
    return { id: 'r', players } as unknown as Room;
  };
  it('a site room with humans plays the human profile, an all-bot room the baseline', () => {
    expect(opponentTypeForRoom(room(0))).toBe('ai');
    expect(opponentTypeForRoom(room(1))).toBe('avgHuman');
    const server = new GameServer(new SocketIOServer(createServer())) as unknown as { botAgents: Map<string, AvalonAgent>; applyOpponentProfile(r: Room): string };
    const r = room(1);
    for (let i = 2; i <= 10; i++) server.botAgents.set(`p${i}`, new HeuristicAgent(`p${i}`));
    expect(server.applyOpponentProfile(r)).toBe('avgHuman');
    const t = (server.botAgents.get('p2') as HeuristicAgent).tuning;
    for (const [k, val] of Object.entries(PROFILE_OVERRIDES.avgHuman)) expect(t[k as AgentTuningKey]).toBe(val);
    // The humans left: the same bots go back to the baseline at the next start.
    const allBots = room(0);
    server.botAgents.set('p1', new HeuristicAgent('p1'));
    expect(server.applyOpponentProfile(allBots)).toBe('ai');
    expect((server.botAgents.get('p2') as HeuristicAgent).tuning).toEqual(getDefaultAgentTuning());
  });
  it('the simulation (human records) reads with the human profile', () => {
    expect(SIM_OPPONENT).toBe('avgHuman');
  });
});
