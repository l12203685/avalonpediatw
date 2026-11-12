/**
 * 待修正牌譜清單（2026-11-09, services/paipuFixList.ts + bots/paipuFix）：原因行擷取、篩選（排除待檢視／模擬）、
 * 快取、LINE 長度截斷、文字指令解析、Discord 斜線指令註冊與回覆、說明、主題計數與聊天匯出。
 * 全部用假的 fetch 與虛構的標題，不連網路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PAIPU_FIX_REPLY_MARKER,
  PAIPU_FIX_TAG_ID,
  createPaipuFixService,
  extractFixReason,
  isPaipuFixThread,
  latestFixReason,
  setPaipuFixServiceForTests,
  type PaipuFixItem,
  type PaipuFixService,
} from '../services/paipuFixList';
import {
  PAIPU_FIX_FOOTER,
  PAIPU_FIX_NO_REASON,
  PAIPU_FIX_NONE_TEXT,
  PAIPU_FIX_NOT_CONFIGURED_TEXT,
  PAIPU_FIX_UNAVAILABLE_TEXT,
  answerPaipuFixTextCommand,
  formatPaipuFixReply,
  isPaipuFixCommandText,
  parsePaipuFixText,
} from '../bots/paipuFix/commands';
import { handlePaipuFixCommand } from '../bots/paipuFix/discordCommand';
import { buildSlashCommands } from '../bots/discord/client';
import { COMMANDS } from '../bots/discord/config';
import { formatStatsHelp } from '../bots/stats/statsReplies';
import { FeedbackService } from '../bots/feedback/service';
import { isTypedCommand } from '../bots/chatExport/rows';

const FORUM = '1132683080134578276';
const GUILD = '1132682489840812113';
const SIM_TAG = '900000000000000001';
const RESULT_TAG = '900000000000000002';

/** 匯入程式 reply_text 的樣子（虛構內容）。 */
function botReply(where: string): string {
  return [
    PAIPU_FIX_REPLY_MARKER,
    '這篇牌譜目前無法自動收錄到戰績統計。',
    where,
    '',
    '格式提示（照牌譜順序，每行一項）：',
    '・每次提議一行：隊伍座號連寫（0 家寫 0）',
    '',
    '修正起始訊息後不用做別的，下次排程（每天凌晨）會自動重新讀取並收錄。',
  ].join('\n');
}

// 依時間遞增的 snowflake（id 大＝新）。
const ID_OLD = '1430000000000000001';
const ID_MID = '1435000000000000001';
const ID_NEW = '1437000000000000001';
const ID_UNVERIFIED = '1437500000000000001';
const ID_SIM = '1437600000000000001';
const ID_NOTAG = '1437700000000000001';
const ID_OTHER_FORUM = '1437800000000000001';

function thread(id: string, name: string, tags: string[], extra: Record<string, unknown> = {}) {
  return { id, name, parent_id: FORUM, applied_tags: tags, last_message_id: `${id}9`, ...extra };
}

interface FakeOpts {
  forumStatus?: number;
  activeStatus?: number;
  archivedStatus?: number;
  fixTagInForum?: boolean;
}

function fakeDiscord(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const json = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const messages: Record<string, unknown[]> = {
    [ID_NEW]: [
      { id: '3', author: { bot: false }, content: '我改好了' },
      { id: '2', author: { bot: true }, content: botReply('第 22 行「刺客刺殺: 4」：刺殺目標和結果標籤對不起來（三藍被刀的刺殺目標要是梅林的座號）') },
      { id: '1', author: { bot: true }, content: botReply('原因：舊的原因') },
    ],
    [ID_MID]: [{ id: '1', author: { bot: true }, content: botReply('原因：玩家名單不完整（要有 1～9 家和 0 家，每個座位一行：1.名字）') }],
    [ID_OLD]: [{ id: '1', author: { bot: false }, content: `${PAIPU_FIX_REPLY_MARKER}\n有人假冒` }],
  };
  const fetchImpl = vi.fn(async (url: string) => {
    const path = url.replace('https://discord.com/api/v10', '');
    calls.push(path);
    if (path === `/channels/${FORUM}`) {
      return json(opts.forumStatus ?? 200, {
        id: FORUM,
        guild_id: GUILD,
        available_tags: [
          ...(opts.fixTagInForum === false ? [] : [{ id: PAIPU_FIX_TAG_ID, name: '待修正' }]),
          { id: SIM_TAG, name: '模擬' },
          { id: RESULT_TAG, name: '三紅' },
        ],
      });
    }
    if (path === `/guilds/${GUILD}/threads/active`) {
      return json(opts.activeStatus ?? 200, {
        threads: [
          thread(ID_NEW, '2026/11/01 線瓦 虛構局A', [PAIPU_FIX_TAG_ID, RESULT_TAG]),
          thread(ID_UNVERIFIED, '【待檢視】含百科機器人_虛構', [PAIPU_FIX_TAG_ID]),
          thread(ID_SIM, '虛構模擬局', [PAIPU_FIX_TAG_ID, SIM_TAG]),
          thread(ID_NOTAG, '2026/11/02 虛構局B', [RESULT_TAG]),
          { ...thread(ID_OTHER_FORUM, '別的頻道', [PAIPU_FIX_TAG_ID]), parent_id: '1' },
        ],
      });
    }
    if (path.startsWith(`/channels/${FORUM}/threads/archived/public`)) {
      if (path.includes('before=')) {
        return json(opts.archivedStatus ?? 200, { has_more: false, threads: [thread(ID_OLD, '2025/12/24 虛構局C', [PAIPU_FIX_TAG_ID], { thread_metadata: { archived: true, archive_timestamp: '2026-01-01T00:00:00.000Z' } })] });
      }
      return json(opts.archivedStatus ?? 200, {
        has_more: true,
        threads: [
          thread(ID_MID, '2026/10/20 虛構局D', [PAIPU_FIX_TAG_ID], { thread_metadata: { archived: true, archive_timestamp: '2026-11-01T00:00:00.000Z' } }),
          // 進行中清單裡也有的同一篇：只列一次。
          thread(ID_NEW, '2026/11/01 線瓦 虛構局A', [PAIPU_FIX_TAG_ID, RESULT_TAG], { thread_metadata: { archived: true, archive_timestamp: '2026-10-31T00:00:00.000Z' } }),
        ],
      });
    }
    const m = /^\/channels\/(\d+)\/messages\?limit=\d+$/.exec(path);
    if (m) return json(200, messages[m[1]] ?? []);
    return json(404, null);
  });
  return { fetchImpl, calls };
}

function service(fake: ReturnType<typeof fakeDiscord>, now: () => number = () => 0): PaipuFixService {
  return createPaipuFixService({ token: 'test-token', fetchImpl: fake.fetchImpl as unknown as typeof fetch, now, log: () => undefined, sleep: async () => undefined });
}

describe('原因行擷取', () => {
  it('取「第 N 行」或「原因：」那一行，拿掉 markdown 跳脫與「原因：」', () => {
    expect(extractFixReason(botReply('第 22 行「刺客刺殺: 4」：刺殺目標和結果標籤對不起來（…）'))).toBe('第 22 行「刺客刺殺: 4」：刺殺目標和結果標籤對不起來（…）');
    expect(extractFixReason(botReply('原因：結果標籤和任務結果對不起來'))).toBe('結果標籤和任務結果對不起來');
    expect(extractFixReason(botReply('第 3 行「389 \\*7 \\_x」：看不懂這一行'))).toBe('第 3 行「389 *7 _x」：看不懂這一行');
  });

  it('不是原因回覆 → null；舊格式取說明後的第一行；太長截掉', () => {
    expect(extractFixReason('一般留言')).toBeNull();
    expect(extractFixReason('')).toBeNull();
    expect(extractFixReason(null)).toBeNull();
    expect(extractFixReason(`${PAIPU_FIX_REPLY_MARKER}\n說明\n配置少一碼`)).toBe('配置少一碼');
    const long = extractFixReason(botReply(`原因：${'長'.repeat(500)}`)) as string;
    expect(long.length).toBe(200);
    expect(long.endsWith('…')).toBe(true);
  });

  it('只認機器人最新的一則', () => {
    expect(latestFixReason([
      { author: { bot: false }, content: botReply('原因：真人貼的') },
      { author: { bot: true }, content: botReply('原因：新的') },
      { author: { bot: true }, content: botReply('原因：舊的') },
    ])).toBe('新的');
    expect(latestFixReason([{ author: { bot: true }, content: '別的機器人訊息' }])).toBeNull();
  });
});

describe('篩選', () => {
  const opts = { forumId: FORUM, fixTagId: PAIPU_FIX_TAG_ID, simTagId: SIM_TAG };
  it('掛待修正的真人牌譜才列；待檢視、模擬、別的論壇、沒標籤的不列', () => {
    expect(isPaipuFixThread(thread(ID_NEW, '虛構局', [PAIPU_FIX_TAG_ID]), opts)).toBe(true);
    expect(isPaipuFixThread(thread(ID_NEW, '【待檢視】虛構局', [PAIPU_FIX_TAG_ID]), opts)).toBe(false);
    expect(isPaipuFixThread(thread(ID_NEW, '虛構局', [PAIPU_FIX_TAG_ID, SIM_TAG]), opts)).toBe(false);
    expect(isPaipuFixThread(thread(ID_NEW, '虛構局', [RESULT_TAG]), opts)).toBe(false);
    expect(isPaipuFixThread({ ...thread(ID_NEW, '虛構局', [PAIPU_FIX_TAG_ID]), parent_id: '1' }, opts)).toBe(false);
    expect(isPaipuFixThread(thread('abc', '虛構局', [PAIPU_FIX_TAG_ID]), opts)).toBe(false);
  });

  it('服務：進行中＋已封存（翻頁）、去重、新的在前、帶原因與連結', async () => {
    const fake = fakeDiscord();
    const load = await service(fake).list();
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.items.map((i) => i.id)).toEqual([ID_NEW, ID_MID, ID_OLD]);
    expect(load.items[0]).toEqual({
      id: ID_NEW,
      title: '2026/11/01 線瓦 虛構局A',
      reason: '第 22 行「刺客刺殺: 4」：刺殺目標和結果標籤對不起來（三藍被刀的刺殺目標要是梅林的座號）',
      url: `https://discord.com/channels/${GUILD}/${ID_NEW}`,
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(load.items[1].reason).toBe('玩家名單不完整（要有 1～9 家和 0 家，每個座位一行：1.名字）');
    // 不是機器人發的「原因回覆」不算。
    expect(load.items[2].reason).toBe('');
    expect(fake.calls.some((c) => c.includes('before=2026-10-31'))).toBe(true);
    // 待檢視、模擬、沒標籤的貼文不讀訊息。
    for (const id of [ID_UNVERIFIED, ID_SIM, ID_NOTAG, ID_OTHER_FORUM]) {
      expect(fake.calls.some((c) => c.startsWith(`/channels/${id}/messages`))).toBe(false);
    }
  });

  it('論壇裡照名字找不到「待修正」時用固定的標籤 id', async () => {
    const load = await service(fakeDiscord({ fixTagInForum: false })).list();
    expect(load.ok && load.items.map((i) => i.id)).toEqual([ID_NEW, ID_MID, ID_OLD]);
  });

  it('快取 5 分鐘；讀不到時回舊的（stale），從來沒讀到過 → unavailable；不丟錯', async () => {
    let t = 0;
    const fake = fakeDiscord();
    const svc = service(fake, () => t);
    await svc.list();
    const first = fake.calls.length;
    t = 4 * 60_000;
    await svc.list();
    expect(fake.calls.length).toBe(first);

    t = 6 * 60_000;
    fake.fetchImpl.mockImplementation(async () => { throw new Error('network'); });
    const stale = await svc.list();
    expect(stale).toMatchObject({ ok: true, stale: true });

    const broken = fakeDiscord({ forumStatus: 500 });
    expect(await service(broken).list()).toEqual({ ok: false, error: 'unavailable' });
    const noThreads = fakeDiscord({ activeStatus: 403, archivedStatus: 403 });
    expect(await service(noThreads).list()).toEqual({ ok: false, error: 'unavailable' });
  });

  it('log 只寫狀態碼', async () => {
    const lines: string[] = [];
    const fake = fakeDiscord({ forumStatus: 403 });
    await createPaipuFixService({ token: 't', fetchImpl: fake.fetchImpl as unknown as typeof fetch, log: (m) => lines.push(m) }).list();
    expect(lines).toEqual(['清單讀取失敗：HTTP 403']);
  });
});

function item(i: number, reason = `第 ${i} 行「虛構」：看不懂這一行`): PaipuFixItem {
  return { id: String(1430000000000000000n + BigInt(i)), title: `2026/10/${String((i % 28) + 1).padStart(2, '0')} 虛構局 ${i}`, reason, url: `https://discord.com/channels/${GUILD}/${1430000000000000000n + BigInt(i)}`, createdAt: '' };
}

describe('回覆格式與 LINE 長度', () => {
  it('沒有 → 固定文字', () => {
    expect(formatPaipuFixReply([], 'line')).toBe(PAIPU_FIX_NONE_TEXT);
  });

  it('標題、原因、連結，結尾提示', () => {
    const text = formatPaipuFixReply([item(1), item(2, '')], 'line');
    expect(text).toBe([
      '目前有 2 篇牌譜需要修正：',
      '',
      `1. 2026/10/02 虛構局 1\n原因：第 1 行「虛構」：看不懂這一行\nhttps://discord.com/channels/${GUILD}/1430000000000000001`,
      '',
      `2. 2026/10/03 虛構局 2\n原因：${PAIPU_FIX_NO_REASON}\nhttps://discord.com/channels/${GUILD}/1430000000000000002`,
      '',
      PAIPU_FIX_FOOTER,
    ].join('\n'));
  });

  it('超過 15 篇只列前 15 篇並說還有幾篇', () => {
    const items = Array.from({ length: 40 }, (_, i) => item(i + 1));
    const text = formatPaipuFixReply(items, 'line');
    expect(text.startsWith('目前有 40 篇牌譜需要修正：')).toBe(true);
    expect(text).toContain('15. ');
    expect(text).not.toContain('16. ');
    expect(text).toContain('…還有 25 篇沒列出');
    expect(text.endsWith(PAIPU_FIX_FOOTER)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(5000);
  });

  it('每篇很長時照字數少列幾篇，永遠在 5000 字以內；Discord 2000 字', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ ...item(i + 1, '長'.repeat(400)), title: '標'.repeat(300) }));
    const line = formatPaipuFixReply(items, 'line');
    expect(line.length).toBeLessThanOrEqual(5000);
    expect(line).toContain('沒列出');
    expect(line.endsWith(PAIPU_FIX_FOOTER)).toBe(true);
    const dc = formatPaipuFixReply(items, 'discord');
    expect(dc.length).toBeLessThanOrEqual(2000);
    expect(dc.endsWith(PAIPU_FIX_FOOTER)).toBe(true);
  });

  it('Discord 跳脫 markdown；LINE 照原字', () => {
    const it1 = { ...item(1, '第 1 行「3*8_9」：看不懂'), title: '虛構_局*1' };
    expect(formatPaipuFixReply([it1], 'discord')).toContain('1. 虛構\\_局\\*1\n原因：第 1 行「3\\*8\\_9」：看不懂');
    expect(formatPaipuFixReply([it1], 'line')).toContain('1. 虛構_局*1\n原因：第 1 行「3*8_9」：看不懂');
  });

  it('舊清單註明幾分鐘前', () => {
    expect(formatPaipuFixReply([item(1)], 'line', { staleMinutes: 7 })).toContain('（DC 暫時讀不到，這是約 7 分鐘前的清單）');
  });
});

describe('文字指令', () => {
  afterEach(() => setPaipuFixServiceForTests(undefined));

  it('/待修正、/牌譜待修正、全形斜線', () => {
    for (const t of ['/待修正', '／待修正', '/牌譜待修正', '／牌譜待修正', ' / 待修正 ', '/待修正 清單', '/待修正\n']) {
      expect(parsePaipuFixText(t)).toBe(true);
      expect(isPaipuFixCommandText(t)).toBe(true);
    }
    for (const t of ['待修正', '/待修正的好多', '/修正', '/戰績 待修正', '', 'hello']) {
      expect(parsePaipuFixText(t)).toBe(false);
    }
  });

  it('回覆：清單、沒設定、讀不到；不是指令 → null', async () => {
    setPaipuFixServiceForTests({ list: async () => ({ ok: true, items: [item(1)], fetchedAt: Date.now(), stale: false }) });
    expect(await answerPaipuFixTextCommand('/待修正')).toContain('目前有 1 篇牌譜需要修正：');
    expect(await answerPaipuFixTextCommand('今天天氣好')).toBeNull();

    setPaipuFixServiceForTests({ list: async () => ({ ok: true, items: [], fetchedAt: Date.now(), stale: false }) });
    expect(await answerPaipuFixTextCommand('／牌譜待修正')).toBe(PAIPU_FIX_NONE_TEXT);

    setPaipuFixServiceForTests(null);
    expect(await answerPaipuFixTextCommand('/待修正')).toBe(PAIPU_FIX_NOT_CONFIGURED_TEXT);

    setPaipuFixServiceForTests({ list: async () => ({ ok: false, error: 'unavailable' }) });
    expect(await answerPaipuFixTextCommand('/待修正')).toBe(PAIPU_FIX_UNAVAILABLE_TEXT);
  });
});

describe('Discord /待修正', () => {
  beforeEach(() => {
    setPaipuFixServiceForTests({ list: async () => ({ ok: true, items: [item(1)], fetchedAt: Date.now(), stale: false }) });
  });
  afterEach(() => setPaipuFixServiceForTests(undefined));

  it('註冊成沒有選項的斜線指令', () => {
    expect(COMMANDS.PAIPU_FIX).toBe('待修正');
    const json = buildSlashCommands().map((c) => c.toJSON());
    const cmd = json.find((c) => c.name === '待修正') as { options?: unknown[]; description: string };
    expect(cmd).toBeDefined();
    expect(cmd.options ?? []).toEqual([]);
    expect(cmd.description.length).toBeLessThanOrEqual(100);
    expect(json.filter((c) => c.name === '待修正')).toHaveLength(1);
  });

  it('公開回覆（defer 後 editReply，不 tag 人）', async () => {
    const i = { deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined), reply: vi.fn() };
    await handlePaipuFixCommand(i as never);
    expect(i.deferReply).toHaveBeenCalledWith();
    const arg = (i.editReply.mock.calls[0] as unknown as [{ content: string; allowedMentions: unknown }])[0];
    expect(arg.allowedMentions).toEqual({ parse: [] });
    expect(arg.content).toContain('目前有 1 篇牌譜需要修正：');
    expect(arg.content.length).toBeLessThanOrEqual(2000);
    expect(i.reply).not.toHaveBeenCalled();
  });
});

describe('說明、主題計數、聊天匯出', () => {
  it('說明列出 /待修正', () => {
    expect(formatStatsHelp('line')).toContain('/待修正　列出 DC 牌譜區目前需要修正的牌譜和原因');
    expect(formatStatsHelp('discord')).toContain('/待修正');
  });

  it('不算意見主題', () => {
    const svc = new FeedbackService({ logger: { warn: () => undefined, error: () => undefined } });
    expect(svc.observe('line', '/待修正')).toEqual([]);
    expect(svc.observe('discord', '／牌譜待修正')).toEqual([]);
  });

  it('聊天匯出當成指令', () => {
    expect(isTypedCommand('/ 待修正')).toBe(true);
    expect(isTypedCommand('／牌譜待修正')).toBe(true);
  });
});
