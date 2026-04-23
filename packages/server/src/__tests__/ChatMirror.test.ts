import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ChatMirror,
  formatOutgoing,
  validateInboundBody,
  LineAdapter,
  DiscordAdapter,
  DiscordChannelAdapter,
  __resetChatMirrorForTests,
  initializeChatMirror,
  getChatMirror,
} from '../bots/ChatMirror';
import { LobbyChatMessage, LOBBY_CHAT_MAX_LEN } from '../socket/LobbyChatBuffer';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeLobbyMsg(overrides: Partial<LobbyChatMessage> = {}): LobbyChatMessage {
  return {
    id: 'm-1',
    playerId: 'user-1',
    playerName: 'Alice',
    message: 'hi everyone',
    timestamp: Date.now(),
    source: 'lobby',
    ...overrides,
  };
}

type PushCall = { to: string; payload: unknown };

function mockLineAdapter(): { adapter: LineAdapter; calls: PushCall[] } {
  const calls: PushCall[] = [];
  return {
    adapter: {
      pushMessage: async (to, payload) => {
        calls.push({ to, payload });
      },
    },
    calls,
  };
}

type DiscordSendCall = { channelId: string; content: string };

function mockDiscordAdapter(opts: { channelExists?: boolean } = {}): {
  adapter: DiscordAdapter;
  calls: DiscordSendCall[];
} {
  const calls: DiscordSendCall[] = [];
  const exists = opts.channelExists ?? true;
  return {
    adapter: {
      fetchChannel: async (channelId): Promise<DiscordChannelAdapter | null> => {
        if (!exists) return null;
        return {
          send: async (content: string) => {
            calls.push({ channelId, content });
            return { id: 'discord-msg-id' };
          },
        };
      },
    },
    calls,
  };
}

function silentLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
}

// ─── formatOutgoing ───────────────────────────────────────────────────────

describe('formatOutgoing', () => {
  it('renders a regular player message as [Avalon] name: text', () => {
    const out = formatOutgoing(makeLobbyMsg({ playerName: 'Bob', message: 'hey' }));
    expect(out).toBe('[Avalon] Bob: hey');
  });

  it('keeps Guest_### names intact', () => {
    const out = formatOutgoing(
      makeLobbyMsg({ playerName: 'Guest_042', message: 'looking for a game' }),
    );
    expect(out).toBe('[Avalon] Guest_042: looking for a game');
  });

  it('renders system notices without a speaker prefix', () => {
    const out = formatOutgoing(
      makeLobbyMsg({ isSystem: true, message: 'Alice 加入大廳', playerName: 'System' }),
    );
    expect(out).toBe('[Avalon] Alice 加入大廳');
  });

  it('falls back to "Unknown" when playerName is empty', () => {
    const out = formatOutgoing(makeLobbyMsg({ playerName: '   ', message: 'x' }));
    expect(out).toBe('[Avalon] Unknown: x');
  });

  it('truncates extra-long bodies at LOBBY_CHAT_MAX_LEN', () => {
    const huge = 'a'.repeat(LOBBY_CHAT_MAX_LEN + 50);
    const out = formatOutgoing(makeLobbyMsg({ message: huge, playerName: 'X' }));
    expect(out.length).toBeLessThanOrEqual(
      OUT_PREFIX_LEN('X') + LOBBY_CHAT_MAX_LEN,
    );
  });
});

// Helper: prefix length `[Avalon] name: ` — computed at runtime so the test
// stays correct if the prefix changes.
function OUT_PREFIX_LEN(name: string): number {
  return `[Avalon] ${name}: `.length;
}

// ─── validateInboundBody ──────────────────────────────────────────────────

describe('validateInboundBody', () => {
  it('trims whitespace on a valid body', () => {
    expect(validateInboundBody('  hello  ')).toBe('hello');
  });

  it('returns null for empty / whitespace-only / non-string', () => {
    expect(validateInboundBody('')).toBeNull();
    expect(validateInboundBody('   ')).toBeNull();
    expect(validateInboundBody(null)).toBeNull();
    expect(validateInboundBody(undefined)).toBeNull();
    expect(validateInboundBody(42)).toBeNull();
  });

  it('truncates over-long inbound instead of dropping', () => {
    const raw = 'x'.repeat(LOBBY_CHAT_MAX_LEN + 20);
    const out = validateInboundBody(raw);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(LOBBY_CHAT_MAX_LEN);
    expect(out!.endsWith('…')).toBe(true);
  });
});

// ─── fanout — loop safety + platform dispatch ────────────────────────────

describe('ChatMirror.fanout', () => {
  it('pushes to LINE + Discord when configured and source=lobby', async () => {
    const line = mockLineAdapter();
    const discord = mockDiscordAdapter();
    const mirror = new ChatMirror({
      lineGroupId: 'G1',
      discordChannelId: 'C1',
      line: line.adapter,
      discord: discord.adapter,
      logger: silentLogger(),
    });
    await mirror.fanout(makeLobbyMsg({ playerName: 'Alice', message: 'hi' }));
    expect(line.calls).toHaveLength(1);
    expect(line.calls[0].to).toBe('G1');
    expect(line.calls[0].payload).toMatchObject({
      type: 'text',
      text: '[Avalon] Alice: hi',
    });
    expect(discord.calls).toEqual([{ channelId: 'C1', content: '[Avalon] Alice: hi' }]);
  });

  it('does NOT push when source=line (loop prevention)', async () => {
    const line = mockLineAdapter();
    const discord = mockDiscordAdapter();
    const mirror = new ChatMirror({
      lineGroupId: 'G1',
      discordChannelId: 'C1',
      line: line.adapter,
      discord: discord.adapter,
      logger: silentLogger(),
    });
    await mirror.fanout(makeLobbyMsg({ source: 'line', message: 'echo' }));
    expect(line.calls).toEqual([]);
    expect(discord.calls).toEqual([]);
  });

  it('does NOT push when source=discord (loop prevention)', async () => {
    const line = mockLineAdapter();
    const discord = mockDiscordAdapter();
    const mirror = new ChatMirror({
      lineGroupId: 'G1',
      discordChannelId: 'C1',
      line: line.adapter,
      discord: discord.adapter,
      logger: silentLogger(),
    });
    await mirror.fanout(makeLobbyMsg({ source: 'discord', message: 'echo' }));
    expect(line.calls).toEqual([]);
    expect(discord.calls).toEqual([]);
  });

  it('treats source=undefined as lobby (back-compat with #63 messages)', async () => {
    const line = mockLineAdapter();
    const mirror = new ChatMirror({
      lineGroupId: 'G1',
      line: line.adapter,
      logger: silentLogger(),
    });
    const msg = makeLobbyMsg();
    delete msg.source;
    await mirror.fanout(msg);
    expect(line.calls).toHaveLength(1);
  });

  it('skips LINE when lineGroupId is empty, still pushes Discord', async () => {
    const line = mockLineAdapter();
    const discord = mockDiscordAdapter();
    const mirror = new ChatMirror({
      lineGroupId: '',
      discordChannelId: 'C1',
      line: line.adapter,
      discord: discord.adapter,
      logger: silentLogger(),
    });
    await mirror.fanout(makeLobbyMsg({ message: 'solo' }));
    expect(line.calls).toEqual([]);
    expect(discord.calls).toHaveLength(1);
  });

  it('skips Discord when channelId is empty, still pushes LINE', async () => {
    const line = mockLineAdapter();
    const discord = mockDiscordAdapter();
    const mirror = new ChatMirror({
      lineGroupId: 'G1',
      discordChannelId: '',
      line: line.adapter,
      discord: discord.adapter,
      logger: silentLogger(),
    });
    await mirror.fanout(makeLobbyMsg({ message: 'solo' }));
    expect(line.calls).toHaveLength(1);
    expect(discord.calls).toEqual([]);
  });

  it('is a complete no-op when nothing is configured', async () => {
    const line = mockLineAdapter();
    const discord = mockDiscordAdapter();
    const mirror = new ChatMirror({ logger: silentLogger() });
    await mirror.fanout(makeLobbyMsg());
    expect(line.calls).toEqual([]);
    expect(discord.calls).toEqual([]);
  });

  it('swallows LINE push errors and still attempts Discord', async () => {
    const line: LineAdapter = {
      pushMessage: async () => {
        throw new Error('line is down');
      },
    };
    const discord = mockDiscordAdapter();
    const logger = silentLogger();
    const mirror = new ChatMirror({
      lineGroupId: 'G1',
      discordChannelId: 'C1',
      line,
      discord: discord.adapter,
      logger,
    });
    await expect(mirror.fanout(makeLobbyMsg())).resolves.toBeUndefined();
    expect(discord.calls).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('logs a warning when Discord channel is missing, does not throw', async () => {
    const discord = mockDiscordAdapter({ channelExists: false });
    const logger = silentLogger();
    const mirror = new ChatMirror({
      discordChannelId: 'missing',
      discord: discord.adapter,
      logger,
    });
    await expect(mirror.fanout(makeLobbyMsg())).resolves.toBeUndefined();
    expect(discord.calls).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Discord channel missing unavailable'),
    );
  });
});

// ─── crossFanout — LINE ↔ Discord cross-platform ─────────────────────────

describe('ChatMirror.crossFanout', () => {
  it('pushes LINE-origin message only to Discord (not back to LINE)', async () => {
    const line = mockLineAdapter();
    const discord = mockDiscordAdapter();
    const mirror = new ChatMirror({
      lineGroupId: 'G1',
      discordChannelId: 'C1',
      line: line.adapter,
      discord: discord.adapter,
      logger: silentLogger(),
    });
    await mirror.crossFanout(
      makeLobbyMsg({ source: 'line', playerName: 'Alice', message: 'hi' }),
    );
    expect(line.calls).toEqual([]);
    expect(discord.calls).toEqual([
      { channelId: 'C1', content: '[Avalon] Alice: hi' },
    ]);
  });

  it('pushes Discord-origin message only to LINE (not back to Discord)', async () => {
    const line = mockLineAdapter();
    const discord = mockDiscordAdapter();
    const mirror = new ChatMirror({
      lineGroupId: 'G1',
      discordChannelId: 'C1',
      line: line.adapter,
      discord: discord.adapter,
      logger: silentLogger(),
    });
    await mirror.crossFanout(
      makeLobbyMsg({ source: 'discord', playerName: 'Bob', message: 'yo' }),
    );
    expect(discord.calls).toEqual([]);
    expect(line.calls).toHaveLength(1);
    expect(line.calls[0].to).toBe('G1');
    expect(line.calls[0].payload).toMatchObject({
      type: 'text',
      text: '[Avalon] Bob: yo',
    });
  });

  it('pushes lobby-origin message to both (same as fanout)', async () => {
    const line = mockLineAdapter();
    const discord = mockDiscordAdapter();
    const mirror = new ChatMirror({
      lineGroupId: 'G1',
      discordChannelId: 'C1',
      line: line.adapter,
      discord: discord.adapter,
      logger: silentLogger(),
    });
    await mirror.crossFanout(makeLobbyMsg({ source: 'lobby' }));
    expect(line.calls).toHaveLength(1);
    expect(discord.calls).toHaveLength(1);
  });

  it('is a no-op when the receiving platform is unconfigured', async () => {
    const line = mockLineAdapter();
    // Mirror configured for LINE only; Discord-origin → LINE push
    const mirror = new ChatMirror({
      lineGroupId: 'G1',
      line: line.adapter,
      logger: silentLogger(),
    });
    await mirror.crossFanout(makeLobbyMsg({ source: 'discord' }));
    expect(line.calls).toHaveLength(1);

    const discord = mockDiscordAdapter();
    // Mirror configured for Discord only; LINE-origin → Discord push
    const mirror2 = new ChatMirror({
      discordChannelId: 'C1',
      discord: discord.adapter,
      logger: silentLogger(),
    });
    await mirror2.crossFanout(makeLobbyMsg({ source: 'line' }));
    expect(discord.calls).toHaveLength(1);
  });

  it('swallows platform errors (loop-safe + never throws into webhook)', async () => {
    const line: LineAdapter = {
      pushMessage: async () => {
        throw new Error('line is down');
      },
    };
    const logger = silentLogger();
    const mirror = new ChatMirror({
      lineGroupId: 'G1',
      line,
      logger,
    });
    await expect(
      mirror.crossFanout(makeLobbyMsg({ source: 'discord' })),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

// ─── ingestInbound (Phase B groundwork) ──────────────────────────────────

describe('ChatMirror.ingestInbound', () => {
  it('calls the lobby ingest with a source-tagged message', () => {
    const mirror = new ChatMirror({ logger: silentLogger() });
    const sink: LobbyChatMessage[] = [];
    mirror.setLobbyIngest((m) => sink.push(m));

    const result = mirror.ingestInbound({
      source: 'line',
      platformUserId: 'U-line-1',
      displayName: 'LINE User',
      text: '  hello from line  ',
      messageId: 'line-abc',
    });

    expect(result).not.toBeNull();
    expect(sink).toHaveLength(1);
    expect(sink[0].source).toBe('line');
    expect(sink[0].playerId).toBe('line:U-line-1');
    expect(sink[0].playerName).toBe('LINE User');
    expect(sink[0].message).toBe('hello from line');
    expect(sink[0].id).toBe('line-abc');
  });

  it('rejects source=lobby with a warning', () => {
    const logger = silentLogger();
    const mirror = new ChatMirror({ logger });
    mirror.setLobbyIngest(() => undefined);

    const result = mirror.ingestInbound({
      source: 'lobby',
      platformUserId: 'x',
      displayName: 'x',
      text: 'x',
      messageId: 'x',
    });
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns null before setLobbyIngest wires a sink', () => {
    const logger = silentLogger();
    const mirror = new ChatMirror({ logger });
    const result = mirror.ingestInbound({
      source: 'line',
      platformUserId: 'x',
      displayName: 'x',
      text: 'hi',
      messageId: 'x',
    });
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('before setLobbyIngest'),
    );
  });

  it('rejects invalid bodies', () => {
    const mirror = new ChatMirror({ logger: silentLogger() });
    mirror.setLobbyIngest(() => undefined);

    expect(
      mirror.ingestInbound({
        source: 'discord',
        platformUserId: 'u',
        displayName: 'u',
        text: '   ',
        messageId: 'x',
      }),
    ).toBeNull();

    expect(
      mirror.ingestInbound({
        source: 'discord',
        platformUserId: 'u',
        displayName: 'u',
        text: 123,
        messageId: 'x',
      }),
    ).toBeNull();
  });

  it('rate-limits a single user within the window', () => {
    const mirror = new ChatMirror({
      inboundRateLimit: { windowMs: 60_000, maxRequests: 2 },
      logger: silentLogger(),
    });
    const sink: LobbyChatMessage[] = [];
    mirror.setLobbyIngest((m) => sink.push(m));

    const common = {
      source: 'line' as const,
      platformUserId: 'U-spam',
      displayName: 'Spammer',
    };

    expect(
      mirror.ingestInbound({ ...common, text: '1', messageId: 'a' }),
    ).not.toBeNull();
    expect(
      mirror.ingestInbound({ ...common, text: '2', messageId: 'b' }),
    ).not.toBeNull();
    expect(
      mirror.ingestInbound({ ...common, text: '3', messageId: 'c' }),
    ).toBeNull();
    expect(sink).toHaveLength(2);
  });

  it('tracks rate limits separately per platform user', () => {
    const mirror = new ChatMirror({
      inboundRateLimit: { windowMs: 60_000, maxRequests: 1 },
      logger: silentLogger(),
    });
    mirror.setLobbyIngest(() => undefined);

    expect(
      mirror.ingestInbound({
        source: 'line',
        platformUserId: 'A',
        displayName: 'A',
        text: 'hi',
        messageId: 'a',
      }),
    ).not.toBeNull();
    expect(
      mirror.ingestInbound({
        source: 'line',
        platformUserId: 'B',
        displayName: 'B',
        text: 'hi',
        messageId: 'b',
      }),
    ).not.toBeNull();
    expect(
      mirror.ingestInbound({
        source: 'line',
        platformUserId: 'A',
        displayName: 'A',
        text: 'hi-again',
        messageId: 'a2',
      }),
    ).toBeNull();
  });

  it('falls back to a platform-scoped name when displayName is empty', () => {
    const mirror = new ChatMirror({ logger: silentLogger() });
    const sink: LobbyChatMessage[] = [];
    mirror.setLobbyIngest((m) => sink.push(m));

    mirror.ingestInbound({
      source: 'discord',
      platformUserId: 'U',
      displayName: '',
      text: 'hey',
      messageId: 'x',
    });

    expect(sink[0].playerName).toBe('discord-user');
  });

  it('logs + returns null when the ingest callback throws', () => {
    const logger = silentLogger();
    const mirror = new ChatMirror({ logger });
    mirror.setLobbyIngest(() => {
      throw new Error('ring buffer exploded');
    });

    const result = mirror.ingestInbound({
      source: 'line',
      platformUserId: 'U',
      displayName: 'U',
      text: 'hi',
      messageId: 'x',
    });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      'lobbyIngest threw',
      expect.any(Error),
    );
  });
});

// ─── Singleton wiring ────────────────────────────────────────────────────

describe('ChatMirror singleton', () => {
  beforeEach(() => {
    __resetChatMirrorForTests();
  });

  it('initializes once and returns the same instance', () => {
    const a = initializeChatMirror({ logger: silentLogger() });
    const b = initializeChatMirror({ logger: silentLogger() });
    expect(a).toBe(b);
    expect(getChatMirror()).toBe(a);
  });

  it('returns null before initialize', () => {
    expect(getChatMirror()).toBeNull();
  });
});
