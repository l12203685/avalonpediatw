/**
 * AsyncNotifier (棋瓦 P2) — unit tests
 *
 * Covers:
 *   - notify() pings only Discord/LINE players in pendingActors
 *   - throttle: same (room, phase, round, attempt, playerId) does not re-ping
 *   - phase change (round / attempt bump) reopens the throttle window
 *   - notify() is a no-op for realtime rooms
 *   - notify() is a no-op for empty pendingActors
 *   - notifyGameEnded() pings ALL players exactly once
 *   - per-channel failures do not break sibling channels
 *   - missing player in room.players is logged and skipped
 *   - format helpers render the expected Chinese body with [查看局面] link
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AsyncNotifier,
  formatPendingMessage,
  formatGameEndedMessage,
  __resetAsyncNotifierForTests,
  initializeAsyncNotifier,
  getAsyncNotifier,
  type DiscordDmAdapter,
  type LineDirectAdapter,
} from '../services/AsyncNotifier';
import type { Room, Player, PendingDecision } from '@avalon/shared';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makePlayer(overrides: Partial<Player> & { id: string }): Player {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    role: overrides.role,
    team: overrides.team,
    status: overrides.status ?? 'active',
    ...overrides,
  } as Player;
}

function makeRoom(overrides: Partial<Room> & { id: string; players: Record<string, Player> }): Room {
  return {
    id: overrides.id,
    name: overrides.name ?? `room-${overrides.id}`,
    host: overrides.host ?? Object.keys(overrides.players)[0] ?? '',
    state: overrides.state ?? 'voting',
    players: overrides.players,
    maxPlayers: overrides.maxPlayers ?? 5,
    currentRound: overrides.currentRound ?? 1,
    maxRounds: overrides.maxRounds ?? 5,
    votes: overrides.votes ?? {},
    questTeam: overrides.questTeam ?? [],
    questResults: overrides.questResults ?? [],
    failCount: overrides.failCount ?? 0,
    evilWins: overrides.evilWins ?? null,
    leaderIndex: overrides.leaderIndex ?? 0,
    voteHistory: overrides.voteHistory ?? [],
    questHistory: overrides.questHistory ?? [],
    questVotedCount: overrides.questVotedCount ?? 0,
    roleOptions: overrides.roleOptions ?? {
      percival: false,
      morgana: false,
      oberon: false,
      mordred: false,
    },
    readyPlayerIds: overrides.readyPlayerIds ?? [],
    mode: overrides.mode,
    pending: overrides.pending,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  } as Room;
}

function makePending(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    phase: overrides.phase ?? 'voting',
    round: overrides.round ?? 1,
    attempt: overrides.attempt ?? 1,
    pendingActors: overrides.pendingActors ?? [],
    submittedActors: overrides.submittedActors ?? [],
    openedAt: overrides.openedAt ?? Date.now(),
  };
}

interface DiscordCall { userId: string; text: string }
function mockDiscord(opts: { failFor?: string[] } = {}): { adapter: DiscordDmAdapter; calls: DiscordCall[] } {
  const calls: DiscordCall[] = [];
  return {
    adapter: {
      sendDm: async (userId, text) => {
        if (opts.failFor?.includes(userId)) {
          throw new Error(`mock discord failure for ${userId}`);
        }
        calls.push({ userId, text });
      },
    },
    calls,
  };
}

interface LineCall { userId: string; text: string }
function mockLine(opts: { failFor?: string[] } = {}): { adapter: LineDirectAdapter; calls: LineCall[] } {
  const calls: LineCall[] = [];
  return {
    adapter: {
      pushDirect: async (userId, text) => {
        if (opts.failFor?.includes(userId)) {
          throw new Error(`mock line failure for ${userId}`);
        }
        calls.push({ userId, text });
      },
    },
    calls,
  };
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ─── notify() ──────────────────────────────────────────────────────────────

describe('AsyncNotifier.notify', () => {
  beforeEach(() => {
    __resetAsyncNotifierForTests();
  });

  it('pings Discord and LINE players in pendingActors', async () => {
    const discord = mockDiscord();
    const line = mockLine();
    const notifier = new AsyncNotifier({
      discord: discord.adapter,
      line: line.adapter,
      webBaseUrl: 'https://example.test',
      logger: silentLogger(),
    });

    const room = makeRoom({
      id: 'ABCDE',
      mode: 'async',
      players: {
        'discord:111': makePlayer({ id: 'discord:111', name: 'Alice' }),
        'line:222': makePlayer({ id: 'line:222', name: 'Bob' }),
        'web:333': makePlayer({ id: 'web:333', name: 'Charlie' }),
      },
    });
    const pending = makePending({ pendingActors: ['discord:111', 'line:222', 'web:333'] });

    const result = await notifier.notify(room, pending);

    expect(result.pinged).toBe(2); // discord + line; web has no channel
    expect(result.skipped).toBe(1); // web player has no out-of-band channel
    expect(discord.calls).toHaveLength(1);
    expect(discord.calls[0].userId).toBe('111');
    expect(discord.calls[0].text).toContain('棋瓦 ABCDE');
    expect(line.calls).toHaveLength(1);
    expect(line.calls[0].userId).toBe('222');
  });

  it('is a no-op for realtime rooms', async () => {
    const discord = mockDiscord();
    const notifier = new AsyncNotifier({
      discord: discord.adapter,
      line: null,
      logger: silentLogger(),
    });
    const room = makeRoom({
      id: 'RT',
      mode: 'realtime',
      players: { 'discord:111': makePlayer({ id: 'discord:111' }) },
    });
    const result = await notifier.notify(room, makePending({ pendingActors: ['discord:111'] }));
    expect(result.pinged).toBe(0);
    expect(discord.calls).toHaveLength(0);
  });

  it('is a no-op for empty pendingActors', async () => {
    const discord = mockDiscord();
    const notifier = new AsyncNotifier({
      discord: discord.adapter,
      line: null,
      logger: silentLogger(),
    });
    const room = makeRoom({
      id: 'EMPTY',
      mode: 'async',
      players: { 'discord:111': makePlayer({ id: 'discord:111' }) },
    });
    const result = await notifier.notify(room, makePending({ pendingActors: [] }));
    expect(result.pinged).toBe(0);
    expect(discord.calls).toHaveLength(0);
  });

  it('throttles: same (room, phase, round, attempt, playerId) does not re-ping', async () => {
    const discord = mockDiscord();
    const notifier = new AsyncNotifier({
      discord: discord.adapter,
      line: null,
      logger: silentLogger(),
    });
    const room = makeRoom({
      id: 'THR',
      mode: 'async',
      players: { 'discord:111': makePlayer({ id: 'discord:111' }) },
    });
    const pending = makePending({ pendingActors: ['discord:111'] });

    const r1 = await notifier.notify(room, pending);
    expect(r1.pinged).toBe(1);
    const r2 = await notifier.notify(room, pending);
    expect(r2.pinged).toBe(0);
    expect(r2.throttled).toBe(1);
    expect(discord.calls).toHaveLength(1);
  });

  it('phase change (round/attempt bump) reopens the throttle window', async () => {
    const discord = mockDiscord();
    const notifier = new AsyncNotifier({
      discord: discord.adapter,
      line: null,
      logger: silentLogger(),
    });
    const room = makeRoom({
      id: 'BUMP',
      mode: 'async',
      players: { 'discord:111': makePlayer({ id: 'discord:111' }) },
    });

    const p1 = makePending({ pendingActors: ['discord:111'], round: 1, attempt: 1 });
    await notifier.notify(room, p1);
    expect(discord.calls).toHaveLength(1);

    const p2 = makePending({ pendingActors: ['discord:111'], round: 1, attempt: 2 });
    await notifier.notify(room, p2);
    expect(discord.calls).toHaveLength(2);

    const p3 = makePending({ pendingActors: ['discord:111'], round: 2, attempt: 1 });
    await notifier.notify(room, p3);
    expect(discord.calls).toHaveLength(3);
  });

  it('per-channel failure does not break sibling channels', async () => {
    const discord = mockDiscord({ failFor: ['111'] });
    const line = mockLine();
    const notifier = new AsyncNotifier({
      discord: discord.adapter,
      line: line.adapter,
      logger: silentLogger(),
    });
    const room = makeRoom({
      id: 'FAIL',
      mode: 'async',
      players: {
        // Player has BOTH discord and line — but here they only have one id.
        // Test the cross-player isolation instead:
        'discord:111': makePlayer({ id: 'discord:111' }),
        'line:222': makePlayer({ id: 'line:222' }),
      },
    });
    const result = await notifier.notify(room, makePending({ pendingActors: ['discord:111', 'line:222'] }));
    // Discord failed for 111; LINE succeeded for 222.
    expect(line.calls).toHaveLength(1);
    expect(discord.calls).toHaveLength(0);
    expect(result.pinged).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('skips when actor missing from room.players', async () => {
    const logger = silentLogger();
    const discord = mockDiscord();
    const notifier = new AsyncNotifier({
      discord: discord.adapter,
      line: null,
      logger,
    });
    const room = makeRoom({
      id: 'MISS',
      mode: 'async',
      players: { 'discord:111': makePlayer({ id: 'discord:111' }) },
    });
    const result = await notifier.notify(room, makePending({ pendingActors: ['discord:999'] }));
    expect(result.pinged).toBe(0);
    expect(result.skipped).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ─── notifyGameEnded() ─────────────────────────────────────────────────────

describe('AsyncNotifier.notifyGameEnded', () => {
  beforeEach(() => {
    __resetAsyncNotifierForTests();
  });

  it('pings every player exactly once', async () => {
    const discord = mockDiscord();
    const line = mockLine();
    const notifier = new AsyncNotifier({
      discord: discord.adapter,
      line: line.adapter,
      logger: silentLogger(),
    });
    const room = makeRoom({
      id: 'END',
      mode: 'async',
      state: 'ended',
      evilWins: false,
      players: {
        'discord:111': makePlayer({ id: 'discord:111' }),
        'line:222': makePlayer({ id: 'line:222' }),
      },
    });
    const result = await notifier.notifyGameEnded(room);
    expect(result.pinged).toBe(2);
    expect(discord.calls[0].text).toContain('好人獲勝');
    expect(line.calls[0].text).toContain('好人獲勝');

    // Re-firing is throttled.
    const again = await notifier.notifyGameEnded(room);
    expect(again.throttled).toBe(1);
    expect(discord.calls).toHaveLength(1);
  });

  it('is a no-op for realtime rooms', async () => {
    const discord = mockDiscord();
    const notifier = new AsyncNotifier({
      discord: discord.adapter,
      line: null,
      logger: silentLogger(),
    });
    const room = makeRoom({
      id: 'RT-END',
      mode: 'realtime',
      state: 'ended',
      players: { 'discord:111': makePlayer({ id: 'discord:111' }) },
    });
    const result = await notifier.notifyGameEnded(room);
    expect(result.pinged).toBe(0);
    expect(discord.calls).toHaveLength(0);
  });
});

// ─── format helpers ───────────────────────────────────────────────────────

describe('formatPendingMessage', () => {
  it('renders the Chinese body with the [查看局面] URL', () => {
    const room = makeRoom({
      id: 'FMT',
      mode: 'async',
      players: { 'discord:111': makePlayer({ id: 'discord:111' }) },
      questTeam: ['a', 'b'],
    });
    const out = formatPendingMessage(
      room,
      makePending({ phase: 'voting', round: 2, pendingActors: ['discord:111'] }),
      'https://example.test',
    );
    expect(out).toContain('棋瓦 FMT');
    expect(out).toContain('第 2 任務');
    expect(out).toContain('隊伍投票');
    expect(out).toContain('https://example.test/room/FMT');
  });

  it('uses 隊長選人 label when questTeam is empty', () => {
    const room = makeRoom({
      id: 'TS',
      mode: 'async',
      players: {},
      questTeam: [],
    });
    const out = formatPendingMessage(
      room,
      makePending({ phase: 'voting' }),
      'https://example.test',
    );
    expect(out).toContain('隊長選人');
  });

  it('renders quest/lady/discussion phase labels', () => {
    const room = makeRoom({ id: 'P', mode: 'async', players: {} });
    expect(
      formatPendingMessage(room, makePending({ phase: 'quest' }), 'http://x'),
    ).toContain('任務投票');
    expect(
      formatPendingMessage(room, makePending({ phase: 'lady_of_the_lake' }), 'http://x'),
    ).toContain('湖中女神');
    expect(
      formatPendingMessage(room, makePending({ phase: 'discussion' }), 'http://x'),
    ).toContain('刺殺梅林');
  });
});

describe('formatGameEndedMessage', () => {
  it('renders 好人獲勝 / 邪惡獲勝 / 局終 by evilWins', () => {
    const base: Partial<Room> = {
      id: 'END',
      mode: 'async',
      state: 'ended',
      players: {},
    };
    expect(
      formatGameEndedMessage(makeRoom({ ...base, evilWins: false } as unknown as Room), 'http://x'),
    ).toContain('好人獲勝');
    expect(
      formatGameEndedMessage(makeRoom({ ...base, evilWins: true } as unknown as Room), 'http://x'),
    ).toContain('邪惡獲勝');
    expect(
      formatGameEndedMessage(makeRoom({ ...base, evilWins: null } as unknown as Room), 'http://x'),
    ).toContain('局終');
  });
});

// ─── singleton ────────────────────────────────────────────────────────────

describe('AsyncNotifier singleton', () => {
  beforeEach(() => {
    __resetAsyncNotifierForTests();
  });

  it('initialize is idempotent', () => {
    const a = initializeAsyncNotifier({ discord: null, line: null });
    const b = initializeAsyncNotifier({ discord: null, line: null });
    expect(a).toBe(b);
    expect(getAsyncNotifier()).toBe(a);
  });

  it('getAsyncNotifier returns null before init', () => {
    expect(getAsyncNotifier()).toBeNull();
  });
});
