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
  imageProblem,
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
  titleOf,
  findByExercise,
  savedFromState,
  postedFromState,
  validatePost,
  writeState,
  type DailyPlan,
} from '../bots/threads/publish/daily';
import { extraRenderers } from '../bots/threads/publish/extraImages';
import { GRID_PAGE_ROWS, GRID_TARGET_H, buildGridSvgs, buildPuzzleSvg, gridOverflowStart, gridPages, renderPuzzlePng, sheetRows } from '../bots/threads/image';
import { SEE_IMAGE_LINE, THREADS_TOPIC_TAG } from '../bots/threads/draft';
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

/** 測試的系列從 11/17 開始、那天的題目是 36AKW-2-5（以前寫死在程式裡，現在只是測試的設定）。 */
function gen(stateDir: string, picks: Map<string, string> = new Map(), opts: { hasPost?: (date: string) => boolean } = {}): ThreadsGenerator {
  const all = new Map([['2026-11-17', '36AKW-2-5'], ...picks]);
  return new ThreadsGenerator({ bank, titles, readSaved: savedFromState(stateDir), startDate: '2026-11-17', pickOverride: (d) => all.get(d) ?? null, ...opts });
}

/** 假的 Threads 伺服器的狀態（跨好幾次執行共用：已經發出去的貼文和回覆）。 */
interface FakeServer {
  containers: Map<string, URLSearchParams>;
  posts: { id: string; text: string; permalink?: string; timestamp?: string }[];
  /** 回覆（mine = false 是別人的）。 */
  replies: { id: string; text: string; replied_to: { id: string }; mine?: boolean }[];
  /** 回覆列表一頁幾則（測分頁用）。 */
  pageSize: number;
  publishCalls: string[];
  /** 發出去的貼文的時間（預設台北 11/18 中午）。 */
  now: string;
}

function fakeServer(): FakeServer {
  return { containers: new Map(), posts: [], replies: [], publishCalls: [], now: '2026-11-18T04:00:00+0000', pageSize: 50 };
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
    const repliesOf = /\/v1\.0\/([^/]+)\/replies$/.exec(u.pathname);
    if (repliesOf) {
      // 某一篇底下的回覆，照分頁（after＝從第幾則開始）
      const all = server.replies.filter((r) => r.replied_to.id === repliesOf[1]);
      const start = Number(u.searchParams.get('after') ?? 0);
      const page = all.slice(start, start + server.pageSize).map((r) => ({ id: r.id, text: r.text, username: r.mine === false ? 'someone' : 'me', is_reply_owned_by_me: r.mine !== false }));
      const more = start + server.pageSize < all.length;
      return reply(200, { data: page, paging: { cursors: { after: String(start + server.pageSize) }, ...(more ? { next: 'https://next' } : {}) } });
    }
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
  const ok = '題目\n輪到你 5家 忠臣 派 3 人，你會派誰？\n\n#阿瓦隆 #梅林 #派西維爾 #亞瑟的忠臣';
  const TAG = '#阿瓦隆 #梅林 #派西維爾 #亞瑟的忠臣';
  it('passes a well-formed post and comment', () => {
    expect(validatePost({ text: ok, comment: '觀念\nhttps://avalon-game-platform.web.app/w/wiki-176/', names: [] })).toEqual([]);
  });
  it('catches length, tag position, 10家 and player names (without printing the name)', () => {
    expect(validatePost({ text: `${'字'.repeat(501)}\n${TAG}`, comment: 'x' })[0]).toContain('超過');
    expect(validatePost({ text: `${TAG}\n題目`, comment: 'x' }).some((e) => e.includes('最後一行'))).toBe(true);
    expect(validatePost({ text: `題目\n${TAG}\n${TAG}`, comment: 'x' }).some((e) => e.includes('剛好一行'))).toBe(true);
    expect(validatePost({ text: '題目\n#阿瓦隆', comment: 'x' }).some((e) => e.includes('最後一行'))).toBe(true); // 舊的單一標籤不算
    expect(validatePost({ text: `10家 派\n${TAG}`, comment: 'x' }).some((e) => e.includes('0 家'))).toBe(true);
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

  it('quotes yesterday and gives its answer only when yesterday really has a post (threads-state record); otherwise a standalone first post', () => {
    // 沒有昨天的記錄（例如 11/17 根本沒發）：獨立的一篇，不引用、不附答案
    const empty = tmp();
    const alone = prepareDaily('2026-11-18', { gen: gen(empty, new Map(), { hasPost: postedFromState(empty) }), stateDir: empty, commentsDir: tmp(), outDir: tmp(), names }) as DailyPlan;
    expect(alone.quote).toBeNull();
    expect(alone.draft.answerToYesterday).toBeFalsy();
    expect(alone.text).not.toContain('的答案 ──');
    // 昨天有貼文 id：引用＋附答案
    const withPost = tmp();
    writeState(withPost, { date: '2026-11-17', exerciseId: '36AKW-2-5', draft: gen(withPost).draftFor('2026-11-17') as DailyPlan['draft'], source: 'auto', postId: 'p17' });
    const quoted = prepareDaily('2026-11-18', { gen: gen(withPost, new Map(), { hasPost: postedFromState(withPost) }), stateDir: withPost, commentsDir: tmp(), outDir: tmp(), names }) as DailyPlan;
    expect(quoted.quote).toMatchObject({ date: '2026-11-17', exerciseId: '36AKW-2-5', postId: 'p17' });
    expect(quoted.draft.answerToYesterday?.exerciseId).toBe('36AKW-2-5');
    // 只試跑過（有草稿記錄、沒有貼文 id）不算
    const dry = tmp();
    writeState(dry, { date: '2026-11-17', exerciseId: '36AKW-2-5', draft: gen(dry).draftFor('2026-11-17') as DailyPlan['draft'], source: 'auto', postId: null });
    expect(postedFromState(dry)('2026-11-17')).toBe(false);
    // 站長手動發、補記過（還沒有 id）算
    const manual = tmp();
    recordManual('2026-11-17', null, { gen: gen(manual), stateDir: manual });
    expect(postedFromState(manual)('2026-11-17')).toBe(true);
    // 週四：週三沒有貼文就不接同一局，改出獨立的題目
    const thuAlone = gen(empty, new Map(), { hasPost: postedFromState(empty) });
    const thu = thuAlone.pickFor('2026-11-19');
    expect(thu?.continues).toBeFalsy();
    expect(thuAlone.draftFor('2026-11-19')?.answerToYesterday).toBeFalsy();
    const thuChain = gen(tmp(), new Map(), { hasPost: () => true });
    expect(thuChain.pickFor('2026-11-19')?.continues).toBe(true);
    expect(thuChain.draftFor('2026-11-19')?.answerToYesterday).toBeTruthy();
  });

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

  it('posts no longer carry 題號 (站長 11/17): today’s and yesterday’s posts are recognised by title + Taipei date', async () => {
    const { plan, stateDir } = prepared();
    expect(plan.text).not.toContain('題號');
    const title = titleOf(plan.text);
    expect(title).toBe('【阿瓦隆每日一題｜週三・1-5 尾派】');
    expect(plan.quote?.title).toMatch(/^【阿瓦隆每日一題｜週二・/);
    // 昨天那篇（只有標題、沒有題號）：拿來引用；同一個標題但不是那一天的不算
    const y = { id: 'y17', text: `${plan.quote?.title}\n…\n\n${THREADS_TOPIC_TAG}`, timestamp: ON_17 };
    expect(findByExercise([y], '36AKW-2-5', '2026-11-17', plan.quote?.title)?.id).toBe('y17');
    expect(findByExercise([y], '36AKW-2-5', '2026-11-16', plan.quote?.title)).toBeNull();
    expect(findByExercise([y], '36AKW-2-5', '2026-11-17', title)).toBeNull(); // 今天的標題不是昨天那篇
    const { api } = fakeApi({ recent: [y] });
    const res = await postDaily(plan, { api, stateDir, imageUrl: 'https://raw.githubusercontent.com/o/r/sha/images/2026-11-18.png' });
    expect(res.quotePostId).toBe('y17');
    // 今天那篇已經發了（標題＋日期）：補記、不再發
    const s2 = tmp();
    const p2 = prepareDaily('2026-11-18', { gen: gen(s2), stateDir: s2, commentsDir: tmp(), outDir: tmp(), names, renderImage: () => Buffer.from('png') }) as DailyPlan;
    const again = fakeApi({ recent: [{ id: 'dup', text: p2.text, timestamp: ON_18 }] });
    const r2 = await postDaily(p2, { api: again.api, stateDir: s2 });
    expect(r2.status).toBe('found-existing');
    expect(again.calls.some((c) => c.method === 'POST' && c.path.endsWith('/42/threads') && !c.params.get('reply_to_id'))).toBe(false); // A 沒有再發
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

  it('our earlier comment on page 2 of the replies is found (pagination followed): no new comment', async () => {
    const { plan, stateDir } = prepared();
    const server = fakeServer();
    server.pageSize = 2;
    server.posts.push({ id: 'dup', text: `題號 ${plan.exerciseId}｜實戰牌譜`, timestamp: ON_18 });
    for (let i = 0; i < 3; i++) server.replies.push({ id: `o${i}`, text: '別人的回覆', replied_to: { id: 'dup' }, mine: false });
    server.replies.push({ id: 'mine', text: plan.comment, replied_to: { id: 'dup' } });
    const { api, calls } = fakeApi({}, server);
    const res = await postDaily(plan, { api, stateDir });
    expect(res).toMatchObject({ status: 'found-existing', commentId: 'mine' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(calls.filter((c) => c.path.endsWith('/dup/replies')).length).toBeGreaterThanOrEqual(2);
  });

  it('too many pages of replies to be sure: fails closed and does not post a comment', async () => {
    const { plan, stateDir } = prepared();
    const server = fakeServer();
    server.pageSize = 1;
    server.posts.push({ id: 'dup', text: `題號 ${plan.exerciseId}｜實戰牌譜`, timestamp: ON_18 });
    for (let i = 0; i < 25; i++) server.replies.push({ id: `o${i}`, text: '別人的回覆', replied_to: { id: 'dup' }, mine: false });
    const { api, calls } = fakeApi({}, server);
    await expect(api.findOwnReplyTo('dup', 3)).rejects.toThrow('確認不了');
    const res = await postDaily(plan, { api, stateDir });
    expect(res.commentId).toBeNull();
    expect(res.notes.join()).toContain('第一則留言這次不發');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(server.replies.filter((r) => r.mine !== false)).toHaveLength(0);
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

  it('a puzzle card that needs a continuation image (record too long) is a warning in the dry run and is not published live', async () => {
    const stateDir = tmp();
    const plan = prepareDaily('2026-11-18', {
      gen: gen(stateDir),
      stateDir,
      commentsDir: tmp(),
      outDir: tmp(),
      names,
      renderImage: () => Buffer.from('png'),
      imageIncomplete: () => '牌譜太長，題目卡要第二張續圖',
    }) as DailyPlan;
    expect(plan.errors).toEqual([]); // 試跑照常產生、內容照印
    expect(plan.liveBlock).toContain('牌譜太長');
    expect(plan.warnings.join()).toContain('正式發佈這天不發');
    expect(planSummary(plan, 'dry-run').join('\n')).toContain('正式發佈這天不發');
    const { api, calls } = fakeApi();
    await expect(postDaily(plan, { api, stateDir })).rejects.toThrow('這天不自動發');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // 沒有圖（只發文字）時不擋；完整的題目卡也不擋
    const noImage = prepareDaily('2026-11-18', { gen: gen(tmp()), stateDir: tmp(), commentsDir: tmp(), outDir: tmp(), names, imageIncomplete: () => 'x' }) as DailyPlan;
    expect(noImage.liveBlock).toBeNull();
    const whole = prepareDaily('2026-11-18', { gen: gen(tmp()), stateDir: tmp(), commentsDir: tmp(), outDir: tmp(), names, renderImage: () => Buffer.from('png'), imageIncomplete: () => null }) as DailyPlan;
    expect(whole.liveBlock).toBeNull();
  });

  it('a post whose record is shortened to 「完整局面看圖」 is not published live without its image', async () => {
    // 找一天：貼文的牌譜縮到要看圖
    const g0 = gen(tmp());
    let date: string | null = null;
    for (let i = 1; i < 200 && !date; i++) {
      const d = addDays('2026-11-17', i);
      if (g0.draftFor(d)?.post.text.includes(SEE_IMAGE_LINE)) date = d;
    }
    expect(date).not.toBeNull();
    const d = date as string;
    const make = (renderImage?: () => Buffer | null) => {
      const stateDir = tmp();
      return { stateDir, plan: prepareDaily(d, { gen: gen(stateDir), stateDir, commentsDir: tmp(), outDir: tmp(), names, ...(renderImage ? { renderImage } : {}) }) as DailyPlan };
    };
    for (const { plan, stateDir } of [
      make(), // 沒有圖
      make(() => null), // 畫不出來
      make(() => {
        throw new Error('font missing');
      }),
    ]) {
      expect(plan.liveBlock).toContain('完整局面看圖');
      expect(plan.warnings.join()).toContain('正式發佈這天不發');
      const { api, calls } = fakeApi();
      await expect(postDaily(plan, { api, stateDir })).rejects.toThrow('這天不自動發');
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    }
    // 有圖但沒有公開網址：也不發；有網址才發
    const ok = make(() => Buffer.from('png'));
    expect(ok.plan.liveBlock).toBeNull();
    await expect(postDaily(ok.plan, { api: fakeApi().api, stateDir: ok.stateDir })).rejects.toThrow('沒有公開網址');
    expect((await postDaily(ok.plan, { api: fakeApi().api, stateDir: ok.stateDir, imageUrl: 'https://x/a.png' })).status).toBe('published');
  }, 60_000);

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
    const { api, calls } = fakeApi({ recent: [{ id: 'y17', text: '題號 36AKW-2-5', timestamp: ON_17 }] });
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

  it('the Threads carousel is question card (→ continuation only when needed) → answer card; no recap images are required', async () => {
    // 找一天：前面有出完的局，而且那天公布昨天的完整答案（有答案卡）
    const stateDir = tmp();
    const g = gen(stateDir);
    let date: string | null = null;
    for (let i = 1; i < 200 && !date; i++) {
      const d = addDays('2026-11-17', i);
      const pick = g.pickFor(d);
      const pv = pick ? g.viewOf(pick) : null;
      const draft = pv && sheetRows(pv).some((r) => r.kind === 'quest') ? g.draftFor(d) : null;
      if (draft?.answerToYesterday && !draft.continuesYesterday) date = d;
    }
    expect(date).not.toBeNull();
    const d = date as string;
    const pv = g.viewOf(g.pickFor(d)!)!;
    // 跟腳本同一個檢查：只看續圖
    const need = gridPages(pv).length;
    const incomplete = (_d: string, images: readonly string[]): string | null => {
      const have = images.filter((n) => /-grid-\d+\.png$/.test(n)).length;
      return have < need ? `牌譜要 ${need} 張續圖，只產生了 ${have} 張` : null;
    };
    const plan = prepareDaily(d, {
      gen: g,
      stateDir,
      commentsDir: tmp(),
      outDir: tmp(),
      names,
      renderImage: () => renderPuzzlePng(pv, weekdayOf(d)),
      renderExtraImages: extraRenderers(g),
      imageIncomplete: incomplete,
    }) as DailyPlan;
    const grids = Array.from({ length: need }, (_, i) => `${d}-grid-${i + 1}.png`);
    expect(plan.images).toEqual([`${d}.png`, ...grids, `${d}-answer.png`]);
    expect(plan.images.some((n) => /-rounds?-/.test(n))).toBe(false); // 沒有回顧圖
    expect(plan.liveBlock).toBeNull();
    const urls = plan.images.map((n) => `https://raw.githubusercontent.com/o/r/sha/images/${n}`);
    const { api, calls } = fakeApi();
    await postDaily(plan, { api, stateDir, imageUrls: urls });
    const creates = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/42/threads'));
    const n = urls.length;
    expect(creates.slice(0, n).map((c) => c.params.get('image_url'))).toEqual(urls); // 題目卡 →（續圖）→ 答案卡
    expect(creates[n].params.get('media_type')).toBe('CAROUSEL');
    expect(creates[n].params.get('children')?.split(',')).toHaveLength(n);
  }, 60_000); // 畫圖＋排程找日子：CI 整套平行跑時會超過預設 5 秒

  it('a very long record is split into as many continuation images as needed: question card → 2/N … N/N → answer card; IG over 10 images is skipped', async () => {
    const stateDir = tmp();
    const g = gen(stateDir);
    const d = '2026-11-18';
    const base = g.viewOf(g.pickFor(d)!)!;
    // 很長的牌譜：把看得到的事件重複好幾次（只測切張，內容不重要）
    expect(base.shown.length).toBeGreaterThan(0);
    const copies = Math.ceil(240 / base.shown.length); // 大約 240 列：題目卡放不下，要三張以上的續圖
    const long = { ...base, shown: Array.from({ length: copies }, () => base.shown).flat() };
    const rows = sheetRows(long);
    const pages = gridPages(long);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    // 最早的列在續圖：從第 1 列開始、照順序、接到題目卡的第 1 列；每列剛好畫一次、每張 ≤ GRID_PAGE_ROWS 列
    expect(pages[0].start).toBe(0);
    for (let i = 1; i < pages.length; i++) expect(pages[i].start).toBe(pages[i - 1].end);
    expect(pages.at(-1)?.end).toBe(gridOverflowStart(long));
    expect(gridOverflowStart(long)).toBeLessThan(rows.length);
    for (const pg of pages) expect(pg.end - pg.start).toBeLessThanOrEqual(GRID_PAGE_ROWS);
    const total = pages.length + 1;
    const card = buildPuzzleSvg(long, weekdayOf(d));
    expect(card).toContain(`前面幾局的牌譜在後面的圖（往右滑）｜1/${total}`);
    const svgs = buildGridSvgs(long, weekdayOf(d));
    expect(svgs).toHaveLength(pages.length);
    svgs.forEach((svg, i) => {
      expect(svg).toContain(`牌譜 ${i + 2}/${total}`);
      expect(Number(/height="(\d+)"/.exec(svg)?.[1])).toBeLessThanOrEqual(GRID_TARGET_H);
      if (i < svgs.length - 1) expect(svg).toContain(`牌譜接下一張（往右滑）｜${i + 2}/${total}`);
      else expect(svg).toContain('盾牌 = 上隊');
    });

    // 發文：輪播照順序；子項數 = 題目卡＋續圖＋答案卡
    const extras = svgs.map((_, i) => ({ suffix: `grid-${i + 1}`, png: Buffer.from(`g${i + 1}`) }));
    const plan = prepareDaily(d, {
      gen: g,
      stateDir,
      commentsDir: tmp(),
      outDir: tmp(),
      names,
      renderImage: () => Buffer.from('q'),
      renderExtraImages: () => [...extras, { suffix: 'answer', png: Buffer.from('a') }],
      imageIncomplete: (_d, images) => (images.filter((n) => /-grid-\d+\.png$/.test(n)).length < pages.length ? 'missing' : null),
    }) as DailyPlan;
    expect(plan.liveBlock).toBeNull();
    expect(plan.images).toEqual([`${d}.png`, ...extras.map((e) => `${d}-${e.suffix}.png`), `${d}-answer.png`]);
    const urls = plan.images.map((n) => `https://x/${n}`);
    const { api, calls } = fakeApi();
    await postDaily(plan, { api, stateDir, imageUrls: urls });
    const creates = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/42/threads'));
    const items = creates.filter((c) => c.params.get('is_carousel_item') === 'true');
    expect(items.map((c) => c.params.get('image_url'))).toEqual(urls);
    const carousel = creates.find((c) => c.params.get('media_type') === 'CAROUSEL');
    expect(carousel?.params.get('children')?.split(',')).toHaveLength(urls.length);

    // 續圖沒產生：試跑警告、正式發佈不發；有產生但少了公開網址也不發
    const s2 = tmp();
    const noGrid = prepareDaily(d, {
      gen: gen(s2),
      stateDir: s2,
      commentsDir: tmp(),
      outDir: tmp(),
      names,
      renderImage: () => Buffer.from('q'),
      renderExtraImages: () => [{ suffix: 'answer', png: Buffer.from('a') }],
      imageIncomplete: (_d, images) => (images.filter((n) => /-grid-\d+\.png$/.test(n)).length < pages.length ? '牌譜續圖不齊' : null),
    }) as DailyPlan;
    expect(noGrid.liveBlock).toContain('牌譜續圖不齊');
    await expect(postDaily(noGrid, { api: fakeApi().api, stateDir: s2, imageUrls: ['u1', 'u2'] })).rejects.toThrow('這天不自動發');
    await expect(postDaily(plan, { api: fakeApi().api, stateDir: tmp(), imageUrls: urls.slice(0, 1) })).rejects.toThrow('公開網址');

    // IG：超過 10 張就這天不同步（不截掉），不建容器
    const many = { ...plan, images: Array.from({ length: 11 }, (_, i) => `${d}-${i}.png`) };
    const ig = fakeIg();
    const r = await postInstagram(many, { api: ig.api, stateDir: tmp(), imageUrls: many.images.map((n) => `https://x/${n}.jpg`) });
    expect(r.status).toBe('skipped');
    expect(r.notes.join()).toContain('IG 輪播最多 10 張');
    expect(ig.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  }, 60_000);

  it('an extra image that is not needed today (grid fits on the card → null) is skipped without dropping the answer card', () => {
    const stateDir = tmp();
    const plan = prepareDaily('2026-11-18', {
      gen: gen(stateDir),
      stateDir,
      commentsDir: tmp(),
      outDir: tmp(),
      names,
      renderImage: () => Buffer.from('q'),
      renderExtraImages: () => [
        { suffix: 'grid', png: null },
        { suffix: 'answer', png: Buffer.from('a') },
      ],
    });
    if (!plan) throw new Error('no plan');
    expect(plan.images).toEqual(['2026-11-18.png', '2026-11-18-answer.png']);
    expect(plan.warnings.join()).not.toContain('其他的圖');
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
function fakeIg(opts: { recent?: { id: string; caption: string; timestamp?: string }[]; losePublish?: number; noLimit?: boolean; noMe?: boolean } = {}) {
  const calls: { method: string; path: string; params: URLSearchParams }[] = [];
  const containers = new Map<string, string>();
  const published: { id: string; caption: string; timestamp?: string }[] = [];
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
      published.unshift({ id, caption: containers.get(cid) ?? '', timestamp: '2026-11-18T04:00:00+0000' });
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
    expect(c.split('\n').filter((l) => l === THREADS_TOPIC_TAG)).toHaveLength(1);
    expect(c.endsWith(THREADS_TOPIC_TAG)).toBe(true);
    expect(c).not.toContain('題號');
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
    const dup = fakeIg({ recent: [{ id: 'old', caption: `題號 ${s2.plan.exerciseId}｜實戰牌譜`, timestamp: ON_18 }] });
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

  it('an older IG post of the same exercise (another day) is not taken for today: IG still publishes one post', async () => {
    const { plan, stateDir } = prepared();
    const ig = fakeIg({ recent: [{ id: 'old', caption: `題號 ${plan.exerciseId}｜實戰牌譜`, timestamp: '2026-11-10T04:00:00+0000' }], losePublish: 1 });
    const r = await postInstagram(plan, { api: ig.api, stateDir, imageUrls: ['https://x/a.jpg'] });
    expect(r.status).toBe('published');
    expect(r.mediaId).not.toBe('old');
    expect(ig.published).toHaveLength(1);
    expect(r.mediaId).toBe(ig.published[0].id);
  });

  it('IG skips an incomplete puzzle the same way Threads does (liveBlock, missing continuation URL, text that needs the image), without publishing', async () => {
    const { plan, stateDir } = prepared();
    const cases: { p: DailyPlan; urls: string[] }[] = [
      { p: { ...plan, liveBlock: '牌譜太長，題目卡要第二張續圖，但續圖沒有產生' }, urls: ['https://x/a.jpg'] },
      { p: { ...plan, liveBlock: null, images: [`${plan.date}.png`, `${plan.date}-grid-1.png`, `${plan.date}-answer.png`] }, urls: ['https://x/a.jpg', 'https://x/c.jpg'] },
    ];
    for (const { p, urls } of cases) {
      const ig = fakeIg();
      const r = await postInstagram(p, { api: ig.api, stateDir, imageUrls: urls });
      expect(r.status).toBe('skipped');
      expect(r.notes.join()).toContain('IG 這天不同步');
      expect(ig.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
      expect(readState(stateDir, plan.date)?.ig).toBeUndefined();
    }
    expect(imageProblem({ ...plan, liveBlock: null, images: [], image: null, text: `x\n${SEE_IMAGE_LINE}` }, [])).toContain('完整局面看圖');
    // 完整的：照發
    const ok = fakeIg();
    expect((await postInstagram({ ...plan, liveBlock: null, images: [`${plan.date}.png`, `${plan.date}-grid-1.png`] }, { api: ok.api, stateDir, imageUrls: ['https://x/a.jpg', 'https://x/b.jpg'] })).status).toBe('published');
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

  it('job-level env does not use the runner context (GitHub rejects the whole workflow if it does)', () => {
    const yml = fs.readFileSync(path.join(serverRoot, '..', '..', '.github', 'workflows', 'threads-publish.yml'), 'utf8');
    // `runner.*` 只能用在 steps 裡；在 workflow／job 的 env 用了，整個 workflow 會解析失敗、排程也不會跑。
    const beforeSteps = yml.split(/\n {4}steps:\n/)[0];
    expect(beforeSteps).not.toMatch(/\$\{\{\s*runner\./);
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

  it('the final state step always pushes local commits (a checkpoint may have committed without pushing)', () => {
    const last = steps().find((s) => s.name === '記下發文狀態');
    expect(last?.body).toContain('commit -q -m "threads: $DATE（$MODE）" || echo');
    expect(last?.body).not.toMatch(/commit[^\n]*\|\| \{[^}]*exit 0/); // 沒有新 commit 也不提早結束
    expect(last?.body).toContain('push -q origin HEAD:threads-state');
    expect(last?.body).toMatch(/fetch -q origin threads-state && git -C "\$STATE_DIR" merge -q --no-edit FETCH_HEAD/);
  });

  describe('go-live gate (THREADS_LIVE_FROM) also covers the server dispatch (workflow_dispatch mode=auto)', () => {
    // 把「決定日期與模式」那一步的 shell 拿出來真的跑一次，看 mode／ig 的結果。
    const gateScript = (): string => {
      const gate = steps().find((s) => s.id === 'gate');
      const run = gate?.body.split(/\n {8}run: \|\n/)[1] ?? '';
      return run.split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
    };
    let hasBash = true;
    try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { hasBash = false; }
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const runGate = (env: Record<string, string>): Record<string, string> => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-gate-'));
      const out = path.join(dir, 'out');
      fs.writeFileSync(out, '');
      try {
        execFileSync('bash', ['-c', gateScript()], {
          env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: out, PUBLISH: '1', HAS_IG: 'true', IG_PUBLISH: '1', POST_HOUR: '12', IN_DATE: '', IN_MODE: '', LIVE_FROM: '', ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return Object.fromEntries(fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => l.split('=') as [string, string]));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };

    it('the gate is not limited to schedule events', () => {
      expect(gateScript()).toContain('if [ "$EVENT" = schedule ] || [ "${IN_MODE:-auto}" = auto ]; then AUTO=1; fi');
    });

    it.skipIf(!hasBash)('workflow_dispatch mode=auto stays a dry run (Threads and IG) while THREADS_LIVE_FROM is unset or in the future', () => {
      for (const LIVE_FROM of ['', '2999-01-01']) {
        const r = runGate({ EVENT: 'workflow_dispatch', IN_MODE: 'auto', LIVE_FROM });
        expect(r).toMatchObject({ mode: 'dry-run', ig: 'dry-run', run: '1', date: today });
      }
      // 日期填未來（≥ 起始日）也不能繞過：今天還沒到起始日就只試跑
      expect(runGate({ EVENT: 'workflow_dispatch', IN_MODE: 'auto', IN_DATE: '2999-06-01', LIVE_FROM: '2999-01-01' })).toMatchObject({ mode: 'dry-run', ig: 'dry-run' });
      // 補前幾天（早於起始日）也只試跑
      expect(runGate({ EVENT: 'workflow_dispatch', IN_MODE: 'auto', IN_DATE: '2026-01-01', LIVE_FROM: '2026-02-01' })).toMatchObject({ mode: 'dry-run', ig: 'dry-run' });
    });

    it.skipIf(!hasBash)('workflow_dispatch mode=auto goes live on and after THREADS_LIVE_FROM', () => {
      expect(runGate({ EVENT: 'workflow_dispatch', IN_MODE: 'auto', LIVE_FROM: today })).toMatchObject({ mode: 'live', ig: 'live', run: '1' });
      expect(runGate({ EVENT: 'workflow_dispatch', IN_MODE: 'auto', LIVE_FROM: '2026-01-01' })).toMatchObject({ mode: 'live', ig: 'live' });
      // THREADS_PUBLISH 沒開就照舊只試跑
      expect(runGate({ EVENT: 'workflow_dispatch', IN_MODE: 'auto', LIVE_FROM: '2026-01-01', PUBLISH: '0', IG_PUBLISH: '0' })).toMatchObject({ mode: 'dry-run', ig: 'dry-run' });
    });

    it.skipIf(!hasBash)('schedule is still gated; explicit manual modes keep working', () => {
      expect(runGate({ EVENT: 'schedule', LIVE_FROM: '' })).toMatchObject({ mode: 'dry-run', ig: 'dry-run' });
      expect(runGate({ EVENT: 'workflow_dispatch', IN_MODE: 'dry-run', LIVE_FROM: '' })).toMatchObject({ mode: 'dry-run', ig: 'dry-run', run: '1' });
      expect(runGate({ EVENT: 'workflow_dispatch', IN_MODE: 'record-manual', IN_DATE: '2026-11-17', LIVE_FROM: '' })).toMatchObject({ mode: 'record-manual', ig: 'off', run: '1', date: '2026-11-17' });
    });
  });

  it('the live post step pushes the state right after each side effect (--checkpoint-push)', () => {
    const post = steps().find((s) => s.body.includes('threadsPublish.ts post --state-dir'));
    expect(post?.body).toMatch(/threadsPublish\.ts post --state-dir "\$STATE_DIR" --out "\$OUT_DIR" --checkpoint-push/);
    const ig = steps().find((s) => s.body.includes('threadsPublish.ts post-ig'));
    expect(ig?.body).toMatch(/threadsPublish\.ts post-ig --state-dir "\$STATE_DIR" --out "\$OUT_DIR" --checkpoint-push/);
  });
});
