/**
 * 模擬瓦 on Discord (2026-10-14): the slash commands /模擬 /派 /分析 /刺 /區間 /公布 /結束 (/下一步 removed 2026-11-17).
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
import { handleHelpCommand, HELP_TOPIC_OPTION } from '../bots/discord/commands';
import { HELP_TOPICS } from '../bots/help';
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

function makeInteraction(commandName: string, options: Record<string, string | number | boolean> = {}, channelId = 'CH-1', userId = 'u-1', guildId: string | null = 'G-1') {
  const fake = {
    commandName,
    channelId,
    guildId,
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

async function run(name: string, options: Record<string, string | number | boolean> = {}, channelId?: string, userId?: string, guildId?: string | null): Promise<string> {
  const it1 = makeInteraction(name, options, channelId, userId, guildId);
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
  it('seven 模擬 commands (incl. /分析 and /刺; /下一步 removed 2026-11-17) pass discord.js validation; 32 commands in all (incl. /機器人補位, /待修正, /回報, /認領, /更正, /說明, /每日一題; 2026-11-25 batch 2: /規則, /角色, /補位)', () => {
    const json = buildSlashCommands().map((c) => c.toJSON());
    expect(json).toHaveLength(32);
    const names = json.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['模擬', '派', '分析', '刺', 'assassinate', '區間', '公布', '結束', '戰績', '排行', '默契', '意見', 'help', '說明', '每日一題', '更正', 'rules', 'roles', '規則', '角色', '機器人補位', '補位']));
    expect(names).not.toContain('下一步');
    expect(new Set(names).size).toBe(names.length);
    for (const c of json) {
      expect(c.name.length).toBeLessThanOrEqual(32);
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
    const sim = json.find((c) => c.name === COMMANDS.SIM);
    expect(sim?.options?.map((o) => [o.name, o.required ?? false])).toEqual([[SIM_OPTIONS.ROLE, false], [SIM_OPTIONS.SEAT, false], [SIM_OPTIONS.STAGE, false], [SIM_OPTIONS.ID, false], [SIM_OPTIONS.HELP, false]]);
    const stage = sim?.options?.[2] as { choices?: { name: string; value: string }[] };
    expect(stage.choices?.map((c) => c.value)).toEqual(['1-5', '2-5', '3-5', '4-5', '4局', '5局', '刺殺', '今天']);
    expect(json.find((c) => c.name === COMMANDS.SIM_ASSASSINATE)?.options).toEqual([expect.objectContaining({ name: SIM_OPTIONS.SEAT, required: true })]);
    const role = sim?.options?.[0] as { choices?: { name: string; value: string }[] };
    expect(role.choices?.map((c) => c.value)).toEqual([...SIM_ROLE_CHOICES]);
    const seat = sim?.options?.[1] as { min_value?: number; max_value?: number };
    expect([seat.min_value, seat.max_value]).toEqual([0, 10]); // 0 家寫 0（10 也照收）
    expect(json.find((c) => c.name === COMMANDS.SIM_PROPOSE)?.options).toEqual([expect.objectContaining({ name: SIM_OPTIONS.TEAM, required: true })]);
    expect(json.find((c) => c.name === COMMANDS.SIM_INTERVAL)?.options).toEqual([expect.objectContaining({ name: SIM_OPTIONS.CONTENT, required: false })]);
  });

  it('/help 主題:模擬 answers just the 模擬瓦 list (plain text); the slash /help has the 主題 choices', async () => {
    const it1 = makeInteraction(COMMANDS.HELP, { [HELP_TOPIC_OPTION]: '模擬' });
    await handleHelpCommand(it1 as never);
    expect((it1.editReply.mock.calls[0][0] as { content: string }).content).toBe(SIM_HELP_TEXT_DISCORD);
    const help = buildSlashCommands().map((c) => c.toJSON() as { name: string; options?: { name: string; choices?: { value: string }[] }[] }).find((c) => c.name === COMMANDS.HELP);
    expect(help?.options?.[0]?.name).toBe(HELP_TOPIC_OPTION);
    expect(help?.options?.[0]?.choices?.map((c) => c.value)).toEqual([...HELP_TOPICS]);
  });

  it('/help and the LINE /指令 advertise /模擬 (only while it is on)', async () => {
    // 2026-11-25: Discord /help is the same plain text as LINE's (no embed).
    const helpContent = async (): Promise<string> => {
      const it1 = makeInteraction(COMMANDS.HELP);
      await handleHelpCommand(it1 as never);
      return (it1.editReply.mock.calls[0][0] as { content: string }).content;
    };
    expect(await helpContent()).toContain('/模擬\u3000模擬瓦：真人牌譜停在派票的當下，換你派');
    expect(await helpContent()).toContain('/help 主題:模擬');
    expect(formatStatsHelp('line')).toContain('/模擬 [角色] [座位]\u3000模擬瓦：練派票資訊的釋放與解讀');
    expect(formatStatsHelp('line')).toContain('/help 模擬 看全部指令');
    expect(formatStatsHelp('discord')).toContain('/模擬 [角色] [座位]');

    SIM_CONFIG.commandsEnabled = false;
    try {
      expect(await helpContent()).not.toContain('/模擬');
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
    // 0 家寫 0（站長 2026-11-12：座位只寫 0 家）
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.SEAT]: 0 })).toEqual({ kind: 'start', seat: 10 });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.ID]: 'w0001-4' })).toEqual({ kind: 'start', exerciseId: 'W0001-4' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.HELP]: true })).toEqual({ kind: 'help' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.HELP]: false, [SIM_OPTIONS.SEAT]: 4 })).toEqual({ kind: 'start', seat: 4 });
    expect(m(COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '４ ６ ０' })).toEqual({ kind: 'propose', team: [4, 6, 10] });
    expect(m(COMMANDS.SIM_INTERVAL, { [SIM_OPTIONS.CONTENT]: '7 8 9 *2' })).toEqual({ kind: 'interval', groups: [{ seats: [7, 8, 9], min: 2, max: 2 }] });
    expect(m(COMMANDS.SIM_INTERVAL)).toEqual({ kind: 'read' });
    // An old /下一步 registration (before the bot re-registers) answers that it was removed.
    expect(m(COMMANDS.SIM_NEXT)).toEqual({ kind: 'removed', command: '下一步' });
    expect(m(COMMANDS.SIM_ANALYSIS)).toEqual({ kind: 'analyze' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.STAGE]: '3-5', [SIM_OPTIONS.ROLE]: '梅林' })).toEqual({ kind: 'start', role: 'merlin', midRound: 3 });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.STAGE]: '4-5' })).toEqual({ kind: 'start', midRound: 4 });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.STAGE]: '5局', [SIM_OPTIONS.SEAT]: 7 })).toEqual({ kind: 'start', seat: 7, midRound: 5 });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.STAGE]: '刺殺' })).toEqual({ kind: 'start', special: 'assassin' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.STAGE]: '今天' })).toEqual({ kind: 'start', special: 'today' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.STAGE]: '今天', [SIM_OPTIONS.ROLE]: '梅林' })).toEqual({ kind: 'usage', command: 'start' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.STAGE]: '6-5' })).toEqual({ kind: 'usage', command: 'start' });
    expect(m(COMMANDS.SIM_ASSASSINATE, { [SIM_OPTIONS.SEAT]: 0 })).toEqual({ kind: 'assassinate', seat: 10 });
    expect(m(COMMANDS.SIM_ASSASSINATE, { [SIM_OPTIONS.SEAT]: 3 })).toEqual({ kind: 'assassinate', seat: 3 });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.ID]: 'w0001-2-5' })).toEqual({ kind: 'start', exerciseId: 'W0001-2-5' });
    // 2026-11-21：題號也可以寫「局號 位置」或只寫局號。
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.ID]: 'w0001 2-5' })).toEqual({ kind: 'start', exerciseId: 'W0001-2-5' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.ID]: 'W0001 4家' })).toEqual({ kind: 'start', exerciseId: 'W0001-4' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.ID]: 'W0001 刺殺' })).toEqual({ kind: 'start', exerciseId: 'W0001-A' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.ID]: 'W0001' })).toEqual({ kind: 'start', gameId: 'W0001' });
    expect(m(COMMANDS.SIM, { [SIM_OPTIONS.ID]: '???' })).toMatchObject({ kind: 'usage', command: 'start' });
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
    expect(start).toContain('【模擬瓦 W0000-4】你是 4家・忠臣\n');
    expect(start).toContain('```\n460 1+\n279\n370\n```');
    expect(start).toContain('\n\n/派 座位 作答 (沒開題的人也能作答，結果只有自己看得到)\n/區間 (百科AI 怎麼讀)\n/help 模擬\n/公布 (結束這題)');

    // 2026-11-21（玩家回饋：一個人作答就暴雷）：公開頻道的 /派 /分析 只回給本人（ephemeral），內容照舊。
    const proposeIt = makeInteraction(COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '469' });
    await handleSimCommand(proposeIt as never);
    expect(proposeIt.deferReply.mock.calls[0][0]).toEqual({ flags: MessageFlags.Ephemeral });
    expect(content(proposeIt).content).toBe('【W0000-4】你派 469：2 好 1 壞\n（只有你看得到；/公布 時會列出大家的答案）\n/分析 看完整解讀｜/區間 百科AI 怎麼讀｜/公布');
    const analysisIt = makeInteraction(COMMANDS.SIM_ANALYSIS);
    await handleSimCommand(analysisIt as never);
    expect(analysisIt.deferReply.mock.calls[0][0]).toEqual({ flags: MessageFlags.Ephemeral });
    expect(content(analysisIt).content).toContain('① 真人：4家 派 469（跟你一樣）→ 被否決');
    expect(await run(COMMANDS.SIM_INTERVAL, { [SIM_OPTIONS.CONTENT]: '789=2' })).toContain('【W0000-4 區間】789=2：可能（45/126 種）');
    const read = await run(COMMANDS.SIM_INTERVAL);
    expect(read).toContain('【W0000-4 百科AI 怎麼讀】');
    expect(read).toContain('百科AI 會派：');
    const revealIt = makeInteraction(COMMANDS.SIM_REVEAL);
    await handleSimCommand(revealIt as never);
    const revealArg = revealIt.editReply.mock.calls.at(-1)?.[0] as { content: string; files?: unknown[] };
    const reveal = revealArg.content;
    expect(reveal.split('\n').slice(0, 2)).toEqual(['【W0000-4 公布】配置: 刺娜莫奧派梅 753921', '1梅 2派 3莫 4忠 5娜 6忠 7刺 8忠 9奧 0忠']);
    expect(revealIt.deferReply.mock.calls[0][0]).toBeUndefined(); // /公布 is public, with everyone's answers
    expect(reveal).toMatch(/\n作答（1 位）：\n第1位：469 2好1壞/u);
    // 網站上沒有這一局：文字牌譜放在 code block；整局牌譜圖附檔（Edward 2026-11-17）。
    expect(reveal).toContain('完整牌譜（網站上沒有這一局）:\n```\n460 1+\n');
    expect(revealArg.files).toHaveLength(1);
    expect(await run(COMMANDS.SIM_END)).toBe(NO_SESSION_TEXT);
    expect(engine.counts.started.discord).toBe(1);
  });

  it('/公布 lists who sat 1～0 under the seats (Edward 2026-11-20); markdown in a name is escaped, mentions stay off', async () => {
    // 編的名字（不是真的玩家）。
    const i = BANK.byId.get('W0000') as number;
    const names = ['_甲蟲_', '乙鳥', '', '丁香', '戊己', '庚辛', '壬癸', '子丑', '@everyone', '辰*巳'];
    const loader = new SimBankLoader(() => ({ ...BANK, names: new Map([[i, names]]) }));
    engine = new SimEngine({ bank: () => loader.get(), random: () => () => 0 });
    __setSimForTests({ loader, engine });
    await run(COMMANDS.SIM, { [SIM_OPTIONS.ROLE]: '忠臣', [SIM_OPTIONS.SEAT]: 4 });
    const revealIt = makeInteraction(COMMANDS.SIM_REVEAL);
    await handleSimCommand(revealIt as never);
    const arg = revealIt.editReply.mock.calls.at(-1)?.[0] as { content: string; allowedMentions: unknown };
    expect(arg.content.split('\n').slice(1, 3)).toEqual([
      '1梅 2派 3莫 4忠 5娜 6忠 7刺 8忠 9奧 0忠',
      '1.\\_甲蟲\\_ 2.乙鳥 3. 4.丁香 5.戊己 6.庚辛 7.壬癸 8.子丑 9.@everyone 0.辰\\*巳',
    ]);
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });

  it('a DM (no guild) is not shared: no co-answer note on the start reply and no co-answering', async () => {
    const start = await run(COMMANDS.SIM, { [SIM_OPTIONS.ROLE]: '忠臣', [SIM_OPTIONS.SEAT]: 4 }, 'DM-1', 'a', null);
    expect(start).toContain('【模擬瓦 W0000-4】');
    expect(start).not.toContain(sharedNote('discord'));
    const other = await run(COMMANDS.SIM_INTERVAL, {}, 'DM-1', 'b', null);
    expect(other).toContain('你目前沒有進行中的模擬');
    expect(engine.counts.coAnswers).toBe(0);
  });

  it('each user in each channel has their own exercise; a user without one co-answers the newest in the channel (marked 代答)', async () => {
    const start = await run(COMMANDS.SIM, { [SIM_OPTIONS.ROLE]: '忠臣', [SIM_OPTIONS.SEAT]: 4 }, 'CH-1', 'a');
    // Public channel: the owner is told others may help and that /公布 or /結束 ends it for everyone.
    expect(start.split('\n').at(-1)).toBe('/公布 (結束這題)');
    expect(start).toContain('/派 座位 作答 (沒開題的人也能作答，結果只有自己看得到)');
    expect(sharedNote('discord')).toContain('頻道裡');
    const co = await run(COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '469' }, 'CH-1', 'b');
    expect(co.split('\n')).toEqual([CO_ANSWER_MARK, '【W0000-4】你派 469：2 好 1 壞', '（只有你看得到；/公布 時會列出大家的答案）', '/分析 看完整解讀｜/區間 百科AI 怎麼讀｜/公布']);
    expect(co).not.toContain('u-1');
    // A malformed /派 from someone without an exercise is answered with the usage only (never a co-answer).
    const bad = await run(COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '西 2' }, 'CH-1', 'b');
    expect(bad).toContain('用法：/派');
    expect(bad).not.toContain(CO_ANSWER_MARK);
    expect(await run(COMMANDS.SIM_INTERVAL, {}, 'CH-2', 'a')).toContain('你目前沒有進行中的模擬');
    const own = await run(COMMANDS.SIM_INTERVAL, {}, 'CH-1', 'a');
    expect(own).toContain('百科AI 怎麼讀】');
    expect(own).not.toContain(CO_ANSWER_MARK);
    expect(engine.counts.coAnswers).toBe(1);
  });

  it('no co-answering where sim replies are only-you (SIM_DISCORD_PUBLIC_CHANNEL_IDS set): the others never saw the exercise', async () => {
    process.env.SIM_DISCORD_PUBLIC_CHANNEL_IDS = 'CH-SIM';
    const start = await run(COMMANDS.SIM, { [SIM_OPTIONS.ROLE]: '忠臣', [SIM_OPTIONS.SEAT]: 4 }, 'CH-1', 'a');
    expect(start).not.toContain('幫忙答');
    for (const [name, opts] of [[COMMANDS.SIM_PROPOSE, { [SIM_OPTIONS.TEAM]: '469' }], [COMMANDS.SIM_INTERVAL, {}], [COMMANDS.SIM_REVEAL, {}], [COMMANDS.SIM_END, {}]] as const) {
      expect(await run(name, opts, 'CH-1', 'b')).toBe(NO_SESSION_TEXT);
    }
    expect(engine.activeSessions()).toBe(1);
    expect(await run(COMMANDS.SIM_REVEAL, {}, 'CH-1', 'a')).toContain('【W0000-4 公布】');
    expect(engine.counts.answers).toBe(0);
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
    expect(help).toContain(`/${COMMANDS.SIM} ${SIM_OPTIONS.ID}:K7Q2M 3-5`);
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
    expect(await run(COMMANDS.SIM_REVEAL)).toContain('【W0000-4 公布】');
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
        id: 'b1', channelId: 'SYNC', content: '【模擬瓦 W0000-4】你是 4家・忠臣', webhookId: null,
        author: { id: 'bot', bot: true, username: 'avalon-bot' }, member: null, attachments: null, stickers: null,
      },
      { targetChannelId: 'SYNC', mirror: mirror as never },
    );
    expect(outcome).toBe('ignored');
    expect(ingested).toEqual([]);
  });
});
