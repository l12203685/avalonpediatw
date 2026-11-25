/**
 * 規則與角色的文字、Discord 的 /rules /roles、看不懂的指令與出錯時的回覆（2026-11-25）。
 * 都是固定文字的純函式測試；不連 Discord、不連 LINE。
 */
import { describe, expect, it, vi } from 'vitest';
import { PLAY_PLATFORM_URL } from '@avalon/shared';
import { COMMANDS, DISCORD_CONFIG, SEAT_FILLER_OPTIONS } from '../bots/discord/config';
import { RELAYED_DISCORD_COMMANDS } from '../bots/discord/replyRelay';
import { SEAT_FILLER_ALIAS_TEXT, SEAT_FILLER_USAGE, formatSeatFillerParseError } from '../bots/seatFiller/commands';
import { DiscordBotClient, buildSlashCommands } from '../bots/discord/client';
import { COMMAND_ERROR_TEXT, UNKNOWN_COMMAND_TEXT, handleRolesCommand, handleRulesCommand } from '../bots/discord/commands';
import { HELP_TOPICS, UNKNOWN_COMMAND_HINT, helpText, parseHelpCommand, topicHelpText, unknownCommandHint } from '../bots/help';
import { playPlatformLine, rolesText, rulesText } from '../bots/rules';
import { simHelpFor } from '../bots/simulation/textCommands';
import { SIM_HELP_TEXT } from '../bots/simulation/replies';
import { formatStatsHelp } from '../bots/stats/statsReplies';
import { answerStatsTextCommand } from '../bots/stats/textCommands';
import { createRolesMessage } from '../bots/line/messages';

function interaction(commandName: string) {
  const fake = {
    commandName,
    deferred: false,
    deferReply: vi.fn(async () => { fake.deferred = true; }),
    editReply: vi.fn(async (_payload: unknown) => {}),
  };
  return fake;
}

/** 回覆裡不該有的東西：英文句子、堆疊、undefined／null／NaN。 */
function expectPlainChinese(text: string): void {
  expect(text).not.toMatch(/undefined|null|NaN|\[object|Error:|\bat \w+ \(/);
  // 網址、指令字（/rules /roles /help）以外沒有連續三個英文單字。
  expect(text.replace(/https?:\/\/\S+/g, '')).not.toMatch(/[A-Za-z]{3,} [A-Za-z]{3,} [A-Za-z]{3,}/);
}

describe('rulesText / rolesText', () => {
  it('rules: the 10-player facts the site uses, one line each', () => {
    const t = rulesText();
    const lines = t.split('\n');
    expect(lines[0]).toBe('📜 阿瓦隆規則（10 人局）');
    expect(t).toContain('五局的任務人數：3、4、4、5、5');
    expect(t).toContain('第 4 局要 2 張');
    expect(t).toContain('第 5 次派的隊直接出發，不投票');
    expect(t).toContain('開局湖在 0家');
    expect(t).toContain('刺客指認梅林');
    for (const role of ['梅林', '派西維爾', '忠臣', '刺客', '莫甘娜', '莫德雷德', '奧伯倫']) expect(t).toContain(role);
    // 之前英文版寫的「5 次否決壞人贏」不是這個社群的規則。
    expect(t).not.toMatch(/5 rejections|否決/);
    // 2026-11-25 第二批：兩邊同一份文字、同一個打法。
    expect(lines.at(-1)).toBe('角色介紹：/角色');
    expect(lines.length).toBeLessThanOrEqual(9);
    expectPlainChinese(t);
  });

  it('roles: Merlin does not see Mordred (and does see Morgana and Oberon); seven roles', () => {
    const t = rolesText();
    expect(t).toContain('🔵 梅林：知道刺客、莫甘娜、奧伯倫是壞人，看不到莫德雷德');
    expect(t).toContain('🔴 莫德雷德：梅林看不到他');
    expect(t).toContain('🔴 莫甘娜：在派西維爾眼中跟梅林一樣');
    expect(t).toContain('🔴 奧伯倫：不知道隊友是誰，隊友也不知道他；梅林看得到他');
    expect(t).not.toContain('莫甘娜除外');
    expect(t.split('\n').filter((l) => /^🔵|^🔴/u.test(l))).toHaveLength(7);
    expect(t.split('\n').at(-1)).toBe('規則：/規則');
    expectPlainChinese(t);
  });

  it('seats are written N家 (0家), never 10家 / 10 號', () => {
    for (const t of [rulesText(), rolesText()]) expect(t).not.toMatch(/10\s*[家號]/u);
  });

  it('the legacy LINE role cards no longer say Merlin cannot see Morgana', () => {
    const json = JSON.stringify(createRolesMessage());
    expect(json).not.toContain('莫甘娜除外');
    expect(json).toContain('看不到莫德雷德');
    expect(json).toContain('梅林看得出你是壞人');
  });
});

describe('Discord /rules, /roles', () => {
  it('reply with the same texts, plain (no embed), mentions off', async () => {
    const rules = interaction(COMMANDS.RULES);
    await handleRulesCommand(rules as never);
    expect(rules.deferReply).toHaveBeenCalledTimes(1);
    expect(rules.editReply).toHaveBeenCalledWith({ content: rulesText(), allowedMentions: { parse: [] } });
    const roles = interaction(COMMANDS.ROLES);
    await handleRolesCommand(roles as never);
    expect(roles.editReply).toHaveBeenCalledWith({ content: rolesText(), allowedMentions: { parse: [] } });
    for (const t of [rulesText(), rolesText()]) expect(t.length).toBeLessThanOrEqual(2000);
  });

  it('every slash command description is in Chinese (an English gloss may follow) and fits Discord (≤ 100)', () => {
    for (const c of buildSlashCommands().map((b) => b.toJSON())) {
      expect(c.description.length).toBeLessThanOrEqual(100);
      expect(c.description).toMatch(/\p{Script=Han}{2,}/u);
    }
  });

  it('the status lines name commands that exist', () => {
    const names = new Set(buildSlashCommands().map((b) => b.toJSON().name));
    for (const s of DISCORD_CONFIG.statuses) {
      const cmd = /^\/(\S+)/u.exec(s.name)?.[1];
      expect(cmd && names.has(cmd)).toBe(true);
    }
  });
});

describe('/help 規則、/help 角色', () => {
  it('topics resolve on both platforms', () => {
    expect(HELP_TOPICS).toEqual(expect.arrayContaining(['規則', '角色', '每日一題']));
    expect(parseHelpCommand('/help 規則')?.topic).toBe('規則');
    expect(parseHelpCommand('/help 角色')?.topic).toBe('角色');
    expect(parseHelpCommand('/help rules')?.topic).toBe('規則');
    expect(topicHelpText('規則', 'line')).toBe(rulesText());
    expect(topicHelpText('角色', 'line')).toBe(rolesText());
    expect(topicHelpText('規則', 'discord')).toBe(rulesText());
  });
  it('LINE typed: /help 規則 answers with the rules', async () => {
    expect(await answerStatsTextCommand('/help 規則', 'line')).toBe(rulesText());
    expect(await answerStatsTextCommand('／說明 角色', 'line')).toBe(rolesText());
  });
});

describe('/說明 = /help', () => {
  it.each([
    ['/說明', null],
    ['／說明', null],
    ['/说明', null],
    ['/說明 模擬', '模擬'],
    ['/說明模擬瓦', '模擬'],
    ['/說明 戰績', '戰績'],
    ['/說明 每日一題', '每日一題'],
    ['/說明 看不懂的主題', null],
  ] as const)('%s → topic %s', (text, topic) => {
    const parsed = parseHelpCommand(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.topic ?? null).toBe(topic);
  });
  it.each(['/說明書在哪', '說明', '請 /說明', '/說明一下這局'])('%s is chatter, not the command', (text) => {
    expect(parseHelpCommand(text)).toBeNull();
  });
  it('answers exactly like /help on LINE', async () => {
    expect(await answerStatsTextCommand('/說明', 'line')).toBe(helpText(null, 'line'));
    expect(await answerStatsTextCommand('/說明 補位', 'line')).toBe(helpText('補位', 'line'));
  });
  it('the 模擬-only practice group answers /說明 with the 模擬瓦 list', () => {
    expect(simHelpFor('/說明')).toBe(SIM_HELP_TEXT);
    expect(simHelpFor('/說明 模擬')).toBe(SIM_HELP_TEXT);
    expect(simHelpFor('/說明 戰績')).toBeNull();
  });
  it('Discord registers /說明 with the same option and choices as /help', () => {
    const json = buildSlashCommands().map((b) => b.toJSON());
    const help = json.find((c) => c.name === COMMANDS.HELP);
    const zh = json.find((c) => c.name === COMMANDS.HELP_ZH);
    expect(zh).toBeDefined();
    expect(zh?.options).toEqual(help?.options);
    expect(zh?.description).toBe(help?.description);
    const choices = (help?.options?.[0] as { choices?: { name: string }[] }).choices?.map((c) => c.name);
    expect(choices).toEqual([...HELP_TOPICS]);
  });
});

describe('fallback texts', () => {
  it('Discord: unknown command / error are Chinese, fixed, and point somewhere useful', () => {
    expect(UNKNOWN_COMMAND_TEXT).toContain('/help');
    expect(COMMAND_ERROR_TEXT).toContain('請稍後再試');
    expect(COMMAND_ERROR_TEXT).toContain('/回報');
    for (const t of [UNKNOWN_COMMAND_TEXT, COMMAND_ERROR_TEXT]) {
      expect(t).not.toMatch(/Unknown command|An error occurred/);
      expectPlainChinese(t);
    }
  });
  it('unknownCommandHint: only for a slash followed by a word; the hint is fixed (never echoes)', () => {
    for (const t of ['/戰積 測試玩家甲', '／模似', '/create', '/x']) expect(unknownCommandHint(t)).toBe(UNKNOWN_COMMAND_HINT);
    for (const t of ['', '/', '/ 戰績', '戰績', 'hi /help', '測試玩家甲 /戰績']) expect(unknownCommandHint(t)).toBeNull();
    expect(UNKNOWN_COMMAND_HINT).toContain('/help');
    expect(UNKNOWN_COMMAND_HINT).not.toContain('測試玩家甲');
    expect(UNKNOWN_COMMAND_HINT.split('\n')).toHaveLength(1);
  });
});

describe('command lists', () => {
  it('/指令 (LINE) now lists /更正 and /每日一題 and is titled as the whole bot, not only stats', () => {
    const t = formatStatsHelp('line');
    expect(t.split('\n')[0]).toBe('📖 阿瓦隆百科機器人指令');
    expect(t).toContain('/更正 局號 [更正內容]\u3000查一局牌譜（含檢查出來的問題），或送出更正給站長');
    expect(t).toContain('/每日一題\u3000今天的阿瓦隆每日一題');
    expect(formatStatsHelp('discord')).toContain('/更正 局號 [內容]');
  });
  it('the play line carries the play URL; on Discord it is wrapped in <> so no login-page preview is added under the help', () => {
    expect(playPlatformLine('line')).toBe(`🎲 開局、對局：signage-cloud ${PLAY_PLATFORM_URL}`);
    expect(playPlatformLine('discord')).toBe(`🎲 開局、對局：signage-cloud <${PLAY_PLATFORM_URL}>`);
  });
});

describe('/規則、/角色、/補位：兩邊同一個打法（2026-11-25 第二批）', () => {
  const json = () => buildSlashCommands().map((b) => b.toJSON());
  const named = (name: string) => json().find((c) => c.name === name);

  it('Discord registers /規則 and /角色 next to /rules and /roles: same description, no options', () => {
    for (const [zh, en] of [[COMMANDS.RULES_ZH, COMMANDS.RULES], [COMMANDS.ROLES_ZH, COMMANDS.ROLES]]) {
      expect(named(zh)).toBeDefined();
      expect(named(en)).toBeDefined();
      expect(named(zh)?.description).toBe(named(en)?.description);
      expect(named(zh)?.options ?? []).toEqual([]);
    }
    expect([COMMANDS.RULES_ZH, COMMANDS.ROLES_ZH]).toEqual(['規則', '角色']);
  });

  it('Discord registers /補位 with exactly the options of /機器人補位 (which stays), and relays both to LINE', () => {
    const zh = named(COMMANDS.SEAT_FILLER_ZH);
    const long = named(COMMANDS.SEAT_FILLER);
    expect(COMMANDS.SEAT_FILLER_ZH).toBe('補位');
    expect(zh).toBeDefined();
    expect(long).toBeDefined();
    expect(zh?.options).toEqual(long?.options);
    expect(zh?.description).toBe(long?.description);
    expect(zh?.options?.map((o) => o.name)).toEqual([SEAT_FILLER_OPTIONS.ROOM, SEAT_FILLER_OPTIONS.BOTS, SEAT_FILLER_OPTIONS.PASSWORD]);
    expect(RELAYED_DISCORD_COMMANDS.has(COMMANDS.SEAT_FILLER_ZH)).toBe(true);
    expect(RELAYED_DISCORD_COMMANDS.has(COMMANDS.SEAT_FILLER)).toBe(true);
  });

  it('the dispatcher answers the Chinese and the English names with the same reply (no Discord connection: handlers only)', async () => {
    const bot = new DiscordBotClient() as unknown as { handleCommand: (i: unknown) => Promise<void> };
    const run = async (name: string): Promise<unknown> => {
      const i = { ...interaction(name), channelId: 'c1', replied: false, reply: vi.fn(async () => {}) };
      i.deferReply = vi.fn(async () => { i.deferred = true; });
      await bot.handleCommand(i);
      return i.editReply.mock.calls[0]?.[0];
    };
    expect(await run(COMMANDS.RULES_ZH)).toEqual({ content: rulesText(), allowedMentions: { parse: [] } });
    expect(await run(COMMANDS.RULES)).toEqual(await run(COMMANDS.RULES_ZH));
    expect(await run(COMMANDS.ROLES_ZH)).toEqual({ content: rolesText(), allowedMentions: { parse: [] } });
    expect(await run(COMMANDS.ROLES)).toEqual(await run(COMMANDS.ROLES_ZH));

    // /補位：格式不對的房號在叫機器人之前就被擋下（只有本人看得到），兩個名字回同一句。
    const seat = async (name: string): Promise<unknown> => {
      const i = {
        ...interaction(name),
        channelId: 'c1',
        replied: false,
        options: { getString: (opt: string) => (opt === SEAT_FILLER_OPTIONS.ROOM ? 'a"b' : null) },
        reply: vi.fn(async (_payload: unknown) => {}),
      };
      await bot.handleCommand(i);
      expect(i.deferReply).not.toHaveBeenCalled();
      return (i.reply.mock.calls[0] as unknown as [{ content: string }])[0].content;
    };
    expect(await seat(COMMANDS.SEAT_FILLER_ZH)).toBe(formatSeatFillerParseError('room', 'discord'));
    expect(await seat(COMMANDS.SEAT_FILLER)).toBe(await seat(COMMANDS.SEAT_FILLER_ZH));
  });

  it('the Discord wording names /補位 now (usage, example); /help 補位 says the long name still works', () => {
    expect(SEAT_FILLER_USAGE.discord).toBe('/補位 房號或描述 [人數] [密碼]');
    expect(SEAT_FILLER_USAGE.line.startsWith('/補位 ')).toBe(true);
    expect(formatSeatFillerParseError('usage', 'discord')).toContain('/補位 房號或描述:百科陪練 人數:補滿 密碼:1234');
    for (const p of ['line', 'discord'] as const) {
      expect(formatSeatFillerParseError('usage', p)).not.toContain('/機器人補位');
      expect(topicHelpText('補位', p).split('\n').at(-1)).toBe(SEAT_FILLER_ALIAS_TEXT);
    }
  });

  it.each([
    ['/規則', '規則'],
    ['／規則', '規則'],
    ['/ 規則 ', '規則'],
    ['/规则', '規則'],
    ['/角色', '角色'],
    ['/角色介紹', '角色'],
  ] as const)('LINE typed %s → the %s text, same as Discord', async (text, topic) => {
    expect(parseHelpCommand(text)?.topic).toBe(topic);
    expect(await answerStatsTextCommand(text, 'line')).toBe(topic === '規則' ? rulesText() : rolesText());
    expect(topicHelpText(topic, 'line')).toBe(topicHelpText(topic, 'discord'));
  });

  it.each(['/角色扮演', '/規則 是什麼', '/角色 梅林', '規則', '大家看一下 /規則', '/規則書'])('%s is chatter, not the command', async (text) => {
    expect(parseHelpCommand(text)).toBeNull();
    expect(await answerStatsTextCommand(text, 'line')).toBeNull();
  });

  it('the two texts point at each other with the names both platforms have; the help lists them once', () => {
    expect(rulesText().split('\n').at(-1)).toBe('角色介紹：/角色');
    expect(rolesText().split('\n').at(-1)).toBe('規則：/規則');
    for (const p of ['line', 'discord'] as const) {
      expect(helpText(null, p)).toContain('/規則 /角色　遊戲規則、角色介紹');
      expect(helpText(null, p)).not.toMatch(/\/rules|\/roles/);
    }
  });
});
