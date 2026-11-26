/**
 * AI騎士團（站長 2026-11-26：與百科AI 有關的全部挪到一個頁面下；百科AI 改名 AI騎士_{風格}_{##}）：
 * 網站的深連結（新的 #ai-knights、#my-knight；舊連結照樣開對的分頁）、對局標題新舊都認、排行榜上舊名字顯示成新名字、
 * 伺服器給網站的 trace 與牌譜也把舊名字換成新名字（存下來的紀錄不改）。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { knightDisplayName as webKnightDisplayName } from '../../../web/src/utils/knightNames';
import { withKnightNames } from '../../../web/src/services/api';
import type { RecordList } from '../../../web/src/utils/records';
import { PUBLIC_STATS_STATES, parseStatsHash } from '../../../web/src/utils/statsLinks';
import { parseAiGameName } from '../../../web/src/utils/aiGames';
import { parseLeaderboard } from '../../../web/src/utils/arena';
import { publicTrace } from '../routes/aiGames';
import { recordNameRenames, renameRecordNames } from '../services/recordsList';
import { isAiGameThread } from '../services/aiGameForum';
import { aiGameThreadName, AI_GAME_TAG_NAME, type AiGameTrace } from '../services/aiGameTrace';

describe('AI騎士團 deep links', () => {
  it('new links open the hub; old links still open their tab', () => {
    for (const h of ['#ai-knights', '#AI-Knights', '#knights', '#AI騎士團', '#AI%E9%A8%8E%E5%A3%AB%E5%9C%98']) {
      expect(parseStatsHash(h)).toEqual({ kind: 'aiGames', id: null });
    }
    for (const h of ['#my-knight', '#myknight', '#我的騎士']) expect(parseStatsHash(h)).toEqual({ kind: 'myKnight' });
    expect(PUBLIC_STATS_STATES.has('myKnight')).toBe(true);
    expect(parseStatsHash('#ai-games')).toEqual({ kind: 'aiGames', id: null });
    expect(parseStatsHash('#ai-history')).toEqual({ kind: 'aiHistory' });
    expect(parseStatsHash('#arena')).toEqual({ kind: 'arena' });
    expect(parseStatsHash('#collab')).toEqual({ kind: 'collab' });
    expect(parseStatsHash('#practice')).toEqual({ kind: 'practice' });
    expect(parseStatsHash('#seat-filler')).toEqual({ kind: 'aiGames', id: null });
  });
});

describe('AI騎士 對局 titles', () => {
  const trace = { startedAt: '2026-11-26T13:05:00.000Z', endedAt: '', room: 'Room-1460', title: '週四練習團' };

  it('new threads start with AI騎士對局; the site reads old and new titles', () => {
    const name = aiGameThreadName(trace);
    expect(name.startsWith('AI騎士對局 ')).toBe(true);
    expect(parseAiGameName(name)).toEqual({ when: '2026-11-26 21:05', where: '週四練習團／Room-1460' });
    expect(parseAiGameName('百科AI對局 20261105_2105 週四練習團／Room-1460')).toEqual({ when: '2026-11-05 21:05', where: '週四練習團／Room-1460' });
    expect(parseAiGameName('【待檢視】含百科機器人_20261105_2105_Room-1460').where).toBe('【待檢視】含AI騎士_20261105_2105_Room-1460');
    // DC 上已經建好的標籤名字不改
    expect(AI_GAME_TAG_NAME).toBe('百科AI對局');
  });

  it('the forum reader accepts old and new thread titles', () => {
    const t = (name: string): Parameters<typeof isAiGameThread>[0] => ({ id: '1570000000000000001', parent_id: 'f', name }) as Parameters<typeof isAiGameThread>[0];
    for (const name of ['AI騎士對局 20261126_2105 x', '百科AI對局 20261105_2105 x', '【待檢視】含AI騎士_20261126', '【待檢視】含百科機器人_20261105']) {
      expect(isAiGameThread(t(name), 'f')).toBe(true);
    }
    expect(isAiGameThread(t('一般牌譜 20261126'), 'f')).toBe(false);
    expect(isAiGameThread(t('AI騎士對局 x'), 'other')).toBe(false);
  });
});

describe('old bot names show as new names (stored records unchanged)', () => {
  it('the web copy of knightDisplayName matches the shared fixture', () => {
    const cases = (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'knight_names.json'), 'utf-8')) as { cases: { name: string; display: string }[] }).cases;
    for (const c of cases) expect(webKnightDisplayName(c.name)).toBe(c.display);
  });

  it('web records list: bot seat names shown with the new name, the same object when nothing changes', () => {
    const list = { posts: [{ id: 'a', game: { names: ['百科AI_3', '虛構甲'] } }, { id: 'b', game: null }] } as unknown as RecordList;
    const out = withKnightNames(list);
    expect(out.posts[0].game?.names).toEqual(['AI騎士_百科_03', '虛構甲']);
    expect(out.posts[1]).toBe(list.posts[1]);
    const plain = { posts: [{ id: 'c', game: { names: ['虛構乙'] } }] } as unknown as RecordList;
    expect(withKnightNames(plain)).toBe(plain);
  });

  it('public trace: AI seats and decisions get the new name; humans stay anonymous', () => {
    const t = {
      seats: [{ seat: 1, name: '百科AI_21', ai: true }, { seat: 2, name: '虛構甲', ai: false }, { seat: 3, name: 'AI騎士_百科_22', ai: true }],
      decisions: [{ seat: 1, nick: '百科AI_21' }, { seat: 3, nick: 'AI騎士_百科_22' }],
    } as unknown as AiGameTrace;
    const out = publicTrace(t);
    expect(out.seats.map((s) => s.name)).toEqual(['AI騎士_百科_21', '', 'AI騎士_百科_22']);
    expect(out.decisions.map((d) => d.nick)).toEqual(['AI騎士_百科_21', 'AI騎士_百科_22']);
    expect(t.seats[0].name).toBe('百科AI_21');
  });

  it('records: bot seat names keep their number with the new name; aliases still apply to people', () => {
    const renames = recordNameRenames({ aliases: { 百科AI_3: '百科AI', 虛構乙2: '虛構乙' } });
    expect([...renames.keys()]).toEqual(['虛構乙2']);
    const post = { game: { names: ['百科AI_3', '虛構乙2', 'AI騎士_百科_04', '虛構丙'] } };
    expect(renameRecordNames(post, renames)).toEqual({ game: { names: ['AI騎士_百科_03', '虛構乙', 'AI騎士_百科_04', '虛構丙'] } });
    expect(renameRecordNames(post, new Map())).toEqual({ game: { names: ['AI騎士_百科_03', '虛構乙2', 'AI騎士_百科_04', '虛構丙'] } });
    const plain = { game: { names: ['虛構丙'] } };
    expect(renameRecordNames(plain, new Map())).toBe(plain);
  });

  it('arena leaderboard: the old reference name shows as AI騎士_百科', () => {
    const bot = (id: string, name: string): object => ({ id, name, rating: { overall: { rating: 1500 } }, red: { winRate: 0.4 }, blue: { winRate: 0.6 } });
    const board = parseLeaderboard({ schema: 1, bots: [bot('baike', '百科AI'), bot('x', '百科AI迷')] });
    expect(board?.bots.map((b) => b.name)).toEqual(['AI騎士_百科', '百科AI迷']);
  });
});
