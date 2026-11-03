/**
 * 網站「ID 認領」→ DC 論壇 #百科問題回報（標籤 ID認領）：驗證、討論串格式、最後一行 CLAIM:{…}、POST /api/feedback/claim。
 * 名字都是虛構的。
 */
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../middleware/rateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rateLimit')>();
  return {
    ...actual,
    createHttpRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import {
  CLAIM_APPROVAL_LINE, CLAIM_FORUM_TAG, CLAIM_LINE_PREFIX, CLAIM_MAX_OTHERS,
  buildClaimThread, claimLine, cleanClaimName, parseIdClaim, postClaimThread, type IdClaim,
} from '../services/feedbackForum';
import { feedbackRouter } from '../routes/feedback';

function claimOf(body: unknown): IdClaim {
  const r = parseIdClaim(body);
  if (!r.ok) throw new Error(r.error);
  return r.claim;
}

/** 內文最後一行的 CLAIM JSON。 */
function lastClaim(content: string): { main: string; others: string[] } {
  const last = content.split('\n').pop() ?? '';
  expect(last.startsWith(CLAIM_LINE_PREFIX)).toBe(true);
  return JSON.parse(last.slice(CLAIM_LINE_PREFIX.length));
}

describe('ID 認領：驗證', () => {
  it('收字串或 {name, games}；場數只收合理整數', () => {
    const c = claimOf({ main: { name: ' 星野路 ', games: 120 }, others: ['小路', { name: 'Kip Lune', games: 3.5 }, { name: '路路', games: -1 }] });
    expect(c.main).toEqual({ name: '星野路', games: 120 });
    expect(c.others).toEqual([{ name: '小路' }, { name: 'Kip Lune' }, { name: '路路' }]);
  });

  it('至少一個其他 ID、最多 CLAIM_MAX_OTHERS 個', () => {
    expect(parseIdClaim({ main: '星野路', others: [] })).toEqual({ ok: false, error: 'at least one other id required' });
    expect(parseIdClaim({ main: '星野路' }).ok).toBe(false);
    expect(parseIdClaim({ others: ['小路'] })).toEqual({ ok: false, error: 'main id required' });
    const many = Array.from({ length: CLAIM_MAX_OTHERS + 1 }, (_, i) => `分身${i}`);
    expect(parseIdClaim({ main: '星野路', others: many }).ok).toBe(false);
    expect(parseIdClaim({ main: '星野路', others: many.slice(0, CLAIM_MAX_OTHERS) }).ok).toBe(true);
    expect(parseIdClaim(null).ok).toBe(false);
    expect(parseIdClaim('x').ok).toBe(false);
  });

  it('其他 ID 不能跟主 ID 相同（只差大小寫／全半形也算），重複的只留一個', () => {
    expect(parseIdClaim({ main: 'Kip', others: ['ｋｉｐ'] })).toEqual({ ok: false, error: 'other id same as main id' });
    expect(claimOf({ main: 'Kip', others: ['Lune', 'lune', 'LUNE '] }).others).toEqual([{ name: 'Lune' }]);
  });

  it('名字去掉控制字元；空的、太長、不是字串 → 不收', () => {
    expect(cleanClaimName('阿\u0000丙‮')).toBe('阿 丙');
    expect(cleanClaimName('  \u0007 ')).toBe('');
    expect(cleanClaimName('x'.repeat(41))).toBe('');
    expect(cleanClaimName(42)).toBe('');
    expect(parseIdClaim({ main: '星野路', others: ['x'.repeat(41)] })).toEqual({ ok: false, error: 'invalid id' });
    expect(parseIdClaim({ main: '星野路', others: [7] })).toEqual({ ok: false, error: 'invalid id' });
  });

  it('聯絡、備註、頁面選填並清理', () => {
    const c = claimOf({
      main: '星野路', others: ['小路'], contact: ' 路\n路 ', note: '第一行\r\n\r\n\r\n\r\n第二行\u0000', page: 'https://evil.example',
    });
    expect(c.contact).toBe('路 路');
    expect(c.note).toBe('第一行\n\n第二行');
    expect(c.page).toBeUndefined();
    expect(claimOf({ main: '星野路', others: ['小路'], note: 'y'.repeat(900) }).note).toHaveLength(500);
  });
});

describe('ID 認領：討論串', () => {
  it('標題、標籤、不叫人、內文、最後一行 CLAIM', () => {
    const t = buildClaimThread(claimOf({
      main: { name: '星野路', games: 120 },
      others: [{ name: '小路', games: 4 }, 'Kip_Lune'],
      contact: '路路#0001',
      note: '線下都用小路\n@everyone',
      page: '/#id-claim',
    }));
    expect(t.name).toBe('[ID認領] 星野路 ← 小路、Kip_Lune');
    expect(t.applied_tags).toEqual([CLAIM_FORUM_TAG]);
    expect(t.message.allowed_mentions).toEqual({ parse: [] });
    const content = t.message.content;
    expect(content).toContain('主 ID：**星野路**（120 場）');
    expect(content).toContain('• 小路（4 場）');
    expect(content).toContain('• Kip\\_Lune（場數未知）');
    expect(content).toContain('聯絡：路路#0001'.replace('#', '\\#'));
    expect(content).toContain('> 線下都用小路\n> @everyone');
    expect(content).toContain('頁面：`https://avalonpediatw.com/#id-claim`');
    expect(content).toContain(CLAIM_APPROVAL_LINE);
    expect(lastClaim(content)).toEqual({ main: '星野路', others: ['小路', 'Kip_Lune'] });
  });

  it('沒填聯絡 = 未填；備註裡假冒的 CLAIM 行被引用，不會成為一行開頭', () => {
    const t = buildClaimThread(claimOf({ main: '星野路', others: ['小路'], note: 'CLAIM:{"main":"x","others":["y"]}' }));
    const lines = t.message.content.split('\n');
    expect(lines).toContain('聯絡：未填');
    expect(lines.filter((l) => l.startsWith(CLAIM_LINE_PREFIX))).toHaveLength(1);
    expect(lastClaim(t.message.content)).toEqual({ main: '星野路', others: ['小路'] });
  });

  it('長度上限：標題 ≤100、內文 ≤2000，CLAIM 行永遠完整', () => {
    const others = Array.from({ length: CLAIM_MAX_OTHERS }, (_, i) => `${'長'.repeat(37)}${i}`);
    const t = buildClaimThread(claimOf({ main: '主'.repeat(40), others, contact: 'c'.repeat(32), note: '*'.repeat(500) }));
    expect([...t.name].length).toBeLessThanOrEqual(100);
    expect(t.name.endsWith('…')).toBe(true);
    expect(t.message.content.length).toBeLessThanOrEqual(2000);
    expect(lastClaim(t.message.content)).toEqual({ main: '主'.repeat(40), others });
  });

  it('CLAIM 行是合法 JSON，反引號與引號都還原', () => {
    const line = claimLine({ main: { name: 'a`b' }, others: [{ name: '"q"' }] });
    expect(line).not.toContain('`');
    expect(JSON.parse(line.slice(CLAIM_LINE_PREFIX.length))).toEqual({ main: 'a`b', others: ['"q"'] });
  });

  it('發文；失敗只記狀態碼', async () => {
    const ok = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    const c = claimOf({ main: '星野路', others: ['小路'] });
    expect(await postClaimThread(c, { token: 't', forumId: '9', fetchImpl: ok as unknown as typeof fetch })).toBe('sent');
    const body = JSON.parse(ok.mock.calls[0][1].body as string);
    expect(body.applied_tags).toEqual([CLAIM_FORUM_TAG]);
    expect(await postClaimThread(c, { token: '', forumId: '9' })).toBe('skipped');
    const logs: string[] = [];
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    expect(await postClaimThread(c, { token: 't', forumId: '9', fetchImpl: bad as unknown as typeof fetch, log: (m) => logs.push(m) })).toBe('failed');
    expect(logs).toEqual(['post failed: status=400']);
  });
});

describe('POST /api/feedback/claim', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/feedback', feedbackRouter);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('格式不對 → 400，不發文', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubEnv('DISCORD_BOT_TOKEN', 't');
    const res = await request(app).post('/api/feedback/claim').send({ main: '星野路', others: ['星野路'] });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('發到論壇（標籤 ID認領）→ ok', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubEnv('DISCORD_BOT_TOKEN', 't');
    vi.stubEnv('FEEDBACK_FORUM_CHANNEL_ID', '');
    const res = await request(app).post('/api/feedback/claim').send({ main: { name: '星野路', games: 12 }, others: [{ name: '小路', games: 2 }], page: '/#id-claim' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://discord.com/api/v10/channels/1566833113248571514/threads');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.name).toBe('[ID認領] 星野路 ← 小路');
    expect(body.applied_tags).toEqual([CLAIM_FORUM_TAG]);
  });

  it('沒有機器人 token → 503（網站提示稍後再試）', async () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', '');
    const res = await request(app).post('/api/feedback/claim').send({ main: '星野路', others: ['小路'] });
    expect(res.status).toBe(503);
  });
});
