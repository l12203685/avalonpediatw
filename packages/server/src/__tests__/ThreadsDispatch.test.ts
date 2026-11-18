import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  ThreadsDispatcher, findAutoRunToday, isAutoRunTitle, taipeiMidnightIso, threadsStartMinute, type ThreadsFetchLike,
} from '../services/threadsDispatch';

const logger = { info: vi.fn(), warn: vi.fn() };
const tw = (day: number, h: number, m: number, s = 0) => Date.UTC(2026, 10, day, h - 8, m, s); // 台灣 11/day h:m

type Run = { display_title: string; conclusion: string | null; created_at: string; event?: string };
const autoTitle = 'Threads 每日發文 mode=auto date=today';

/**
 * 假的 GitHub：記下每一次呼叫；POST dispatches 成功時就多一筆 mode=auto 的執行（跟 GitHub 一樣，
 * 之後再查就看得到）。多個 ThreadsDispatcher 共用同一個，模擬部署時新舊程序並存。
 */
function fakeGitHub(opts: { runs?: Run[]; dispatch?: () => { ok: boolean; status: number }; list?: () => { ok: boolean; status: number } } = {}) {
  const runs: Run[] = [...(opts.runs ?? [])];
  const calls: { method: string; url: string; body?: string }[] = [];
  let clock = 0;
  const fetchFn: ThreadsFetchLike = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body });
    if (init.method === 'GET') {
      const l = opts.list?.() ?? { ok: true, status: 200 };
      const since = new URL(url).searchParams.get('created')?.replace(/^>=/, '') ?? '';
      const visible = runs.filter((r) => Date.parse(r.created_at) >= Date.parse(since));
      return { ...l, json: async () => ({ total_count: visible.length, workflow_runs: visible }) };
    }
    const d = opts.dispatch?.() ?? { ok: true, status: 204 };
    if (d.ok) runs.push({ display_title: autoTitle, conclusion: null, created_at: new Date(clock).toISOString(), event: 'workflow_dispatch' });
    return d;
  };
  return { fetchFn, calls, runs, setClock: (t: number) => { clock = t; }, posts: () => calls.filter((c) => c.method === 'POST') };
}

describe('每天觸發 Threads 每日發文（伺服器自己觸發）', () => {
  it('台灣 12:07 前不觸發；之後每天一次；23:00 後不補；隔天再一次', async () => {
    const gh = fakeGitHub();
    const d = new ThreadsDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't' }), gh.fetchFn, logger);
    expect(await d.tick(tw(18, 12, 6))).toBe(false);
    gh.setClock(tw(18, 12, 7));
    expect(await d.tick(tw(18, 12, 7))).toBe(true);
    expect(await d.tick(tw(18, 15, 0))).toBe(false);
    expect(gh.posts()).toHaveLength(1);
    expect(gh.posts()[0].url).toBe('https://api.github.com/repos/l12203685/avalonpediatw/actions/workflows/threads-publish.yml/dispatches');
    expect(JSON.parse(gh.posts()[0].body ?? '')).toEqual({ ref: 'main', inputs: { mode: 'auto', date: '' } });
    expect(await d.tick(tw(19, 23, 30))).toBe(false); // 隔天 23:00 後不補
    gh.setClock(tw(20, 12, 7));
    expect(await d.tick(tw(20, 12, 7))).toBe(true); // 前一天的執行不算今天
    expect(gh.posts()).toHaveLength(2);
  });

  it('THREADS_POST_HOUR 改開始時間；格式不對用 12', () => {
    expect(threadsStartMinute({})).toBe(12 * 60 + 7);
    expect(threadsStartMinute({ THREADS_POST_HOUR: '9' })).toBe(9 * 60 + 7);
    expect(threadsStartMinute({ THREADS_POST_HOUR: '09' })).toBe(9 * 60 + 7);
    expect(threadsStartMinute({ THREADS_POST_HOUR: '23' })).toBe(12 * 60 + 7);
    expect(threadsStartMinute({ THREADS_POST_HOUR: 'noon' })).toBe(12 * 60 + 7);
  });

  it('失敗或沒回應的下一分鐘再試；沒有 token 或關閉時不打 API', async () => {
    let n = 0;
    const gh = fakeGitHub({
      dispatch: () => {
        n += 1;
        if (n === 1) throw Object.assign(new Error('x'), { name: 'TimeoutError' });
        return { ok: n > 2, status: n > 2 ? 204 : 500 };
      },
    });
    const d = new ThreadsDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't' }), gh.fetchFn, logger);
    expect(await d.tick(tw(18, 12, 10))).toBe(false);
    expect(d.state.lastError).toBe('TimeoutError');
    expect(await d.tick(tw(18, 12, 11))).toBe(false);
    expect(d.state.lastError).toBe('status=500');
    gh.setClock(tw(18, 12, 12));
    expect(await d.tick(tw(18, 12, 12))).toBe(true);
    const f = vi.fn();
    expect(await new ThreadsDispatcher(() => ({}), f, logger).tick(tw(18, 13, 0))).toBe(false);
    expect(await new ThreadsDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't', THREADS_DISPATCH: 'off' }), f, logger).tick(tw(18, 13, 0))).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('一天只觸發一次：跨重啟、跨程序（2026-11-18 12:07 觸發兩次、12:16 部署後又一次）', () => {
  it('查今天的執行：workflow_dispatch、台北 00:00 以後（UTC 前一天 16:00）', async () => {
    expect(taipeiMidnightIso('2026-11-18')).toBe('2026-11-17T16:00:00Z');
    expect(taipeiMidnightIso('2026-01-01')).toBe('2025-12-31T16:00:00Z');
    const gh = fakeGitHub();
    await new ThreadsDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't' }), gh.fetchFn, logger).tick(tw(18, 12, 7));
    const get = gh.calls[0];
    expect(get.method).toBe('GET');
    const u = new URL(get.url);
    expect(u.pathname).toBe('/repos/l12203685/avalonpediatw/actions/workflows/threads-publish.yml/runs');
    expect(u.searchParams.get('event')).toBe('workflow_dispatch');
    expect(u.searchParams.get('created')).toBe('>=2026-11-17T16:00:00Z');
    expect(gh.calls.map((c) => c.method)).toEqual(['GET', 'POST']); // 先查再觸發
  });

  it('部署時新舊兩個程序並存（相隔 4 秒各看一次）：只觸發一次', async () => {
    const gh = fakeGitHub();
    const env = () => ({ GITHUB_DISPATCH_TOKEN: 't' });
    const oldProc = new ThreadsDispatcher(env, gh.fetchFn, logger);
    const newProc = new ThreadsDispatcher(env, gh.fetchFn, logger);
    gh.setClock(tw(18, 12, 7, 10));
    expect(await oldProc.tick(tw(18, 12, 7, 10))).toBe(true);
    expect(await newProc.tick(tw(18, 12, 7, 14))).toBe(false); // 新程序啟動時馬上看一次
    expect(newProc.state.doneDay).toBe('2026-11-18');
    expect(gh.posts()).toHaveLength(1);
  });

  it('重新部署（記憶體清空）後同一天不再觸發，也不會每分鐘一直查', async () => {
    const gh = fakeGitHub({ runs: [{ display_title: autoTitle, conclusion: 'success', created_at: '2026-11-18T04:07:10Z', event: 'workflow_dispatch' }] });
    const restarted = new ThreadsDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't' }), gh.fetchFn, logger);
    expect(await restarted.tick(tw(18, 12, 16))).toBe(false);
    expect(await restarted.tick(tw(18, 12, 17))).toBe(false);
    expect(gh.posts()).toHaveLength(0);
    expect(gh.calls).toHaveLength(1); // 查到一次就記住今天
  });

  it('只算 mode=auto、今天、沒被取消的；手動試跑、補記、排程、昨天的、取消的都不算', async () => {
    const day = '2026-11-18';
    expect(isAutoRunTitle('Threads 每日發文 mode=auto date=today', day)).toBe(true);
    expect(isAutoRunTitle('Threads 每日發文 mode=auto date=2026-11-18', day)).toBe(true);
    expect(isAutoRunTitle('Threads 每日發文 mode=auto date=2026-11-17', day)).toBe(false);
    expect(isAutoRunTitle('Threads 每日發文 mode=dry-run date=today', day)).toBe(false);
    expect(isAutoRunTitle('Threads 每日發文 mode=record-manual date=2026-11-18', day)).toBe(false);
    expect(isAutoRunTitle('Threads 每日發文 mode=schedule date=today', day)).toBe(false);
    expect(isAutoRunTitle('Threads 每日發文', day)).toBe(false);
    const runs: Run[] = [
      { display_title: 'Threads 每日發文 mode=dry-run date=today', conclusion: 'success', created_at: '2026-11-18T01:00:00Z' },
      { display_title: autoTitle, conclusion: 'cancelled', created_at: '2026-11-18T04:07:00Z' },
      { display_title: autoTitle, conclusion: 'success', created_at: '2026-11-17T04:07:00Z' }, // 昨天（API 沒濾掉也不算）
    ];
    const fetchFn: ThreadsFetchLike = async () => ({ ok: true, status: 200, json: async () => ({ workflow_runs: runs }) });
    expect(await findAutoRunToday(fetchFn, 't', 'o/r', day)).toEqual({ ok: true, found: false });
    runs.push({ display_title: autoTitle, conclusion: null, created_at: '2026-11-18T04:07:10Z' }); // 排隊中的也算
    expect(await findAutoRunToday(fetchFn, 't', 'o/r', day)).toEqual({ ok: true, found: true });
  });

  it('查不到今天的執行（狀態碼、沒回應、內容不對）就不觸發，下一分鐘再試', async () => {
    let listStatus = 403;
    const gh = fakeGitHub({ list: () => ({ ok: listStatus === 200, status: listStatus }) });
    const d = new ThreadsDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't' }), gh.fetchFn, logger);
    expect(await d.tick(tw(18, 12, 7))).toBe(false);
    expect(d.state.lastError).toBe('runs status=403');
    expect(gh.posts()).toHaveLength(0);
    listStatus = 200;
    expect(await d.tick(tw(18, 12, 8))).toBe(true);
    const thrower: ThreadsFetchLike = async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); };
    expect(await findAutoRunToday(thrower, 't', 'o/r', '2026-11-18')).toEqual({ ok: false, error: 'runs TimeoutError' });
    const bad: ThreadsFetchLike = async () => ({ ok: true, status: 200, json: async () => ({ message: 'x' }) });
    expect(await findAutoRunToday(bad, 't', 'o/r', '2026-11-18')).toEqual({ ok: false, error: 'runs bad-body' });
  });

  it('同一個程序上一次還沒跑完（API 很慢）時再看一次，不會再觸發', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const gh = fakeGitHub();
    const slow: ThreadsFetchLike = async (url, init) => { if (init.method === 'POST') await gate; return gh.fetchFn(url, init); };
    const d = new ThreadsDispatcher(() => ({ GITHUB_DISPATCH_TOKEN: 't' }), slow, logger);
    gh.setClock(tw(18, 12, 7));
    const first = d.tick(tw(18, 12, 7));
    await new Promise((r) => setTimeout(r, 0));
    expect(await d.tick(tw(18, 12, 8))).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(gh.posts()).toHaveLength(1);
  });
});

describe('workflow 的執行名稱跟伺服器查的格式一致', () => {
  it('伺服器觸發（mode=auto、date 空白）的執行名稱會被認成今天的 auto 執行；手動試跑、排程不會', () => {
    const yml = readFileSync(path.join(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'threads-publish.yml'), 'utf8');
    const tpl = /\nrun-name: "(.*)"\n/.exec(yml)?.[1] ?? '';
    expect(tpl).not.toBe('');
    // 照 GitHub 的規則代入：inputs.mode || github.event_name、inputs.date || 'today'
    const render = (event: string, mode: string, date: string) =>
      tpl.replace(/\$\{\{ inputs\.mode \|\| github\.event_name \}\}/, mode || event).replace(/\$\{\{ inputs\.date \|\| 'today' \}\}/, date || 'today');
    expect(render('workflow_dispatch', 'auto', '')).not.toContain('${{');
    expect(isAutoRunTitle(render('workflow_dispatch', 'auto', ''), '2026-11-18')).toBe(true);
    expect(isAutoRunTitle(render('workflow_dispatch', 'dry-run', ''), '2026-11-18')).toBe(false);
    expect(isAutoRunTitle(render('schedule', '', ''), '2026-11-18')).toBe(false);
  });
});
