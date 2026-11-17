/**
 * Threads 每日自動發佈（2026-11-17，站長同意自動發佈）：
 *   - 選題檔（threads_picks.json）蓋過計畫、週三選的局週四接著用、不合主題的題號忽略；
 *   - 內容檢查（≤ 500 字、最後一行剛好一個 #阿瓦隆、不寫 10 家、不含玩家名字）；連續 28 天的貼文都過；
 *   - 發文順序（假的 HTTP）：先找昨天的貼文 id → 發 A（引用）→ 先記下 A → 發第一則留言；
 *   - 不重複發：狀態檔有 id 就跳過、最近的貼文裡已經有今天的題號就補記不發；
 *   - 權杖不會出現在錯誤訊息；暫時性錯誤重試。
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSimBank, readSimBankFile, type SimBank } from '../bots/simulation/bank';
import { readRecordPosts } from '../bots/simulation/recordsIndex';
import { ThreadsGenerator } from '../bots/threads/generate';
import { addDays, exerciseIdOfPick, weekdayOf } from '../bots/threads/plan';
import {
  igCaption,
  postInstagram,
  fallbackComment,
  loadPlayerNames,
  planSummary,
  postDaily,
  prepareDaily,
  readComment,
  readPicks,
  readState,
  recordManual,
  taipeiDateOf,
  savedFromState,
  validatePost,
  writeState,
  type DailyPlan,
} from '../bots/threads/publish/daily';
import { gitCheckpoint } from '../bots/threads/publish/stateGit';
import { REQUIRED_SCOPES, ThreadsApi, redact, tokenProblem, type FetchLike } from '../bots/threads/publish/threadsApi';
import { InstagramApi } from '../bots/threads/publish/instagramApi';

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

/** 假的 Threads 伺服器的狀態（跨好幾次執行共用：已經發出去的貼文和回覆）。 */
interface FakeServer {
  containers: Map<string, URLSearchParams>;
  posts: { id: string; text: string; permalink?: string; timestamp?: string }[];
  replies: { id: string; text: string; replied_to: { id: string } }[];
  publishCalls: string[];
  /** 發出去的貼文的時間（預設台北 11/18 中午）。 */
  now: string;
}

function fakeServer(): FakeServer {
  return { containers: new Map(), posts: [], replies: [], publishCalls: [], now: '2026-11-18T04:00:00+0000' };
}

const ON_17 = '2026-11-17T04:10:00+0000';
const ON_18 = '2026-11-18T04:10:00+0000';

/**
 * 假的 Threads API：記下每一次呼叫，照路徑回答；容器發佈後真的出現在最近的貼文／自己的回覆裡。
 * losePublish：發佈「其實成功了」但回應丟了（回 503）幾次；failPublish：發佈真的失敗（503、沒發）幾次。
 */
function fakeApi(
  opts: {
    recent?: { id: string; text: string; permalink?: string; timestamp?: string }[];
    failFirst?: number;
    failReply?: boolean;
    onPermalink?: () => void;
    losePublish?: { post?: number; reply?: number };
    failPublish?: { post?: number; reply?: number };
  } = {},
  server: FakeServer = fakeServer(),
) {
  const calls: { method: string; path: string; params: URLSearchParams }[] = [];
  let n = server.containers.size;
  let failLeft = opts.failFirst ?? 0;
  const lose = { post: opts.losePublish?.post ?? 0, reply: opts.losePublish?.reply ?? 0 };
  const fail = { post: opts.failPublish?.post ?? 0, reply: opts.failPublish?.reply ?? 0 };
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, params: u.searchParams });
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (failLeft > 0) {
      failLeft--;
      return reply(503, { error: { message: 'busy' } });
    }
    if (opts.failReply && u.pathname.endsWith('/threads') && init?.method === 'POST' && u.searchParams.get('reply_to_id')) return reply(400, { error: { message: 'reply rejected' } });
    if (u.pathname.endsWith('/threads') && init?.method === 'POST') {
      const id = `c${++n}`;
      server.containers.set(id, new URLSearchParams(u.searchParams));
      return reply(200, { id });
    }
    if (u.pathname.endsWith('/threads_publish')) {
      const cid = u.searchParams.get('creation_id') ?? '';
      const c = server.containers.get(cid);
      const kind = c?.get('reply_to_id') ? 'reply' : 'post';
      server.publishCalls.push(cid);
      if (fail[kind] > 0) {
        fail[kind]--;
        return reply(503, { error: { message: 'busy' } });
      }
      const id = `p${cid}`;
      if (server.posts.some((p) => p.id === id) || server.replies.some((r) => r.id === id)) return reply(400, { error: { message: 'already published' } });
      if (kind === 'reply') server.replies.unshift({ id, text: c?.get('text') ?? '', replied_to: { id: c?.get('reply_to_id') ?? '' } });
      else server.posts.unshift({ id, text: c?.get('text') ?? '', permalink: `https://www.threads.net/@x/post/${id}`, timestamp: server.now });
      if (lose[kind] > 0) {
        lose[kind]--;
        return reply(503, { error: { message: 'gateway timeout' } });
      }
      return reply(200, { id });
    }
    if (u.pathname.endsWith('/42/threads')) return reply(200, { data: [...server.posts, ...(opts.recent ?? [])] });
    if (u.pathname.endsWith('/42/replies')) return reply(200, { data: server.replies });
    if (u.searchParams.get('fields') === 'status,error_message') {
      const cid = u.pathname.split('/').pop() ?? '';
      return reply(200, { status: server.publishCalls.includes(cid) && [...server.posts, ...server.replies].some((x) => x.id === `p${cid}`) ? 'PUBLISHED' : 'FINISHED' });
    }
    if (u.searchParams.get('fields') === 'permalink') opts.onPermalink?.();
    if (u.searchParams.get('fields') === 'permalink') return reply(200, { permalink: `https://www.threads.net/@x/post/${u.pathname.split('/').pop()}` });
    return reply(404, {});
  };
  const api = new ThreadsApi({ token: 'SECRET-TOKEN', userId: '42', fetch, sleep: async () => {}, backoff: [1, 1, 1, 1] });
  return { api, calls, server };
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
    const { api, calls } = fakeApi({ recent: [{ id: 'y17', text: `…\n題號 36AKW-2-5｜實戰牌譜\n#阿瓦隆`, permalink: 'https://www.threads.net/@x/post/y17', timestamp: ON_17 }] });
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
    const first = fakeApi({ recent: [{ id: 'dup', text: `題號 ${plan.exerciseId}｜實戰牌譜`, timestamp: ON_18 }] });
    first.server.replies.push({ id: 'r-dup', text: plan.comment, replied_to: { id: 'dup' } });
    const r1 = await postDaily(plan, { api: first.api, stateDir });
    expect(r1.status).toBe('found-existing');
    expect(r1.commentId).toBe('r-dup'); // 留言也已經有了：沿用
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

  it('a post found in recent posts without our reply gets exactly one comment; a day posted by hand is not touched', async () => {
    const { plan, stateDir } = prepared();
    const first = fakeApi({ recent: [{ id: 'dup', text: `題號 ${plan.exerciseId}｜實戰牌譜`, timestamp: ON_18 }] });
    const r1 = await postDaily(plan, { api: first.api, stateDir });
    expect(r1.status).toBe('found-existing');
    const creates = first.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/42/threads'));
    expect(creates).toHaveLength(1);
    expect(creates[0].params.get('reply_to_id')).toBe('dup');
    expect(readState(stateDir, '2026-11-18')).toMatchObject({ postId: 'dup', commentId: r1.commentId });
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

  it('an older post of the same exercise (picked again) is not taken for today or as yesterday: today still publishes', async () => {
    expect(taipeiDateOf('2026-11-17T17:30:00+0000')).toBe('2026-11-18'); // 台北已經過午夜
    expect(taipeiDateOf(undefined)).toBeNull();
    const { plan, stateDir } = prepared();
    const old = [
      { id: 'old-today', text: `題號 ${plan.exerciseId}｜實戰牌譜`, timestamp: '2026-11-10T04:00:00+0000' },
      { id: 'old-yesterday', text: '題號 36AKW-2-5｜實戰牌譜', timestamp: '2026-11-03T04:00:00+0000' },
    ];
    const { api, calls, server } = fakeApi({ recent: old, losePublish: { post: 1 } });
    const res = await postDaily(plan, { api, stateDir });
    expect(res.status).toBe('published');
    expect(res.postId).not.toBe('old-today');
    expect(res.postId).toBe(server.posts[0].id); // 回應丟了也認得出今天發的那篇，不是舊的
    expect(res.quotePostId).toBeNull(); // 舊的那篇不是昨天的
    const creates = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/42/threads') && !c.params.get('reply_to_id'));
    expect(creates).toHaveLength(1);
    expect(creates[0].params.get('text')).toBe(plan.text);
    expect(server.posts).toHaveLength(1);
  });

  it('server published but the response was lost: adopts that post and that reply instead of publishing again', async () => {
    const { plan, stateDir } = prepared();
    const { api, server } = fakeApi({ losePublish: { post: 1, reply: 1 } });
    const res = await postDaily(plan, { api, stateDir });
    expect(res.status).toBe('published');
    expect(server.posts).toHaveLength(1); // A 只有一篇
    expect(server.replies).toHaveLength(1); // 留言只有一則
    expect(server.publishCalls).toHaveLength(2); // 每個容器只發佈一次，沒有重發
    expect(res.postId).toBe(server.posts[0].id);
    expect(res.commentId).toBe(server.replies[0].id);
    expect(readState(stateDir, plan.date)).toMatchObject({ postId: res.postId, commentId: res.commentId });
  });

  it('publish really failed (not published): checks first, then publishes once more', async () => {
    const { plan, stateDir } = prepared();
    const { api, server } = fakeApi({ failPublish: { post: 1 } });
    const res = await postDaily(plan, { api, stateDir });
    expect(res.status).toBe('published');
    expect(server.posts).toHaveLength(1);
    expect(server.publishCalls.filter((c) => !server.containers.get(c)?.get('reply_to_id'))).toHaveLength(2);
  });

  it('a container that shows PUBLISHED but cannot be found is not published again', async () => {
    const { api, server } = fakeApi({ losePublish: { post: 1 } });
    await expect(api.publishPost({ text: 'x', find: async () => null })).rejects.toThrow('不再重發');
    expect(server.publishCalls).toHaveLength(1);
    expect(server.posts).toHaveLength(1);
  });

  it('checkpoints the state after A and after the comment (pushed to a real git remote); a rerun after a crash posts nothing new', async () => {
    const git = (args: string[], cwd: string): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const base = tmp();
    const bare = path.join(base, 'state.git');
    git(['init', '-q', '--bare', '-b', 'threads-state', bare], base);
    const clone = (name: string): string => {
      const dir = path.join(base, name);
      git(['clone', '-q', bare, dir], base);
      return dir;
    };
    const { plan, stateDir: seedDir } = prepared();
    const server = fakeServer();
    server.posts.push({ id: 'y17', text: '題號 36AKW-2-5', timestamp: ON_17 });

    // 第一次：A 發出、推上去；留言發出後「當機」（留言的狀態沒推上去），整個工作目錄丟掉
    const run1 = clone('run1');
    fs.cpSync(path.join(seedDir, 'state'), path.join(run1, 'state'), { recursive: true });
    const labels: string[] = [];
    const r1 = await postDaily(plan, {
      api: fakeApi({}, server).api,
      stateDir: run1,
      checkpoint: async (label) => {
        labels.push(label);
        if (label === 'A') await gitCheckpoint(run1, `threads: ${plan.date} ${label}`, { sleep: async () => {} });
      },
    });
    expect(labels).toEqual(['A', '第一則留言']);
    expect(server.replies).toHaveLength(1);

    // 重跑：新的 clone 只看得到推上去的（A 有 id、留言是 null）→ 先查自己的回覆，沿用，不再發
    const run2 = clone('run2');
    expect(readState(run2, plan.date)).toMatchObject({ postId: r1.postId, commentId: null });
    const plan2 = prepareDaily(plan.date, { gen: gen(run2), stateDir: run2, commentsDir: tmp(), outDir: tmp(), names }) as DailyPlan;
    expect(plan2.resumeComment).toBe(true);
    const second = fakeApi({}, server);
    const r2 = await postDaily(plan2, { api: second.api, stateDir: run2, checkpoint: (label) => gitCheckpoint(run2, `threads: ${plan.date} ${label}`, { sleep: async () => {} }) });
    expect(r2).toMatchObject({ status: 'comment-resumed', commentId: r1.commentId });
    expect(second.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(server.posts.filter((p) => p.id !== 'y17')).toHaveLength(1);
    expect(server.replies).toHaveLength(1);

    // 再一次：推上去的狀態已經有留言 id → 什麼都不做
    const run3 = clone('run3');
    expect(readState(run3, plan.date)).toMatchObject({ postId: r1.postId, commentId: r1.commentId });
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

describe('threads carousel', () => {
  it('question card, grid and answer card are kept in order and posted as one carousel with the text and the quote', async () => {
    const stateDir = tmp();
    const g = gen(stateDir);
    recordManual('2026-11-17', null, { gen: g, stateDir });
    const outDir = tmp();
    const plan = prepareDaily('2026-11-18', {
      gen: g,
      stateDir,
      commentsDir: tmp(),
      outDir,
      names,
      renderImage: () => Buffer.from('q'),
      renderExtraImages: () => [
        { suffix: 'grid', png: Buffer.from('g') },
        { suffix: 'answer', png: Buffer.from('a') },
      ],
    });
    if (!plan) throw new Error('no plan');
    expect(plan.images).toEqual(['2026-11-18.png', '2026-11-18-grid.png', '2026-11-18-answer.png']);
    expect(fs.existsSync(path.join(outDir, '2026-11-18-grid.png'))).toBe(true);
    const urls = plan.images.map((n) => `https://raw.githubusercontent.com/o/r/sha/images/${n}`);
    const { api, calls } = fakeApi({ recent: [{ id: 'y17', text: '題號 36AKW-2-5' }] });
    const res = await postDaily(plan, { api, stateDir, imageUrls: urls });
    const creates = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/42/threads'));
    // 3 張子項、1 個輪播容器、1 則留言。
    expect(creates.map((c) => c.params.get('media_type'))).toEqual(['IMAGE', 'IMAGE', 'IMAGE', 'CAROUSEL', 'TEXT']);
    expect(creates.slice(0, 3).map((c) => c.params.get('image_url'))).toEqual(urls);
    expect(creates.slice(0, 3).every((c) => c.params.get('is_carousel_item') === 'true')).toBe(true);
    const carousel = creates[3];
    expect(carousel.params.get('children')).toBe('c1,c2,c3');
    expect(carousel.params.get('text')).toBe(plan.text);
    expect(carousel.params.get('quote_post_id')).toBe('y17');
    expect(creates[4].params.get('reply_to_id')).toBe(res.postId);
    expect(res.notes).toContain('輪播 3 張');
    expect(readState(stateDir, '2026-11-18')?.postId).toBe(res.postId);
  });

  it('one image stays a single image post; a failing extra renderer keeps the question card', async () => {
    const stateDir = tmp();
    const g = gen(stateDir);
    const plan = prepareDaily('2026-11-18', {
      gen: g,
      stateDir,
      commentsDir: tmp(),
      outDir: tmp(),
      names,
      renderImage: () => Buffer.from('q'),
      renderExtraImages: () => {
        throw new Error('font missing');
      },
    });
    if (!plan) throw new Error('no plan');
    expect(plan.images).toEqual(['2026-11-18.png']);
    expect(plan.warnings.join()).toContain('font missing');
    const { api, calls } = fakeApi();
    await postDaily(plan, { api, stateDir, imageUrls: ['https://x/2026-11-18.png'] });
    const first = calls.find((c) => c.method === 'POST' && c.path.endsWith('/42/threads'));
    expect(first?.params.get('media_type')).toBe('IMAGE');
    expect(first?.params.get('is_carousel_item')).toBeNull();
  });
});

describe('token check', () => {
  it('fails closed when permissions cannot be confirmed; passes only a valid token with every scope', () => {
    expect(tokenProblem(null)).toContain('確認不了權限');
    expect(tokenProblem({ valid: true, scopes: [], expiresAt: 0 })).toContain('確認不了權限');
    expect(tokenProblem({ valid: false, scopes: [...REQUIRED_SCOPES], expiresAt: 0 })).toContain('失效');
    expect(tokenProblem({ valid: true, scopes: ['threads_basic', 'threads_content_publish'], expiresAt: 0 })).toContain('threads_manage_replies');
    expect(tokenProblem({ valid: true, scopes: [...REQUIRED_SCOPES], expiresAt: 0 })).toBeNull();
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

/**
 * 假的 Instagram API：發佈後真的出現在最近的貼文裡。
 * losePublish：發佈其實成功但回應丟了（回 503）幾次；noLimit：查不到發文額度（權限不夠）；noMe：查不到帳號。
 */
function fakeIg(opts: { recent?: { id: string; caption: string }[]; losePublish?: number; noLimit?: boolean; noMe?: boolean } = {}) {
  const calls: { method: string; path: string; params: URLSearchParams }[] = [];
  const containers = new Map<string, string>();
  const published: { id: string; caption: string }[] = [];
  const publishCalls: string[] = [];
  let n = 0;
  let lose = opts.losePublish ?? 0;
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, params: u.searchParams });
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (u.pathname.endsWith('/media') && init?.method === 'POST') {
      const id = `ic${++n}`;
      containers.set(id, u.searchParams.get('caption') ?? '');
      return reply(200, { id });
    }
    if (u.pathname.endsWith('/media_publish')) {
      const cid = u.searchParams.get('creation_id') ?? '';
      publishCalls.push(cid);
      const id = `im${cid}`;
      if (published.some((p) => p.id === id)) return reply(400, { error: { message: 'already published' } });
      published.unshift({ id, caption: containers.get(cid) ?? '' });
      if (lose > 0) {
        lose--;
        return reply(503, { error: { message: 'gateway timeout' } });
      }
      return reply(200, { id });
    }
    if (u.pathname.endsWith('/media')) return reply(200, { data: [...published, ...(opts.recent ?? [])] });
    if (u.pathname.endsWith('/content_publishing_limit')) return opts.noLimit ? reply(403, { error: { message: 'missing permission' } }) : reply(200, { data: [{ quota_usage: 1, config: { quota_total: 50 } }] });
    if (u.pathname.endsWith('/me')) return opts.noMe ? reply(401, { error: { message: 'invalid token' } }) : reply(200, { user_id: '77', username: 'x' });
    if (u.searchParams.get('fields') === 'status_code,status') {
      const cid = u.pathname.split('/').pop() ?? '';
      return reply(200, { status_code: published.some((p) => p.id === `im${cid}`) ? 'PUBLISHED' : 'FINISHED' });
    }
    if (u.searchParams.get('fields') === 'permalink') return reply(200, { permalink: `https://www.instagram.com/p/${u.pathname.split('/').pop()}/` });
    return reply(404, {});
  };
  return { api: new InstagramApi({ token: 'IG-SECRET', userId: '77', fetch, sleep: async () => {}, backoff: [1] }), calls, published, publishCalls };
}

describe('instagram', () => {
  function prepared(): { plan: DailyPlan; stateDir: string } {
    const stateDir = tmp();
    const g = gen(stateDir);
    const plan = prepareDaily('2026-11-18', { gen: g, stateDir, commentsDir: tmp(), outDir: tmp(), names, renderImage: () => Buffer.from('png') });
    if (!plan) throw new Error('no plan');
    return { plan, stateDir };
  }

  it('caption = the post text + the first comment, #阿瓦隆 once at the end, records link kept as text', () => {
    const { plan } = prepared();
    const c = igCaption(plan);
    expect(c.startsWith(plan.text.split('\n')[0])).toBe(true);
    expect(c).toContain(plan.comment);
    expect(c.split('\n').filter((l) => l === '#阿瓦隆')).toHaveLength(1);
    expect(c.endsWith('#阿瓦隆')).toBe(true);
    expect(c).toContain('#records=');
  });

  it('single image: container → wait → publish; records the IG id next to the Threads state; never twice', async () => {
    const { plan, stateDir } = prepared();
    writeState(stateDir, { date: plan.date, exerciseId: plan.exerciseId, draft: plan.draft, source: 'auto', postId: 'th1' });
    const { api, calls } = fakeIg();
    const r = await postInstagram(plan, { api, stateDir, imageUrls: ['https://raw.githubusercontent.com/o/r/s/images/2026-11-18.jpg'] });
    expect(r.status).toBe('published');
    const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('/77/media'));
    expect(create?.params.get('image_url')).toContain('.jpg');
    expect(create?.params.get('caption')).toBe(igCaption(plan));
    expect(calls.some((c) => c.path.endsWith('/77/media_publish'))).toBe(true);
    const st = readState(stateDir, plan.date);
    expect(st?.postId).toBe('th1');
    expect(st?.ig?.mediaId).toBe(r.mediaId);
    expect(st?.ig?.permalink).toContain('instagram.com');
    const again = fakeIg();
    expect((await postInstagram(plan, { api: again.api, stateDir, imageUrls: ['x'] })).status).toBe('already-published');
    expect(again.calls).toHaveLength(0);
  });

  it('two images make a carousel; a recent post with today’s 題號 is recorded; no image = skipped', async () => {
    const { plan, stateDir } = prepared();
    const { api, calls } = fakeIg();
    await postInstagram(plan, { api, stateDir, imageUrls: ['https://x/a.jpg', 'https://x/b.jpg'] });
    const posts = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/77/media'));
    expect(posts.map((c) => c.params.get('is_carousel_item'))).toEqual(['true', 'true', null]);
    expect(posts[2].params.get('media_type')).toBe('CAROUSEL');
    expect(posts[2].params.get('children')).toBe('ic1,ic2');

    const s2 = prepared();
    const dup = fakeIg({ recent: [{ id: 'old', caption: `題號 ${s2.plan.exerciseId}｜實戰牌譜` }] });
    expect((await postInstagram(s2.plan, { api: dup.api, stateDir: s2.stateDir, imageUrls: ['x'] })).status).toBe('found-existing');
    expect(dup.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(readState(s2.stateDir, s2.plan.date)?.postId).toBeNull(); // Threads 那邊之後照樣能發

    const s3 = prepared();
    expect((await postInstagram(s3.plan, { api: fakeIg().api, stateDir: s3.stateDir, imageUrls: [] })).status).toBe('skipped');
  });

  it('IG published but the response was lost: adopts that post instead of publishing again; checkpoints after publishing', async () => {
    const { plan, stateDir } = prepared();
    const ig = fakeIg({ losePublish: 1 });
    const labels: string[] = [];
    const r = await postInstagram(plan, { api: ig.api, stateDir, imageUrls: ['https://x/a.jpg'], checkpoint: (l) => void labels.push(l) });
    expect(r.status).toBe('published');
    expect(ig.published).toHaveLength(1); // 只有一篇
    expect(ig.publishCalls).toHaveLength(1); // 沒有重發
    expect(r.mediaId).toBe(ig.published[0].id);
    expect(readState(stateDir, plan.date)?.ig?.mediaId).toBe(r.mediaId);
    expect(labels).toEqual(['IG']);
  });

  it('IG publishing is checked first: an unconfirmable token or missing publish permission is reported (IG skipped, Threads untouched)', async () => {
    expect(await fakeIg().api.publishingProblem()).toBeNull();
    expect(await fakeIg({ noLimit: true }).api.publishingProblem()).toContain('確認不了 IG 的發文權限');
    expect(await fakeIg({ noMe: true }).api.publishingProblem()).toContain('查不到 IG 帳號');
    const msg = (await fakeIg({ noMe: true }).api.publishingProblem()) ?? '';
    expect(msg.includes('IG-SECRET')).toBe(false);
  });

  it('a Threads post after IG keeps the IG record', async () => {
    const { plan, stateDir } = prepared();
    await postInstagram(plan, { api: fakeIg().api, stateDir, imageUrls: ['x'] });
    const { api } = fakeApi();
    await postDaily(plan, { api, stateDir });
    const st = readState(stateDir, plan.date);
    expect(st?.postId).toBeTruthy();
    expect(st?.ig?.mediaId).toBeTruthy();
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

  it('an Instagram JPEG conversion failure does not stop the Threads upload and post; IG publishes only after a successful conversion', () => {
    const all = steps();
    const jpeg = all.find((s) => s.id === 'ig_jpeg');
    expect(jpeg?.continueOnError).toBe(true);
    const image = all.find((s) => s.id === 'image');
    const post = all.find((s) => s.body.includes('threadsPublish.ts post --state-dir'));
    const ig = all.find((s) => s.body.includes('threadsPublish.ts post-ig'));
    expect(image && post && ig).toBeTruthy();
    // Threads 的上傳和發文不看轉檔的結果
    expect(image?.cond).not.toContain('ig_jpeg');
    expect(post?.cond).not.toContain('ig_jpeg');
    // IG 只在轉檔成功時發，也只拿轉檔成功的 JPEG 網址
    expect(ig?.cond).toContain("steps.ig_jpeg.outcome == 'success'");
    expect(image?.body).toContain("IG_JPEG_OK: ${{ steps.ig_jpeg.outcome == 'success' && '1' || '0' }}");
    expect(image?.body.match(/IG_JPEG_OK" = 1/g)?.length).toBe(2);
  });

  it('an IG token refresh whose secret write fails only warns and does not stop Threads', () => {
    const all = steps();
    const refresh = all.find((s) => s.body.includes('token-ig --token-out'));
    expect(refresh?.continueOnError).toBe(true);
    expect(refresh?.body).toContain('if GH_TOKEN="$SECRETS_PAT" gh secret set INSTAGRAM_ACCESS_TOKEN');
    expect(refresh?.body).toContain('::warning::');
    // Threads 的產生不看 IG 續期的結果
    expect(all.find((s) => s.id === 'prepare')?.cond).not.toMatch(/ig/i);
  });

  it('uploads the dry-run artifact when either Threads or IG is a dry run (IG JPEG previews with Threads live)', () => {
    const upload = steps().find((s) => s.name.startsWith('試跑：把要發的內容存成附件'));
    expect(upload?.cond).toContain("steps.gate.outputs.mode == 'dry-run'");
    expect(upload?.cond).toContain("steps.gate.outputs.ig == 'dry-run'");
  });

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

  it('the live post step pushes the state right after each side effect (--checkpoint-push)', () => {
    const post = steps().find((s) => s.body.includes('threadsPublish.ts post --state-dir'));
    expect(post?.body).toMatch(/threadsPublish\.ts post --state-dir "\$STATE_DIR" --out "\$OUT_DIR" --checkpoint-push/);
    const ig = steps().find((s) => s.body.includes('threadsPublish.ts post-ig'));
    expect(ig?.body).toMatch(/threadsPublish\.ts post-ig --state-dir "\$STATE_DIR" --out "\$OUT_DIR" --checkpoint-push/);
  });
});
