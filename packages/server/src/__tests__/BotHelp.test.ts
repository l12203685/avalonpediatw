/**
 * /help（Edward 2026-11-17：「我覺得機器人最基本的說明就是 /help 剩下可以再靠後面打指令細查 比如 /help 模擬 這樣」）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PLAY_PLATFORM_URL } from '@avalon/shared';
import { basicHelpText, HELP_TOPICS, helpText, helpTopicOf, parseHelpCommand, topicHelpText } from '../bots/help';
import { SIM_CONFIG } from '../bots/simulation/config';
import { SIM_HELP_TEXT, SIM_HELP_TEXT_DISCORD } from '../bots/simulation/replies';
import { simHelpFor } from '../bots/simulation/textCommands';
import { answerStatsTextCommand, parseStatsCommand } from '../bots/stats/textCommands';
import { formatStatsHelp } from '../bots/stats/statsReplies';

afterEach(() => {
  SIM_CONFIG.commandsEnabled = true;
});

describe('parseHelpCommand', () => {
  it.each([
    ['/help', null],
    ['/HELP', null],
    ['／help', null],
    ['/help 模擬', '模擬'],
    ['/help模擬瓦', '模擬'],
    ['/help 排行', '戰績'],
    ['/help 認領', '回報'],
    ['/help 補位', '補位'],
    ['/help 什麼', null],
  ] as const)('%s → %s', (text, topic) => {
    expect(parseHelpCommand(text)?.topic ?? null).toBe(topic);
  });
  it.each(['/helpme', 'help', '/指令', '/模擬 說明', 'hello /help'])('%s is not /help', (text) => {
    expect(parseHelpCommand(text)).toBeNull();
  });
  it('every topic resolves to itself', () => {
    for (const t of HELP_TOPICS) expect(helpTopicOf(t)).toBe(t);
  });
});

describe('texts', () => {
  it('/help is one line per feature and ends with how to see details', () => {
    const line = basicHelpText('line');
    const lines = line.split('\n');
    expect(lines[0]).toBe('📖 阿瓦隆百科機器人');
    expect(lines.at(-1)).toBe('/help 主題 看細節（例：/help 模擬；打 /說明 也一樣）');
    for (const cmd of ['/模擬', '/每日一題', '/戰績 名字', '/補位', '/待修正', '/回報', '/意見 文字', '/規則 /角色', '/每日一題 昨天']) expect(line).toContain(cmd);
    // 2026-11-25：多了 /每日一題、規則與角色、去哪裡開局，還是每個功能一行。
    expect(lines.length).toBeLessThanOrEqual(11);
    for (const l of lines) expect(l.split('\n')).toHaveLength(1);
    expect(line).toContain(`🎲 開局、對局：signage-cloud ${PLAY_PLATFORM_URL}`);
    expect(basicHelpText('discord').split('\n').at(-1)).toBe('/help 主題 看細節（例：/help 主題:模擬；打 /說明 也一樣）');
    // 2026-11-25 第二批：兩邊同一個打法（Discord 的 /rules、/roles 照舊可以用，說明裡只寫中文的）。
    for (const p of ['line', 'discord'] as const) expect(basicHelpText(p)).toContain('/規則 /角色\u3000遊戲規則、角色介紹');
    expect(basicHelpText('discord')).toContain('/補位 房號或描述 [人數] [密碼]\u3000叫百科AI 進房補位');
    expect(basicHelpText('discord')).toContain('（/每日一題 哪一天:昨天 看昨天的答案）');
  });
  it('/help 模擬 is the 模擬瓦 command list (same as /模擬 說明); /區間 shows how 百科AI reads, /區間 789=2 checks your own; no /下一步', () => {
    expect(topicHelpText('模擬', 'line')).toBe(SIM_HELP_TEXT);
    expect(topicHelpText('模擬', 'discord')).toBe(SIM_HELP_TEXT_DISCORD);
    expect(SIM_HELP_TEXT).toContain('/區間　百科AI 怎麼讀這個局面');
    expect(SIM_HELP_TEXT).toContain('檢查你自己的區間');
    expect(SIM_HELP_TEXT).toContain('還剩幾種可能');
    expect(SIM_HELP_TEXT).not.toContain('/下一步');
    expect(SIM_HELP_TEXT).toContain('/help 模擬　這份說明（/模擬 說明 也可以）');
    expect(SIM_HELP_TEXT).toContain('「0>9 x」= 0家湖 9家、說紅');
  });
  it('other topics', () => {
    expect(topicHelpText('戰績', 'line', '各人最近 100 場')).toContain('/排行　角色理論勝率排行 Top 10（各人最近 100 場）');
    expect(topicHelpText('補位', 'line')).toContain('/補位');
    expect(topicHelpText('待修正', 'discord')).toContain('/待修正');
    expect(topicHelpText('回報', 'line')).toContain('/認領');
    expect(topicHelpText('意見', 'line')).toContain('/意見 文字');
    expect(helpText(null, 'line')).toBe(basicHelpText('line'));
  });
  it('模擬 is hidden while SIM_COMMANDS_ENABLED is off', () => {
    SIM_CONFIG.commandsEnabled = false;
    expect(basicHelpText('line')).not.toContain('/模擬');
    expect(topicHelpText('模擬', 'line')).toBe('模擬瓦目前沒有開放。');
  });
});

describe('LINE routing', () => {
  it('/help → botHelp (basic), /help 模擬 → the 模擬瓦 list; /指令 keeps the full command list', async () => {
    expect(parseStatsCommand('/help')).toEqual({ kind: 'botHelp', topic: null });
    expect(parseStatsCommand('/help 模擬')).toEqual({ kind: 'botHelp', topic: '模擬' });
    expect(await answerStatsTextCommand('/help', 'line')).toBe(basicHelpText('line'));
    expect(await answerStatsTextCommand('／help 模擬', 'line')).toBe(SIM_HELP_TEXT);
    expect(parseStatsCommand('/指令')).toEqual({ kind: 'help' });
    expect(formatStatsHelp('line')).toContain('/help 主題 看單一功能的細節');
  });
  it('the 模擬-only practice group answers /help, /help 模擬 and /指令 with the 模擬瓦 list', () => {
    for (const t of ['/help', '/help 模擬', '/指令', '／help模擬瓦']) expect(simHelpFor(t)).toBe(SIM_HELP_TEXT);
    expect(simHelpFor('/help 戰績')).toBeNull();
  });
});
