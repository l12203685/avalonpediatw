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
import { isRed, midDecision, publicEvents } from '../bots/simulation/scenario';
import { THREADS_ARTICLES, THREADS_MAX_CHARS, THREADS_TOPIC_TAG, answerText, buildDraft, draftMarkdown, pickView, postText, type ThreadsDraft } from '../bots/threads/draft';
import { ThreadsGenerator } from '../bots/threads/generate';
import { GRID_ROW_MIN, GRID_TARGET_H, buildAnswerSvg, buildGridSvg, buildPuzzleSvg, cardLayout, gridOverflowStart, recordLines, renderAnswerPng, renderGridPng, renderPuzzlePng, seatPosition, sheetRows, textWidth, voteLegend, wrapLine, missionChips, lakeLine, missionTeam, identityText, identityLines, lakeLines, logoRimPoint, cardSheetRows, buildGridSvgs, gridPages, rowRound, cardTop, lakeKnowledge, lakeEntries, lakeBlock, seatMarks, resolveThumbs, THREADS_ASSET_DIR } from '../bots/threads/image';
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

/** 題目卡加上續圖（一整組輪播的牌譜 SVG）：每一列都在其中一張。 */
function allSvg(pv: ReturnType<typeof pickView>, weekday: number): string {
  return [buildPuzzleSvg(pv, weekday), ...buildGridSvgs(pv, weekday)].join('\n');
}

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
      expect(d.post.text).not.toContain(`題號 ${d.exerciseId}`); // 站長 11/17：貼文不寫題號（在圖上）
      expect(d.post.text).toContain(d.theme);
      expect(d.post.text.split('\n').at(-2)).toBe(''); // 標籤前空一行
      expect(d.post.text).not.toMatch(/^第 \d+ 局：$/m); // 每一局寫「[第 N 局]」
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

  it('the first day of the series is standalone; the next day carries its answer; nothing is hardcoded as posted on 11/17', () => {
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null, startDate: '2026-11-18' });
    const first = gen.draftFor('2026-11-18') as ThreadsDraft;
    expect(first.answerToYesterday).toBeFalsy();
    expect(first.quoteYesterday).toBeFalsy();
    const next = gen.draftFor('2026-11-19') as ThreadsDraft;
    expect(next.answerToYesterday?.exerciseId).toBe(first.exerciseId);
    expect(next.post.text).toContain(`[昨天 ${first.exerciseId} 的答案]`);
    // 昨天沒有真的貼文（hasPost）：今天也是獨立的一篇
    const noPost = new ThreadsGenerator({ bank, titles, readSaved: () => null, startDate: '2026-11-18', hasPost: () => false });
    expect(noPost.draftFor('2026-11-20')?.answerToYesterday).toBeFalsy();
    expect(THREADS_START_DATE).toBe('2026-11-17'); // 站長 11/17：「我想從11/17開始」
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
    const answers = [['[昨天 X 的答案]', '長答案'.repeat(10)], ['[昨天 X 的答案]', '短']];
    const text = postText(pv, { weekday: 0, answers });
    expect([...text].length).toBeLessThanOrEqual(THREADS_MAX_CHARS);
    expect(text).toMatch(/\[第 1 局\] 任務/);
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
    // 站長 11/17：一行標題「阿瓦隆百科 ‧ 每日一題: 1-5 第一局尾派 [SV1Q8]」，左上角小標誌
    expect(svg).toContain(`阿瓦隆百科 ‧ 每日一題: 1-5 第一局尾派 [${pv.pick.gameId}]`);
    expect(svg).toContain('class="header-logo"');
    expect(svg).not.toContain('週三・1-5 尾派');
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

  it('seats sit around a small round table: 0 at twelve o’clock, clockwise, 5 at six o’clock', () => {
    const top = seatPosition(10, 300, 400);
    expect(top.x).toBeCloseTo(300);
    expect(top.y).toBeLessThan(400);
    const bottom = seatPosition(5, 300, 400);
    expect(bottom.x).toBeCloseTo(300);
    expect(bottom.y).toBeGreaterThan(400);
    for (const seat of [1, 2, 3, 4]) expect(seatPosition(seat, 300, 400).x).toBeGreaterThan(300); // 右邊往下
    for (const seat of [6, 7, 8, 9]) expect(seatPosition(seat, 300, 400).x).toBeLessThan(300); // 左邊往上
    expect(seatPosition(1, 300, 400).y).toBeLessThan(seatPosition(4, 300, 400).y);
    expect(seatPosition(9, 300, 400).y).toBeLessThan(seatPosition(6, 300, 400).y);
    const [, tue] = planWeek(bank, 0) as ThreadsPick[];
    const svg = buildPuzzleSvg(pickView(gameOf(tue), tue), 2);
    expect(svg).not.toContain('<ellipse'); // 不是橢圓
    expect(svg).toContain('拇指');
    // 正圓：每個座位離圓心一樣遠（站長 11/18「座位不要橢圓 直接圍繞 logo」）
    const d = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seat) => Math.hypot(seatPosition(seat, 300, 400).x - 300, seatPosition(seat, 300, 400).y - 400));
    for (const x of d) expect(x).toBeCloseTo(d[0], 6);
  });

  it('the question card shows the whole record (proposals, missions, lakes) up to the question; only a record too tall moves its earliest whole rounds to continuation images; every row drawn once, all ≤ 1350', () => {
    let whole = 0;
    let total = 0;
    const shields = (svg: string): number => (svg.match(/class="team-shield"/g) ?? []).length;
    for (let w = 0; w < 4; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        total++;
        const pv = pickView(gameOf(pick), pick);
        const rows = sheetRows(pv);
        const teamCount = (rs: readonly (typeof rows)[number][]): number => rs.reduce((n, r) => n + (r.kind === 'proposal' ? r.team.length : 0), 0);
        const card = buildPuzzleSvg(pv, 3);
        expect(Number(/height="(\d+)"/.exec(card)?.[1])).toBeLessThanOrEqual(GRID_TARGET_H);
        const cardRows = cardSheetRows(pv);
        const pages = gridPages(pv);
        const start = rows.length - cardRows.length;
        expect(cardRows).toEqual(rows.slice(start)); // 題目卡一路畫到「輪到你」
        expect(shields(card)).toBe(teamCount(cardRows));
        if (!pages.length) {
          whole++;
          expect(start).toBe(0); // 整份牌譜都在題目卡
          expect(gridOverflowStart(pv)).toBeNull();
          expect(card).not.toContain('在後面的圖');
        } else {
          // 放不下：最早的幾局在續圖，從第 1 列接到題目卡第 1 列；不把一局拆開
          expect(gridOverflowStart(pv)).toBe(start);
          expect(rowRound(rows[start])).not.toBe(rowRound(rows[start - 1]));
          expect(pages[0].start).toBe(0);
          for (let i = 1; i < pages.length; i++) expect(pages[i].start).toBe(pages[i - 1].end);
          expect(pages.at(-1)?.end).toBe(start);
          const svgs = buildGridSvgs(pv, 3);
          expect(svgs).toHaveLength(pages.length);
          svgs.forEach((svg, i) => {
            expect(shields(svg)).toBe(teamCount(rows.slice(pages[i].start, pages[i].end)));
            expect(Number(/height="(\d+)"/.exec(svg)?.[1])).toBeLessThanOrEqual(GRID_TARGET_H);
          });
          expect(card).toContain(`前面幾局的牌譜在後面的圖（往右滑）｜1/${pages.length + 1}`);
        }
        // 任務結果、湖中都在同一份表格裡
        expect((card.match(/class="lake-line"/g) ?? []).length).toBe(rows.filter((r) => r.kind === 'lake').length);
        expect(card).not.toMatch(/10\s*家/);
      }
    }
    expect(whole).toBeGreaterThan(total * 0.9); // 絕大多數一張就放得下
    expect(cardLayout(5)).toMatchObject({ overflow: false, cardRows: 5 });
    expect(cardLayout(60).overflow).toBe(true);
  });

  it('the 阿瓦隆百科 logo sits subdued in the middle of the small round table; the question card drops the big watermark', () => {
    const [, tue] = planWeek(bank, 0) as ThreadsPick[];
    const svg = buildPuzzleSvg(pickView(gameOf(tue), tue), 2);
    expect(svg).toContain('<clipPath id="tl"><circle'); // 標誌裁成圓形徽章、放在桌面正中
    expect(svg).toMatch(/<image href="data:image\/png;base64,[^"]+" [^>]*opacity="0\.3" clip-path="url\(#tl\)"/);
    expect(svg).not.toContain('clip-path="url(#wm)"'); // 題目卡不再鋪大浮水印
    // 標誌在任務格和座位之前畫（在它們下面）
    expect(svg.indexOf('url(#tl)')).toBeLessThan(svg.indexOf('任務1'));
    // 答案卡照舊有浮水印
    expect(buildAnswerSvg(pickView(gameOf(tue), tue))).toContain('clip-path="url(#wm)"');
  });

  it('the round table is only the ten seats around the logo; mission chips sit in the right block, wrapping when narrow', () => {
    const [, tue] = planWeek(bank, 0) as ThreadsPick[];
    const pv = pickView(gameOf(tue), tue);
    const svg = buildPuzzleSvg(pv, 2);
    // 任務格在右邊（「你的視角」那一欄，x ≥ 600），不在圓桌裡
    const chip = /<text x="([\d.]+)" y="[\d.]+"[^>]*>(?:<tspan[^>]*>)?任務1/.exec(svg);
    expect(chip).not.toBeNull();
    expect(Number(chip![1])).toBeGreaterThan(480);
    const one = missionChips(sheetRows(pv), 0, 0, 500);
    const two = missionChips(sheetRows(pv), 0, 0, 200);
    expect(two.height).toBeGreaterThan(one.height); // 寬度不夠就換行
    for (let r = 1; r <= 5; r++) expect(one.svg).toContain(`>任務${r}<`); // 站長的格式：[任務N]（結果）{座位}
    expect(one.svg).not.toContain('・'); // 不再寫 1・3
  });

  it('the Lady of the Lake is one line under the mission chips (0 > 1 o | 1 > 9 o（看到好） | 9 > 4 x); no arrows on the table', () => {
    const rows = [
      { kind: 'lake' as const, round: 2, holderSeat: 10, targetSeat: 1, claim: 'o' as const },
      { kind: 'lake' as const, round: 3, holderSeat: 1, targetSeat: 9, claim: 'o' as const, seen: 'good' as const },
      { kind: 'lake' as const, round: 4, holderSeat: 9, targetSeat: 4, claim: 'x' as const },
      { kind: 'lake' as const, round: 4, holderSeat: 4, targetSeat: 2, claim: '' as const },
    ];
    const line = lakeLine(rows).map((g) => g.t).join('');
    expect(line).toBe('0 > 1 o | 1 > 9 o | 9 > 4 x | 4 > 2 沒說'); // 看到的結果不放旁邊
    // （看到好）放在那一筆的正下方
    const block = lakeBlock(lakeEntries(rows), 100, 500, 24).svg;
    const note = /<text x="([\d.]+)" y="([\d.]+)"[^>]*>(?:<tspan[^>]*>)?（看到好）/.exec(block)!;
    expect(Number(note[2])).toBeGreaterThan(500);
    const entryX = 100 + textWidth('0 > 1 o | ', 24);
    expect(Number(note[1])).toBeCloseTo(entryX, 0);
    const segsOf = lakeLine(rows);
    expect(segsOf.find((g) => g.t === 'o')?.fill).not.toBe(segsOf.find((g) => g.t === 'x')?.fill); // o 藍、x 紅
    expect(lakeLine([])).toEqual([]);
    for (let w = 0; w < 4; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const pv = pickView(gameOf(pick), pick);
        const svg = buildPuzzleSvg(pv, 3);
        expect(svg).not.toContain('lake-arrow');
        for (const r of sheetRows(pv)) if (r.kind === 'lake') expect(svg).toContain(`${r.holderSeat === 10 ? '0' : r.holderSeat} &gt; ${r.targetSeat === 10 ? '0' : r.targetSeat} `);
      }
    }
  });

  it('each played mission chip shows the result and the seats that went (the approved team, 0 for seat 10); no tags under the seats', () => {
    for (let w = 0; w < 4; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const pv = pickView(gameOf(pick), pick);
        const rows = sheetRows(pv);
        const chips = missionChips(rows, 0, 0, 500).svg;
        for (let r = 1; r <= 5; r++) {
          const q = rows.find((x) => x.kind === 'quest' && x.round === r);
          const team = missionTeam(rows, r);
          if (!q) {
            expect(team).toEqual([]); // 還沒出的任務照舊
            continue;
          }
          const approved = rows.find((x) => x.kind === 'proposal' && x.round === r && x.approved);
          expect(team).toEqual(approved && approved.kind === 'proposal' ? approved.team : []);
          expect(team).toHaveLength([3, 4, 4, 5, 5][r - 1]);
          expect(chips).toContain(`>${team.map((x) => (x === 10 ? '0' : String(x))).join('')}<`);
        }
        expect(buildPuzzleSvg(pv, 3)).not.toMatch(/>m[1-5](×\d)?</); // 座位下方不再有 m1 標籤
      }
    }
  });

  it('lake lines on the table: holder → target arrows anchored at the logo rim, declaration on the line, latest emphasized; no proposal lines', () => {
    const lake = (round: number, holderSeat: number, targetSeat: number, claim: 'o' | 'x' | '') => ({ kind: 'lake' as const, round, holderSeat, targetSeat, claim });
    const svg = lakeLines([lake(2, 10, 2, 'o'), lake(3, 2, 4, 'x'), lake(4, 4, 1, '')], 300, 400);
    expect((svg.match(/class="lake-line"/g) ?? []).length).toBe(3);
    expect((svg.match(/class="lake-head"/g) ?? []).length).toBe(3);
    expect(svg).toContain('>o<');
    expect(svg).toContain('>x<');
    expect(svg).toContain('>?<');
    // 起點在拿湖的人的切點、箭頭尖端在被湖的人的切點
    const first = /<line x1="([\d.]+)" y1="([\d.]+)"[^>]*class="lake-line"/.exec(svg)!;
    expect(Number(first[1])).toBeCloseTo(logoRimPoint(10, 300, 400).x, 0);
    expect(Number(first[2])).toBeCloseTo(logoRimPoint(10, 300, 400).y, 0);
    const head = /<path d="M([\d.]+) ([\d.]+) /.exec(svg)!;
    expect(Number(head[1])).toBeCloseTo(logoRimPoint(2, 300, 400).x, 0);
    expect(Number(head[2])).toBeCloseTo(logoRimPoint(2, 300, 400).y, 0);
    // 最新的一次湖比較粗
    const widths = [...svg.matchAll(/stroke-width="([\d.]+)" class="lake-line"/g)].map((m) => Number(m[1]));
    expect(widths[2]).toBeGreaterThan(widths[0]);
    expect(lakeLines([], 300, 400)).toBe('');
    // 題目卡畫出題那一刻知道的每一次湖；沒有派票連線
    for (let w = 0; w < 2; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const pv = pickView(gameOf(pick), pick);
        const card = buildPuzzleSvg(pv, 3);
        expect((card.match(/class="lake-line"/g) ?? []).length).toBe(sheetRows(pv).filter((r) => r.kind === 'lake').length);
        expect(card).not.toContain('class="lane');
      }
    }
  });

  it('official art: known-alignment seats get the faded team medallion center (embedded once); the vote grid keeps the drawn yellow shield', () => {
    for (const f of ['seat-good.png', 'seat-evil.png']) expect(fs.existsSync(path.join(THREADS_ASSET_DIR, f))).toBe(true);
    // 梅林看到的紅：紅色陣營圖；格子：畫的黃色盾牌（站長 11/17「盾牌原本的好像比較好」）
    let pv: ReturnType<typeof pickView> | null = null;
    for (let w = 0; w < 8 && !pv; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const v = pickView(gameOf(pick), pick);
        if (sheetRows(v).some((r) => r.kind === 'proposal')) {
          // 當成梅林看：兩個不是自己的座位是看到的紅
          const others = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((x) => x !== v.pick.seat).slice(0, 2);
          pv = { ...v, view: { ...v.view, sight: { kind: 'merlin', seen: others } } } as typeof v;
          break;
        }
      }
    }
    expect(pv).not.toBeNull();
    const svg = allSvg(pv!, 3);
    const seen = (pv!.view.sight as { seen: number[] }).seen;
    const card = buildPuzzleSvg(pv!, 3);
    expect((card.match(/class="seat-side seat-evil"/g) ?? []).length).toBe(seen.length);
    expect(card.match(/<symbol id="seat-evil"/g)?.length).toBe(1); // 只放一次
    expect(svg).not.toContain('mission-shield');
    expect(svg).toMatch(/<path [^>]*d="M12 2 [^>]*fill="#facc15"[^>]*class="team-shield"\/>/);
    // 盾牌放到列高允許的最大：精縮列高 19 時看得到的高度（24 格裡佔 20）至少 15px
    const k = Number(/scale\(([\d.]+)\)" d="M12 2 /.exec(svg)?.[1]);
    expect(k * 20).toBeGreaterThanOrEqual(15);
    expect(card).toMatch(/class="seat-side seat-evil"[^>]*/);
    expect(/<use href="#seat-evil"[^>]*opacity="0\.(\d+)"/.exec(card)).not.toBeNull(); // 淡化
    // 湖中鏈推出的好人：藍色陣營圖
    const lake = (round: number, holderSeat: number, targetSeat: number, claim: 'o' | 'x' | '', seen2?: 'good' | 'red') => ({ kind: 'lake' as const, round, holderSeat, targetSeat, claim, ...(seen2 ? { seen: seen2 } : {}) });
    const roles = ['loyal', 'merlin', 'percival', 'assassin', 'morgana', 'loyal', 'mordred', 'loyal', 'loyal', 'oberon'];
    const marks = seatMarks({ game: { seatRoles: roles }, pick: { seat: 1 }, view: { sight: { kind: 'loyal' } } } as never, [lake(2, 1, 9, 'o', 'good'), lake(3, 9, 6, 'o'), lake(3, 9, 4, 'x')]);
    expect(marks.get(9)?.side).toBe('good');
    expect(marks.get(6)?.side).toBe('good');
    expect(marks.get(4)?.side).toBe('evil');
  });

  it('every seat whose alignment you know gets a blue (good) or red (bad) circle: night info, own lake, lake chain', () => {
    const lake = (round: number, holderSeat: number, targetSeat: number, claim: 'o' | 'x' | '', seen?: 'good' | 'red') => ({ kind: 'lake' as const, round, holderSeat, targetSeat, claim, ...(seen ? { seen } : {}) });
    const roles = ['loyal', 'merlin', 'percival', 'assassin', 'morgana', 'loyal', 'mordred', 'loyal', 'loyal', 'oberon'];
    const pv = { game: { seatRoles: roles }, pick: { seat: 1 }, view: { sight: { kind: 'loyal' } } } as never;
    const marks = seatMarks(pv, [lake(2, 1, 9, 'o', 'good'), lake(3, 9, 4, 'x'), lake(3, 9, 6, 'o')]);
    const blue = marks.get(9)?.color;
    expect(marks.get(9)).toMatchObject({ label: '湖到好', side: 'good' });
    expect(marks.get(1)?.label).toBe('你');
    expect(marks.get(1)?.color).not.toBe(blue); // 你是黃圈
    expect(marks.get(6)).toMatchObject({ label: '湖鏈：好', color: blue });
    expect(marks.get(4)?.label).toBe('湖鏈：紅');
    expect(marks.get(4)?.color).not.toBe(blue);
    const merlin = seatMarks({ game: { seatRoles: roles }, pick: { seat: 2 }, view: { sight: { kind: 'merlin', seen: [4, 5, 10] } } } as never, []);
    expect(merlin.get(5)?.color).toBe(marks.get(4)?.color); // 夜裡看到的紅＝紅圈
  });

  it('lake chain: a player you know is good reports truthfully, so their lake becomes your info (direct and two-hop); red viewers get none; night info is not duplicated', () => {
    const lake = (round: number, holderSeat: number, targetSeat: number, claim: 'o' | 'x' | '', seen?: 'good' | 'red') => ({ kind: 'lake' as const, round, holderSeat, targetSeat, claim, ...(seen ? { seen } : {}) });
    const roles = ['loyal', 'merlin', 'percival', 'assassin', 'morgana', 'loyal', 'mordred', 'loyal', 'loyal', 'oberon'];
    const fakePv = (seat: number, sight: object, rs = roles) => ({ game: { seatRoles: rs }, pick: { seat }, view: { sight } }) as never;
    // 你是 1家（忠臣）：1 湖 9 看到好，9 湖 4 說紅 → 4 是紅；9 湖 5 說好、5 湖 3 說紅 → 3 是紅（兩步）
    const rows = [lake(2, 1, 9, 'o', 'good'), lake(3, 9, 4, 'x'), lake(3, 9, 5, 'o'), lake(4, 5, 3, 'x')];
    const k = lakeKnowledge(fakePv(1, { kind: 'loyal' }), rows);
    expect(k.seats.get(9)).toEqual({ evil: false, via: null });
    expect(k.seats.get(4)).toEqual({ evil: true, via: 9 });
    expect(k.seats.get(5)).toEqual({ evil: false, via: 9 });
    expect(k.seats.get(3)).toEqual({ evil: true, via: 5 });
    const notes = lakeEntries(rows, k.chain).map((e) => e.notes[0]?.t);
    expect(notes).toEqual(['（看到好）', '9 是好人 → 4 是紅', '9 是好人 → 5 是好人', '5 是好人 → 3 是紅']);
    // 不知道是好人的人宣告的湖不算
    expect(lakeKnowledge(fakePv(1, { kind: 'loyal' }), [lake(2, 6, 4, 'x')]).seats.size).toBe(0);
    // 紅方看的：自己湖到的照算，湖中鏈不推
    const red = lakeKnowledge(fakePv(4, { kind: 'evil', mates: [5, 7] }), [lake(2, 4, 9, 'o', 'good'), lake(3, 9, 1, 'x')]);
    expect(red.chain).toEqual([]);
    expect([...red.seats.keys()]).toEqual([9]);
    // 梅林：夜裡已經看到的紅不重複標，湖中鏈揭露的莫德雷德要標
    const merlinRows = [lake(2, 2, 9, 'o', 'good'), lake(3, 9, 4, 'x'), lake(4, 9, 7, 'x')];
    const marks = seatMarks(fakePv(2, { kind: 'merlin', seen: [4, 5, 10] }), merlinRows);
    expect(marks.get(4)?.label).toBe('紅');
    expect(marks.get(7)?.label).toBe('湖鏈：紅');
    expect(marks.get(9)?.label).toBe('湖到好');
  });

  it('Percival: once one thumb’s alignment is known (own lake or chain) the thumbs become 梅林 (blue) and 莫甘娜 (red); not before', () => {
    const lake = (round: number, holderSeat: number, targetSeat: number, claim: 'o' | 'x' | '', seen?: 'good' | 'red') => ({ kind: 'lake' as const, round, holderSeat, targetSeat, claim, ...(seen ? { seen } : {}) });
    const roles = ['loyal', 'percival', 'loyal', 'merlin', 'assassin', 'morgana', 'mordred', 'loyal', 'loyal', 'oberon'];
    const pv = { game: { seatRoles: roles }, pick: { seat: 2 }, view: { sight: { kind: 'percival', thumbs: [4, 6] } } } as never;
    // 自己湖到拇指 4 是好人 → 4 梅林（藍）、6 莫甘娜（紅）
    const good = seatMarks(pv, [lake(2, 2, 4, 'o', 'good')]);
    expect(good.get(4)).toMatchObject({ label: '梅林' });
    expect(good.get(6)).toMatchObject({ label: '莫甘娜' });
    expect(good.get(4)?.color).not.toBe(good.get(6)?.color);
    expect(good.get(4)).toMatchObject({ side: 'good', color: seatMarks(pv, [lake(2, 2, 1, 'o', 'good')]).get(1)?.color }); // 藍（跟湖到好同色）
    expect(good.get(4)?.split).toBeFalsy();
    // 自己湖到拇指 6 是紅 → 6 莫甘娜、4 梅林
    const red = seatMarks(pv, [lake(2, 2, 6, 'x', 'red')]);
    expect(red.get(6)?.label).toBe('莫甘娜');
    expect(red.get(4)?.label).toBe('梅林');
    // 湖中鏈：2 湖 1 好，1 湖 4 說好 → 4 梅林
    const chainRows = [lake(2, 2, 1, 'o', 'good'), lake(3, 1, 4, 'o')];
    const viaChain = seatMarks(pv, chainRows);
    expect(viaChain.get(4)?.label).toBe('梅林');
    expect(viaChain.get(6)?.label).toBe('莫甘娜');
    const notes = lakeEntries(chainRows, lakeKnowledge(pv, chainRows).chain, { thumbs: [4, 6] }).map((e) => e.notes.map((n) => n.t));
    expect(notes[1]).toEqual(['1 是好人 → 4 是好人', '4 是好人 → 4 是梅林、6 是莫甘娜']); // 疊在鏈的註記下面
    // 還沒湖到拇指：「拇指?」半圈藍半圈紅（站長 11/17「派西維爾看到的姆指可以是半圈藍半圈紅 然後打問號」），沒有陣營圖
    const before = seatMarks(pv, [lake(2, 2, 1, 'o', 'good')]);
    expect(before.get(4)).toMatchObject({ label: '拇指?', split: true });
    expect(before.get(6)).toMatchObject({ label: '拇指?', split: true });
    expect(before.get(4)?.side).toBeUndefined();
    expect(resolveThumbs([4, 6], new Map())).toBeNull();
  });

  it('Percival: a thumb resolved as Merlin is known good, so their lake declarations propagate through the chain (and the other thumb is known evil)', () => {
    const lake = (round: number, holderSeat: number, targetSeat: number, claim: 'o' | 'x' | '', seen?: 'good' | 'red') => ({ kind: 'lake' as const, round, holderSeat, targetSeat, claim, ...(seen ? { seen } : {}) });
    const roles = ['loyal', 'percival', 'loyal', 'merlin', 'assassin', 'morgana', 'mordred', 'loyal', 'loyal', 'oberon'];
    const pv = { game: { seatRoles: roles }, pick: { seat: 2 }, view: { sight: { kind: 'percival', thumbs: [4, 6] } } } as never;
    // 拇指 4、6；2 湖 6 私下看到紅 → 6 莫甘娜、4 梅林（好人）；6 湖 4（紅方的宣告不算）；4 湖 9 說紅 → 9 是紅
    const rows = [lake(2, 2, 6, 'x', 'red'), lake(3, 6, 4, 'o'), lake(4, 4, 9, 'x')];
    const k = lakeKnowledge(pv, rows);
    expect(k.seats.get(4)).toEqual({ evil: false, via: 6, thumb: true });
    expect(k.seats.get(9)).toEqual({ evil: true, via: 4 });
    expect(k.chain).toEqual([{ holder: 4, target: 9, evil: true }]);
    const marks = seatMarks(pv, rows);
    expect(marks.get(4)?.label).toBe('梅林');
    expect(marks.get(9)).toMatchObject({ label: '湖鏈：紅', side: 'evil' });
    expect(lakeEntries(rows, k.chain, { thumbs: [4, 6] }).map((e) => e.notes.map((n) => n.t))[2]).toEqual(['4 是好人 → 9 是紅']);
    // 反過來：湖到拇指 4 是好人 → 6 是莫甘娜（紅），6 的宣告照樣不算
    const sym = [lake(2, 2, 4, 'o', 'good'), lake(3, 4, 1, 'o'), lake(4, 6, 8, 'x')];
    const k2 = lakeKnowledge(pv, sym);
    expect(k2.seats.get(6)).toEqual({ evil: true, via: 4, thumb: true });
    expect(k2.seats.get(1)).toEqual({ evil: false, via: 4 });
    expect(k2.seats.has(8)).toBe(false);
    expect(seatMarks(pv, sym).get(6)?.label).toBe('莫甘娜');
  });

  it('your own seat is a yellow ring whatever your side (a red viewer is not blue); red viewers see teammates red; unresolved thumbs are split rings on the card', () => {
    const roles = ['loyal', 'percival', 'loyal', 'merlin', 'assassin', 'morgana', 'mordred', 'loyal', 'loyal', 'oberon'];
    const fakePv = (seat: number, sight: object) => ({ game: { seatRoles: roles }, pick: { seat }, view: { sight } }) as never;
    const loyal = seatMarks(fakePv(1, { kind: 'loyal' }), []).get(1);
    const assassin = seatMarks(fakePv(5, { kind: 'evil', mates: [6, 7] }), []);
    const merlin = seatMarks(fakePv(4, { kind: 'merlin', seen: [5, 6, 10] }), []);
    expect(assassin.get(5)).toEqual(loyal); // 刺客自己：跟忠臣一樣的黃圈「你」
    expect(merlin.get(4)).toEqual(loyal);
    expect(assassin.get(6)).toMatchObject({ label: '隊友', side: 'evil', color: merlin.get(5)?.color });
    expect(assassin.get(7)?.color).toBe(merlin.get(5)?.color);
    expect([loyal?.color, assassin.get(6)?.color]).not.toContain(seatMarks(fakePv(1, { kind: 'loyal' }), [{ kind: 'lake', round: 2, holderSeat: 1, targetSeat: 9, claim: 'o', seen: 'good' }] as never).get(9)?.color);

    // 畫在卡上：紅方的題目，自己的座位是黃圈；派西沒分出來的兩根拇指各兩段半圈（圓桌＋格子欄名）
    let red: ReturnType<typeof pickView> | null = null;
    for (let w = 0; w < 8 && !red; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const v = pickView(gameOf(pick), pick);
        if (!sheetRows(v).some((r) => r.kind === 'lake')) {
          red = v;
          break;
        }
      }
    }
    expect(red).not.toBeNull();
    const others = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((x) => x !== red!.pick.seat);
    const asRed = { ...red!, view: { ...red!.view, sight: { kind: 'evil', mates: others.slice(0, 2) } } } as typeof red;
    const card = buildPuzzleSvg(asRed!, 3);
    expect(card).toContain(`r="27" fill="none" stroke="${loyal?.color}"`);
    expect((card.match(/class="seat-side seat-evil"/g) ?? []).length).toBe(2);
    const asPercival = { ...red!, view: { ...red!.view, sight: { kind: 'percival', thumbs: others.slice(0, 2) } } } as typeof red;
    const pcard = buildPuzzleSvg(asPercival!, 3);
    expect((pcard.match(/class="thumb-ring"/g) ?? []).length).toBe(8);
    expect(pcard).toContain('拇指?');
    expect(pcard).not.toContain('class="seat-side');
  });

  it('the question card shows every lake known at the question moment; earlier rows alone did not know it yet', () => {
    // 找一張有兩次湖以上的題目，把後面那次湖改成「你」拿湖
    let found: ReturnType<typeof pickView> | null = null;
    for (let w = 0; w < 8 && !found; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const pv = pickView(gameOf(pick), pick);
        if (pv.shown.filter((e) => e.kind === 'lake').length >= 2) {
          found = pv;
          break;
        }
      }
    }
    expect(found).not.toBeNull();
    const pv = found!;
    const lakesShown = pv.shown.filter((e): e is Extract<typeof e, { kind: 'lake' }> => e.kind === 'lake');
    const later = lakesShown[lakesShown.length - 1];
    const target = later.targetSeat === pv.pick.seat ? lakesShown[0].targetSeat : later.targetSeat;
    const evil = ['assassin', 'morgana', 'mordred', 'oberon', 'minion'].includes(pv.game.seatRoles[target - 1]);
    const mine = {
      ...pv,
      shown: pv.shown.map((e) => (e === later ? { ...e, holderSeat: pv.pick.seat, targetSeat: target } : e)),
      view: { ...pv.view, sight: { kind: 'loyal' as const }, ownLakes: [{ targetSeat: target, evil }] },
    } as typeof pv;
    const label = evil ? '湖到紅' : '湖到好';
    const rows = sheetRows(mine);
    const lakeRound = later.round;
    expect(buildPuzzleSvg(mine, 3)).toContain(label); // 題目卡：出題那一刻知道了
    expect(lakeKnowledge(mine, rows.filter((r) => r.kind !== 'decision' && r.round < lakeRound)).seats.has(target)).toBe(false);
  });

  it('identity is one line without the gray subtitle: 忠臣 / 派西（夜間看到 X、Y 兩根拇指）/ 梅林（看到紅…，莫德雷德看不到）/ 紅方（隊友…）', () => {
    expect(identityText(4, 'loyal', { kind: 'loyal' } as never)).toBe('你是 4家 忠臣');
    expect(identityText(5, 'percival', { kind: 'percival', thumbs: [1, 3] } as never)).toBe('你是 5家 派西維爾（夜間看到 1、3 兩根拇指）');
    expect(identityText(1, 'merlin', { kind: 'merlin', seen: [4, 5, 7] } as never)).toBe('你是 1家 梅林（看到紅 4、5、7，莫德雷德看不到）');
    expect(identityText(3, 'assassin', { kind: 'evil', mates: [6, 10] } as never)).toBe('你是 3家 刺客（隊友 6、0）');
    // 放不下才把括號換到第二行（不縮排）
    const lines = identityLines('你是 1家 梅林（看到紅 4、5、7，莫德雷德看不到）', 460);
    expect(lines.map((l) => l.line)).toEqual(['你是 1家 梅林', '（看到紅 4、5、7，莫德雷德看不到）']);
    expect(identityLines('你是 4家 忠臣', 460)).toHaveLength(1);
    const [, tue] = planWeek(bank, 0) as ThreadsPick[];
    const svg = buildPuzzleSvg(pickView(gameOf(tue), tue), 2);
    expect(svg).toContain('兩根拇指');
    expect(svg).not.toContain('梅林、莫甘娜各一'); // 舊的灰色小字
  });

  it('the draft markdown lists every continuation image in order', () => {
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const d = gen.draftFor('2026-11-18', { image: '2026-11-18.png' }) as ThreadsDraft;
    d.post.gridImages = ['2026-11-18-grid-1.png', '2026-11-18-grid-2.png'];
    const md = draftMarkdown(d);
    expect(md.indexOf('2026-11-18-grid-1.png（牌譜 2/3）')).toBeGreaterThan(-1);
    expect(md.indexOf('2026-11-18-grid-2.png（牌譜 3/3）')).toBeGreaterThan(md.indexOf('2026-11-18-grid-1.png'));
  });

  it('the answer card lists yesterday’s blue and red roles and the result', () => {
    const [, tue] = planWeek(bank, 0) as ThreadsPick[];
    const pv = pickView(gameOf(tue), tue);
    const svg = buildAnswerSvg(pv);
    for (const role of ['派西維爾', '梅林', '刺客', '莫甘娜']) expect(svg).toContain(role);
    // 站長 11/17「刺娜德奧派梅」：紅方在上、藍方在下（標題列之後）
    const body = svg.slice(svg.indexOf('紅方'));
    expect(body.indexOf('紅方')).toBeLessThan(body.indexOf('藍方'));
    expect(body.indexOf('刺客')).toBeLessThan(body.indexOf('莫甘娜'));
    expect(body.indexOf('莫甘娜')).toBeLessThan(body.indexOf('派西維爾'));
    expect(svg).toContain('結果：');
    expect(svg).toContain(`[${pv.pick.gameId}] · 答案`);
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
              expect(r.votes.every((v) => v === (r.forced ? 'none' : 'unknown'))).toBe(true);
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

  it('missing vote records look different from forced proposals and get their own legend entry', () => {
    const [, tue] = planWeek(bank, 0) as ThreadsPick[];
    const pv = pickView(gameOf(tue), tue);
    const i = pv.shown.findIndex((e) => e.kind === 'proposal' && !e.forced);
    expect(i).toBeGreaterThanOrEqual(0);
    const plain = allSvg(pv, 2);
    expect(plain).not.toContain('票沒記錄');
    expect(plain).toContain('灰 = 強制局不投票');
    // 同一題，把一次非強制的提議改成票沒記錄
    const unreliable = { ...pv, shown: pv.shown.map((e, j) => (j === i && e.kind === 'proposal' ? { ...e, votesReliable: false } : e)) };
    const row = sheetRows(unreliable).find((r) => r.kind === 'proposal' && !r.reliable);
    expect(row?.kind === 'proposal' && row.votes.every((v) => v === 'unknown')).toBe(true);
    expect(voteLegend(sheetRows(unreliable))).toContain('？ = 票沒記錄');
    expect(voteLegend(sheetRows(pv))).not.toContain('票沒記錄');
    const svg = allSvg(unreliable, 2);
    expect(svg).toContain('票沒記錄');
    expect(svg).toContain('#52525b'); // 跟強制局的灰（#18181b）不同色
    expect(svg).toContain('>？<');
    expect(textWidth(voteLegend(sheetRows(unreliable)), 21)).toBeLessThanOrEqual(1080 - 80);
  });

  it('the viewer’s own lake result shows in the lake row even on a marked seat; nobody else’s lake result is shown', () => {
    // 實際的題目：有 seen 的只會是出題的人自己湖的那一列，而且跟那個座位的陣營一致
    for (let w = 0; w < 8; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const pv = pickView(gameOf(pick), pick);
        for (const r of sheetRows(pv)) {
          if (r.kind !== 'lake') continue;
          if (r.holderSeat !== pick.seat) expect(r.seen).toBeUndefined();
          else {
            expect(r.seen).toBe(isRed(pv.game.seatRoles[r.targetSeat - 1]) ? 'red' : 'good');
          }
        }
      }
    }
    // 派西湖到拇指（座位已經有「拇指」標記）：湖的那一列照樣寫出私下看到的結果
    let found: { pv: ReturnType<typeof pickView>; target: number } | null = null;
    for (let w = 0; w < 8 && !found; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const pv = pickView(gameOf(pick), pick);
        const lake = pv.shown.find((e) => e.kind === 'lake');
        if (lake && lake.kind === 'lake' && pv.view.sight.kind === 'percival') {
          found = { pv, target: lake.targetSeat };
          break;
        }
      }
    }
    if (found) {
      const { pv, target } = found;
      const sight = pv.view.sight as Extract<typeof pv.view.sight, { kind: 'percival' }>;
      const evil = isRed(pv.game.seatRoles[target - 1]);
      const mine = {
        ...pv,
        shown: pv.shown.map((e) => (e.kind === 'lake' && e.targetSeat === target ? { ...e, holderSeat: pv.pick.seat } : e)),
        view: { ...pv.view, sight: { ...sight, thumbs: [target, ...sight.thumbs.filter((t) => t !== target)].slice(0, 2) }, ownLakes: [{ targetSeat: target, evil }] },
      };
      const row = sheetRows(mine).find((r) => r.kind === 'lake' && r.targetSeat === target);
      expect(row?.kind === 'lake' && row.seen).toBe(evil ? 'red' : 'good');
      const svg = allSvg(mine, 2);
      expect(svg).toContain(`你看到：${evil ? '紅' : '好人'}`);
      expect(svg).toContain('拇指');
      expect(recordLines(sheetRows(mine)).map((l) => l.map((x) => x.t).join('')).join('\n')).toContain(`（你看到的：${evil ? '紅' : '好人'}）`);
      // 別人的湖不畫結果
      if (!pv.shown.some((e) => e.kind === 'lake' && e.holderSeat === pv.pick.seat)) expect(allSvg(pv, 2).includes('你看到：')).toBe(false);
    }
    expect(found).not.toBeNull();
    expect(textWidth('0 家 驗 0 家 → 宣告藍（你看到：好人）', 22)).toBeLessThanOrEqual(10 * 63);
  });

  it('the post text follows the owner’s 11/18 edit: [第 N 局] headers, one ask line with seat and role, no 題號, blank line + four tags', () => {
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null, startDate: '2026-11-18' });
    const d = gen.draftFor('2026-11-18') as ThreadsDraft;
    const lines = d.post.text.split('\n');
    expect(lines[0]).toBe('【阿瓦隆每日一題｜週三・1-5 尾派】');
    expect(lines[1]).toMatch(/^你是 \d家・/);
    expect(lines[2]).toBe('[第 1 局]');
    expect(lines.at(-3)).toMatch(/^輪到你 \d家 \S+ 派 3 人，你會派誰？$/);
    expect(lines.at(-2)).toBe('');
    expect(lines.at(-1)).toBe('#阿瓦隆 #梅林 #派西維爾 #亞瑟的忠臣');
    expect(THREADS_TOPIC_TAG).toBe('#阿瓦隆 #梅林 #派西維爾 #亞瑟的忠臣');
    expect(d.post.text).not.toContain('題號');
    expect(d.post.text).not.toContain('強制出發）');
    expect(d.post.text).not.toContain('留言寫');
  });

  it('the ask line is white, right under 「你是…」, without 第 X 局第 K 次 / 強制出發; the grid ends with a short 輪到你; header is one line with the game id', () => {
    for (let w = 0; w < 2; w++) {
      for (const pick of planWeek(bank, w) as ThreadsPick[]) {
        const pv = pickView(gameOf(pick), pick);
        const card = buildPuzzleSvg(pv, 3);
        const ask = /<text class="ask-line" x="([\d.]+)" y="([\d.]+)"[^>]*><tspan fill="([^"]+)"[^>]*>([^<]+)</.exec(card);
        expect(ask).not.toBeNull();
        expect(ask![3]).toBe('#f4f4f5'); // 白字
        expect(ask![4]).toMatch(pick.proposal === null ? /^三藍：輪到你刺殺/ : /^輪到你派 \d 人$/);
        const id = card.indexOf('你是 ');
        expect(id).toBeGreaterThan(-1);
        expect(card.indexOf('class="ask-line"')).toBeGreaterThan(id); // 在「你是…」後面（下面）
        expect(Number(ask![2])).toBeLessThan(cardTop(pv)); // 在牌譜上面的右欄
        expect(card).not.toMatch(/第 \d 局第 \d 次/);
        expect(card).not.toContain('強制出發');
        expect(card).toContain(`[${pv.pick.gameId}]`);
        expect(card).not.toContain(pv.exerciseId); // 標題只寫局號
        if (pick.proposal !== null) expect(card).toMatch(/>輪到你</);
        for (const svg of buildGridSvgs(pv, 3)) expect(svg).toContain(`[${pv.pick.gameId}] · 牌譜`);
      }
    }
  });

  it('wraps long lines at a comma or bracket', () => {
    expect(wrapLine('短', 30, 500)).toEqual(['短']);
    const parts = wrapLine('湖：0家 湖 8家，說好人（o）（你看到的：紅）', 26, 300);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(textWidth(p, 26)).toBeLessThanOrEqual(300);
  });
});
