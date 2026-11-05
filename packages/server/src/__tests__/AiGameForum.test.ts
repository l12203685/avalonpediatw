/**
 * 百科AI 對局 → DC 論壇 #百科問題回報 的貼文內容（mock fetch）：標籤（沒有就加）、起始訊息＋兩個附檔、依局分組的後續訊息、
 * 429 重送、沒有 token 不貼、失敗只記狀態碼。名字都是編的。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  aiGameSiteUrl, ensureAiGameTag, postAiGameTrace, resolveAiGameForumId,
} from '../services/aiGameForum';
import { AI_GAME_FORMAT, AI_GAME_VERSION, type AiGameTrace } from '../services/aiGameTrace';

const FORUM = '1566833113248571514';
const THREAD = '1570000000000000001';

function trace(decisions = 3): AiGameTrace {
  return {
    format: AI_GAME_FORMAT, version: AI_GAME_VERSION, source: 'signage-cloud',
    room: 'Room-1460', title: '週四練習團', startedAt: '2026-11-05T13:05:00.000Z', endedAt: '2026-11-05T13:40:00.000Z', winner: 'good',
    seats: Array.from({ length: 10 }, (_, i) => ({
      seat: i + 1, name: i === 2 ? '百科AI_21' : `測試玩家${i + 1}`, role: i === 2 ? '派西維爾' : '雜魚1', team: 'good' as const, ai: i === 2,
    })),
    proposals: [{ round: 1, attempt: 1, leader: 1, team: [1, 3, 4], approve: [1, 3, 4, 6, 8, 9], reject: [2, 5, 7, 10], approved: true, forced: false }],
    missions: [{ round: 1, team: [1, 3, 4], fails: 0, result: 'success' }],
    lakes: [],
    assassination: null,
    decisions: Array.from({ length: decisions }, (_, i) => ({
      id: i + 1, at: i, round: 1, attempt: 1, kind: 'vote' as const, seat: 3, nick: '百科AI_21', role: 'percival', team: 'good' as const,
      action: '贊成', detail: { vote: true }, reason: `理由 ${i + 1}：${'很長的說明'.repeat(40)}`, source: 'agent' as const,
    })),
    notes: [],
  };
}

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }

function mockDiscord(opts: { tags?: { id: string; name: string }[]; patchOk?: boolean; createStatus?: number; rateLimitOnce?: boolean } = {}) {
  const calls: Call[] = [];
  let limited = false;
  const tags = opts.tags ?? [{ id: '1566833113248571515', name: '錯誤' }];
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith(`/channels/${FORUM}`) && method === 'GET') return json(200, { id: FORUM, available_tags: tags });
    if (url.endsWith(`/channels/${FORUM}`) && method === 'PATCH') {
      if (opts.patchOk === false) return json(403, { message: 'Missing Permissions' });
      const sent = JSON.parse(String(init?.body)) as { available_tags: { name: string }[] };
      return json(200, { available_tags: sent.available_tags.map((t, i) => ({ id: `99${i}`, ...t })) });
    }
    if (url.endsWith(`/channels/${FORUM}/threads`)) return json(opts.createStatus ?? 201, { id: THREAD });
    if (url.endsWith(`/channels/${THREAD}/messages`)) {
      if (opts.rateLimitOnce && !limited) { limited = true; return json(429, { retry_after: 0.01 }); }
      return json(200, { id: '1' });
    }
    return json(404, {});
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('論壇標籤「百科AI對局」', () => {
  it('已經有就直接用，不改論壇', async () => {
    const dc = mockDiscord({ tags: [{ id: '7', name: '百科AI對局' }] });
    expect(await ensureAiGameTag({ token: 't', forumId: FORUM, fetchImpl: dc.fetchImpl })).toBe('7');
    expect(dc.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('沒有就加上去（保留原有的標籤）', async () => {
    const dc = mockDiscord();
    const id = await ensureAiGameTag({ token: 't', forumId: FORUM, fetchImpl: dc.fetchImpl });
    expect(id).toBe('991');
    const patch = dc.calls.find((c) => c.method === 'PATCH')!;
    expect(JSON.parse(String(patch.body)).available_tags).toEqual([
      { id: '1566833113248571515', name: '錯誤', moderated: false, emoji_id: null, emoji_name: null },
      { name: '百科AI對局', moderated: false },
    ]);
  });

  it('加不了（沒權限）回傳 null，只記狀態碼', async () => {
    const logs: string[] = [];
    const dc = mockDiscord({ patchOk: false });
    expect(await ensureAiGameTag({ token: 't', forumId: FORUM, fetchImpl: dc.fetchImpl, log: (m) => logs.push(m) })).toBeNull();
    expect(logs).toEqual(['新增論壇標籤失敗：HTTP 403']);
  });
});

describe('貼一局', () => {
  it('開討論串：標題、標籤、摘要、trace.json＋trace.txt；後續訊息依局分組、每則 2000 字內、最後附網站網址', async () => {
    const dc = mockDiscord({ tags: [{ id: '7', name: '百科AI對局' }] });
    const logs: string[] = [];
    const r = await postAiGameTrace(trace(12), { token: 'secret-token', forumId: FORUM, fetchImpl: dc.fetchImpl, gapMs: 0, log: (m) => logs.push(m) });
    expect(r).toEqual({ outcome: 'sent', threadId: THREAD, followups: expect.any(Number), tagged: true });
    const create = dc.calls.find((c) => c.url.endsWith('/threads'))!;
    expect(create.headers.Authorization).toBe('Bot secret-token');
    const form = create.body as FormData;
    const payload = JSON.parse(String(form.get('payload_json')));
    expect(payload.name).toBe('百科AI對局 20261105_2105 週四練習團／Room-1460');
    expect(payload.applied_tags).toEqual(['7']);
    expect(payload.message.allowed_mentions).toEqual({ parse: [] });
    expect(payload.message.attachments).toEqual([{ id: 0, filename: 'trace.json' }, { id: 1, filename: 'trace.txt' }]);
    expect(payload.message.content).toMatch(/怎麼回饋/);
    expect(payload.message.content.length).toBeLessThanOrEqual(2000);
    const json = form.get('files[0]') as File;
    const txt = form.get('files[1]') as File;
    expect(json.name).toBe('trace.json');
    expect(JSON.parse(await json.text()).decisions).toHaveLength(12);
    expect(txt.name).toBe('trace.txt');
    expect(await txt.text()).toContain('#12 3家 派西維爾 百科AI_21・投票：贊成');

    const msgs = dc.calls.filter((c) => c.url.endsWith(`/channels/${THREAD}/messages`)).map((c) => JSON.parse(String(c.body)));
    expect(msgs.length).toBe(r.followups);
    expect(msgs.length).toBeGreaterThan(1); // 12 個長理由拆成好幾則
    for (const m of msgs) {
      expect(m.content.length).toBeLessThanOrEqual(2000);
      expect(m.allowed_mentions).toEqual({ parse: [] });
    }
    expect(msgs[0].content).toMatch(/^\*\*第 1 局\*\*/);
    expect(msgs[msgs.length - 1].content).toContain(aiGameSiteUrl(THREAD));
    // log 不含暱稱或內容（這裡什麼都沒失敗，沒有 log）
    expect(logs).toEqual([]);
  });

  it('沒有 DISCORD_BOT_TOKEN：不貼也不打任何 API', async () => {
    const dc = mockDiscord();
    expect(await postAiGameTrace(trace(), { token: '', forumId: FORUM, fetchImpl: dc.fetchImpl })).toEqual({ outcome: 'skipped', followups: 0, tagged: false });
    expect(dc.calls).toHaveLength(0);
  });

  it('開討論串失敗：failed＋狀態碼，不送後續訊息；log 只有狀態碼', async () => {
    const dc = mockDiscord({ createStatus: 403 });
    const logs: string[] = [];
    const r = await postAiGameTrace(trace(), { token: 't', forumId: FORUM, fetchImpl: dc.fetchImpl, gapMs: 0, log: (m) => logs.push(m) });
    expect(r).toMatchObject({ outcome: 'failed', status: 403 });
    expect(dc.calls.some((c) => c.url.includes(`/channels/${THREAD}/`))).toBe(false);
    expect(logs.join('\n')).not.toMatch(/測試玩家|百科AI_21|Room-1460/);
    expect(logs).toContain('開討論串失敗：HTTP 403');
  });

  it('網路錯誤不丟錯', async () => {
    const boom = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;
    await expect(postAiGameTrace(trace(), { token: 't', forumId: FORUM, fetchImpl: boom, gapMs: 0 })).resolves.toMatchObject({ outcome: 'failed' });
  });

  it('後續訊息被 429：照 retry_after 等一下再送一次', async () => {
    const dc = mockDiscord({ tags: [{ id: '7', name: '百科AI對局' }], rateLimitOnce: true });
    const sleep = vi.fn(async () => undefined);
    const r = await postAiGameTrace(trace(1), { token: 't', forumId: FORUM, fetchImpl: dc.fetchImpl, gapMs: 0, sleep });
    const msgCalls = dc.calls.filter((c) => c.url.endsWith(`/channels/${THREAD}/messages`));
    expect(msgCalls.length).toBe(r.followups + 1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('論壇 id：預設＝問題回報論壇；AI_GAME_FORUM_CHANNEL_ID 可換、off 關掉', () => {
    expect(resolveAiGameForumId({})).toBe(FORUM);
    expect(resolveAiGameForumId({ AI_GAME_FORUM_CHANNEL_ID: '42' })).toBe('42');
    expect(resolveAiGameForumId({ AI_GAME_FORUM_CHANNEL_ID: 'off' })).toBe('');
  });
});
