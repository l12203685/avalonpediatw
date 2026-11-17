/**
 * Threads 每日出題草稿（2026-11-17）：
 *   - plan.ts：日期／星期／週次、一週的計畫（週三＋週四、週五＋週六同一局、3-5 只出第二局開紅的局、同一週不重複）；
 *   - draft.ts：新貼文 A＝今天的題目＋昨天的答案（≤ 500 字、引用昨天的貼文、沒有另外串的答案）、延續的日子不公布幾好幾壞和角色、
 *     完整公布附角色與牌譜連結、0 家寫 0、第一天（11/17）沒有昨天的答案；週六沒有連著的局改出第四局忠臣派 5 人；
 *   - generate.ts：存下來的草稿優先（題目、ChatGPT 填的第一則留言保留）、延續跟著前一天實際的那一局；
 *   - image.ts：深色題目卡與答案卡的 SVG／PNG（題目只畫到出題那一刻）、長行斷開。
 * 用 commit 進 repo 的題庫 sim_bank.json（實戰的局，沒有名字）。
 */

import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// 整個題庫建池子、排 8 週：單獨跑 1–2 秒，整套測試平行跑時 CI 上會超過預設的 5 秒。
vi.setConfig({ testTimeout: 60_000 });
import { buildSimBank, readSimBankFile, type SimBank } from '../bots/simulation/bank';
import { readRecordPosts } from '../bots/simulation/recordsIndex';
import { midDecision, publicEvents } from '../bots/simulation/scenario';
import { THREADS_ARTICLES, THREADS_MAX_CHARS, THREADS_TOPIC_TAG, answerText, buildDraft, draftMarkdown, pickView, postText, type ThreadsDraft } from '../bots/threads/draft';
import { ThreadsGenerator } from '../bots/threads/generate';
import { GRID_TARGET_H, buildAnswerSvg, buildGridSvg, buildPuzzleSvg, gridRowHeight, recordLines, renderAnswerPng, renderGridPng, renderPuzzlePng, seatPosition, sheetRows, textWidth, wrapLine } from '../bots/threads/image';
import { THREADS_START_DATE, addDays, buildCandidates, labelFor, planWeek, themeOf, weekIndexOf, weekdayOf, type ThreadsPick } from '../bots/threads/plan';

const serverRoot = path.resolve(__dirname, '..', '..');
let bank: SimBank;
let titles: Map<string, string>;

beforeAll(() => {
  const file = readSimBankFile([path.join(serverRoot, 'sim_bank.json')]);
  if (!file) throw new Error('sim_bank.json missing');
  bank = buildSimBank(file, readRecordPosts([path.join(serverRoot, 'records_cache.json')]));
  const wiki = JSON.parse(fs.readFileSync(path.join(serverRoot, 'wiki_data.json'), 'utf8')) as { id: string; title: string }[];
  titles = new Map(wiki.map((a) => [a.id, a.title] as [string, string]));
});

const gameOf = (pick: ThreadsPick) => bank.games[bank.byId.get(pick.gameId) as number];

describe('dates', () => {
  it('weekday, week index and day arithmetic follow the Taipei calendar date', () => {
    expect(weekdayOf('2026-11-16')).toBe(1);
    expect(weekdayOf('2026-11-22')).toBe(0);
    expect(weekIndexOf('2026-11-16')).toBe(0);
    expect(weekIndexOf('2026-11-22')).toBe(0);
    expect(weekIndexOf('2026-11-23')).toBe(1);
    expect(weekIndexOf('2026-11-15')).toBe(-1);
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(() => weekdayOf('2026-02-30')).toThrow();
  });

  it('the seven themes follow the 2026-11-11 schedule', () => {
    expect(themeOf(1).kind).toBe('assassin');
    expect(themeOf(2).kind).toBe('percival');
    expect(themeOf(3)).toMatchObject({ kind: 'tail', round: 1 });
    expect(themeOf(4)).toMatchObject({ kind: 'tail', round: 3, continues: true });
    expect(themeOf(5)).toMatchObject({ kind: 'tail', round: 2 });
    expect(themeOf(6)).toMatchObject({ kind: 'tail', round: 4, continues: true });
    expect(themeOf(0)).toMatchObject({ kind: 'final', round: 5 });
  });
});

describe('planWeek', () => {
  it('is reproducible, fills every day and links Wed→Thu and Fri→Sat in the same game', () => {
    const candidates = buildCandidates(bank);
    for (let week = 0; week < 12; week++) {
      const plan = planWeek(bank, week, candidates);
      expect(planWeek(bank, week, candidates)).toEqual(plan);
      expect(plan.every((p) => p !== null)).toBe(true);
      const [mon, tue, wed, thu, fri, sat, sun] = plan as ThreadsPick[];
      expect(mon.kind).toBe('assassin');
      expect(gameOf(mon).seatRoles[mon.seat - 1]).toBe('assassin');
      expect(tue.kind).toBe('percival');
      expect(gameOf(tue).seatRoles[tue.seat - 1]).toBe('percival');
      expect(gameOf(tue).proposals[tue.proposal as number].round).toBeGreaterThanOrEqual(2);
      expect(wed).toMatchObject({ kind: 'tail', round: 1 });
      expect(thu).toMatchObject({ kind: 'tail', round: 3, continues: true, gameId: wed.gameId });
      // 3-5 只出第二局開紅的局。
      expect(gameOf(thu).quests.find((q) => q.round === 2)?.failed).toBe(true);
      expect(midDecision(gameOf(thu), 3)).toBe(thu.proposal);
      expect(fri).toMatchObject({ kind: 'tail', round: 2 });
      expect(sat).toMatchObject({ kind: 'tail', round: 4, continues: true, gameId: fri.gameId });
      expect(sun.kind).toBe('final');
      expect(gameOf(sun).proposals[sun.proposal as number].round).toBe(5);
      // 同一週不出同一局兩次（週四、週六延續的除外）。
      const ids = [mon, tue, wed, fri, sun].map((p) => p.gameId);
      expect(new Set(ids).size).toBe(ids.length);
      // 每一題的隊長就是視角的座位。
      for (const p of [tue, wed, thu, fri, sat, sun]) expect(gameOf(p).proposals[p.proposal as number].leaderSeat).toBe(p.seat);
    }
  });

  it('prefers blue viewpoints and games with a records page, and moves on week to week', () => {
    const candidates = buildCandidates(bank);
    const seen = new Set<string>();
    for (let week = 0; week < 8; week++) {
      const plan = planWeek(bank, week, candidates) as ThreadsPick[];
      for (const p of plan.slice(1)) {
        expect(['loyal', 'percival', 'merlin']).toContain(gameOf(p).seatRoles[p.seat - 1]);
      }
      if (bank.records.size > 0) for (const p of plan) expect(bank.records.has(bank.byId.get(p.gameId) as number)).toBe(true);
      seen.add(plan[0].gameId);
    }
    expect(seen.size).toBe(8);
  });
});

describe('draft texts', () => {
  const week = (w: number) => planWeek(bank, w) as ThreadsPick[];

  it('post A (question + yesterday’s answer) fits 500 characters for 8 weeks, ends with the topic tag, writes 0家', () => {
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    for (let i = 0; i < 56; i++) {
      const date = addDays(THREADS_START_DATE, i);
      const d = gen.draftFor(date) as ThreadsDraft;
      expect(d.post.chars).toBeLessThanOrEqual(THREADS_MAX_CHARS);
      expect([...d.post.text].length).toBe(d.post.chars);
      expect(d.post.text.split('\n').at(-1)).toBe(THREADS_TOPIC_TAG);
      expect(d.post.text).not.toMatch(/10\s*[家號]/);
      expect(d.post.text).toContain(d.exerciseId);
      expect(d.post.text).toContain(d.theme);
      // 沒有另外串在昨天底下的答案；答案在 A 裡。
      expect(d).not.toHaveProperty('replyToYesterday');
      if (i === 0) {
        expect(d.answerToYesterday).toBeNull();
        expect(d.quoteYesterday).toBe(false);
        expect(d.post.text).not.toContain('昨天');
      } else {
        expect(d.quoteYesterday).toBe(true);
        const ans = d.answerToYesterday as NonNullable<ThreadsDraft['answerToYesterday']>;
        expect(ans.date).toBe(addDays(date, -1));
        expect(d.post.text).toContain(ans.text);
        expect(ans.text).toContain(`昨天 ${ans.exerciseId} 的答案`);
        // 牌譜連結一定留（不延續的日子）。
        if (!d.continuesYesterday && gen.recordIdOf(ans.exerciseId.split('-')[0])) expect(ans.text).toContain('#records=');
        // 週四、週六延續：不公布幾好幾壞和角色。
        if (d.continuesYesterday) {
          expect([4, 6]).toContain(d.weekday);
          expect(ans.text).not.toMatch(/\d 好 \d 壞/);
          expect(ans.text).not.toMatch(/角色 [刺娜莫奧派梅]/);
          expect(ans.text).toContain('明天公布');
        }
      }
    }
  }, 60_000); // 8 週 56 天的草稿：單獨跑不到 1 秒，整套測試平行跑時 CI 上超過預設的 5 秒

  it('the 11/17 first post stays 36AKW-2-5 and 11/18’s A carries its answer', () => {
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    expect(gen.draftFor('2026-11-17')?.exerciseId).toBe('36AKW-2-5');
    const d = gen.draftFor('2026-11-18') as ThreadsDraft;
    expect(d.answerToYesterday?.exerciseId).toBe('36AKW-2-5');
    expect(d.post.text).toContain('── 昨天 36AKW-2-5 的答案 ──');
    expect(gen.draftFor('2026-11-16')?.answerToYesterday).toBeNull();
  });

  it('a continued answer reveals nothing; the next day reveals both answers', () => {
    const [, , wed, thu] = week(0);
    const wedPv = pickView(gameOf(wed), wed);
    const thuPv = pickView(gameOf(thu), thu);
    const partial = answerText({ yesterday: wedPv, todayContinues: true });
    expect(partial).not.toMatch(/好 \d 壞/);
    expect(partial).not.toMatch(/角色 [刺娜莫奧派梅]/);
    expect(partial).toContain('理由');
    expect(partial).toContain('明天公布');
    const full = answerText({ yesterday: thuPv, earlier: wedPv, todayContinues: false, recordId: 'abc123' });
    expect(full).toContain(`前一題 ${wedPv.exerciseId}`);
    expect(full.match(/\d 好 \d 壞/g)?.length).toBe(2);
    expect(full).toContain('角色 ');
    expect(full).toContain('#records=abc123');
  });

  it('the assassin answer names Merlin and what the real assassin did', () => {
    const [mon] = week(0);
    const pv = pickView(gameOf(mon), mon);
    const text = answerText({ yesterday: pv, todayContinues: false });
    const merlin = gameOf(mon).seatRoles.indexOf('merlin') + 1;
    expect(text).toContain(`梅林是 ${merlin === 10 ? 0 : merlin}家`);
    expect(text).toContain('真人刺');
  });

  it('a continued post says it continues yesterday’s game', () => {
    const [, , wed, thu] = week(0);
    const d = buildDraft({
      date: '2026-11-19',
      today: pickView(gameOf(thu), thu),
      yesterday: { date: '2026-11-18', pv: pickView(gameOf(wed), wed) },
      titles,
    });
    expect(d.quoteYesterday).toBe(true);
    expect(d.continuesYesterday).toBe(true);
    expect(d.post.text).toContain('接昨天那一局');
    expect(d.answerToYesterday?.text).toContain('明天公布');
  });

  it('long records shrink the question before the answer', () => {
    // 找一題完整牌譜寫不下的第 5 局題目。
    const candidates = buildCandidates(bank);
    const long = candidates.final.map((c) => c.picks[0]).find((p) => {
      const pv = pickView(gameOf(p), p);
      return pv.shown.filter((e) => e.kind === 'proposal').length > 22;
    });
    expect(long).toBeDefined();
    const pv = pickView(gameOf(long as ThreadsPick), long as ThreadsPick);
    const answers = [['── 昨天 X 的答案 ──', '長答案'.repeat(10)], ['── 昨天 X 的答案 ──', '短']];
    const text = postText(pv, { weekday: 0, answers });
    expect([...text].length).toBeLessThanOrEqual(THREADS_MAX_CHARS);
    expect(text).toMatch(/第 1 局 任務/);
    expect(text).toContain('長答案');
  });

  it('suggested articles exist in wiki_data.json; the markdown tells the owner to quote yesterday and has no reply section', () => {
    for (const ids of Object.values(THREADS_ARTICLES)) for (const id of ids) expect(titles.has(id), id).toBe(true);
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const mon = gen.draftFor('2026-11-23') as ThreadsDraft;
    expect(mon.firstComment.text).toBeNull();
    expect(mon.firstComment.articles[0].url).toBe('https://avalon-game-platform.web.app/w/wiki-12/');
    const md = draftMarkdown(mon);
    expect(md).toContain('## ① 新貼文 A');
    expect(md).toContain('用「引用」昨天（2026-11-22）的貼文發這篇');
    expect(md).toContain('## ② A 的第一則留言（ChatGPT 填）');
    expect(md).not.toContain('③');
    expect(draftMarkdown(gen.draftFor('2026-11-17') as ThreadsDraft)).toContain('第一天');
  });
});

describe('Saturday fallback', () => {
  it('without a chainable 2-5＋4-5 game, Saturday is a round-4 loyal five-person proposal', () => {
    const small = { games: bank.games.filter((g) => midDecision(g, 2) === null || midDecision(g, 4) === null), records: new Map<number, string>() };
    const plan = planWeek(small, 0) as (ThreadsPick | null)[];
    const sat = plan[5] as ThreadsPick;
    expect(sat.kind).toBe('round4');
    const g = small.games.find((x) => x.id === sat.gameId) as (typeof small.games)[number];
    const p = g.proposals[sat.proposal as number];
    expect(p.round).toBe(4);
    expect(g.seatRoles[p.leaderSeat - 1]).toBe('loyal');
    expect(p.teamSeats.length).toBe(5);
    expect(labelFor(6, sat)).toBe('週六・第四局忠臣派 5 人');
    expect(labelFor(4, { kind: 'tail', round: 3 })).toBe('週四・3-5 尾派');
  });
});

describe('ThreadsGenerator', () => {
  it('keeps a saved pick and ChatGPT’s first comment, and continues the saved game', () => {
    const fresh = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const planned = fresh.pickFor('2026-11-18') as ThreadsPick;
    // 找一局不同、也有 1-5 和 3-5 的局，假裝週三實際貼的是它。
    const other = buildCandidates(bank).wedThu.map((c) => c.picks[0]).find((p) => p.gameId !== planned.gameId) as ThreadsPick;
    const saved: Record<string, ThreadsDraft> = {};
    const wedDraft = fresh.draftFor('2026-11-18') as ThreadsDraft;
    saved['2026-11-18'] = { ...wedDraft, pick: other, firstComment: { ...wedDraft.firstComment, text: '冷知識' } };
    const gen = new ThreadsGenerator({ bank, titles, readSaved: (d) => saved[d] ?? null });
    expect(gen.pickFor('2026-11-18')).toEqual(other);
    expect(gen.draftFor('2026-11-18')?.firstComment.text).toBe('冷知識');
    const thu = gen.pickFor('2026-11-19') as ThreadsPick;
    expect(thu).toMatchObject({ gameId: other.gameId, round: 3, continues: true });
    const friday = gen.draftFor('2026-11-20') as ThreadsDraft;
    expect(friday.answerToYesterday?.text).toContain(`前一題 ${other.gameId}-1-5`);
    expect(friday.post.text).toContain(friday.answerToYesterday?.text as string);
  });
});

describe('image', () => {
  it('builds an SVG with the exercise id and renders a PNG', () => {
    const [mon, , wed] = planWeek(bank, 0) as ThreadsPick[];
    const pv = pickView(gameOf(wed), wed);
    const svg = buildPuzzleSvg(pv, 3);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(pv.exerciseId);
    expect(svg).toContain('週三・1-5 尾派');
    const png = renderPuzzlePng(pickView(gameOf(mon), mon), 1);
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('draws the record only up to the decision: no later vote, mission or lake reaches the renderer', () => {
    let truncated = 0;
    for (let w = 0; w < 8; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const game = gameOf(pick);
        const pv = pickView(game, pick);
        const rows = sheetRows(pv);
        expect(rows.length).toBe(pv.shown.length + 1);
        const last = rows[rows.length - 1];
        expect(last.kind).toBe('decision');
        if (pick.proposal === null) continue; // 刺殺題：整局都公開，只有角色不公開
        const p = game.proposals[pick.proposal];
        for (const r of rows.slice(0, -1)) {
          if (r.kind === 'proposal') expect(r.index).toBeLessThan(pick.proposal);
          else expect(r.round).toBeLessThan(p.round);
        }
        if (last.kind === 'decision') expect([last.round, last.attempt, last.leaderSeat]).toEqual([p.round, p.attempt, pick.seat]);
        if (publicEvents(game).length > pv.shown.length) truncated++;
      }
    }
    expect(truncated).toBeGreaterThan(30); // 檢查真的有東西被截掉
  });

  it('the card’s record lines use the site notation and only the rows the renderer got', () => {
    const [, , wed, thu] = planWeek(bank, 0) as ThreadsPick[];
    for (const pick of [wed, thu]) {
      const pv = pickView(gameOf(pick), pick);
      const rows = sheetRows(pv);
      const lines = recordLines(rows).map((l) => l.map((p) => p.t).join(''));
      const proposals = rows.filter((r) => r.kind === 'proposal');
      // 每次提議一行（隊長＋DC 格式），任務一行，湖一行，每局一個標題
      for (const r of proposals) if (r.kind === 'proposal') expect(lines.some((l) => l.startsWith(`${r.leaderSeat === 10 ? '0' : r.leaderSeat}家 ${r.line}`))).toBe(true);
      expect(lines.filter((l) => l.startsWith('任務：')).length).toBe(rows.filter((r) => r.kind === 'quest').length);
      expect(lines.filter((l) => l.startsWith('湖：')).length).toBe(rows.filter((r) => r.kind === 'lake').length);
      expect(lines.join('\n')).not.toMatch(/10\s*[家號]/);
    }
  });

  it('seats sit around a round table: 1 at the top, clockwise to 0 at the upper left', () => {
    const top = seatPosition(1, 540, 500);
    expect(top.x).toBeCloseTo(540);
    expect(top.y).toBeLessThan(500);
    expect(seatPosition(3, 540, 500).x).toBeGreaterThan(540); // 右半圈
    expect(seatPosition(6, 540, 500).y).toBeGreaterThan(500); // 正下方
    expect(seatPosition(10, 540, 500).x).toBeLessThan(540); // 0 在左上
    const [, tue] = planWeek(bank, 0) as ThreadsPick[];
    const svg = buildPuzzleSvg(pickView(gameOf(tue), tue), 2);
    expect(svg).toContain('<ellipse'); // 圓桌
    expect(svg).toContain('拇指');
  });

  it('the grid image is the site scoresheet built only from the rendered rows, and fits 4:5 for normal games', () => {
    for (let w = 0; w < 4; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const pv = pickView(gameOf(pick), pick);
        const rows = sheetRows(pv);
        const svg = buildGridSvg(pv, 3);
        // 每次提議的文字紀錄都在圖上，而且只有出題前的列（列來自 sheetRows，截斷由上面的測試鎖住）
        for (const r of rows) if (r.kind === 'proposal') expect(svg).toContain(`>${r.line.split(' ')[0]}<`);
        expect((svg.match(/<path /g) ?? []).length).toBe(rows.reduce((n, r) => n + (r.kind === 'proposal' ? r.team.length : 0), 0));
        const h = Number(/height="(\d+)"/.exec(svg)?.[1]);
        if (rows.length <= 22) expect(h).toBeLessThanOrEqual(GRID_TARGET_H);
        expect(svg).not.toMatch(/10\s*家/);
      }
    }
    expect(gridRowHeight(5)).toBe(60);
    expect(gridRowHeight(40)).toBe(34);
    const [, , wed] = planWeek(bank, 0) as ThreadsPick[];
    expect(renderGridPng(pickView(gameOf(wed), wed), 3).subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('the answer card lists yesterday’s blue and red roles and the result', () => {
    const [, tue] = planWeek(bank, 0) as ThreadsPick[];
    const pv = pickView(gameOf(tue), tue);
    const svg = buildAnswerSvg(pv);
    for (const role of ['派西維爾', '梅林', '刺客', '莫甘娜']) expect(svg).toContain(role);
    // 站長 11/17「刺娜德奧派梅」：紅方在上、藍方在下
    expect(svg.indexOf('紅方')).toBeLessThan(svg.indexOf('藍方'));
    expect(svg.indexOf('刺客')).toBeLessThan(svg.indexOf('莫甘娜'));
    expect(svg.indexOf('莫甘娜')).toBeLessThan(svg.indexOf('派西維爾'));
    expect(svg).toContain('結果：');
    expect(svg).toContain(pv.exerciseId);
    expect(svg).not.toMatch(/10\s*家/);
    expect(renderAnswerPng(pv).subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('rows follow the site notation: votes, approve counts, 強制, DC text line, lake o/x', () => {
    for (let w = 0; w < 4; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const pv = pickView(gameOf(pick), pick);
        for (const r of sheetRows(pv)) {
          if (r.kind === 'proposal') {
            expect(r.votes).toHaveLength(10);
            if (r.forced || !r.reliable) {
              expect(r.votes.every((v) => v === 'none')).toBe(true);
              expect(r.approves).toBeNull();
            } else {
              expect(r.approves).toBe(r.votes.filter((v) => v === 'approve').length);
              if (r.approved) expect(r.approves as number).toBeGreaterThanOrEqual(6);
            }
            expect(r.line.split(' ')[0]).toBe(r.team.map((x) => (x === 10 ? '0' : String(x))).join(''));
          }
          if (r.kind === 'lake') expect(['o', 'x', '']).toContain(r.claim);
        }
      }
    }
  });

  it('the post text keeps theme, record, question, yesterday’s answer, 題號 and the tag only', () => {
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const d = gen.draftFor('2026-11-18') as ThreadsDraft;
    const lines = d.post.text.split('\n');
    expect(lines[0]).toContain('週三・1-5 尾派');
    expect(lines.at(-2)).toBe(`題號 ${d.exerciseId}`);
    expect(lines.at(-1)).toBe(THREADS_TOPIC_TAG);
    expect(d.post.text).not.toContain('留言寫');
  });

  it('wraps long lines at a comma or bracket', () => {
    expect(wrapLine('短', 30, 500)).toEqual(['短']);
    const parts = wrapLine('湖：0家 湖 8家，說好人（o）（你看到的：紅）', 26, 300);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(textWidth(p, 26)).toBeLessThanOrEqual(300);
  });
});
