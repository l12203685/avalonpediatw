/**
 * Threads 貼文格式（2026-11-18，站長：「我可以再主控台那邊 先調整貼文格式? (應該只有出題內容會改 大部分都可以套用?)」）：
 *   - 內建格式就是照順序接起來（兩週的題目、三種系列起點；用直接拼的寫法重算一次比對）：
 *     標題（一句話的問題）、接續、你是、三個選項、空一行＋精簡的局面、空一行＋答案、空一行、標籤（2026-11-25「一目瞭然」）；
 *     檔案裡存的是 11/25 以前的內建格式＝站長沒改過，照現在的內建格式；
 *   - 套範本的規則：空的佔位符整行拿掉、不留連續空行、多行的內容照放；
 *   - 範本檢查：不認得的佔位符、{標籤} 要在最後一行、留言要有 {小觀念}；
 *   - threads_template.json：沒有、壞掉、某一欄不合格 → 那一欄用內建格式＋警告；
 *   - 站長的格式每天都套、套完一樣 ≤ 500 字（先縮牌譜再縮答案），放不下那天改用內建格式；
 *   - 草稿帶 parts（每個佔位符這天的內容）；第一則留言的內建格式跟寫好的檔一字不差。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { buildSimBank, readSimBankFile, type SimBank } from '../bots/simulation/bank';
import { readRecordPosts } from '../bots/simulation/recordsIndex';
import { SEE_IMAGE_LINE, THREADS_MAX_CHARS, THREADS_TOPIC_TAG, answerVariants, postTitle, questionParts, renderPost, type PickView, type ThreadsDraft } from '../bots/threads/draft';
import { choiceLines, choicesFor } from '../bots/threads/choices';
import { ThreadsGenerator } from '../bots/threads/generate';
import { THREADS_START_DATE, THREADS_THEMES, addDays, weekdayOf, type ThreadsKind } from '../bots/threads/plan';
import { commentText, draftNeedsImage, imageProblem, prepareDaily, type DailyPlan } from '../bots/threads/publish/daily';
import {
  COMMENT_PLACEHOLDERS,
  DEFAULT_COMMENT_TEMPLATE,
  DEFAULT_POST_TEMPLATE,
  LEGACY_POST_TEMPLATE,
  POST_PLACEHOLDERS,
  PLACEHOLDER_HELP,
  THREADS_TYPES,
  templateFor,
  typeOf,
  commentBody,
  parseTemplateFile,
  readTemplateFile,
  renderTemplate,
  validateTemplate,
} from '../bots/threads/template';

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

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'threads-tpl-'));

/**
 * 不經過範本、直接拼的寫法：標題（問題）、接續＋你是、三個選項、空一行＋局面、空一行＋答案、空一行、標籤。
 * 放不下時先換短的答案，最後才把局面縮成「看圖」。
 */
function plainPostText(pv: PickView, opts: { weekday: number; continuesFrom?: { exerciseId: string; seat: number }; answers?: string[][] }): string {
  const title = postTitle(opts.weekday, pv.pick);
  const q = questionParts(pv, opts);
  const answers = opts.answers && opts.answers.length > 0 ? opts.answers : [[]];
  let last = '';
  for (const body of q.bodies) {
    for (const ans of answers) {
      last = [title, ...q.head, ...choiceLines(choicesFor(pv)), '', ...body, ...(ans.length ? ['', ...ans] : []), '', THREADS_TOPIC_TAG].join('\n');
      if ([...last].length <= THREADS_MAX_CHARS) return last;
    }
  }
  return last;
}

/** 一天的輸入照產生器的規則重組（沒有存下來的草稿、起始日以後每天都有貼文）。 */
function inputsFor(gen: ThreadsGenerator, date: string, startDate: string): { pv: PickView; continuesFrom?: { exerciseId: string; seat: number }; answers: string[][] } {
  const pick = gen.pickFor(date);
  const pv = gen.viewOf(pick as NonNullable<typeof pick>) as PickView;
  const yDate = addDays(date, -1);
  if (date <= startDate) return { pv, answers: [] };
  const yPick = gen.pickFor(yDate);
  const yPv = gen.viewOf(yPick as NonNullable<typeof yPick>) as PickView;
  const continues = !!pv.pick.continues && yPv.pick.gameId === pv.pick.gameId;
  let earlier: PickView | undefined;
  if (yPick?.continues && yDate > startDate) {
    const e = gen.pickFor(addDays(date, -2));
    if (e && e.gameId === yPick.gameId) earlier = gen.viewOf(e) ?? undefined;
  }
  const answers = answerVariants({ yesterday: yPv, earlier, todayContinues: continues, recordId: gen.recordIdOf(yPv.pick.gameId) });
  return { pv, ...(continues ? { continuesFrom: { exerciseId: yPv.exerciseId, seat: yPv.pick.seat } } : {}), answers };
}

describe('default template = the plain concatenation, byte for byte', () => {
  for (const startDate of [THREADS_START_DATE, '2026-11-18', '2026-11-23']) {
    it(`two weeks of picks from ${startDate}: drafts equal the plain concatenation; parts re-render to the same text`, () => {
      const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null, startDate });
      for (let i = 0; i < 14; i++) {
        const date = addDays(startDate, i);
        const d = gen.draftFor(date) as ThreadsDraft;
        const inp = inputsFor(gen, date, startDate);
        const old = plainPostText(inp.pv, { weekday: weekdayOf(date), ...(inp.continuesFrom ? { continuesFrom: inp.continuesFrom } : {}), answers: inp.answers });
        expect(d.post.text).toBe(old);
        expect(d.parts).toBeDefined();
        expect(renderTemplate(DEFAULT_POST_TEMPLATE, d.parts as NonNullable<ThreadsDraft['parts']>)).toBe(d.post.text);
        expect(d.templateWarning).toBeUndefined();
        // 第一天沒有昨天答案；延續的日子有「接續」那一行。
        expect(d.parts?.昨天答案 === '').toBe(i === 0);
        expect(d.parts?.接續 !== '').toBe(d.continuesYesterday);
        expect(d.parts?.標題).toBe(d.post.text.split('\n')[0]);
        expect(d.parts?.題號).toBe(d.exerciseId);
        expect(d.parts?.主題).toBe(d.theme);
        expect(d.parts?.選項).toBe(choiceLines(choicesFor(inp.pv)).join('\n'));
        expect(d.post.text).toContain(`\n${d.parts?.選項}\n`);
      }
      expect(gen.warnings).toEqual([]);
    });
  }

  it('an explicit default template (with CRLF and a trailing newline from a textarea) changes nothing', () => {
    const a = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const b = new ThreadsGenerator({ bank, titles, readSaved: () => null, postTemplate: `${DEFAULT_POST_TEMPLATE.replace(/\n/g, '\r\n')}\r\n` });
    for (let i = 0; i < 7; i++) {
      const date = addDays(THREADS_START_DATE, i);
      expect(b.draftFor(date)?.post.text).toBe(a.draftFor(date)?.post.text);
    }
  });

  it('the built-in format from before 2026-11-25 stored in the file means “never customised”: the current built-in format is used, no warning', () => {
    expect(validateTemplate('post', LEGACY_POST_TEMPLATE)).toEqual([]);
    expect(LEGACY_POST_TEMPLATE).not.toBe(DEFAULT_POST_TEMPLATE);
    const a = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const b = new ThreadsGenerator({ bank, titles, readSaved: () => null, postTemplate: `${LEGACY_POST_TEMPLATE}\n` });
    for (let i = 0; i < 7; i++) {
      const date = addDays(THREADS_START_DATE, i);
      expect(b.draftFor(date)?.post.text).toBe(a.draftFor(date)?.post.text);
    }
    expect(b.warnings).toEqual([]);
  });
});

describe('renderTemplate', () => {
  const parts = { 標題: 'T', 接續: '', 你是: 'V', 派票紀錄: 'r1\nr2', 提問: 'Q', 昨天答案: '', 標籤: '#tag' };

  it('drops a line whose placeholders are all empty, without leaving two blank lines', () => {
    expect(renderTemplate(LEGACY_POST_TEMPLATE, parts)).toBe('T\nV\nr1\nr2\nQ\n\n#tag');
    expect(renderTemplate(LEGACY_POST_TEMPLATE, { ...parts, 昨天答案: 'A1\nA2', 接續: 'C' })).toBe('T\nC\nV\nr1\nr2\nQ\n\nA1\nA2\n\n#tag');
    // 現在的內建格式：問題（標題）、你是、三個選項、空一行＋局面、空一行＋答案、空一行、標籤
    const now = { ...parts, 選項: 'A a\nB b\nC c\n都不是？' };
    expect(renderTemplate(DEFAULT_POST_TEMPLATE, now)).toBe('T\nV\nA a\nB b\nC c\n都不是？\n\nr1\nr2\n\n#tag');
    expect(renderTemplate(DEFAULT_POST_TEMPLATE, { ...now, 昨天答案: 'A1\nA2', 接續: 'C' })).toBe('T\nC\nV\nA a\nB b\nC c\n都不是？\n\nr1\nr2\n\nA1\nA2\n\n#tag');
    // 兩個空的段落之間的空行也只留一個。
    expect(renderTemplate('{標題}\n\n{接續}\n\n{昨天答案}\n\n{標籤}', parts)).toBe('T\n\n#tag');
    // 最前面的空佔位符行：後面的空行一起拿掉。
    expect(renderTemplate('{接續}\n\n{標題}', parts)).toBe('T');
  });

  it('keeps a line that has fixed text even when its placeholder is empty; keeps blank lines the owner wrote', () => {
    expect(renderTemplate('{標題}\n接續：{接續}\n\n\n{標籤}', parts)).toBe('T\n接續：\n\n\n#tag');
    expect(renderTemplate('前言 {你是}，{提問}', parts)).toBe('前言 V，Q');
  });

  it('leaves unknown placeholders as they are (validateTemplate rejects them first)', () => {
    expect(renderTemplate('{標題} {不存在}', parts)).toBe('T {不存在}');
  });
});

describe('validateTemplate', () => {
  it('accepts the defaults and every listed placeholder; each placeholder is documented', () => {
    expect(validateTemplate('post', DEFAULT_POST_TEMPLATE)).toEqual([]);
    expect(validateTemplate('comment', DEFAULT_COMMENT_TEMPLATE)).toEqual([]);
    expect(validateTemplate('post', `${POST_PLACEHOLDERS.filter((n) => n !== '標籤').map((n) => `{${n}}`).join('\n')}\n{標籤}`)).toEqual([]);
    for (const n of [...POST_PLACEHOLDERS, ...COMMENT_PLACEHOLDERS]) expect(PLACEHOLDER_HELP[n]).toBeTruthy();
  });

  it('rejects unknown placeholders, a missing or misplaced {標籤}, a comment without {小觀念}, empty text and over-long fixed text', () => {
    expect(validateTemplate('post', '{標題}\n{局號}\n{標籤}').join()).toContain('{局號}');
    expect(validateTemplate('post', '{標題}\n{你是}\n{派票紀錄}\n{標籤}\n結尾')).toHaveLength(1);
    expect(validateTemplate('post', '{標題}\n{你是}\n{派票紀錄}\n{標籤}\n{標籤}')).toHaveLength(1);
    expect(validateTemplate('post', '{標題}\n{你是}\n{派票紀錄}')).toHaveLength(1);
    expect(validateTemplate('comment', '【標題】\n{題號}').join()).toContain('{小觀念}');
    expect(validateTemplate('comment', '{小觀念}\n{你是}').join()).toContain('{你是}'); // 留言不能用貼文的佔位符
    expect(validateTemplate('post', '  \n')).toEqual(['是空的']);
    expect(validateTemplate('post', `${'字'.repeat(501)}\n{標籤}`).join()).toContain('超過 500');
  });
});

describe('validateTemplate: what publishing depends on (Codex review of #82)', () => {
  const ok = '{標題}\n{你是}\n{派票紀錄}\n{提問}\n\n{昨天答案}\n\n{標籤}';

  it('the first line is {標題} alone: no leading blank line, no generic heading, no text next to it (duplicate detection matches the first line + date)', () => {
    expect(validateTemplate('post', ok)).toEqual([]);
    expect(validateTemplate('post', `\n${ok}`).join()).toContain('第一行要是 {標題}');
    expect(validateTemplate('post', `【阿瓦隆每日一題】\n${ok}`).join()).toContain('第一行要是 {標題}');
    expect(validateTemplate('post', ok.replace('{標題}', '{主題}')).join()).toContain('第一行要是 {標題}');
    expect(validateTemplate('post', ok.replace('{標題}', '📌 {標題}')).join()).toContain('第一行要是 {標題}');
    expect(validateTemplate('post', ok.replace('{你是}', '{標題}')).join()).toContain('第一行要是 {標題}');
  });

  it('{派票紀錄} is required (otherwise a failed image posts a question with no record)', () => {
    expect(validateTemplate('post', ok.replace('{派票紀錄}\n', '')).join()).toContain('{派票紀錄}');
  });

  it('{你是} is required too (seat, role and decision; without it a failed image posts a question nobody can read)', () => {
    expect(validateTemplate('post', ok.replace('{你是}\n', '')).join()).toContain('{你是}');
    expect(parseTemplateFile({ post: ok.replace('{你是}\n', '') })).toMatchObject({ source: { post: 'default' } });
  });

  it('a literal hashtag line besides {標籤} is rejected (every post would fail validatePost)', () => {
    expect(validateTemplate('post', ok.replace('\n\n{標籤}', `\n\n${THREADS_TOPIC_TAG}\n{標籤}`)).join()).toContain('#標籤');
    expect(validateTemplate('post', ok.replace('{提問}', '{提問}\n#阿瓦隆')).join()).toContain('#標籤');
    // 句子裡的 # 不算（例如「#1 的觀念」後面還有字）。
    expect(validateTemplate('post', ok.replace('{提問}', '{提問} #每日一題 快來回答'))).toEqual([]);
  });

  it('a template passed as a string is checked too: invalid → the default for that day, with a warning', () => {
    const def = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null, postTemplate: '{標題}\n{你是}\n{提問}\n{標籤}' });
    const date = addDays(THREADS_START_DATE, 2);
    const d = gen.draftFor(date) as ThreadsDraft;
    expect(d.post.text).toBe(def.draftFor(date)?.post.text);
    expect(d.templateWarning).toContain('{派票紀錄}');
    expect(gen.warnings.some((w) => w.startsWith(`${date}：`))).toBe(true);
  });
});

describe('a post that depends on the image is not published without it, in prepare and in post', () => {
  const draftOf = (text: string, record: string): Pick<ThreadsDraft, 'post' | 'parts'> =>
    ({ post: { text, chars: [...text].length }, parts: { 派票紀錄: record } as ThreadsDraft['parts'] });

  it('draftNeedsImage: the record shrunk to 「完整局面看圖」, or the record missing from the text', () => {
    expect(draftNeedsImage(draftOf(`T\n[第 1 局]\n1家 124\n你會派誰？\n\n${THREADS_TOPIC_TAG}`, '[第 1 局]\n1家 124'))).toBe(false);
    expect(draftNeedsImage(draftOf(`T\n${SEE_IMAGE_LINE}\n你會派誰？\n\n${THREADS_TOPIC_TAG}`, SEE_IMAGE_LINE))).toBe(true);
    expect(draftNeedsImage(draftOf(`T\n你會派誰？\n\n${THREADS_TOPIC_TAG}`, '[第 1 局]\n1家 124'))).toBe(true);
    // 舊的草稿沒有 parts：照文字判斷。
    expect(draftNeedsImage({ post: { text: `T\n你會派誰？`, chars: 6 } })).toBe(false);
  });

  it('prepare blocks the live post when there is no image; post refuses without a public image URL', () => {
    const text = `【阿瓦隆每日一題｜週三・1-5 尾派】\n你會派誰？\n\n${THREADS_TOPIC_TAG}`;
    const real = new ThreadsGenerator({ bank, titles, readSaved: () => null }).draftFor('2026-11-18') as ThreadsDraft;
    const fake = { ...real, quoteYesterday: false, answerToYesterday: null, post: { text, chars: [...text].length } };
    const gen = { draftFor: () => fake, warnings: [], pickFor: () => null, gameOf: () => null } as unknown as ThreadsGenerator;
    const plan = prepareDaily('2026-11-18', { gen, stateDir: tmp(), commentsDir: tmp(), outDir: tmp() }) as DailyPlan;
    expect(plan.needsImage).toBe(true);
    expect(plan.liveBlock).toContain('沒有牌譜');
    expect(imageProblem({ ...plan, liveBlock: null }, [])).toContain('沒有牌譜');
    expect(imageProblem({ ...plan, liveBlock: null }, ['https://example.test/a.png'])).toBeNull();
    const normal = prepareDaily('2026-11-18', { gen: new ThreadsGenerator({ bank, titles, readSaved: () => null }), stateDir: tmp(), commentsDir: tmp(), outDir: tmp() }) as DailyPlan;
    expect(normal.needsImage).toBe(normal.text.includes(SEE_IMAGE_LINE));
  });
});

describe('threads_template.json', () => {
  it('missing or unreadable → defaults with a warning', () => {
    const dir = tmp();
    const missing = readTemplateFile(path.join(dir, 'threads_template.json'));
    expect(missing.template).toEqual({ post: DEFAULT_POST_TEMPLATE, comment: DEFAULT_COMMENT_TEMPLATE });
    expect(missing.source).toEqual({ post: 'default', comment: 'default' });
    expect(missing.warnings).toHaveLength(1);
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{ not json');
    expect(readTemplateFile(broken).template.post).toBe(DEFAULT_POST_TEMPLATE);
    expect(readTemplateFile(broken).warnings).toHaveLength(1);
    expect(parseTemplateFile([]).warnings).toHaveLength(1);
  });

  it('a valid file is used (CRLF normalized); an invalid field falls back alone, with a warning', () => {
    const dir = tmp();
    const f = path.join(dir, 'threads_template.json');
    const post = '{標題}\r\n{你是}\r\n{派票紀錄}\r\n{提問}\r\n\r\n{昨天答案}\r\n\r\n{標籤}\r\n';
    fs.writeFileSync(f, JSON.stringify({ post, comment: '💡 {小觀念}', updatedAt: '2026-11-18T01:00:00.000Z', note: 'x' }));
    const ok = readTemplateFile(f);
    expect(ok.warnings).toEqual([]);
    expect(ok.source).toEqual({ post: 'file', comment: 'file' });
    expect(ok.template.post).toBe('{標題}\n{你是}\n{派票紀錄}\n{提問}\n\n{昨天答案}\n\n{標籤}');
    expect(ok.updatedAt).toBe('2026-11-18T01:00:00.000Z');
    const bad = parseTemplateFile({ post: '{標題}\n{局號}\n{標籤}', comment: '{小觀念}' });
    expect(bad.source).toEqual({ post: 'default', comment: 'file' });
    expect(bad.template.post).toBe(DEFAULT_POST_TEMPLATE);
    expect(bad.warnings.join()).toContain('{局號}');
    expect(parseTemplateFile({ post: 3 }).warnings).toHaveLength(1);
    // 只有留言欄：貼文用內建、不警告。
    expect(parseTemplateFile({ comment: '{小觀念}' })).toMatchObject({ source: { post: 'default', comment: 'file' }, warnings: [] });
  });
});

describe('the owner’s template applies to every day', () => {
  const custom = '{標題}\n題號 {題號}\n{接續}\n{你是}\n{派票紀錄}\n👉 {提問}\n\n{昨天答案}\n\n{標籤}';

  it('two weeks: same question content, new format, ≤ 500 characters, tag last; parts are the same as with the default', () => {
    const def = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null, postTemplate: custom });
    for (let i = 0; i < 14; i++) {
      const date = addDays(THREADS_START_DATE, i);
      const d = gen.draftFor(date) as ThreadsDraft;
      const base = def.draftFor(date) as ThreadsDraft;
      expect(d.post.chars).toBeLessThanOrEqual(THREADS_MAX_CHARS);
      const lines = d.post.text.split('\n');
      expect(lines[0]).toBe(base.post.text.split('\n')[0]);
      expect(lines[1]).toBe(`題號 ${d.exerciseId}`);
      expect(lines.at(-1)).toBe(THREADS_TOPIC_TAG);
      expect(d.post.text).toContain(`👉 ${d.parts?.提問}`);
      expect(renderTemplate(custom, d.parts as NonNullable<ThreadsDraft['parts']>)).toBe(d.post.text);
      expect(d.parts?.你是).toBe(base.parts?.你是);
      if (d.answerToYesterday) expect(d.post.text).toContain(d.answerToYesterday.text);
    }
    expect(gen.warnings).toEqual([]);
  });

  it('longer fixed text still fits: the record shrinks first, then the answer', () => {
    const pad = '這是一段站長加在每天貼文裡的固定說明文字。'.repeat(4);
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null, postTemplate: `{標題}\n${pad}\n{你是}\n{派票紀錄}\n{提問}\n\n{昨天答案}\n\n{標籤}` });
    const def = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    let shrunk = 0;
    for (let i = 0; i < 14; i++) {
      const date = addDays(THREADS_START_DATE, i);
      const d = gen.draftFor(date) as ThreadsDraft;
      expect(d.post.chars).toBeLessThanOrEqual(THREADS_MAX_CHARS);
      expect(d.templateWarning).toBeUndefined();
      expect(d.post.text).toContain(pad);
      const base = def.draftFor(date) as ThreadsDraft;
      if (d.parts?.派票紀錄 !== base.parts?.派票紀錄 || d.parts?.昨天答案 !== base.parts?.昨天答案) shrunk++;
    }
    expect(shrunk).toBeGreaterThan(0);
  });

  it('a template that cannot fit 500 characters on a day falls back to the default for that day, with a warning', () => {
    const pad = '固'.repeat(480);
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null, postTemplate: `{標題}\n${pad}\n{你是}\n{派票紀錄}\n{標籤}` });
    const def = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const date = addDays(THREADS_START_DATE, 1);
    const d = gen.draftFor(date) as ThreadsDraft;
    expect(d.post.text).toBe(def.draftFor(date)?.post.text);
    expect(d.templateWarning).toContain('內建格式');
    expect(gen.warnings.some((w) => w.startsWith(`${date}：`))).toBe(true);
  });

  it('renderPost reports which answer version it used; a template without {昨天答案} has no answerToYesterday', () => {
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const date = addDays(THREADS_START_DATE, 1);
    const inp = inputsFor(gen, date, THREADS_START_DATE);
    const r = renderPost(inp.pv, { weekday: weekdayOf(date), answers: inp.answers });
    expect(r.answerIndex).toBeGreaterThanOrEqual(0);
    expect(r.parts.昨天答案).toBe(inp.answers[r.answerIndex].join('\n'));
    const noAnswer = new ThreadsGenerator({ bank, titles, readSaved: () => null, postTemplate: '{標題}\n{你是}\n{派票紀錄}\n{提問}\n\n{標籤}' });
    const d = noAnswer.draftFor(date) as ThreadsDraft;
    expect(d.post.text).not.toContain('的答案]');
    expect(d.answerToYesterday).toBeNull();
    expect(d.quoteYesterday).toBe(true);
  });
});

describe('first comment template', () => {
  const written = '【阿瓦隆百科小觀念】\n尾家看過前面 4 次派票，是這一局資訊最多的人。\nhttps://avalon-game-platform.web.app/w/wiki-206/';
  const draft = { theme: '週三・1-5 尾派', exerciseId: 'SV1Q8-1-5' };

  it('the default reproduces the written comment byte for byte; {小觀念} is the text without the header line', () => {
    expect(commentBody(written)).toBe('尾家看過前面 4 次派票，是這一局資訊最多的人。\nhttps://avalon-game-platform.web.app/w/wiki-206/');
    expect(commentText(written, draft).text).toBe(written);
    expect(commentText(written, draft, `${DEFAULT_COMMENT_TEMPLATE}\n`).text).toBe(written);
  });

  it('the owner’s comment template applies; over 500 characters falls back to the default with a warning', () => {
    expect(commentText(written, draft, '💡 阿瓦隆百科小觀念（{主題}）\n{小觀念}')).toEqual({ text: `💡 阿瓦隆百科小觀念（週三・1-5 尾派）\n${commentBody(written)}` });
    const long = commentText(written, draft, `${'長'.repeat(480)}\n{小觀念}`);
    expect(long.text).toBe(written);
    expect(long.warning).toContain('內建格式');
  });

  it('prepareDaily formats the written comment with the comment template (the fallback comment is left as it is)', () => {
    const commentsDir = tmp();
    fs.writeFileSync(path.join(commentsDir, '2026-11-18.md'), `${written}\n`);
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const plan = prepareDaily('2026-11-18', { gen, stateDir: tmp(), commentsDir, outDir: tmp(), commentTemplate: '💡 {小觀念}' }) as DailyPlan;
    expect(plan.comment).toBe(`💡 ${commentBody(written)}`);
    const plain = prepareDaily('2026-11-18', { gen, stateDir: tmp(), commentsDir, outDir: tmp() }) as DailyPlan;
    expect(plain.comment).toBe(written);
    const fallback = prepareDaily('2026-11-18', { gen, stateDir: tmp(), commentsDir: tmp(), outDir: tmp(), commentTemplate: '💡 {小觀念}' }) as DailyPlan;
    expect(fallback.comment.startsWith('💡')).toBe(false);
  });
});

describe('per-type templates (owner 11/18: 「順便幫我整理分類 目前有的題型 我直接進去改各種題型的格式」)', () => {
  const ok = (marker: string): string => `{標題}\n${marker}\n{接續}\n{你是}\n{派票紀錄}\n{提問}\n\n{昨天答案}\n\n{標籤}`;

  it('THREADS_TYPES lists every kind once with a Chinese name, a description and its days', () => {
    const kinds = new Set<ThreadsKind>([...THREADS_THEMES.map((t) => t.kind), 'round4']);
    expect(THREADS_TYPES.map((t) => t.kind).sort()).toEqual([...kinds].sort());
    for (const t of THREADS_TYPES) {
      expect(t.name).toMatch(/[\u4e00-\u9fff]/);
      expect(t.description.length).toBeGreaterThan(5);
      expect(t.days).toMatch(/週/);
      expect(typeOf(t.kind)).toBe(t);
    }
    expect(new Set(THREADS_TYPES.map((t) => t.name)).size).toBe(THREADS_TYPES.length);
  });

  it('every draft’s parts carry its type (kind + name), matching the pick', () => {
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const seen = new Set<string>();
    for (let i = 0; i < 28; i++) {
      const d = gen.draftFor(addDays(THREADS_START_DATE, i)) as ThreadsDraft;
      expect(d.parts?.type).toEqual({ kind: d.pick.kind, name: typeOf(d.pick.kind).name });
      seen.add(d.pick.kind);
    }
    expect(seen.has('tail') && seen.has('assassin') && seen.has('percival') && seen.has('final')).toBe(true);
  });

  it('byType in threads_template.json: valid entries are used; invalid fields, unknown types and a bad shape fall back with warnings', () => {
    const r = parseTemplateFile({
      post: ok('共用'),
      byType: {
        tail: { post: ok('尾派') },
        assassin: { comment: '🗡 {小觀念}' },
        percival: { post: '{標題}\n{派票紀錄}\n{標籤}' }, // 缺 {你是}
        lake: { post: ok('湖') },
        final: null,
      },
    });
    expect(r.template.byType).toEqual({ tail: { post: ok('尾派') }, assassin: { comment: '🗡 {小觀念}' } });
    expect(r.source.byType).toEqual({ tail: { post: 'file' }, assassin: { comment: 'file' } });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join()).toContain('派西維爾思考');
    expect(r.warnings.join()).toContain('lake');
    expect(parseTemplateFile({ byType: [] }).warnings).toHaveLength(1);
    expect(parseTemplateFile({ byType: { tail: 'x' } }).warnings).toHaveLength(1);
    expect(parseTemplateFile({ post: ok('共用') }).template.byType).toBeUndefined();
  });

  it('templateFor: the type’s own field → the shared one (which is the built-in default when none is saved)', () => {
    const t = parseTemplateFile({ post: ok('共用'), byType: { tail: { post: ok('尾派') }, final: { comment: '🏁 {小觀念}' } } }).template;
    expect(templateFor(t, 'tail')).toEqual({ post: ok('尾派'), comment: DEFAULT_COMMENT_TEMPLATE });
    expect(templateFor(t, 'final')).toEqual({ post: ok('共用'), comment: '🏁 {小觀念}' });
    expect(templateFor(t, 'percival')).toEqual({ post: ok('共用'), comment: DEFAULT_COMMENT_TEMPLATE });
    const onlyType = parseTemplateFile({ byType: { assassin: { post: ok('刺殺') } } }).template;
    expect(templateFor(onlyType, 'tail').post).toBe(DEFAULT_POST_TEMPLATE);
    expect(templateFor(onlyType, 'assassin').post).toBe(ok('刺殺'));
  });

  it('the generator picks each day’s template by its type; one tail template serves continuing and standalone days', () => {
    const t = parseTemplateFile({ post: ok('共用'), byType: { tail: { post: ok('尾派格式') }, assassin: { post: ok('刺殺格式') } } }).template;
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null, template: t });
    let continued = 0, alone = 0;
    for (let i = 0; i < 14; i++) {
      const date = addDays(THREADS_START_DATE, i);
      const d = gen.draftFor(date) as ThreadsDraft;
      const marker = d.pick.kind === 'tail' ? '尾派格式' : d.pick.kind === 'assassin' ? '刺殺格式' : '共用';
      expect(d.post.text.split('\n')[1]).toBe(marker);
      expect(d.post.chars).toBeLessThanOrEqual(THREADS_MAX_CHARS);
      if (d.pick.kind === 'tail') {
        if (d.continuesYesterday) {
          continued++;
          expect(d.post.text.split('\n')[2]).toMatch(/^接昨天那一局/);
        } else {
          alone++;
          expect(d.post.text.split('\n')[2]).toMatch(/^你是/);
        }
      }
    }
    expect(continued).toBeGreaterThan(0);
    expect(alone).toBeGreaterThan(0);
    expect(gen.warnings).toEqual([]);
    // 沒有任何格式：跟內建一樣。
    const plain = new ThreadsGenerator({ bank, titles, readSaved: () => null, template: parseTemplateFile({}).template });
    const def = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    for (let i = 0; i < 7; i++) expect(plain.draftFor(addDays(THREADS_START_DATE, i))?.post.text).toBe(def.draftFor(addDays(THREADS_START_DATE, i))?.post.text);
  });

  it('prepareDaily formats the comment with the type’s comment template', () => {
    const written = '【阿瓦隆百科小觀念】\n尾家看過前面 4 次派票。';
    const commentsDir = tmp();
    fs.writeFileSync(path.join(commentsDir, '2026-11-18.md'), written);
    const gen = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    const kind = gen.pickFor('2026-11-18')?.kind as ThreadsKind;
    const other: ThreadsKind = kind === 'tail' ? 'final' : 'tail';
    const template = parseTemplateFile({ comment: '共用 {小觀念}', byType: { [kind]: { comment: '這型 {小觀念}' }, [other]: { comment: '別型 {小觀念}' } } }).template;
    const plan = prepareDaily('2026-11-18', { gen, stateDir: tmp(), commentsDir, outDir: tmp(), template }) as DailyPlan;
    expect(plan.comment).toBe('這型 尾家看過前面 4 次派票。');
  });
});
