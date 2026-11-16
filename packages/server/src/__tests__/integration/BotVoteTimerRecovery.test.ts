/**
 * Issue #20: bot voting timers run on their own async stack.
 * These regression probes exercise the real GameServer scheduler with
 * controlled room/engine seams (no network or production deployment).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../../socket/GameServer';

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
  return { room, engine, agent, schedule: () => schedule.call(server, 'test-room') };
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
