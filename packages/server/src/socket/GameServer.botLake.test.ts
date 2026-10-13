/**
 * GameServer — bot Lady-of-the-Lake path (2026-10-13 live parity).
 *
 * The live bot used to pick a uniformly random eligible target and run its
 * own claim rule (good = truth, red = invert), so the lake `AgentTuning`
 * switches only affected self-play. It now asks the bot's own agent
 * (`pickLakeTarget` / `declareLake`, i.e. `LakePolicy` with the bot's
 * tuning) and falls back to the old behaviour when the agent is missing,
 * lacks the lake API, throws, or returns an ineligible target — and for
 * every bot when `AVALON_BOT_LAKE_VIA_AGENT=0`.
 *
 * Every HeuristicAgent here gets a complete tuning object so exported
 * `AVALON_TUNING_*` variables cannot change the expectations, and the
 * routing switch is pinned per test with `vi.stubEnv`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import type { Player, Room, Role } from '@avalon/shared';

import { GameServer, isBotLakeViaAgentEnabled } from './GameServer';
import { HeuristicAgent } from '../ai/HeuristicAgent';
import { RandomAgent } from '../ai/RandomAgent';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING } from '../ai/AgentTuning';
import type { AvalonAgent } from '../ai/types';
import type { GameEngine } from '../game/GameEngine';

const EVIL: Role[] = ['assassin', 'morgana', 'mordred', 'oberon'];

function player(id: string, role: Role): Player {
  return {
    id,
    name: id,
    role,
    team: EVIL.includes(role) ? 'evil' : 'good',
    status: 'active',
    isBot: true,
  } as Player;
}

/** 10 seats: p1 assassin, p2 morgana, p3 mordred, p4 oberon, p5 merlin, p6 percival, p7–p10 loyal. */
function makeRoom(over: Partial<Room> = {}): Room {
  const roles: Role[] = ['assassin', 'morgana', 'mordred', 'oberon', 'merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal'];
  const players: Record<string, Player> = {};
  roles.forEach((role, i) => { players[`p${i + 1}`] = player(`p${i + 1}`, role); });
  return {
    id: 'room-bot-lake',
    state: 'lady_of_the_lake',
    players,
    host: 'p1',
    leaderIndex: 0,
    currentRound: 2,
    questTeam: [],
    questResults: ['fail', 'success'],
    questHistory: [
      { round: 1, team: ['p2', 'p5', 'p6'], result: 'fail', failCount: 1 },
      { round: 2, team: ['p3', 'p7', 'p8', 'p9'], result: 'success', failCount: 0 },
    ],
    voteHistory: [],
    votes: {},
    failCount: 0,
    maxPlayers: 10,
    createdAt: Date.now(),
    isPrivate: false,
    ladyOfTheLakeEnabled: true,
    ladyOfTheLakeHolder: 'p1',
    ladyOfTheLakeUsed: ['p10', 'p1'],
    ladyOfTheLakeHistory: [],
    ...over,
  } as unknown as Room;
}

interface BotLakeInternals {
  botAgents: Map<string, AvalonAgent>;
  pickBotLakeTarget(r: Room, holderId: string, eligible: readonly string[], engine: GameEngine): string | undefined;
  decideBotLakeClaim(room: Room, holderId: string, targetId: string, engine?: GameEngine): 'good' | 'evil' | null;
}

function makeServer(): BotLakeInternals {
  const io = new SocketIOServer(createServer());
  return new GameServer(io) as unknown as BotLakeInternals;
}

const ENGINE = { getCurrentLeaderId: () => 'p3' } as unknown as GameEngine;
const ELIGIBLE = ['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];
const PRODUCTION = { ...DEFAULT_AGENT_TUNING };
const HUMAN_STRATEGY = { ...LEGACY_AGENT_TUNING, evilLakeHumanStrategy: true };

beforeEach(() => { vi.stubEnv('AVALON_BOT_LAKE_VIA_AGENT', ''); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('GameServer bot lake — agent decides target and claim', () => {
  it('red bot with evilLakeHumanStrategy lakes its most suspected visible teammate and washes them', () => {
    const server = makeServer();
    server.botAgents.set('p1', new HeuristicAgent('p1', undefined, undefined, HUMAN_STRATEGY));
    const room = makeRoom();
    const target = server.pickBotLakeTarget(room, 'p1', ELIGIBLE, ENGINE);
    expect(target).toBe('p2'); // on the failed R1 mission → most pressured teammate
    const claim = server.decideBotLakeClaim({ ...room, ladyOfTheLakeResult: 'evil' } as Room, 'p1', 'p2', ENGINE);
    expect(claim).toBe('good');
  });

  it('the agent claim replaces the old inversion (red bot, human strategy, truthful "good" on a blue)', () => {
    const server = makeServer();
    server.botAgents.set('p1', new HeuristicAgent('p1', undefined, undefined, HUMAN_STRATEGY));
    const room = { ...makeRoom(), ladyOfTheLakeResult: 'good' } as Room;
    expect(server.decideBotLakeClaim(room, 'p1', 'p7', ENGINE)).toBe('good');
  });

  it('good bot (production tuning) extends the trust chain at 1-1 and tells the truth', () => {
    const server = makeServer();
    const room = makeRoom({ ladyOfTheLakeHolder: 'p7', ladyOfTheLakeUsed: ['p10', 'p7'] } as Partial<Room>);
    server.botAgents.set('p7', new HeuristicAgent('p7', undefined, undefined, PRODUCTION));
    const eligible = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p8', 'p9'];
    const target = server.pickBotLakeTarget(room, 'p7', eligible, ENGINE);
    // 1-1 and the holder went on the passed R2 mission: `goodLakeInfoMax`
    // (GoodLakeInfo.ts, production default since 2026-10-13) lakes a fellow
    // R2 member — most likely good, so a trusted next holder (Edward:
    // 「信任鏈的湖中選擇對於一紅一藍時幾乎成立」); p3 / p8 / p9 tie → seat order.
    expect(target).toBe('p3');
    // The old production rule (`goodLakeTargetMostSuspicious`) inspects the failed R1 mission.
    const mostSuspicious = { ...PRODUCTION, goodLakeTargetMostSuspicious: true, goodLakeInfoMax: false };
    server.botAgents.set('p7', new HeuristicAgent('p7', undefined, undefined, mostSuspicious));
    expect(['p2', 'p5', 'p6']).toContain(server.pickBotLakeTarget(room, 'p7', eligible, ENGINE));
    const claimRoom = { ...room, ladyOfTheLakeResult: 'evil' } as Room;
    expect(server.decideBotLakeClaim(claimRoom, 'p7', 'p2', ENGINE)).toBe('evil');
  });

  it('only ever returns an eligible id', () => {
    const server = makeServer();
    server.botAgents.set('p1', new HeuristicAgent('p1', undefined, undefined, PRODUCTION));
    const room = makeRoom();
    for (const eligible of [['p5'], ['p4', 'p9'], ELIGIBLE]) {
      expect(eligible).toContain(server.pickBotLakeTarget(room, 'p1', eligible, ENGINE));
    }
    expect(server.pickBotLakeTarget(room, 'p1', [], ENGINE)).toBeUndefined();
  });
});

describe('GameServer bot lake — fallback to the pre-2026-10-13 behaviour', () => {
  it('AVALON_BOT_LAKE_VIA_AGENT=0 → every bot uses the old random target and good = truth / red = invert', () => {
    vi.stubEnv('AVALON_BOT_LAKE_VIA_AGENT', '0');
    const server = makeServer();
    server.botAgents.set('p1', new HeuristicAgent('p1', undefined, undefined, HUMAN_STRATEGY));
    server.botAgents.set('p7', new HeuristicAgent('p7', undefined, undefined, PRODUCTION));
    const room = makeRoom();
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      expect(server.pickBotLakeTarget(room, 'p1', ELIGIBLE, ENGINE)).toBe('p9');
    } finally {
      spy.mockRestore();
    }
    // The agent would say "good" on this blue (truthful goodwill); the old rule inverts.
    expect(server.decideBotLakeClaim({ ...room, ladyOfTheLakeResult: 'good' } as Room, 'p1', 'p7', ENGINE)).toBe('evil');
    expect(server.decideBotLakeClaim({ ...room, ladyOfTheLakeResult: 'evil' } as Room, 'p1', 'p2', ENGINE)).toBe('good');
    const goodRoom = makeRoom({ ladyOfTheLakeHolder: 'p7', ladyOfTheLakeUsed: ['p10', 'p7'] } as Partial<Room>);
    expect(server.decideBotLakeClaim({ ...goodRoom, ladyOfTheLakeResult: 'good' } as Room, 'p7', 'p5', ENGINE)).toBe('good');
  });

  it('isBotLakeViaAgentEnabled: on unless explicitly 0 / false / off / no', () => {
    expect(isBotLakeViaAgentEnabled({})).toBe(true);
    expect(isBotLakeViaAgentEnabled({ AVALON_BOT_LAKE_VIA_AGENT: '1' })).toBe(true);
    expect(isBotLakeViaAgentEnabled({ AVALON_BOT_LAKE_VIA_AGENT: 'junk' })).toBe(true);
    for (const off of ['0', 'false', 'OFF', ' no ']) {
      expect(isBotLakeViaAgentEnabled({ AVALON_BOT_LAKE_VIA_AGENT: off })).toBe(false);
    }
  });

  it('agent without the lake API (RandomAgent) → random eligible target and the inversion claim', () => {
    const server = makeServer();
    server.botAgents.set('p1', new RandomAgent('p1'));
    const room = makeRoom();
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      expect(server.pickBotLakeTarget(room, 'p1', ELIGIBLE, ENGINE)).toBe('p9');
    } finally {
      spy.mockRestore();
    }
    expect(server.decideBotLakeClaim({ ...room, ladyOfTheLakeResult: 'good' } as Room, 'p1', 'p7', ENGINE)).toBe('evil');
    expect(server.decideBotLakeClaim({ ...room, ladyOfTheLakeResult: 'evil' } as Room, 'p1', 'p2', ENGINE)).toBe('good');
  });

  it('agent that throws → fallback, never throws out of the timer path', () => {
    const server = makeServer();
    const broken = {
      agentId: 'p1',
      agentType: 'heuristic',
      onGameStart: () => undefined,
      act: () => { throw new Error('boom'); },
      onGameEnd: () => undefined,
      pickLakeTarget: () => { throw new Error('boom'); },
      declareLake: () => { throw new Error('boom'); },
    } as unknown as AvalonAgent;
    server.botAgents.set('p1', broken);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const room = makeRoom();
      expect(ELIGIBLE).toContain(server.pickBotLakeTarget(room, 'p1', ELIGIBLE, ENGINE));
      expect(server.decideBotLakeClaim({ ...room, ladyOfTheLakeResult: 'good' } as Room, 'p1', 'p7', ENGINE)).toBe('evil');
    } finally {
      err.mockRestore();
    }
  });

  it('agent returning an ineligible id → random eligible target', () => {
    const server = makeServer();
    const liar = {
      agentId: 'p1',
      agentType: 'heuristic',
      onGameStart: () => undefined,
      act: () => ({ type: 'team_vote', vote: true }),
      onGameEnd: () => undefined,
      pickLakeTarget: () => 'p10',
      declareLake: () => 'good',
    } as unknown as AvalonAgent;
    server.botAgents.set('p1', liar);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(ELIGIBLE).toContain(server.pickBotLakeTarget(makeRoom(), 'p1', ELIGIBLE, ENGINE));
    } finally {
      warn.mockRestore();
    }
  });

  it('no engine handed in → old rule (kept for callers outside the bot timer)', () => {
    const server = makeServer();
    server.botAgents.set('p1', new HeuristicAgent('p1', undefined, undefined, HUMAN_STRATEGY));
    const room = { ...makeRoom(), ladyOfTheLakeResult: 'good' } as Room;
    expect(server.decideBotLakeClaim(room, 'p1', 'p7')).toBe('evil');
  });

  it('unknown holder camp or unknown target camp → null (caller skips the declaration)', () => {
    const server = makeServer();
    const room = makeRoom();
    room.players.p1 = { ...room.players.p1, team: null } as unknown as Player;
    expect(server.decideBotLakeClaim(room, 'p1', 'p7', ENGINE)).toBeNull();
    const room2 = makeRoom();
    room2.players.p7 = { ...room2.players.p7, team: null } as unknown as Player;
    expect(server.decideBotLakeClaim(room2, 'p1', 'p7', ENGINE)).toBeNull();
  });
});
