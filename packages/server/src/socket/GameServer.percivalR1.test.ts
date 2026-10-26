/**
 * GameServer bot path — Percival's R1 thumbs (`AgentTuning.percivalNoThumbsR1`,
 * D5 fixes 2026-10-14, docs/ai/logic_first.md).
 *
 * The live bot builds its observation with `GameServer.buildBotObservation`
 * and decides through `HeuristicAgent.act` → ForwardAgent. These tests take
 * the observation from the server wiring (role knowledge from the room, the
 * vote history the engine keeps) and run the production decision on it, so
 * the knownWizards wiring is covered too:
 *   - Morgana on: Percival sees two thumbs and puts neither on his R1 team;
 *   - Morgana off in the lobby (she becomes a minion): Percival sees one
 *     wizard, the certain Merlin, and the rule does not apply;
 *   - a thumb that put the other thumb on its own R1 team: the included thumb
 *     may go on Percival's team (`percivalR1ThumbOnThumb`), the other never.
 */
import { describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import type { Player, Room, Role, VoteRecord } from '@avalon/shared';

import { GameServer } from './GameServer';
import { HeuristicAgent } from '../ai/HeuristicAgent';
import { ForwardAgent } from '../ai/forward/ForwardAgent';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from '../ai/AgentTuning';
import { percivalNoThumbsR1Active } from '../ai/PercivalThumbs';
import type { PlayerObservation } from '../ai/types';
import type { GameEngine } from '../game/GameEngine';

const EVIL: Role[] = ['assassin', 'morgana', 'mordred', 'oberon', 'minion'];

function player(id: string, role: Role): Player {
  return { id, name: id, role, team: EVIL.includes(role) ? 'evil' : 'good', status: 'active', isBot: true } as Player;
}

/** p1 assassin, p2 morgana (or minion), p3 mordred, p4 oberon, p5 merlin, p6 percival, p7–p10 loyal. */
function makeRoom(morgana: boolean, voteHistory: VoteRecord[] = []): Room {
  const roles: Role[] = ['assassin', morgana ? 'morgana' : 'minion', 'mordred', 'oberon', 'merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal'];
  const players: Record<string, Player> = {};
  roles.forEach((role, i) => { players[`p${i + 1}`] = player(`p${i + 1}`, role); });
  return {
    id: 'room-percival-r1',
    state: 'voting',
    players,
    host: 'p1',
    leaderIndex: 5,
    currentRound: 1,
    questTeam: [],
    questResults: [],
    questHistory: [],
    voteHistory,
    votes: {},
    failCount: voteHistory.length,
    maxPlayers: 10,
    createdAt: Date.now(),
    isPrivate: false,
    ladyOfTheLakeEnabled: true,
    ladyOfTheLakeHolder: 'p10',
    ladyOfTheLakeUsed: ['p10'],
    ladyOfTheLakeHistory: [],
  } as unknown as Room;
}

interface ServerInternals {
  buildBotObservation(r: Room, botId: string, engine: GameEngine, phase: PlayerObservation['gamePhase']): PlayerObservation;
}

const ENGINE = { getCurrentLeaderId: () => 'p6' } as unknown as GameEngine;

function serverObs(room: Room): PlayerObservation {
  const server = new GameServer(new SocketIOServer(createServer())) as unknown as ServerInternals;
  return server.buildBotObservation(room, 'p6', ENGINE, 'team_select');
}

/** The production decision (HeuristicAgent.act routes to ForwardAgent with USE_FORWARD_REASONING). */
function botTeam(obs: PlayerObservation, tuning: AgentTuning): string[] {
  const base = new HeuristicAgent('p6', undefined, undefined, tuning);
  const fwd = new ForwardAgent('p6', base);
  fwd.onGameStart(obs);
  base._ingestForTesting(obs);
  const d = fwd.decide(obs);
  expect(d.reasoningTrace.usedFallback).toBe(false);
  if (d.action.type !== 'team_select') throw new Error('expected a team');
  return d.action.teamIds;
}

const normal = (attempt: number, leader: string, team: string[]): VoteRecord => {
  const votes: Record<string, boolean> = {};
  for (let i = 1; i <= 10; i++) votes[`p${i}`] = team.includes(`p${i}`);
  return { round: 1, attempt, leader, team, approved: false, votes };
};

const PROD: AgentTuning = { ...DEFAULT_AGENT_TUNING };
const OFF: AgentTuning = { ...DEFAULT_AGENT_TUNING, percivalNoThumbsR1: false, percivalR1ThumbOnThumb: false };

describe('GameServer bot path — Percival R1 thumbs', () => {
  it('Morgana on: two thumbs from the server wiring, neither on the R1 team (every attempt)', () => {
    const history = [
      normal(1, 'p1', ['p1', 'p3', 'p7']),
      normal(2, 'p2', ['p2', 'p8', 'p9']),
      normal(3, 'p3', ['p3', 'p7', 'p10']),
      normal(4, 'p4', ['p4', 'p8', 'p10']),
    ];
    for (let k = 0; k <= 4; k++) {
      const obs = serverObs(makeRoom(true, history.slice(0, k)));
      expect([...(obs.knownWizards ?? [])].sort()).toEqual(['p2', 'p5']);
      expect(percivalNoThumbsR1Active(PROD, obs)).toBe(true);
      const team = botTeam(obs, PROD);
      expect(team).toHaveLength(3);
      expect(team).toContain('p6');
      expect(team.filter((id) => id === 'p2' || id === 'p5')).toEqual([]);
    }
  });

  it('Morgana off in the lobby: one wizard (the certain Merlin) — the rule does not apply', () => {
    const obs = serverObs(makeRoom(false, [normal(1, 'p1', ['p1', 'p3', 'p7'])]));
    expect(obs.knownWizards).toEqual(['p5']);
    expect(percivalNoThumbsR1Active(PROD, obs)).toBe(false);
    // Same decision as with the switch off: the rule leaves this game alone.
    expect(botTeam(obs, PROD)).toEqual(botTeam(obs, OFF));
  });

  it('thumb-on-thumb: Morgana (p2) put Merlin (p5) on her R1 team → p5 may go on Percival\'s team, p2 never', () => {
    const history = [normal(1, 'p1', ['p1', 'p3', 'p7']), normal(2, 'p2', ['p2', 'p5', 'p8'])];
    const obs = serverObs(makeRoom(true, history));
    const team = botTeam(obs, PROD);
    expect(team).toContain('p5');
    expect(team).not.toContain('p2');
    // Exception off → no thumb at all.
    const noException = botTeam(obs, { ...PROD, percivalR1ThumbOnThumb: false });
    expect(noException.filter((id) => id === 'p2' || id === 'p5')).toEqual([]);
  });
});
