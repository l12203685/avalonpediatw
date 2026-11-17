/**
 * Issue #20: bot voting timers run on their own async stack.
 * These regression probes exercise the real GameServer scheduler with
 * controlled room/engine seams (no network or production deployment).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../../socket/GameServer';
import { GameEngine } from '../../game/GameEngine';
import type { Player, Room } from '@avalon/shared';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(opts: { onTeam: boolean; failSubmitOnce?: boolean }) {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const room = {
    id: 'test-room', state: 'voting', currentRound: 3,
    questTeam: opts.onTeam ? ['bot', 'human'] : ['human'],
    players: { bot: { isBot: true }, human: { isBot: false } },
    votes: {} as Record<string, boolean>,
    voteHistory: [] as unknown[],
  };
  let submitCount = 0;
  const engine = {
    submitVote: vi.fn((id: string, vote: boolean) => {
      submitCount++;
      if (opts.failSubmitOnce && submitCount === 1) throw new Error('temporary engine failure');
      if (id in room.votes) throw new Error('duplicate vote');
      room.votes[id] = vote;
    }),
  };
  const agent = { act: vi.fn(() => { throw new Error('synthetic AI exception'); }) };
  const server = Object.create(GameServer.prototype) as GameServer;
  Object.assign(server, {
    roomManager: { getRoom: () => room },
    gameEngines: new Map([['test-room', engine]]),
    botAgents: new Map([['bot', agent]]),
    botDelayScale: 0,
    botVoteRecovery: new Map(),
    isPracticeRoom: () => false,
    broadcastRoomState: vi.fn(),
    commitPracticeTrace: vi.fn(),
    onGameEnded: vi.fn(),
    buildBotObservation: () => ({ currentRound: 3 }),
  });
  const schedule = (server as unknown as { scheduleBotActions: (id: string) => void }).scheduleBotActions;
  return { room, engine, agent, server, schedule: () => schedule.call(server, 'test-room') };
}

describe('GameServer bot vote timer recovery (#20)', () => {
  it.each([
    { onTeam: true, expected: true },
    { onTeam: false, expected: false },
  ])('falls back to normal ballot (onTeam=$onTeam)', async ({ onTeam, expected }) => {
    const { room, agent, schedule } = setup({ onTeam });
    schedule();
    await vi.advanceTimersByTimeAsync(3000);
    expect(agent.act).toHaveBeenCalled();
    expect(room.votes.bot).toBe(expected);
    // A human may vote later; bot's vote must remain in the same proposal.
    expect(room.state).toBe('voting');
    room.votes.human = true;
    expect(Object.keys(room.votes)).toHaveLength(2);
  });

  it('retries one failed engine submission without an uncaught timer error', async () => {
    const { room, engine, schedule } = setup({ onTeam: true, failSubmitOnce: true });
    schedule();
    await vi.advanceTimersByTimeAsync(3000);
    expect(engine.submitVote).toHaveBeenCalledTimes(2);
    expect(room.votes.bot).toBe(true);
  });

  it('stops after bounded retries when engine always rejects', async () => {
    const { room, engine, schedule } = setup({ onTeam: false });
    engine.submitVote.mockImplementation(() => { throw new Error('permanent engine failure'); });
    schedule();
    await vi.advanceTimersByTimeAsync(5000);
    expect(engine.submitVote).toHaveBeenCalledTimes(3);
    expect(room.votes.bot).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});


/**
 * Real GameEngine fixture: unlike the synthetic scheduler-only probes above,
 * votes go through GameEngine.submitVote and resolveVoting. Keep timers fake
 * so this does not depend on AFK thresholds or a live server.
 */
function realEngineRoom(): { room: Room; engine: GameEngine } {
  vi.useFakeTimers();
  const players: Record<string, Player> = Object.fromEntries(
    ['bot', 'human1', 'human2', 'human3', 'human4'].map((id) => [
      id,
      {
        id, name: id, role: null, team: null, status: 'active',
        createdAt: Date.now(), isBot: id === 'bot',
      } satisfies Player,
    ]),
  );
  const room: Room = {
    id: 'real-engine-room', name: 'Bot vote regression', host: 'human1',
    state: 'lobby', players, maxPlayers: 10, currentRound: 0, maxRounds: 5,
    votes: {}, questTeam: [], questResults: [], failCount: 0, evilWins: null,
    leaderIndex: 0, voteHistory: [], questHistory: [], questVotedCount: 0,
    roleOptions: {
      percival: true, morgana: true, oberon: true, mordred: true,
      ladyOfTheLake: false,
    },
    readyPlayerIds: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  const engine = new GameEngine(room);
  engine.startGame();
  return { room, engine };
}

describe('post-merge bot vote regression (#20)', () => {
  it('keeps phase scheduling after a committed ballot even if trace and broadcast throw', async () => {
    const { room, engine, server, schedule } = setup({ onTeam: false });
    const submit = engine.submitVote.getMockImplementation()!;
    engine.submitVote.mockImplementation((id, vote) => {
      submit(id, vote);
      room.state = 'quest'; // accepted ballot synchronously resolved the phase
    });

    const next = vi.spyOn(
      server as unknown as { scheduleBotActions: (id: string) => void },
      'scheduleBotActions',
    ).mockImplementation(() => undefined);
    const trace = (server as unknown as { commitPracticeTrace: ReturnType<typeof vi.fn> }).commitPracticeTrace;
    const broadcast = (server as unknown as { broadcastRoomState: ReturnType<typeof vi.fn> }).broadcastRoomState;
    trace.mockImplementation(() => { throw new Error('trace storage unavailable'); });
    broadcast.mockImplementation(() => { throw new Error('broadcast failure'); });

    schedule();
    await vi.advanceTimersByTimeAsync(3000);

    expect(engine.submitVote).toHaveBeenCalledTimes(1);
    expect(room.state).toBe('quest');
    expect(trace).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith('test-room');
  });

  it('does not replay an accepted ballot when the game-end hook throws', async () => {
    const { room, engine, server, schedule } = setup({ onTeam: true });
    const submit = engine.submitVote.getMockImplementation()!;
    engine.submitVote.mockImplementation((id, vote) => {
      submit(id, vote);
      room.state = 'ended';
    });
    const ended = (server as unknown as { onGameEnded: ReturnType<typeof vi.fn> }).onGameEnded;
    ended.mockImplementation(() => { throw new Error('archive unavailable'); });

    schedule();
    await vi.advanceTimersByTimeAsync(3000);

    expect(engine.submitVote).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(room.state).toBe('ended');
  });

  it('a human casting the last ballot resolves a mixed human/bot proposal with real GameEngine', async () => {
    const { room, engine } = realEngineRoom();
    const ids = Object.keys(room.players);
    const humans = ids.filter(id => id !== 'bot');
    const team = ids.slice(0, engine.getEffectiveQuestSizes()[0]);
    engine.selectQuestTeam(team);
    humans.slice(0, 3).forEach(id => engine.submitVote(id, true));

    const server = Object.create(GameServer.prototype) as GameServer;
    const agent = { act: vi.fn(() => { throw new Error('injected team_vote failure'); }) };
    Object.assign(server, {
      roomManager: { getRoom: () => room },
      gameEngines: new Map([[room.id, engine]]),
      botAgents: new Map([['bot', agent]]),
      botDelayScale: 0,
      botVoteRecovery: new Map(),
      isPracticeRoom: () => false,
      broadcastRoomState: vi.fn(),
      commitPracticeTrace: vi.fn(),
      onGameEnded: vi.fn(),
      buildBotObservation: () => ({ currentRound: 1 }),
    });
    const schedule = (server as unknown as { scheduleBotActions: (id: string) => void }).scheduleBotActions;
    schedule.call(server, room.id);
    await vi.advanceTimersByTimeAsync(100);

    expect(agent.act).toHaveBeenCalledTimes(1);
    expect(room.votes.bot).toBe(team.includes('bot'));
    expect(room.state).toBe('voting');
    engine.submitVote(humans[3], true);
    expect(room.state).toBe('quest');
    expect(room.voteHistory).toHaveLength(1);
    expect(room.voteHistory[0].approved).toBe(true);
  });

  it('fifth rejected proposal is forcibly approved by the real GameEngine without a fifth ballot', () => {
    const { room, engine } = realEngineRoom();
    const ids = Object.keys(room.players);
    const team = ids.slice(0, engine.getEffectiveQuestSizes()[0]);

    for (let rejected = 1; rejected <= 4; rejected++) {
      engine.selectQuestTeam(team);
      ids.forEach(id => engine.submitVote(id, false));
      expect(room.state).toBe('voting');
      expect(room.failCount).toBe(rejected);
      expect(room.questTeam).toEqual([]);
    }

    engine.selectQuestTeam(team);
    expect(room.state).toBe('quest');
    expect(room.failCount).toBe(0);
    expect(room.voteHistory).toHaveLength(5);
    expect(room.voteHistory[4].attempt).toBe(5);
    expect(room.voteHistory[4].approved).toBe(true);
    expect(room.voteHistory[4].votes).toEqual(
      Object.fromEntries(ids.map(id => [id, true])),
    );
  });
});
