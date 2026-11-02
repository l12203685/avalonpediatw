import { describe, expect, it, vi } from 'vitest';
import {
  buildFeedbackThread, cleanPage, postFeedbackThread, resolveFeedbackForumId,
  DEFAULT_FEEDBACK_FORUM_ID, FEEDBACK_FORUM_TAGS,
} from '../services/feedbackForum';

describe('網站問題回報 → DC 論壇', () => {
  it('標題帶類型、掛對應標籤、不叫人', () => {
    const t = buildFeedbackThread({ kind: 'bug', message: '牌譜頁\n手機上 表格超出畫面 @everyone', name: ' 小明 ', page: '/#records' });
    expect(t.name).toBe('[錯誤] 牌譜頁 手機上 表格超出畫面 @everyone');
    expect(t.applied_tags).toEqual([FEEDBACK_FORUM_TAGS.bug]);
    expect(t.message.allowed_mentions).toEqual({ parse: [] });
    expect(t.message.content).toContain('— 網站回報・錯誤・小明');
    expect(t.message.content).toContain('頁面：`https://avalonpediatw.com/#records`');
  });

  it('沒填暱稱 = 匿名；長度有上限', () => {
    const t = buildFeedbackThread({ kind: 'content', message: 'x'.repeat(5000) });
    expect(t.message.content).toContain('網站回報・文章內容・匿名');
    expect(t.message.content.length).toBeLessThanOrEqual(2000);
    expect(t.name.length).toBeLessThanOrEqual(100);
  });

  it('頁面只收站內路徑', () => {
    expect(cleanPage('/wiki#刺客')).toBe('/wiki#刺客');
    expect(cleanPage('#analysis')).toBe('#analysis');
    expect(cleanPage('https://evil.example')).toBe('');
    expect(cleanPage('/a b')).toBe('');
    expect(cleanPage(42)).toBe('');
  });

  it('論壇 id：預設、自訂、關掉', () => {
    expect(resolveFeedbackForumId({})).toBe(DEFAULT_FEEDBACK_FORUM_ID);
    expect(resolveFeedbackForumId({ FEEDBACK_FORUM_CHANNEL_ID: '123' })).toBe('123');
    expect(resolveFeedbackForumId({ FEEDBACK_FORUM_CHANNEL_ID: 'off' })).toBe('');
  });

  it('開討論串；沒 token 略過；失敗只記狀態碼', async () => {
    const ok = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    expect(await postFeedbackThread({ kind: 'suggestion', message: '加深色模式' }, { token: 't', forumId: '9', fetchImpl: ok as unknown as typeof fetch })).toBe('sent');
    expect(ok.mock.calls[0][0]).toBe('https://discord.com/api/v10/channels/9/threads');
    expect(await postFeedbackThread({ kind: 'bug', message: 'x' }, { token: '', forumId: '9' })).toBe('skipped');
    const logs: string[] = [];
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    expect(await postFeedbackThread({ kind: 'bug', message: '秘密內容' }, { token: 't', forumId: '9', fetchImpl: bad as unknown as typeof fetch, log: (m) => logs.push(m) })).toBe('failed');
    expect(logs).toEqual(['post failed: status=403']);
  });
});
