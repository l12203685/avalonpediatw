/**
 * AI騎士的名字（站長 2026-11-26：百科AI 改名 AI騎士_{風格}_{##}）：@avalon/shared knights.ts。
 * 同一份 fixtures/knight_names.json 也給 generate_cache.py 測（test_generate_cache.py KnightNameTest）。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KNIGHT_STATS_NAME, KNIGHT_TEAM_NAME, isKnightBotName, knightDisplayName, knightName, knightSerial, knightStatsName,
  parseKnightName,
} from '@avalon/shared';

interface Case { name: string; display: string; stats: string | null; bot: boolean }
const cases = (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'knight_names.json'), 'utf-8')) as { cases: Case[] }).cases;

describe('AI騎士 名字', () => {
  it.each(cases)('$name', (c) => {
    expect(knightDisplayName(c.name)).toBe(c.display);
    expect(knightStatsName(c.name)).toBe(c.stats);
    expect(isKnightBotName(c.name)).toBe(c.bot);
  });

  it('組名字：風格沒指定就是「百科」、序號兩位數', () => {
    expect(knightName()).toBe('AI騎士_百科');
    expect(knightName(undefined, 3)).toBe('AI騎士_百科_03');
    expect(knightName('穩健', 12)).toBe('AI騎士_穩健_12');
    expect(knightName('  ', 0)).toBe('AI騎士_百科_00');
    expect(knightSerial(7)).toBe('07');
    expect(knightSerial(99)).toBe('99');
    expect(knightSerial(120)).toBe('120');
    expect(DEFAULT_KNIGHT_STATS_NAME).toBe('AI騎士_百科');
    expect(KNIGHT_TEAM_NAME).toBe('AI騎士團');
  });

  it('拆名字：舊名字先換成新的', () => {
    expect(parseKnightName('AI騎士_穩健_01')).toEqual({ style: '穩健', serial: 1 });
    expect(parseKnightName('百科AI_3')).toEqual({ style: '百科', serial: 3 });
    expect(parseKnightName('百科AI')).toEqual({ style: '百科', serial: null });
    expect(parseKnightName('虛構甲')).toBeNull();
  });

  it('補位機器人 0–99 號：新舊名字在戰績上是同一位', () => {
    for (let n = 0; n < 100; n++) {
      expect(knightStatsName(`百科AI_${n}`)).toBe(knightStatsName(knightName('百科', n)));
      expect(knightDisplayName(`百科AI_${n}`)).toBe(knightName('百科', n));
    }
  });
});
