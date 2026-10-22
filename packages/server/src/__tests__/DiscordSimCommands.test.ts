/**
 * 模擬瓦 on Discord (2026-10-14): the six slash commands /模擬 /派 /區間 /下一步 /公布 /結束.
 *
 *   - registered next to the stats commands, discord.js builder validation offline (21 commands);
 *   - every handler defers, then edits the reply with mentions off; the step is applied only after
 *     the edit went out, and a throwing commit never replaces the posted answer;
 *   - the rate limit covers malformed commands too (no endless public usage replies);
 *   - /help and the LINE /指令 list /模擬 only while SIM_COMMANDS_ENABLED is on;
 *   - public everywhere when SIM_DISCORD_PUBLIC_CHANNEL_IDS is empty, else public only there;
 *   - co-answering (2026-10-22) only where the replies are public; /模擬 說明:True gets the Discord wording;
 *   - a bot reply in the sync channel is never mirrored (bots are ignored by the mirror);
 *   - errors are logged as codes only.
 * Hand-rolled interaction mock; invented bank (fixtures/simGames.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { buildSlashCommands } from '../bots/discord/client';
import { COMMANDS, SIM_OPTIONS, SIM_ROLE_CHOICES } from '../bots/discord/config';
import { handleHelpCommand } from '../bots/discord/commands';
import { handleDiscordMirrorMessage } from '../bots/discord/mirrorInbound';
import { SimBankLoader } from '../bots/simulation/bank';
import { SIM_CONFIG, SIM_REPLY_MAX_CHARS } from '../bots/simulation/config';
import { handleSimCommand, simCommandFromInteraction, simReplyIsPublic, SIM_ERROR_TEXT } from '../bots/simulation/discordCommand';
import { __setSimForTests } from '../bots/simulation';
import { SimEngine } from '../bots/simulation/session';
import { CO_ANSWER_MARK, NO_SESSION_TEXT, SIM_HELP_TEXT, SIM_HELP_TEXT_DISCORD, sharedNote } from '../bots/simulation/replies';
import { formatStatsHelp } from '../bots/stats/statsReplies';
import { fixtureBank } from './fixtures/simGames';

vi.mock('../bots/stats/statsQueries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bots/stats/statsQueries')>()),
  leaderboardScopeText: async () => null,
}));

const BANK = fixtureBank();

function makeInteraction(commandName: string, options: Record<string, string | number | boolean> = {}, channelId = 'CH-1', userId = 'u-1') {
  const fake = {
    commandName,
    channelId,
    user: { id: userId, username: 'user-1' },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async (_opts?: unknown) => {
      fake.deferred = true;
    }),
    editReply: vi.fn(async (_payload: unknown) => {}),
    deleteReply: vi.fn(async () => {}),
    reply: vi.fn(async (_payload: unknown) => {
      fake.replied = true;
    }),
    followUp: vi.fn(async (_payload: unknown) => {}),
    options: {
      getString: vi.fn((name: string, required?: boolean) => {
        const v = options[name];
        if (v === undefined && required) throw new Error(`missing option ${name}`);
        return v === undefined ? null : String(v);
      }),
      getInteger: vi.fn((name: string) => {
        const v = options[name];
        return v === undefined ? null : Number(v);
      }),
      getBoolean: vi.fn((name: string) => {
        const v = options[name];
        return v === undefined ? null : Boolean(v);
      }),
    },
  };
  return fake;
}

type Fake = ReturnType<typeof makeInteraction>;

/** The one edited reply. */
function content(it1: Fake): { content: string; allowedMentions?: unknown } {
  expect(it1.deferReply).toHaveBeenCalledTimes(1);
  expect(it1.editReply).toHaveBeenCalledTimes(1);
  const payload = it1.editReply.mock.calls[0][0] as { content: string; allowedMentions?: unknown };
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(payload.content.length).toBeLessThanOrEqual(SIM_REPLY_MAX_CHARS);
  return payload;
}

async function run(name: string, options: Record<string, string | number | boolean> = {}, channelId?: string, userId?: string): Promise<string> {
  const it1 = makeInteraction(name, options, channelId, userId);
  await handleSimCommand(it1 as never);
  return content(it1).content;
}

let engine: SimEngine;
beforeEach(() => {
  delete process.env.SIM_DISCORD_PUBLIC_CHANNEL_IDS;
  SIM_CONFIG.commandsEnabled = true;
  const loader = new SimBankLoader(() => BANK);
  engine = new SimEngine({ bank: () => loader.get(), random: () => () => 0 });
  __setSimForTests({ loader, engine });
});
afterEach(() => {
  __setSimForTests({ loader: null, engine: null });
  delete process.env.SIM_DISCORD_PUBLIC_CHANNEL_IDS;
});

describe('registration', () => {
  it('six 模擬 commands pass discord.js validation; 21 commands in all', () => {
    const json = buildSlashCommands().map((c) => c.toJSON());
    expect(json).toHaveLength(21);
    const names = json.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['模擬', '派', '區間', '下一步', '公布', '結束', '戰績', '排行', '默契', '意見', 'help']));
    for (const c of json) {
      expect(c.name.length).toBeLessThanOrEqual(32);
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
    const sim = json.find((c) => c.name === COMMANDS.SIM);
    expect(sim?.options?.map((o) => [o.name, o.required ?? false])).toEqual([[SIM_OPTIONS.ROLE, false], [SIM_OPTIONS.SEAT, false], [SIM_OPTIONS.ID, false], [SIM_OPTIONS.HELP, false]]);
    const role = sim?.options?.[0] as { choices?: { name: string; value: string }[] };
    expect(role.choices?.map((c) => c.value)).toEqual([...SIM_ROLE_CHOICES]);
    const seat = sim?.options?.[1] as { min_value?: number; max_value?: number };
    expect([seat.min_value, seat.max_value]).toEqual([1, 10]);
    expect(json.find((c) => c.name === COMMANDS.SIM_PROPOSE)?.options).toEqual([expect.objectContaining({ name: SIM_OPTIONS.TEAM, required: true })]);
    expect(json.find((c) => c.name === COMMANDS.SIM_INTERVAL)?.options).toEqual([expect.objectContaining({ name: SIM_OPTIONS.CONTENT, required: true })]);
  });

  it('/help and the LINE /指令 advertise /模擬 (only while it is on)', async () => {
    const helpFields = async (): Promise<{ name: string; value: string }[]> => {
      const it1 = makeInteraction(COMMANDS.HELP);
      await handleHelpCommand(it1 as never);
      return (it1.editReply.mock.calls[0][0] as { embeds: { toJSON: () => { fields: { name: string; value: string }[] } }[] }).embeds[0].toJSON().fields;
    };
    const field = (await helpFields()).find((f) => f.name.includes('模擬瓦'));
    expect(field?.value).toContain('/模擬 [角色] [座位]');
    expect(field?.value).toContain('/派 /區間 /下一步 /公布 /結束');
    expect(field?.value).toContain('/模擬 說明:True');
    expect(formatStatsHelp('line')).toContain('/模擬 [角色] [座位]\u3000模擬瓦：練派票資訊的釋放與解讀');
    expect(formatStatsHelp('line')).toContain('/模擬 說明 看全部指令');
    expect(formatStatsHelp('discord')).toContain('/模擬 [角色] [座位]');

    SIM_CONFIG.commandsEnabled = false;
    try {
      expect((await helpFields()).some((f) => f.name.includes('模擬瓦'))).toBe(false);
      expect(formatStatsHelp('line')).not.toContain('/模擬');
    } finally {
      SIM_CONFIG.commandsEnabled = true;
    }
  });
});

describe('options → command', () => {
  it('maps every command, with the same parsers as LINE', () => {
    const m = (name: string, o: Record<string, string | number> = {}) => simCommandFromInteraction(makeInteraction(name, o) as never);
    expect(m(COMMANDS.SIM)).toEqual({ kind: 'start' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.ROLE]: '派西維爾', [SIM_OPTIONS.SEAT]: 2 })).toEqual({ kind: 'start', role: 'percival', seat: 2 });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.ROLE]: '紅' })).toEqual({ kind: 'start', role: 'red' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.SEAT]: 10 })).toEqual({ kind: 'start', seat: 10 });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.ID]: 'w0001-4' })).toEqual({ kind: 'start', exerciseId: 'W0001-4' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.HELP]: true })).toEqual({ kind: 'help' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.HELP]: false, [SIM_OPTIONS.SEAT]: 4 })).toEqual({ kind: 'start', seat: 4 });
    expect(m(COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '４ ６ ０' })).toEqual({ kind: 'propose', team: [4, 6, 10] });
    expect(m(COMMANDS.SIM_INTERVAL, { [SIM_OPTIONS.CONTENT]: '7 8 9 *2' })).toEqual({ kind: 'interval', groups: [{ seats: [7, 8, 9], min: 2, max: 2 }] });
    expect(m(COMMANDS.SIM_NEXT)).toEqual({ kind: 'next' });
    expect(m(COMMANDS.SIM_REVEAL)).toEqual({ kind: 'reveal' });
    expect(m(COMMANDS.SIM_END)).toEqual({ kind: 'end' });
  });
});

describe('handlers', () => {
  it('a whole exercise; the proposals sit in a code block; mentions off; public by default', async () => {
    const it1 = makeInteraction(COMMANDS.SIM, { [SIM_OPTIONS.ROLE]: '忠臣', [SIM_OPTIONS.SEAT]: 4 });
    await handleSimCommand(it1 as never);
    expect(it1.deferReply.mock.calls[0][0]).toBeUndefined(); // public, like /戰績
    const start = content(it1).content;
    expect(start).toContain('【模擬瓦 W0000-4】你是 4家・忠臣（沒有額外資訊）');
    expect(start).toContain('```\n1家 460 1+\n2家 279\n3家 370\n```');

    expect(await run(COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '469' })).toContain('① 當時真人怎麼派：4家 派 469（跟你一樣）→ 被否決');
    expect(await run(COMMANDS.SIM_INTERVAL, { [SIM_OPTIONS.CONTENT]: '789=2' })).toContain('・789=2（7 8 9 裡有 2 紅）：可能，126 種裡有 45 種符合');
    expect(await run(COMMANDS.SIM_NEXT)).toContain('輪到你派 4 人（第 3 局第 4 次）。');
    expect(await run(COMMANDS.SIM_REVEAL)).toContain('角色：梅林1 派西維爾2 莫德雷德3 莫甘娜5 刺客7 奧伯倫9；忠臣 4 6 8 0');
    expect(await run(COMMANDS.SIM_END)).toBe(NO_SESSION_TEXT);
    expect(engine.counts.started.discord).toBe(1);
  });

  it('each user in each channel has their own exercise; a user without one co-answers the newest in the channel (marked 代答)', async () => {
    const start = await run(COMMANDS.SIM, { [SIM_OPTIONS.ROLE]: '忠臣', [SIM_OPTIONS.SEAT]: 4 }, 'CH-1', 'a');
    // Public channel: the owner is told others may help and that /公布 or /結束 ends it for everyone.
    expect(start.split('\n').at(-1)).toBe(sharedNote('discord'));
    expect(sharedNote('discord')).toContain('頻道裡');
    const co = await run(COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '469' }, 'CH-1', 'b');
    expect(co.split('\n').slice(0, 2)).toEqual([CO_ANSWER_MARK, '【W0000-4・4家忠臣】你派 469']);
    expect(co.split('\n').at(-1)).toBe(sharedNote('discord'));
    expect(co).not.toContain('u-1');
    expect(co.length).toBeLessThanOrEqual(900);
    // A malformed /派 from someone without an exercise is answered with the usage only (never a co-answer).
    const bad = await run(COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '西 2' }, 'CH-1', 'b');
    expect(bad).toContain('用法：/派');
    expect(bad).not.toContain(CO_ANSWER_MARK);
    expect(await run(COMMANDS.SIM_NEXT, {}, 'CH-2', 'a')).toContain('你目前沒有進行中的模擬');
    const own = await run(COMMANDS.SIM_NEXT, {}, 'CH-1', 'a');
    expect(own).toContain('下一步】');
    expect(own).not.toContain(CO_ANSWER_MARK);
    expect(engine.counts.coAnswers).toBe(1);
  });

  it('no co-answering where sim replies are only-you (SIM_DISCORD_PUBLIC_CHANNEL_IDS set): the others never saw the exercise', async () => {
    process.env.SIM_DISCORD_PUBLIC_CHANNEL_IDS = 'CH-SIM';
    const start = await run(COMMANDS.SIM, { [SIM_OPTIONS.ROLE]: '忠臣', [SIM_OPTIONS.SEAT]: 4 }, 'CH-1', 'a');
    expect(start).not.toContain('幫忙答');
    for (const [name, opts] of [[COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '469' }], [COMMANDS.SIM_NEXT, {}], [COMMANDS.SIM_REVEAL, {}], [COMMANDS.SIM_END, {}]] as const) {
      expect(await run(name, opts, 'CH-1', 'b')).toBe(NO_SESSION_TEXT);
    }
    expect(engine.activeSessions()).toBe(1);
    expect(await run(COMMANDS.SIM_REVEAL, {}, 'CH-1', 'a')).toContain('你這題沒有作答。');
    // The public channel still co-answers.
    await run(COMMANDS.SIM, { [SIM_OPTIONS.ROLE]: '忠臣', [SIM_OPTIONS.SEAT]: 4 }, 'CH-SIM', 'a');
    expect((await run(COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '469' }, 'CH-SIM', 'b')).split('\n')[0]).toBe(CO_ANSWER_MARK);
    expect(engine.counts.coAnswers).toBe(1);
  });

  it('/模擬 說明:True → the Discord command list (slash option names), without opening an exercise', async () => {
    const help = await run(COMMANDS.SIM, { [SIM_OPTIONS.HELP]: true });
    expect(help).toBe(SIM_HELP_TEXT_DISCORD);
    expect(help).not.toBe(SIM_HELP_TEXT);
    expect(help).toContain(`/${COMMANDS.SIM_PROPOSE} ${SIM_OPTIONS.TEAM}:469`);
    expect(help).toContain(`/${COMMANDS.SIM_INTERVAL} ${SIM_OPTIONS.CONTENT}:789=2 460=1`);
    expect(help).toContain(`/${COMMANDS.SIM} ${SIM_OPTIONS.ROLE}:派西維爾 ${SIM_OPTIONS.SEAT}:2`);
    expect(help).toContain(`/${COMMANDS.SIM} ${SIM_OPTIONS.ID}:K7Q2M-4`);
    expect(help).toContain(`/${COMMANDS.SIM} ${SIM_OPTIONS.HELP}:True`);
    expect(help).not.toContain('/解答'); // LINE only
    expect(engine.activeSessions()).toBe(0);
    expect(engine.counts.help).toBe(1);
  });

  it('SIM_DISCORD_PUBLIC_CHANNEL_IDS set → public there, only-you elsewhere', async () => {
    process.env.SIM_DISCORD_PUBLIC_CHANNEL_IDS = 'CH-SIM';
    expect(simReplyIsPublic('CH-SIM')).toBe(true);
    expect(simReplyIsPublic('CH-1')).toBe(false);
    const elsewhere = makeInteraction(COMMANDS.SIM, {}, 'CH-1');
    await handleSimCommand(elsewhere as never);
    expect(elsewhere.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const there = makeInteraction(COMMANDS.SIM, {}, 'CH-SIM');
    await handleSimCommand(there as never);
    expect(there.deferReply.mock.calls[0][0]).toBeUndefined();
  });

  it('a malformed /派 without an exercise still answers with the usage (a slash command is explicit)', async () => {
    expect(await run(COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '西 2' })).toContain('用法：/派');
  });

  it('malformed commands are rate limited too: after the notice, nothing is posted (no echo, no usage)', async () => {
    const loader = new SimBankLoader(() => BANK);
    __setSimForTests({ loader, engine: new SimEngine({ bank: () => loader.get(), rateLimit: { windowMs: 600_000, max: 2 } }) });
    const bad = { [SIM_OPTIONS.CONTENT]: '12=1 假名01是梅林' };
    const first = await run(COMMANDS.SIM_INTERVAL, bad);
    expect(first).toMatch(/^第 2 組看不懂/);
    expect(first).not.toContain('假名');
    await run(COMMANDS.SIM_INTERVAL, bad);
    expect(await run(COMMANDS.SIM_INTERVAL, bad)).toBe('模擬指令太頻繁了，10 分鐘後再試。');
    for (let i = 0; i < 3; i++) {
      const again = makeInteraction(COMMANDS.SIM_INTERVAL, bad);
      await handleSimCommand(again as never);
      expect(again.editReply).not.toHaveBeenCalled();
      expect(again.deleteReply).toHaveBeenCalledTimes(1);
    }
  });

  it('a commit that throws after the answer was posted leaves the answer (logs a code only)', async () => {
    vi.spyOn(engine, 'handle').mockResolvedValueOnce({
      text: '模擬回覆', kind: 'start', sessionOpen: true, commit: () => { throw new Error('boom 469'); },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const it1 = makeInteraction(COMMANDS.SIM);
    await handleSimCommand(it1 as never);
    expect(it1.editReply).toHaveBeenCalledTimes(1);
    expect(it1.editReply).toHaveBeenLastCalledWith({ content: '模擬回覆', allowedMentions: { parse: [] } });
    expect(errors.mock.calls.flat().join(' ')).toBe('[sim] Discord commit failed (Error)');
    errors.mockRestore();
  });

  it('the step is applied only after the edit went out', async () => {
    await run(COMMANDS.SIM, { [SIM_OPTIONS.ROLE]: '忠臣', [SIM_OPTIONS.SEAT]: 4 });
    const failing = makeInteraction(COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '469' });
    failing.editReply.mockRejectedValueOnce(Object.assign(new Error('Unknown interaction: 469 回覆內容'), { code: 10062 }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleSimCommand(failing as never);
    expect(errors.mock.calls.flat().join(' ')).toBe('[sim] Discord command failed (Error code=10062)');
    errors.mockRestore();
    expect(failing.editReply).toHaveBeenLastCalledWith({ content: SIM_ERROR_TEXT, allowedMentions: { parse: [] } });
    expect(engine.counts.answers).toBe(0);
    expect(await run(COMMANDS.SIM_REVEAL)).toContain('你這題沒有作答。');
  });

  it('flag off → a fixed "停用" reply', async () => {
    SIM_CONFIG.commandsEnabled = false;
    expect(await run(COMMANDS.SIM)).toBe('模擬瓦目前停用。');
    SIM_CONFIG.commandsEnabled = true;
  });

  it('rate limited past the notice → the deferred reply is deleted, nothing posted', async () => {
    const loader = new SimBankLoader(() => BANK);
    __setSimForTests({ loader, engine: new SimEngine({ bank: () => loader.get(), rateLimit: { windowMs: 600_000, max: 1 } }) });
    await run(COMMANDS.SIM);
    expect(await run(COMMANDS.SIM_NEXT)).toBe('模擬指令太頻繁了，10 分鐘後再試。');
    const third = makeInteraction(COMMANDS.SIM_NEXT);
    await handleSimCommand(third as never);
    expect(third.editReply).not.toHaveBeenCalled();
    expect(third.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("the bot's own reply in the sync channel is never mirrored", async () => {
    const ingested: unknown[] = [];
    const mirror = { ingestInbound: (m: unknown) => { ingested.push(m); return null; } };
    const outcome = await handleDiscordMirrorMessage(
      {
        id: 'b1', channelId: 'SYNC', content: '【模擬瓦 W0000-4】你是 4家・忠臣（沒有額外資訊）', webhookId: null,
        author: { id: 'bot', bot: true, username: 'avalon-bot' }, member: null, attachments: null, stickers: null,
      },
      { targetChannelId: 'SYNC', mirror: mirror as never },
    );
    expect(outcome).toBe('ignored');
    expect(ingested).toEqual([]);
  });
});
