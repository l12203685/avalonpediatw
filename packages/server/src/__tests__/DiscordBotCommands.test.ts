/**
 * Unit tests for the Discord bot command handlers.
 *
 * Coverage:
 *
 *   1. `buildGameJoinUrl` throws in production when WEB_BASE_URL is missing
 *      (no more silent localhost fallback on live Render) — PR#8.
 *   2. Game-flow commands (/create /join /start /status /vote /quest
 *      /assassinate /end) only reply with the signage-cloud play URL and never
 *      create, join or end a room on this server — 2026-10-09 owner decision
 *      (games are played on signage-cloud). /help points there too.
 *   3. `roleReveal` correctly computes role knowledge for Merlin (evil
 *      minus Mordred/Oberon), Percival (Merlin+Morgana sorted), evil-
 *      minus-Oberon (other evil minus Oberon), and Oberon (sees nothing,
 *      seen by no one) — PR#4 bot-full.
 *
 * The tests mock the CommandInteraction surface instead of pulling in the
 * full discord.js runtime — we only exercise the code paths in our own
 * command handlers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { PLAY_PLATFORM_URL } from '@avalon/shared';
import type { Room, Player, Role } from '@avalon/shared';

import { buildGameJoinUrl } from '../bots/discord/invite';
import { COMMANDS, PLAY_PLATFORM_COMMANDS } from '../bots/discord/config';
import {
  buildPlayPlatformMessage,
  handleHelpCommand,
  handlePlayPlatformCommand,
} from '../bots/discord/commands';
import {
  buildRoleRevealEmbed,
  computeKnownEvils,
  computePercivalWizards,
  extractDiscordUserId,
} from '../bots/discord/roleReveal';
import { RoomManager } from '../game/RoomManager';
import {
  getSharedRoomManager,
  setSharedRoomManager,
} from '../game/roomManagerSingleton';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeInteraction {
  commandName: string;
  user: { id: string; username: string; displayName?: string };
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  replied: boolean;
  deferred: boolean;
  options: {
    getString: (_: string) => string;
  };
}

function makeInteraction(userId: string, commandName = COMMANDS.HELP): FakeInteraction {
  const fake: FakeInteraction = {
    commandName,
    user: { id: userId, username: `user-${userId}`, displayName: `User ${userId}` },
    deferReply: vi.fn(async () => {
      fake.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {
      fake.replied = true;
    }),
    followUp: vi.fn(async () => {}),
    replied: false,
    deferred: false,
    options: { getString: () => '' },
  };
  return fake;
}

// ---------------------------------------------------------------------------
// buildGameJoinUrl
// ---------------------------------------------------------------------------

describe('buildGameJoinUrl', () => {
  const originalBaseUrl = process.env.WEB_BASE_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.WEB_BASE_URL;
    else process.env.WEB_BASE_URL = originalBaseUrl;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('uses WEB_BASE_URL when set', () => {
    process.env.WEB_BASE_URL = 'https://play.example.com';
    expect(buildGameJoinUrl('abc')).toBe('https://play.example.com/game/abc');
  });

  it('falls back to localhost in development when WEB_BASE_URL is unset', () => {
    delete process.env.WEB_BASE_URL;
    process.env.NODE_ENV = 'development';
    expect(buildGameJoinUrl('abc')).toBe('http://localhost:3000/game/abc');
  });

  it('throws in production when WEB_BASE_URL is unset (no silent localhost)', () => {
    delete process.env.WEB_BASE_URL;
    process.env.NODE_ENV = 'production';
    expect(() => buildGameJoinUrl('abc')).toThrow(/WEB_BASE_URL/);
  });
});

// ---------------------------------------------------------------------------
// Game-flow commands → signage-cloud pointer (2026-10-09)
// ---------------------------------------------------------------------------

describe('PLAY_PLATFORM_URL', () => {
  it('is the signage-cloud login page the community plays on', () => {
    expect(PLAY_PLATFORM_URL).toBe('https://avalon.signage-cloud.org/Account/Login');
  });
});

describe('Discord bot: game-flow commands point to signage-cloud', () => {
  let rm: RoomManager;
  const userId = 'u-1';
  const discordPlayerId = `discord:${userId}`;

  beforeEach(() => {
    rm = new RoomManager();
    setSharedRoomManager(rm);
  });

  afterEach(() => {
    rm.destroy();
  });

  it('covers exactly the self-hosted game-flow commands (not /help /rules /roles)', () => {
    expect([...PLAY_PLATFORM_COMMANDS].sort()).toEqual(
      ['assassinate', 'create', 'end', 'join', 'quest', 'start', 'status', 'vote'],
    );
    for (const kept of [COMMANDS.HELP, COMMANDS.RULES, COMMANDS.ROLES]) {
      expect(PLAY_PLATFORM_COMMANDS).not.toContain(kept);
    }
  });

  it('buildPlayPlatformMessage names the command and carries the play URL', () => {
    const msg = buildPlayPlatformMessage('create');
    expect(msg).toContain(PLAY_PLATFORM_URL);
    expect(msg).toContain('/create');
    expect(msg).toContain('signage-cloud');
  });

  it.each([...PLAY_PLATFORM_COMMANDS])(
    '/%s: replies ephemerally with the play URL and creates no room',
    async (commandName) => {
      const interaction = makeInteraction(userId, commandName);

      await handlePlayPlatformCommand(interaction as never);

      expect(interaction.reply).toHaveBeenCalledTimes(1);
      const [payload] = interaction.reply.mock.calls[0];
      expect(payload).toMatchObject({
        content: expect.stringContaining(PLAY_PLATFORM_URL),
        flags: MessageFlags.Ephemeral,
      });
      expect(payload.content).toContain(`/${commandName}`);
      expect(interaction.editReply).not.toHaveBeenCalled();
      expect(rm.getRoomCount()).toBe(0);
    },
  );

  it.each([...PLAY_PLATFORM_COMMANDS])(
    '/%s: leaves an existing room on this server untouched',
    async (commandName) => {
      const room = rm.createRoom('r1', 'Host', discordPlayerId);
      const before = JSON.stringify(room);

      const interaction = makeInteraction(userId, commandName);
      await handlePlayPlatformCommand(interaction as never);

      expect(rm.getRoomCount()).toBe(1);
      expect(JSON.stringify(rm.getRoom('r1'))).toBe(before);
      expect(interaction.reply.mock.calls[0][0].content).toContain(PLAY_PLATFORM_URL);
    },
  );

  it('/help: points to the play URL and still lists /rules and /roles', async () => {
    const interaction = makeInteraction(userId, COMMANDS.HELP);

    await handleHelpCommand(interaction as never);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const [payload] = interaction.editReply.mock.calls[0];
    const json = payload.embeds[0].toJSON();
    expect(json.description).toContain(PLAY_PLATFORM_URL);
    const names = (json.fields ?? []).map((f: { name: string }) => f.name);
    expect(names).toContain(`/${COMMANDS.RULES}`);
    expect(names).toContain(`/${COMMANDS.ROLES}`);
    // Game-flow commands are no longer advertised as standalone entries.
    expect(names).not.toContain(`/${COMMANDS.CREATE}`);
    expect(names).not.toContain(`/${COMMANDS.JOIN} <room-id>`);
  });
});

// ---------------------------------------------------------------------------
// Singleton sanity
// ---------------------------------------------------------------------------

describe('roomManagerSingleton', () => {
  it('returns the RoomManager instance after setSharedRoomManager', () => {
    const rm = new RoomManager();
    setSharedRoomManager(rm);
    expect(getSharedRoomManager()).toBe(rm);
    rm.destroy();
  });
});

// ---------------------------------------------------------------------------
// Role reveal — knowledge computation
// ---------------------------------------------------------------------------

/**
 * Build a canonical fixture room with N players. Roles are assigned in the
 * order given so tests can pin specific IDs to specific roles.
 */
function makeStartedRoom(roomId: string, playerRoles: Array<[string, string, Role]>): Room {
  const players: Record<string, Player> = {};
  for (const [playerId, name, role] of playerRoles) {
    players[playerId] = {
      id: playerId,
      name,
      role,
      team: ['merlin', 'percival', 'loyal'].includes(role) ? 'good' : 'evil',
      status: 'active',
      createdAt: Date.now(),
    };
  }
  return {
    id: roomId,
    name: `Room ${roomId}`,
    host: playerRoles[0][0],
    state: 'voting',
    players,
    maxPlayers: 10,
    currentRound: 1,
    maxRounds: 5,
    votes: {},
    questTeam: [],
    questResults: [],
    failCount: 0,
    evilWins: null,
    leaderIndex: 0,
    voteHistory: [],
    questHistory: [],
    questVotedCount: 0,
    roleOptions: { percival: true, morgana: true, oberon: true, mordred: true, ladyOfTheLake: false },
    readyPlayerIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('roleReveal: extractDiscordUserId', () => {
  it('strips the "discord:" prefix', () => {
    expect(extractDiscordUserId('discord:123')).toBe('123');
  });

  it('returns null for non-discord player ids', () => {
    expect(extractDiscordUserId('web-42')).toBeNull();
    expect(extractDiscordUserId('firebase:abc')).toBeNull();
  });

  it('returns null when the prefix is present but the id is empty', () => {
    expect(extractDiscordUserId('discord:')).toBeNull();
  });
});

describe('roleReveal: computeKnownEvils — canonical 5-player', () => {
  // 5p: merlin + percival + loyal + morgana + assassin
  const room = makeStartedRoom('5p', [
    ['discord:merlin-1', 'Merlin', 'merlin'],
    ['discord:perc-1', 'Percival', 'percival'],
    ['discord:loyal-1', 'Loyal', 'loyal'],
    ['discord:morg-1', 'Morgana', 'morgana'],
    ['discord:assn-1', 'Assassin', 'assassin'],
  ]);

  it('Merlin sees both evil (no mordred/oberon in 5p)', () => {
    const merlin = room.players['discord:merlin-1'];
    const known = computeKnownEvils(merlin, room);
    expect(new Set(known)).toEqual(new Set(['discord:morg-1', 'discord:assn-1']));
  });

  it('Assassin sees Morgana (other evil)', () => {
    const assassin = room.players['discord:assn-1'];
    const known = computeKnownEvils(assassin, room);
    expect(known).toEqual(['discord:morg-1']);
  });

  it('Percival sees Merlin+Morgana (scrambled, sorted by name)', () => {
    const perc = room.players['discord:perc-1'];
    const wizards = computePercivalWizards(perc, room);
    expect(new Set(wizards)).toEqual(new Set(['discord:merlin-1', 'discord:morg-1']));
    expect(wizards).toHaveLength(2);
  });

  it('Loyal sees nothing', () => {
    const loyal = room.players['discord:loyal-1'];
    expect(computeKnownEvils(loyal, room)).toEqual([]);
    expect(computePercivalWizards(loyal, room)).toEqual([]);
  });
});

describe('roleReveal: computeKnownEvils — 7-player with Oberon', () => {
  // 7p: merlin + percival + loyal*2 + morgana + assassin + oberon
  const room = makeStartedRoom('7p-ob', [
    ['discord:m', 'Merlin', 'merlin'],
    ['discord:p', 'Percival', 'percival'],
    ['discord:l1', 'Loyal-1', 'loyal'],
    ['discord:l2', 'Loyal-2', 'loyal'],
    ['discord:morg', 'Morgana', 'morgana'],
    ['discord:assn', 'Assassin', 'assassin'],
    ['discord:ob', 'Oberon', 'oberon'],
  ]);

  it('Merlin sees Morgana+Assassin AND Oberon (Edward 2026-04-26 spec)', () => {
    // Edward 2026-04-26 00:22 spec: Merlin sees ALL evil except Mordred.
    // Oberon IS visible to Merlin (canonical Avalon thumbs-up rule).
    const merlin = room.players['discord:m'];
    const known = computeKnownEvils(merlin, room);
    expect(new Set(known)).toEqual(new Set(['discord:morg', 'discord:assn', 'discord:ob']));
    expect(known).toContain('discord:ob');
  });

  it('Assassin sees Morgana but NOT Oberon', () => {
    const assn = room.players['discord:assn'];
    const known = computeKnownEvils(assn, room);
    expect(new Set(known)).toEqual(new Set(['discord:morg']));
    expect(known).not.toContain('discord:ob');
  });

  it('Oberon sees nothing (other evil cannot see him; he cannot see them)', () => {
    const ob = room.players['discord:ob'];
    expect(computeKnownEvils(ob, room)).toEqual([]);
  });
});

describe('roleReveal: computeKnownEvils — 7-player with Mordred', () => {
  // 7p: merlin + percival + loyal*2 + morgana + assassin + mordred
  const room = makeStartedRoom('7p-mord', [
    ['discord:m', 'Merlin', 'merlin'],
    ['discord:p', 'Percival', 'percival'],
    ['discord:l1', 'Loyal-1', 'loyal'],
    ['discord:l2', 'Loyal-2', 'loyal'],
    ['discord:morg', 'Morgana', 'morgana'],
    ['discord:assn', 'Assassin', 'assassin'],
    ['discord:mord', 'Mordred', 'mordred'],
  ]);

  it('Merlin sees Morgana+Assassin but NOT Mordred', () => {
    const merlin = room.players['discord:m'];
    const known = computeKnownEvils(merlin, room);
    expect(new Set(known)).toEqual(new Set(['discord:morg', 'discord:assn']));
    expect(known).not.toContain('discord:mord');
  });

  it('Mordred sees all other evil (non-oberon)', () => {
    const mord = room.players['discord:mord'];
    const known = computeKnownEvils(mord, room);
    expect(new Set(known)).toEqual(new Set(['discord:morg', 'discord:assn']));
  });
});

describe('roleReveal: computeKnownEvils — canonical 10-player (all 4 evil roles)', () => {
  // Edward 2026-04-28 regression test: 10p includes the full canonical
  // evil quartet (assassin + morgana + mordred + oberon). Merlin must
  // see assassin + morgana + oberon (3 thumbs-up) but NOT mordred.
  // This is the bug Edward saw at 17:00 — Merlin showing only assassin.
  const room = makeStartedRoom('10p', [
    ['discord:m', 'Merlin', 'merlin'],
    ['discord:p', 'Percival', 'percival'],
    ['discord:l1', 'Loyal-1', 'loyal'],
    ['discord:l2', 'Loyal-2', 'loyal'],
    ['discord:l3', 'Loyal-3', 'loyal'],
    ['discord:l4', 'Loyal-4', 'loyal'],
    ['discord:assn', 'Assassin', 'assassin'],
    ['discord:morg', 'Morgana', 'morgana'],
    ['discord:mord', 'Mordred', 'mordred'],
    ['discord:ob', 'Oberon', 'oberon'],
  ]);

  it('Merlin sees Assassin + Morgana + Oberon (3 thumbs-up), NOT Mordred', () => {
    const merlin = room.players['discord:m'];
    const known = computeKnownEvils(merlin, room);
    expect(new Set(known)).toEqual(new Set(['discord:assn', 'discord:morg', 'discord:ob']));
    expect(known).toContain('discord:ob');     // canonical fix
    expect(known).not.toContain('discord:mord'); // canonical hide
    expect(known).toHaveLength(3);              // exactly 3 visible evils
  });

  it('Assassin sees Morgana + Mordred but NOT Oberon (evil-evil rule)', () => {
    const assn = room.players['discord:assn'];
    const known = computeKnownEvils(assn, room);
    expect(new Set(known)).toEqual(new Set(['discord:morg', 'discord:mord']));
    expect(known).not.toContain('discord:ob');
  });

  it('Mordred sees Assassin + Morgana but NOT Oberon', () => {
    const mord = room.players['discord:mord'];
    const known = computeKnownEvils(mord, room);
    expect(new Set(known)).toEqual(new Set(['discord:assn', 'discord:morg']));
    expect(known).not.toContain('discord:ob');
  });

  it('Oberon sees nothing (lone wolf)', () => {
    const ob = room.players['discord:ob'];
    expect(computeKnownEvils(ob, room)).toEqual([]);
  });
});

describe('roleReveal: buildRoleRevealEmbed — smoke', () => {
  const room = makeStartedRoom('smoke', [
    ['discord:m', 'Merlin', 'merlin'],
    ['discord:p', 'Percival', 'percival'],
    ['discord:morg', 'Morgana', 'morgana'],
    ['discord:assn', 'Assassin', 'assassin'],
    ['discord:l', 'Loyal', 'loyal'],
  ]);

  it('produces an embed for each canonical role without throwing', () => {
    for (const pid of ['discord:m', 'discord:p', 'discord:morg', 'discord:assn', 'discord:l']) {
      const embed = buildRoleRevealEmbed(room.players[pid], room);
      expect(embed).toBeDefined();
      // Embed must have at least title + description
      const json = embed.toJSON();
      expect(json.title).toContain('你的身分');
      expect(json.description).toBeDefined();
    }
  });

  it('Merlin embed lists both known-evil names', () => {
    const merlin = room.players['discord:m'];
    const json = buildRoleRevealEmbed(merlin, room).toJSON();
    const knownEvilField = json.fields?.find((f: { name: string }) =>
      f.name.includes('梅林視野')
    );
    expect(knownEvilField).toBeDefined();
    expect(knownEvilField?.value).toContain('Assassin');
    expect(knownEvilField?.value).toContain('Morgana');
  });

  it('Percival embed lists both possible-Merlin wizards', () => {
    const perc = room.players['discord:p'];
    const json = buildRoleRevealEmbed(perc, room).toJSON();
    const wizardField = json.fields?.find((f: { name: string }) =>
      f.name.includes('可能的梅林')
    );
    expect(wizardField).toBeDefined();
    expect(wizardField?.value).toContain('Merlin');
    expect(wizardField?.value).toContain('Morgana');
  });

  it('Oberon embed documents the solo constraint', () => {
    const roomWithOb = makeStartedRoom('ob', [
      ['discord:m', 'Merlin', 'merlin'],
      ['discord:assn', 'Assassin', 'assassin'],
      ['discord:morg', 'Morgana', 'morgana'],
      ['discord:ob', 'Oberon', 'oberon'],
      ['discord:l1', 'L1', 'loyal'],
      ['discord:l2', 'L2', 'loyal'],
      ['discord:l3', 'L3', 'loyal'],
    ]);
    const ob = roomWithOb.players['discord:ob'];
    const json = buildRoleRevealEmbed(ob, roomWithOb).toJSON();
    const teammateField = json.fields?.find((f: { name: string }) => f.name === '隊友');
    expect(teammateField?.value).toContain('獨立行動');
  });
});
