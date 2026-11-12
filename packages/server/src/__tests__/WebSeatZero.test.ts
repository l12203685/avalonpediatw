/**
 * 座位寫法（站長 2026-11-12）：第十個座位一律寫「0 家」，不寫「10 號」「10 家」；座位範圍寫「6～0 家」「1～9、0 家」。
 * 只管座位：「10 人局」「10 人」這類人數照舊。
 * 掃使用者看得到的文字：百科（wiki_data.json 與 docs/avalon-wiki 副本）、繁中／英文介面字串、llms.txt 的開頭、
 * 練習模式字串、機器人回給玩家的訊息（bots/ 與牌譜匯入的 Discord 回覆）。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { displaySeatKey, seatListLabel, seatRangeLabel } from '../../../web/src/utils/seatDisplay';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** 「10 號」「10家」…；「10 人」不算。 */
const SEAT_TEN = /10\s*(號|家)/;
/** 「6–10」「1～10」這種座位範圍（前面不是數字、日期或代號，後面不是人數、時間等單位）。 */
const SEAT_RANGE_TO_TEN = /(?<![\w\-./])[1-9]\s*[–～~-]\s*10(?!\s*(人|分鐘|\d|局|%|年|月|日|次|場))/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

/** 每一行 → 違規的片段（code 檔跳過註解行）。 */
function offenders(rel: string, text: string, code: boolean): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (code && /^\s*(\*|\/\/|\/\*|#)/.test(line)) return;
    for (const re of [SEAT_TEN, SEAT_RANGE_TO_TEN]) {
      const m = re.exec(line);
      if (m) out.push(`${rel}:${i + 1}: …${line.slice(Math.max(0, m.index - 20), m.index + m[0].length + 10)}…`);
    }
  });
  return out;
}

describe('seat 0 (站長 2026-11-12：座位寫 0 家，不寫 10 號／10 家)', () => {
  it('the wiki never writes seat 10 (articles, titles, excerpts)', () => {
    const articles = JSON.parse(read('packages/server/wiki_data.json')) as Array<Record<string, unknown>>;
    const bad: string[] = [];
    for (const a of articles) {
      for (const [k, v] of Object.entries(a)) {
        if (typeof v === 'string') bad.push(...offenders(`${a.id}.${k}`, v, false));
      }
    }
    expect(bad).toEqual([]);
    // player counts stay
    expect(articles.some((a) => /10 人局/.test(String(a.content)))).toBe(true);
  });

  it('the docs/avalon-wiki copies never write seat 10', () => {
    const dir = path.join(ROOT, 'docs', 'avalon-wiki');
    const bad = walk(dir).filter((f) => f.endsWith('.md')).flatMap((f) => offenders(path.relative(ROOT, f), fs.readFileSync(f, 'utf-8'), false));
    expect(bad).toEqual([]);
  });

  it('the zh-TW UI strings never write seat 10; seat labels say 家', () => {
    const text = read('packages/web/src/i18n/locales/zh-TW/common.json');
    expect(offenders('zh-TW/common.json', text, false)).toEqual([]);
    expect(text).not.toMatch(/\{\{(n|seat|seats|hiSeat|loSeat)\}\}\s*號/);
    expect(text).toContain('"back": "6～0 家合計"');
  });

  it('the en UI strings say seat 0, not seat 10', () => {
    const text = read('packages/web/src/i18n/locales/en/common.json');
    expect(text).not.toMatch(/seats? 10\b|seats? [1-9]\s*[–-]\s*10\b|\(1-10\)/i);
  });

  it('generated text, practice strings and bot replies never write seat 10', () => {
    const files = [
      'packages/web/src/utils/llmsTxt.ts',
      'packages/web/src/i18n/practice.ts',
      'packages/shared/src/stats/strength.ts',
      'packages/shared/src/stats/discovery.ts',
      'packages/server/discord_records_import.py',
      ...walk(path.join(ROOT, 'packages', 'server', 'src', 'bots')).filter((f) => f.endsWith('.ts')).map((f) => path.relative(ROOT, f)),
    ];
    expect(files.flatMap((f) => offenders(f, read(f), true))).toEqual([]);
  });

  it('stats tables show the tenth seat as 0 and keep the data keys', () => {
    // overview / roleSeatStats key the tenth seat "10", players[] and records key it "0": both display 0
    expect(['1', '5', '9', '10', '0', 10, 3].map(displaySeatKey)).toEqual(['1', '5', '9', '0', '0', '0', '3']);
  });

  it('playstyle assassin seats read as 家 lists and ranges, never 1–0 or 5-0-2', () => {
    expect(seatListLabel([5, 10, 2])).toBe('5、0、2 家');
    expect(seatRangeLabel([10, 6, 8])).toBe('6～0 家');
    expect(seatRangeLabel([1, 10, 4])).toBe('1～9、0 家');
    expect(seatRangeLabel([7, 3])).toBe('3～7 家');
    expect(seatRangeLabel([10])).toBe('0 家');
  });

  it('the wiki defines the tenth seat one way: 第十個座位', () => {
    const wiki = read('packages/server/wiki_data.json');
    expect(wiki).not.toMatch(/第\s*10\s*位/);
    expect(wiki).toContain('第十個座位稱為 **0 家**');
  });
});
