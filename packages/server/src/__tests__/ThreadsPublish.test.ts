/**
 * Threads 每日自動發佈（2026-11-17，站長同意自動發佈）：
 *   - 選題檔（threads_picks.json）蓋過計畫、週三選的局週四接著用、不合主題的題號忽略；
 *   - 內容檢查（≤ 500 字、最後一行剛好一個 #阿瓦隆、不寫 10 家、不含玩家名字）；連續 28 天的貼文都過；
 *   - 發文順序（假的 HTTP）：先找昨天的貼文 id → 發 A（引用）→ 先記下 A → 發第一則留言；
 *   - 不重複發：狀態檔有 id 就跳過、最近的貼文裡已經有今天的題號就補記不發；
 *   - 權杖不會出現在錯誤訊息；暫時性錯誤重試。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSimBank, readSimBankFile, type SimBank } from '../bots/simulation/bank';
import { readRecordPosts } from '../bots/simulation/recordsIndex';
import { ThreadsGenerator } from '../bots/threads/generate';
import { addDays, exerciseIdOfPick, weekdayOf } from '../bots/threads/plan';
import {
  fallbackComment,
  loadPlayerNames,
  planSummary,
  postDaily,
  prepareDaily,
  readComment,
  readPicks,
  readState,
  recordManual,
  savedFromState,
  validatePost,
  writeState,
  type DailyPlan,
} from '../bots/threads/publish/daily';
import { ThreadsApi, redact, type FetchLike } from '../bots/threads/publish/threadsApi';

const serverRoot = path.resolve(__dirname, '..', '..');
let bank: SimBank;
let titles: Map<string, string>;
let names: string[];

beforeAll(() => {
  const file = readSimBankFile([path.join(serverRoot, 'sim_bank.json')]);
  if (!file) throw new Error('sim_bank.json missing');
  bank = buildSimBank(file, readRecordPosts([path.join(serverRoot, 'records_cache.json')]));
  const wiki = JSON.parse(fs.readFileSync(path.join(serverRoot, 'wiki_data.json'), 'utf8')) as { id: string; title: string }[];
  titles = new Map(wiki.map((a) => [a.id, a.title] as [string, string]));
  names = loadPlayerNames(serverRoot);
});

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'threads-pub-'));
}

function gen(stateDir: string, picks: Map<string, string> = new Map()): ThreadsGenerator {
  return new ThreadsGenerator({ bank, titles, readSaved: savedFromState(stateDir), pickOverride: (d) => picks.get(d) ?? null });
}

/** 假的 Threads API：記下每一次呼叫，照路徑回答。 */
function fakeApi(opts: { recent?: { id: string; text: string; permalink?: string }[]; failFirst?: number; failReply?: boolean; onPermalink?: () => void } = {}) {
  const calls: { method: string; path: string; params: URLSearchParams }[] = [];
  let n = 0;
  let failLeft = opts.failFirst ?? 0;
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, params: u.searchParams });
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (failLeft > 0) {
      failLeft--;
      return reply(503, { error: { message: 'busy' } });
    }
    if (opts.failReply && u.pathname.endsWith('/threads') && init?.method === 'POST' && u.searchParams.get('reply_to_id')) return reply(400, { error: { message: 'reply rejected' } });
    if (u.pathname.endsWith('/threads') && init?.method === 'POST') return reply(200, { id: `c${++n}` });
    if (u.pathname.endsWith('/threads_publish')) return reply(200, { id: `p${u.searchParams.get('creation_id')}` });
    if (u.pathname.endsWith('/threads')) return reply(200, { data: opts.recent ?? [] });
    if (u.searchParams.get('fields') === 'status,error_message') return reply(200, { status: 'FINISHED' });
    if (u.searchParams.get('fields') === 'permalink') opts.onPermalink?.();
    if (u.searchParams.get('fields') === 'permalink') return reply(200, { permalink: `https://www.threads.net/@x/post/${u.pathname.split('/').pop()}` });
    return reply(404, {});
  };
  const api = new ThreadsApi({ token: 'SECRET-TOKEN', userId: '42', fetch, sleep: async () => {}, backoff: [1, 1, 1, 1] });
  return { api, calls };
}

describe('picks', () => {
  it('reads date → exercise id and skips malformed rows', () => {
    const dir = tmp();
    const f = path.join(dir, 'p.json');
    fs.writeFileSync(f, JSON.stringify({ version: 1, picks: { '2026-11-18': 'Y39DE-1-5', bad: 'x', '2026-11-19': 'nope' } }));
    const warnings: string[] = [];
    const picks = readPicks(f, warnings);
    expect([...picks]).toEqual([['2026-11-18', 'Y39DE-1-5']]);
    expect(warnings).toHaveLength(2);
    expect(readPicks(path.join(dir, 'missing.json')).size).toBe(0);
  });

  it('a chosen Wednesday game overrides the plan and Thursday continues it; a wrong-theme id is ignored', () => {
    const wed = '2026-11-25';
    const auto = gen(tmp());
    const autoWed = auto.pickFor(wed);
    // 另一個能出週三 1-5、而且有 3-5 可以接的局。
    const other = new ThreadsGenerator({ bank, titles, readSaved: () => null });
    let chosen: string | null = null;
    for (let i = 1; i < 40 && !chosen; i++) {
      const p = other.pickFor(addDays(wed, 7 * i));
      const nextDay = other.pickFor(addDays(wed, 7 * i + 1));
      if (p && nextDay?.continues && p.gameId !== autoWed?.gameId) {
        const g = other.gameOf(p.gameId);
        if (g) chosen = exerciseIdOfPick(p, g.game);
      }
    }
    expect(chosen).not.toBeNull();
    const g = gen(tmp(), new Map([[wed, chosen as string]]));
    const pick = g.pickFor(wed);
    expect(pick?.gameId).toBe((chosen as string).split('-')[0]);
    const thu = g.pickFor(addDays(wed, 1));
    expect(thu?.gameId).toBe(pick?.gameId);
    expect(thu?.continues).toBe(true);
    expect(g.warnings).toEqual([]);

    const bad = gen(tmp(), new Map([[wed, `${(chosen as string).split('-')[0]}-A`]]));
    expect(bad.pickFor(wed)?.gameId).toBe(autoWed?.gameId);
    expect(bad.warnings[0]).toContain('不是這天主題能出的題');
  });

  it('a published day keeps its saved pick even if a pick is listed later', () => {
    const stateDir = tmp();
    const first = gen(stateDir);
    const d = '2026-11-18';
    const draft = first.draftFor(d);
    if (!draft) throw new Error('no draft');
    writeState(stateDir, { date: d, exerciseId: draft.exerciseId, draft, source: 'auto', postId: 'p1' });
    const later = gen(stateDir, new Map([[d, 'ZZZZZ-1-5']]));
    expect(later.pickFor(d)?.gameId).toBe(draft.pick.gameId);
  });
});

describe('validation', () => {
  const ok = '題目\n題號 AAAAA-1-5｜實戰牌譜\n#阿瓦隆';
  it('passes a well-formed post and comment', () => {
    expect(validatePost({ text: ok, comment: '觀念\nhttps://avalon-game-platform.web.app/w/wiki-176/', names: [] })).toEqual([]);
  });
  it('catches length, tag position, 10家 and player names (without printing the name)', () => {
    expect(validatePost({ text: `${'字'.repeat(501)}\n#阿瓦隆`, comment: 'x' })[0]).toContain('超過');
    expect(validatePost({ text: '#阿瓦隆\n題目', comment: 'x' }).some((e) => e.includes('最後一行'))).toBe(true);
    expect(validatePost({ text: '題目\n#阿瓦隆\n#阿瓦隆', comment: 'x' }).some((e) => e.includes('剛好一行'))).toBe(true);
    expect(validatePost({ text: '10家 派\n#阿瓦隆', comment: 'x' }).some((e) => e.includes('0 家'))).toBe(true);
    const errs = validatePost({ text: ok, comment: '今天測試者小明很強', names: ['測試者小明', 'ED'] });
    expect(errs).toEqual(['第一則留言含疑似玩家名字（不列出名字）']);
    expect(validatePost({ text: ok, comment: 'RED team', names: ['ED'] })).toEqual([]);
    expect(validatePost({ text: ok, comment: '' })).toContain('第一則留言是空的');
  });

  it('28 days of generated posts with the fallback comment all pass', () => {
    const g = gen(tmp());
    for (let i = 0; i < 28; i++) {
      const date = addDays('2026-11-17', i);
      const d = g.draftFor(date);
      if (!d) continue;
      expect(validatePost({ text: d.post.text, comment: fallbackComment(d), names }), `${date} ${weekdayOf(date)}`).toEqual([]);
    }
  }, 60_000);
});

describe('comments', () => {
  it('reads ChatGPT’s file without HTML comments; falls back to a concept line and the article URL', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '2026-11-18.md'), '<!-- 備註 -->\n尾家的觀念。\nhttps://avalon-game-platform.web.app/w/wiki-205/\n');
    expect(readComment(dir, '2026-11-18')).toBe('尾家的觀念。\nhttps://avalon-game-platform.web.app/w/wiki-205/');
    expect(readComment(dir, '2026-11-19')).toBeNull();
    const d = gen(tmp()).draftFor('2026-11-18');
    if (!d) throw new Error('no draft');
    expect(fallbackComment(d)).toMatch(/^今天這題跟「.+」有關，觀念整理在這篇：\nhttps:\/\/avalon-game-platform\.web\.app\/w\//);
  });
});

describe('prepare + post', () => {
  function prepared(date = '2026-11-18', withImage = true): { plan: DailyPlan; stateDir: string } {
    const stateDir = tmp();
    const g = gen(stateDir);
    recordManual('2026-11-17', null, { gen: g, stateDir });
    const plan = prepareDaily(date, { gen: g, stateDir, commentsDir: tmp(), outDir: tmp(), names, ...(withImage ? { renderImage: () => Buffer.from('png') } : {}) });
    if (!plan) throw new Error('no plan');
    return { plan, stateDir };
  }

  it('quotes yesterday (found in recent posts), records A before the reply, then replies under A', async () => {
    const { plan, stateDir } = prepared();
    expect(plan.quote?.exerciseId).toBe('36AKW-2-5');
    expect(plan.errors).toEqual([]);
    const { api, calls } = fakeApi({ recent: [{ id: 'y17', text: `…\n題號 36AKW-2-5｜實戰牌譜\n#阿瓦隆`, permalink: 'https://www.threads.net/@x/post/y17' }] });
    const res = await postDaily(plan, { api, stateDir, imageUrl: 'https://raw.githubusercontent.com/o/r/sha/images/2026-11-18.png' });
    expect(res.status).toBe('published');
    expect(res.quotePostId).toBe('y17');
    const creates = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/42/threads'));
    expect(creates).toHaveLength(2);
    expect(creates[0].params.get('media_type')).toBe('IMAGE');
    expect(creates[0].params.get('quote_post_id')).toBe('y17');
    expect(creates[0].params.get('text')).toBe(plan.text);
    expect(creates[1].params.get('reply_to_id')).toBe(res.postId);
    expect(creates[1].params.get('text')).toBe(plan.comment);
    const st = readState(stateDir, '2026-11-18');
    expect(st?.postId).toBe(res.postId);
    expect(st?.commentId).toBe(res.commentId);
    expect(st?.permalink).toContain(res.postId);
    expect(readState(stateDir, '2026-11-17')?.postId).toBe('y17'); // 昨天補記
  });

  it('never posts twice: a recorded id skips; a recent post with today’s 題號 is recorded instead of reposting', async () => {
    const { plan, stateDir } = prepared();
    const first = fakeApi({ recent: [{ id: 'dup', text: `題號 ${plan.exerciseId}｜實戰牌譜` }] });
    const r1 = await postDaily(plan, { api: first.api, stateDir });
    expect(r1.status).toBe('found-existing');
    expect(first.calls.some((c) => c.method === 'POST')).toBe(false);
    const second = fakeApi();
    const r2 = await postDaily(plan, { api: second.api, stateDir });
    expect(r2.status).toBe('already-published');
    expect(second.calls).toHaveLength(0);
  });

  it('records the comment id as soon as the reply succeeds, before looking up the permalink (an interruption there cannot cause a second comment)', async () => {
    const { plan, stateDir } = prepared();
    let atPermalink: unknown;
    const { api } = fakeApi({ onPermalink: () => (atPermalink = readState(stateDir, '2026-11-18')?.commentId) });
    const res = await postDaily(plan, { api, stateDir });
    expect(res.commentId).toBeTruthy();
    expect(atPermalink).toBe(res.commentId);
    // 在查網址的時候中斷：狀態檔已經有留言 id，下一次不補留言
    const again = prepareDaily('2026-11-18', { gen: gen(stateDir), stateDir, commentsDir: tmp(), outDir: tmp(), names }) as DailyPlan;
    expect(again.resumeComment).toBe(false);
  });

  it('a failed first comment is resumed by a later run without posting A again', async () => {
    const { plan, stateDir } = prepared();
    const first = fakeApi({ failReply: true });
    const r1 = await postDaily(plan, { api: first.api, stateDir });
    expect(r1.status).toBe('published');
    expect(r1.commentId).toBeNull();
    expect(readState(stateDir, '2026-11-18')).toMatchObject({ postId: r1.postId, commentId: null });

    // 下一次執行：A 不再發，只補留言
    const again = prepareDaily('2026-11-18', { gen: gen(stateDir), stateDir, commentsDir: tmp(), outDir: tmp(), names });
    expect(again).toMatchObject({ alreadyPublished: true, resumeComment: true });
    const second = fakeApi();
    const r2 = await postDaily(again as DailyPlan, { api: second.api, stateDir });
    expect(r2.status).toBe('comment-resumed');
    const creates = second.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/42/threads'));
    expect(creates).toHaveLength(1);
    expect(creates[0].params.get('reply_to_id')).toBe(r1.postId);
    expect(readState(stateDir, '2026-11-18')).toMatchObject({ postId: r1.postId, commentId: r2.commentId });
    expect(r2.commentId).toBeTruthy();

    // 留言補上之後：什麼都不做
    const third = fakeApi();
    const plan3 = prepareDaily('2026-11-18', { gen: gen(stateDir), stateDir, commentsDir: tmp(), outDir: tmp(), names }) as DailyPlan;
    expect(plan3.resumeComment).toBe(false);
    expect((await postDaily(plan3, { api: third.api, stateDir })).status).toBe('already-published');
    expect(third.calls).toHaveLength(0);
  });

  it('does not resume comments for posts found in recent posts or posted by hand (unknown whether a comment exists)', async () => {
    const { plan, stateDir } = prepared();
    const first = fakeApi({ recent: [{ id: 'dup', text: `題號 ${plan.exerciseId}｜實戰牌譜` }] });
    expect((await postDaily(plan, { api: first.api, stateDir })).status).toBe('found-existing');
    const again = prepareDaily('2026-11-18', { gen: gen(stateDir), stateDir, commentsDir: tmp(), outDir: tmp(), names }) as DailyPlan;
    expect(again).toMatchObject({ alreadyPublished: true, resumeComment: false });
    const manual = prepareDaily('2026-11-17', { gen: gen(stateDir), stateDir, commentsDir: tmp(), outDir: tmp(), names }) as DailyPlan;
    expect(readState(stateDir, '2026-11-17')?.source).toBe('manual');
    expect(manual.resumeComment).toBe(false);
  });

  it('content rejected by validation is not printed and not written to plan.json (public CI logs and artifacts)', () => {
    // 從資料讀一個會被擋下的玩家名字（程式和測試裡不寫名字）
    const name = names.find((n) => validatePost({ text: '題號 X\n#阿瓦隆', comment: `看這裡 ${n} 好`, names: [n] }).length > 0);
    expect(name).toBeDefined();
    const stateDir = tmp();
    const commentsDir = tmp();
    const outDir = tmp();
    const secretComment = `看這裡 ${name} 好`;
    fs.writeFileSync(path.join(commentsDir, '2026-11-18.md'), secretComment);
    const plan = prepareDaily('2026-11-18', { gen: gen(stateDir), stateDir, commentsDir, outDir, names }) as DailyPlan;
    expect(plan.errors.join()).toContain('第一則留言含疑似玩家名字');
    const written = fs.readFileSync(path.join(outDir, 'plan.json'), 'utf8');
    // 用 true/false 比，測試失敗時 CI 紀錄也不會印出名字
    expect(written.includes(name as string)).toBe(false);
    expect(written.includes(plan.text.split('\n')[0])).toBe(false);
    expect(JSON.parse(written)).toMatchObject({ rejected: true, errors: plan.errors });
    const summary = planSummary(plan, 'dry-run').join('\n');
    expect(summary.includes(name as string)).toBe(false);
    expect(summary).not.toContain('### 貼文 A');
    expect(summary).toContain('第一則留言含疑似玩家名字');

    // 檢查過了才印內容、plan.json 才有內容（post 段要讀）
    const ok = prepareDaily('2026-11-18', { gen: gen(stateDir), stateDir, commentsDir: tmp(), outDir, names }) as DailyPlan;
    expect(ok.errors).toEqual([]);
    expect(planSummary(ok, 'dry-run').join('\n').includes(ok.comment)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(outDir, 'plan.json'), 'utf8')).text).toBe(ok.text);
  });

  it('posts without a quote when yesterday cannot be found, and refuses content that failed validation', async () => {
    const { plan, stateDir } = prepared('2026-11-18', false);
    const { api, calls } = fakeApi();
    const res = await postDaily(plan, { api, stateDir });
    expect(res.quotePostId).toBeNull();
    expect(res.notes.join()).toContain('這篇不引用');
    expect(calls.find((c) => c.method === 'POST')?.params.get('media_type')).toBe('TEXT');
    await expect(postDaily({ ...plan, errors: ['x'] }, { api, stateDir: tmp() })).rejects.toThrow('內容檢查沒過');
  });
});

describe('api', () => {
  it('retries transient errors and keeps the token out of error messages', async () => {
    const { api, calls } = fakeApi({ failFirst: 2 });
    expect(await api.publishReply({ text: 'hi', replyToId: 'p1' })).toMatch(/^p/);
    expect(calls.length).toBeGreaterThan(3);
    const failing = new ThreadsApi({
      token: 'SECRET-TOKEN',
      userId: '42',
      sleep: async () => {},
      backoff: [],
      fetch: async (url) => ({ ok: false, status: 400, text: async () => `bad request ${url}` }),
    });
    await expect(failing.publishPost({ text: 'x' })).rejects.toThrow(/HTTP 400/);
    await failing.publishPost({ text: 'x' }).catch((e: Error) => expect(e.message).not.toContain('SECRET-TOKEN'));
    expect(redact('x?access_token=abc&y=1 abc', 'abc')).toBe('x?access_token=***&y=1 ***');
  });
});

describe('workflow', () => {
  // 沒有 YAML 套件：照兩格縮排的「- name:／- uses:」切出每一步，只看 id、if、continue-on-error 這幾行。
  const steps = (): { name: string; id?: string; cond: string; continueOnError: boolean; body: string }[] => {
    const yml = fs.readFileSync(path.join(serverRoot, '..', '..', '.github', 'workflows', 'threads-publish.yml'), 'utf8');
    return yml
      .split(/\n {6}- /)
      .slice(1)
      .map((body) => ({
        name: /^(?:name|uses): (.*)/.exec(body)?.[1] ?? '',
        id: /\n {8}id: (\S+)/.exec(body)?.[1],
        cond: /\n {8}if: (.*)/.exec(body)?.[1] ?? '',
        continueOnError: /\n {8}continue-on-error: true/.test(body),
        body,
      }));
  };

  it('a Threads token refresh whose secret write fails only warns and still publishes with the refreshed token', () => {
    const all = steps();
    const refresh = all.find((s) => s.body.includes('threadsPublish.ts token --token-out'));
    expect(refresh?.continueOnError).toBe(true);
    expect(refresh?.body).toContain('if GH_TOKEN="$SECRETS_PAT" gh secret set THREADS_ACCESS_TOKEN');
    expect(refresh?.body).toContain('::warning::');
    // 寫回成功與否，這次都用新權杖（寫進 GITHUB_ENV，發文那一步優先讀它）
    const after = refresh?.body.split('gh secret set THREADS_ACCESS_TOKEN')[1] ?? '';
    expect(after.indexOf('fi\n')).toBeLessThan(after.indexOf('echo "THREADS_ACCESS_TOKEN='));
    const post = all.find((s) => s.body.includes('threadsPublish.ts post --state-dir'));
    expect(post?.body).toContain('THREADS_ACCESS_TOKEN: ${{ env.THREADS_ACCESS_TOKEN || secrets.THREADS_ACCESS_TOKEN }}');
  });
});
