/**
 * 每日「阿瓦隆百科小觀念」（2026-11-18，bots/conceptDaily）：
 *   - 時間：台北 06:00 以前不發、06:00:00 整就發、跨 UTC 日界線；
 *   - 一個群組一天一次：送出去才算、沒送出去下一則再試、重啟（新的服務、同一份狀態檔）後不重發；LINE 和 Discord 同一天同一張；
 *   - 選卡：當天 Threads 題目配得到的卡優先、兩週內不重複；沒有題目就輪替、一輪裡不重複；
 *   - 訊息格式（半形冒號）與牌譜連結的退路（沒有牌譜就「文章:」）；
 *   - 回饋：引用 bot 那一則、或打「觀念回饋 …」；限流；讀回與標記已處理；
 *   - LINE（reply_token、引用、跟同步佇列共用一個 token）與 Discord 的接線。
 */
import crypto from 'crypto';
import type { Client } from '@line/bot-sdk';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conceptBank, type Concept, type ConceptExercise } from '../bots/threads/concepts';
import { conceptDailyConfig, parseStartTime } from '../bots/conceptDaily/config';
import { dailyKeyAt, prepareKeyAt } from '../bots/conceptDaily/schedule';
import {
  CONCEPT_FEEDBACK_HINT,
  RECENT_DAYS,
  chooseDay,
  conceptPageUrl,
  cutoffRecordUrl,
  formatConceptMessage,
  needsRecord,
  rotationEligible,
  type DayPlan,
  type HistoryEntry,
  type RecordIndex,
} from '../bots/conceptDaily/plan';
import { ConceptStateStore, MemoryBackend, emptyState, mergeStates, type StateBackend } from '../bots/conceptDaily/store';
import { ConceptDailyService, __setConceptDailyForTests, type IncomingChatMessage } from '../bots/conceptDaily/service';
import {
  CONCEPT_FEEDBACK_ACK,
  CONCEPT_FEEDBACK_USAGE,
  FeedbackRateLimiter,
  formatFeedbackForAdmin,
  parseFeedbackKeyword,
} from '../bots/conceptDaily/feedback';
import { handleConceptDailyDiscord } from '../bots/conceptDaily/discord';
import { listConceptFeedback, markConceptFeedback, parseConceptFeedbackMessage } from '../services/conceptFeedbackList';
import { LineBotClient } from '../bots/line/client';
import { __resetChatMirrorForTests } from '../bots/ChatMirror';
import { addDays } from '../bots/threads/plan';

// 真的題庫那一題要建題庫＋配對索引：單獨跑約 4 秒，整套平行跑時可能超過預設的 5 秒。
vi.setConfig({ testTimeout: 60_000 });

const SITE = 'https://avalon-game-platform.web.app';
const CONCEPTS = conceptBank().concepts;
const LINE_GROUP = 'Cconcept-group';
const DC_CHANNEL = '111111111111111111';

/** 台北時間 → epoch 毫秒。 */
const taipei = (iso: string): number => Date.parse(`${iso}+08:00`);

const ENV_KEYS = ['CONCEPT_DAILY_LINE', 'CONCEPT_DAILY_LINE_GROUP_IDS', 'CONCEPT_DAILY_DISCORD', 'CONCEPT_DAILY_DISCORD_CHANNEL_IDS', 'CONCEPT_DAILY_START', 'CONCEPT_FEEDBACK', 'LOBBY_MIRROR_LINE_GROUP_ID', 'SIM_LINE_GROUP_IDS'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CONCEPT_DAILY_LINE = 'true';
  process.env.CONCEPT_DAILY_LINE_GROUP_IDS = LINE_GROUP;
  process.env.CONCEPT_DAILY_DISCORD = 'true';
  process.env.CONCEPT_DAILY_DISCORD_CHANNEL_IDS = DC_CHANNEL;
  delete process.env.CONCEPT_DAILY_START;
  delete process.env.CONCEPT_FEEDBACK;
  delete process.env.LOBBY_MIRROR_LINE_GROUP_ID;
  delete process.env.SIM_LINE_GROUP_IDS;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setConceptDailyForTests(null);
});

// ─── 時間 ─────────────────────────────────────────────────────────────────

describe('daily window (Asia/Taipei, no DST)', () => {
  const six = parseStartTime('06:00') as number;

  it('parses the start time and falls back to 06:00', () => {
    expect(parseStartTime('06:00')).toBe(360);
    expect(parseStartTime('7:30')).toBe(450);
    expect(parseStartTime('24:00')).toBeNull();
    expect(parseStartTime('six')).toBeNull();
    expect(conceptDailyConfig({ CONCEPT_DAILY_START: 'nope' }).startMinute).toBe(360);
    expect(conceptDailyConfig({ CONCEPT_DAILY_START: '08:15' }).startMinute).toBe(495);
  });

  it('is off before 06:00 and on from 06:00:00 exactly', () => {
    expect(dailyKeyAt(taipei('2026-11-18T05:59:59'), six)).toBeNull();
    expect(dailyKeyAt(taipei('2026-11-18T06:00:00'), six)).toBe('2026-11-18');
    expect(dailyKeyAt(taipei('2026-11-18T23:59:59'), six)).toBe('2026-11-18');
    expect(dailyKeyAt(taipei('2026-11-19T00:00:00'), six)).toBeNull();
  });

  it('uses the Taipei date, not the UTC one (06:00 +08 is 22:00 UTC the day before)', () => {
    expect(dailyKeyAt(Date.parse('2026-11-17T22:00:00Z'), six)).toBe('2026-11-18');
    expect(dailyKeyAt(Date.parse('2026-11-17T21:59:00Z'), six)).toBeNull();
  });

  it('prepares the card 30 minutes ahead', () => {
    expect(prepareKeyAt(taipei('2026-11-18T05:29:00'), six)).toBeNull();
    expect(prepareKeyAt(taipei('2026-11-18T05:30:00'), six)).toBe('2026-11-18');
  });
});

// ─── 選卡 ─────────────────────────────────────────────────────────────────

const exercise = (over: Partial<ConceptExercise>): ConceptExercise => ({
  decision: '派隊', round: 1, attempt: 5, seat: 5, role: 'loyal', score: '0:0',
  lakeHolder: false, lastQuestMember: null, lastQuestFails: null, thumbsLed: null, ...over,
});

describe('choosing the card', () => {
  const noIndex: RecordIndex = new Map();

  it('takes the top card for today’s Threads question and links that question’s record, cut at the decision', () => {
    const url = cutoffRecordUrl('S358', 4, 5);
    expect(url).toBe(`${SITE}/#records=S358&upto=4&seat=5`);
    const plan = chooseDay({ date: '2026-11-18', concepts: CONCEPTS, history: [], threads: { exerciseId: 'SV1Q8-1-5', exercise: exercise({}), recordUrl: url }, index: noIndex });
    expect(plan?.source).toBe('threads');
    expect(plan?.exerciseId).toBe('SV1Q8-1-5');
    expect(plan?.link).toEqual({ kind: 'record', url });
    const card = CONCEPTS.find((c) => c.id === plan?.cardId) as Concept;
    expect(card.tags.decision).toContain('派隊');
  });

  it('skips cards used in the last two weeks, and may reuse them after', () => {
    const threads = { exerciseId: 'X-1-5', exercise: exercise({}), recordUrl: null };
    const first = chooseDay({ date: '2026-11-18', concepts: CONCEPTS, history: [], threads, index: noIndex }) as DayPlan;
    const recent: HistoryEntry[] = [{ date: addDays('2026-11-18', -RECENT_DAYS), cardId: first.cardId }];
    const second = chooseDay({ date: '2026-11-18', concepts: CONCEPTS, history: recent, threads, index: noIndex }) as DayPlan;
    expect(second.cardId).not.toBe(first.cardId);
    const old: HistoryEntry[] = [{ date: addDays('2026-11-18', -RECENT_DAYS - 1), cardId: first.cardId }];
    expect(chooseDay({ date: '2026-11-18', concepts: CONCEPTS, history: old, threads, index: noIndex })?.cardId).toBe(first.cardId);
  });

  it('falls back to the article section, labelled 文章:, when the question has no records page', () => {
    const plan = chooseDay({ date: '2026-11-18', concepts: CONCEPTS, history: [], threads: { exerciseId: 'X-1-5', exercise: exercise({}), recordUrl: null }, index: noIndex }) as DayPlan;
    const card = CONCEPTS.find((c) => c.id === plan.cardId) as Concept;
    expect(plan.link).toEqual({ kind: 'article', url: card.article.url });
    const text = formatConceptMessage(plan, card, SITE);
    expect(text).toContain(`\n文章: ${card.article.url}\n`);
    expect(text).not.toContain('牌局:');
  });

  it('rotates through every eligible card without repeats, then starts a new round', () => {
    const eligible = rotationEligible(CONCEPTS, noIndex);
    // 沒有題庫：只剩情境沒寫前提的卡，連文章。
    expect(eligible.every((c) => !needsRecord(c))).toBe(true);
    expect(eligible.length).toBeGreaterThan(10);
    const history: HistoryEntry[] = [];
    let date = '2026-11-18';
    for (let i = 0; i < eligible.length; i++) {
      const plan = chooseDay({ date, concepts: CONCEPTS, history, threads: null, index: noIndex }) as DayPlan;
      expect(plan.source).toBe('rotation');
      expect(plan.link.kind).toBe('article');
      history.push({ date, cardId: plan.cardId });
      date = addDays(date, 1);
    }
    expect(new Set(history.map((h) => h.cardId)).size).toBe(eligible.length);
    const next = chooseDay({ date, concepts: CONCEPTS, history, threads: null, index: noIndex }) as DayPlan;
    // 新的一輪：避開最近兩週的卡。
    expect(history.slice(-RECENT_DAYS).map((h) => h.cardId)).not.toContain(next.cardId);
  });

  it('uses a matching record for a card with preconditions, and only then', () => {
    const card = CONCEPTS.find(needsRecord) as Concept;
    const index: RecordIndex = new Map([[card.id, [{ url: cutoffRecordUrl('123456789012345678', 7, 10), rank: 30, key: 'G/7' }]]]);
    expect(rotationEligible(CONCEPTS, noIndex).some((c) => c.id === card.id)).toBe(false);
    expect(rotationEligible(CONCEPTS, index).some((c) => c.id === card.id)).toBe(true);
    // 輪到它的那一天連到那一局（0 家寫 0）。
    let date = '2026-11-18';
    const history: HistoryEntry[] = [];
    for (let i = 0; i < 200; i++) {
      const plan = chooseDay({ date, concepts: CONCEPTS, history, threads: null, index }) as DayPlan;
      if (plan.cardId === card.id) {
        expect(plan.link).toEqual({ kind: 'record', url: `${SITE}/#records=123456789012345678&upto=7&seat=0` });
        return;
      }
      history.push({ date, cardId: plan.cardId });
      date = addDays(date, 1);
    }
    throw new Error('card never came up');
  });
});

describe('message format', () => {
  it('matches the owner’s format with half-width colons', () => {
    const card = CONCEPTS[0];
    const plan: DayPlan = { date: '2026-11-18', cardId: card.id, source: 'threads', link: { kind: 'record', url: `${SITE}/#records=S1&upto=0&seat=1` } };
    expect(formatConceptMessage(plan, card, SITE)).toBe([
      '[阿瓦隆百科小觀念]',
      `情境: ${card.情境}`,
      `觀念: ${card.觀念}`,
      `應用: ${card.應用}`,
      `牌局: ${SITE}/#records=S1&upto=0&seat=1`,
      `觀念卡: ${SITE}/#concepts=${card.id}`,
      CONCEPT_FEEDBACK_HINT,
    ].join('\n'));
    expect(formatConceptMessage({ ...plan, threadsUrl: 'https://www.threads.net/@x/post/1' }, card, SITE, { feedbackHint: false }).split('\n').slice(-2))
      .toEqual(['Threads: https://www.threads.net/@x/post/1', `觀念卡: ${conceptPageUrl(SITE, card.id)}`]);
  });
});

// ─── 一天一次 ────────────────────────────────────────────────────────────

function service(backend: StateBackend, now: { t: number }, sink?: (c: string) => Promise<boolean>): ConceptDailyService {
  return new ConceptDailyService({
    store: new ConceptStateStore(backend, { warn: () => undefined }),
    bank: async () => null,
    now: () => now.t,
    site: SITE,
    feedbackSink: sink,
    logger: { warn: () => undefined },
  });
}

const msg = (over: Partial<IncomingChatMessage> = {}): IncomingChatMessage => ({ platform: 'line', chatId: LINE_GROUP, userId: 'U1', text: '早安', ...over });

describe('one per group per day', () => {
  it('sends on the first message after 06:00 only, and only once', async () => {
    const now = { t: taipei('2026-11-18T05:59:00') };
    const svc = service(new MemoryBackend(), now);
    expect(await svc.handle(msg())).toEqual([]);
    now.t = taipei('2026-11-18T06:00:00');
    const [first] = await svc.handle(msg());
    expect(first.kind).toBe('daily');
    expect(first.text.startsWith('[阿瓦隆百科小觀念]\n情境: ')).toBe(true);
    // 還沒回報送出：同一個群組的下一則不會再拿到（處理中）。
    expect(await svc.handle(msg({ text: '第二則' }))).toEqual([]);
    first.delivered('m1');
    expect(await svc.handle(msg({ text: '第三則' }))).toEqual([]);
    now.t = taipei('2026-11-19T05:00:00');
    expect(await svc.handle(msg())).toEqual([]);
    now.t = taipei('2026-11-19T06:30:00');
    expect((await svc.handle(msg()))[0]?.kind).toBe('daily');
  });

  it('retries on the next message when the reply did not go out', async () => {
    const now = { t: taipei('2026-11-18T07:00:00') };
    const svc = service(new MemoryBackend(), now);
    const [a] = await svc.handle(msg());
    a.failed();
    const [b] = await svc.handle(msg());
    expect(b.text).toBe(a.text);
  });

  it('does not send twice after a restart (new service, same state file)', async () => {
    const backend = new MemoryBackend();
    const now = { t: taipei('2026-11-18T06:05:00') };
    const store1 = new ConceptStateStore(backend, { warn: () => undefined });
    const svc1 = new ConceptDailyService({ store: store1, bank: async () => null, now: () => now.t, logger: { warn: () => undefined } });
    const [a] = await svc1.handle(msg());
    a.delivered('line-msg-1');
    await store1.update(() => undefined); // 等寫回
    const svc2 = service(backend, now);
    expect(await svc2.handle(msg({ text: '重啟後第一則' }))).toEqual([]);
    // 另一個群組（Discord）照樣發，而且是同一張卡。
    const [d] = await svc2.handle(msg({ platform: 'discord', chatId: DC_CHANNEL }));
    expect(d.text).toBe(a.text);
  });

  it('sends the same card on LINE and Discord the same day', async () => {
    const now = { t: taipei('2026-11-18T08:00:00') };
    const svc = service(new MemoryBackend(), now);
    const [l] = await svc.handle(msg());
    const [d] = await svc.handle(msg({ platform: 'discord', chatId: DC_CHANNEL }));
    expect(l.text).toBe(d.text);
  });

  it('ignores groups and channels that are not listed, and platforms that are off', async () => {
    const now = { t: taipei('2026-11-18T08:00:00') };
    const svc = service(new MemoryBackend(), now);
    expect(await svc.handle(msg({ chatId: 'Cother' }))).toEqual([]);
    process.env.CONCEPT_DAILY_DISCORD = 'false';
    expect(await svc.handle(msg({ platform: 'discord', chatId: DC_CHANNEL }))).toEqual([]);
  });

  it('merges a conflicting state file: the first plan of a day wins, sent dates keep the newest', () => {
    const a = emptyState();
    const b = emptyState();
    a.days['2026-11-18'] = { date: '2026-11-18', cardId: 'x', source: 'rotation', link: { kind: 'article', url: 'u' } };
    b.days['2026-11-18'] = { date: '2026-11-18', cardId: 'y', source: 'rotation', link: { kind: 'article', url: 'u' } };
    a.sent.k = '2026-11-17';
    b.sent.k = '2026-11-18';
    const m = mergeStates(a, b);
    expect(m.days['2026-11-18'].cardId).toBe('x');
    expect(m.sent.k).toBe('2026-11-18');
  });
});

// ─── 回饋 ─────────────────────────────────────────────────────────────────

describe('feedback on the card', () => {
  it('parses the keyword fallback', () => {
    expect(parseFeedbackKeyword('觀念回饋 應用看不懂')).toBe('應用看不懂');
    expect(parseFeedbackKeyword('/觀念：前提不清楚')).toBe('前提不清楚');
    expect(parseFeedbackKeyword('／觀念回饋')).toBe('');
    expect(parseFeedbackKeyword('觀念回饋')).toBe('');
    expect(parseFeedbackKeyword('觀念回饋很棒')).toBeNull();
    expect(parseFeedbackKeyword('我覺得觀念回饋')).toBeNull();
  });

  it('records a reply that quotes the bot’s card message and acknowledges it', async () => {
    const now = { t: taipei('2026-11-18T06:10:00') };
    const sink = vi.fn(async () => true);
    const svc = service(new MemoryBackend(), now, sink);
    const [daily] = await svc.handle(msg());
    daily.delivered('bot-msg-9');
    const cardId = /#concepts=([^\s]+)/.exec(daily.text)?.[1];
    const replies = await svc.handle(msg({ userId: 'U2', text: '應用那句跟情境對不上', quotedMessageId: 'bot-msg-9' }));
    expect(replies.map((r) => [r.kind, r.text])).toEqual([['feedback', CONCEPT_FEEDBACK_ACK]]);
    expect(sink).toHaveBeenCalledTimes(1);
    const posted = (sink.mock.calls[0] as unknown as [string])[0];
    const parsed = parseConceptFeedbackMessage(posted);
    expect(parsed).toMatchObject({ cardId, date: '2026-11-18', platform: 'line', text: '應用那句跟情境對不上', handled: false });
    // 不放原始 id，只放雜湊。
    expect(posted).not.toContain(LINE_GROUP);
    expect(posted).not.toContain('U2');
    expect(parsed?.groupHash).toMatch(/^[0-9a-f]{12}$/);
    // 引用別的訊息不算。
    expect(await svc.handle(msg({ text: '+1', quotedMessageId: 'someone-else' }))).toEqual([]);
  });

  it('takes 「觀念回饋 …」 when LINE’s quote is not detectable, for the card last sent to that group', async () => {
    const now = { t: taipei('2026-11-18T06:10:00') };
    const sink = vi.fn(async () => true);
    const svc = service(new MemoryBackend(), now, sink);
    // 還沒發過卡：不是回饋，什麼都不回（當天的第一則照樣拿到卡）。
    const first = await svc.handle(msg({ text: '觀念回饋 太難' }));
    expect(first.map((r) => r.kind)).toEqual(['daily']);
    first[0].delivered(); // LINE 沒回訊息 id 也行
    const replies = await svc.handle(msg({ text: '觀念回饋 太難懂' }));
    expect(replies.map((r) => r.text)).toEqual([CONCEPT_FEEDBACK_ACK]);
    expect(parseConceptFeedbackMessage((sink.mock.calls[0] as unknown as [string])[0])?.text).toBe('太難懂');
    expect((await svc.handle(msg({ text: '觀念回饋' }))).map((r) => r.text)).toEqual([CONCEPT_FEEDBACK_USAGE]);
  });

  it('rate-limits one person (3 per 10 minutes) and drops the rest silently', async () => {
    const now = { t: taipei('2026-11-18T06:10:00') };
    const sink = vi.fn(async () => true);
    const svc = service(new MemoryBackend(), now, sink);
    (await svc.handle(msg()))[0].delivered('b1');
    for (let i = 0; i < 3; i++) expect((await svc.handle(msg({ text: `意見${i}`, quotedMessageId: 'b1' }))).length).toBe(1);
    expect(await svc.handle(msg({ text: '第四則', quotedMessageId: 'b1' }))).toEqual([]);
    // 別人不受影響；十分鐘後又可以。
    expect((await svc.handle(msg({ userId: 'U9', text: '我也有意見', quotedMessageId: 'b1' }))).length).toBe(1);
    now.t += 10 * 60_000 + 1;
    expect((await svc.handle(msg({ text: '第五則', quotedMessageId: 'b1' }))).length).toBe(1);
    expect(sink).toHaveBeenCalledTimes(5);
    expect(svc.counts.feedbackThrottled).toBe(1);
  });

  it('caps a day per person and the whole bot per hour', () => {
    const rl = new FeedbackRateLimiter({ userWindowMs: 1, userMax: 100, userDayMax: 2, globalHourMax: 3 });
    expect([rl.allow('a', 1), rl.allow('a', 10), rl.allow('a', 20)]).toEqual([true, true, false]);
    expect([rl.allow('b', 30), rl.allow('c', 40)]).toEqual([true, false]);
  });

  it('lists feedback since a time and marks it handled (Discord REST, mocked)', async () => {
    const content = formatFeedbackForAdmin({ cardId: 'w205-loyal-seat1', date: '2026-11-18', platform: 'discord', groupHash: 'aaaaaaaaaaaa', userHash: 'bbbbbbbbbbbb', text: '看不懂 *這句*', createdAt: '2026-11-17T22:10:00.000Z' });
    // 2026-11-17T22:10Z 左右的 snowflake
    const id = ((BigInt(Date.parse('2026-11-17T22:10:00Z')) - 1420070400000n) << 22n).toString();
    const messages = [
      { id, content, author: { id: 'BOT' } },
      { id: (BigInt(id) - 1n).toString(), content: '一般訊息', author: { id: 'BOT' } },
    ];
    let edited = '';
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (url.endsWith('/users/@me')) return ok({ id: 'BOT' });
      if (init?.method === 'PATCH') {
        edited = (JSON.parse(init.body as string) as { content: string }).content;
        return ok({});
      }
      if (url.includes(`/messages/${id}`)) return ok({ id, content: edited || content });
      return ok(messages);
    }) as unknown as typeof fetch;
    const listing = await listConceptFeedback({ token: 't', channelId: 'C', since: '2026-11-18T00:00:00+08:00', fetchImpl });
    expect(listing.items).toEqual([expect.objectContaining({ messageId: id, cardId: 'w205-loyal-seat1', platform: 'discord', text: '看不懂 *這句*', handled: false })]);
    expect(await markConceptFeedback({ token: 't', channelId: 'C', messageId: id, fetchImpl })).toBe('edited');
    expect(edited.split('\n')[0]).toBe('【觀念卡回饋】w205-loyal-seat1（已處理）');
    expect(await markConceptFeedback({ token: 't', channelId: 'C', messageId: id, fetchImpl })).toBe('already');
    messages[0].content = edited;
    expect((await listConceptFeedback({ token: 't', channelId: 'C', since: '2026-11-18T00:00:00+08:00', fetchImpl })).items).toEqual([]);
    expect((await listConceptFeedback({ token: 't', channelId: 'C', since: '2026-11-18T00:00:00+08:00', includeHandled: true, fetchImpl })).items[0].handled).toBe(true);
    // 太晚的 since：沒有。
    expect((await listConceptFeedback({ token: 't', channelId: 'C', since: '2026-11-19T00:00:00+08:00', fetchImpl })).items).toEqual([]);
  });
});

// ─── 接線 ─────────────────────────────────────────────────────────────────

describe('Discord wiring', () => {
  it('replies to the first human message without pings, records the bot message id, and takes quoted replies as feedback', async () => {
    const now = { t: taipei('2026-11-18T09:00:00') };
    const sink = vi.fn(async () => true);
    const svc = service(new MemoryBackend(), now, sink);
    const sent: { content: string; allowedMentions: unknown }[] = [];
    const message = (over: Record<string, unknown> = {}) => ({
      author: { bot: false, id: 'u1' },
      webhookId: null,
      channelId: DC_CHANNEL,
      content: '早',
      reference: null,
      reply: async (o: { content: string; allowedMentions: unknown }) => {
        sent.push(o);
        return { id: `bot-${sent.length}` };
      },
      ...over,
    });
    await handleConceptDailyDiscord(message({ author: { bot: true, id: 'b' } }), svc);
    expect(sent).toEqual([]);
    await handleConceptDailyDiscord(message(), svc);
    expect(sent).toHaveLength(1);
    expect(sent[0].content.startsWith('[阿瓦隆百科小觀念]')).toBe(true);
    expect(sent[0].allowedMentions).toEqual({ parse: [], repliedUser: false });
    await handleConceptDailyDiscord(message({ content: '第二則' }), svc);
    expect(sent).toHaveLength(1);
    await handleConceptDailyDiscord(message({ content: '這張的應用怪怪的', reference: { messageId: 'bot-1' } }), svc);
    expect(sent.map((s) => s.content)).toEqual([sent[0].content, CONCEPT_FEEDBACK_ACK]);
    expect(sink).toHaveBeenCalledTimes(1);
    // 沒列的頻道：什麼都不做。
    await handleConceptDailyDiscord(message({ channelId: '222' }), svc);
    expect(sent).toHaveLength(2);
  });
});

describe('LINE wiring', () => {
  const SECRET = 'test-channel-secret';

  function signed(events: unknown[]): { req: Request; res: Response & { statusCode: number } } {
    const raw = JSON.stringify({ destination: 'U', events });
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
    const req = { get: (h: string) => (h === 'X-Line-Signature' ? sig : undefined), body: JSON.parse(raw), rawBody: Buffer.from(raw) } as unknown as Request;
    const res = {
      statusCode: 0,
      status(code: number) { this.statusCode = code; return this; },
      json() { return this; },
    } as unknown as Response & { statusCode: number };
    return { req, res };
  }

  const textEvent = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: 'message', replyToken: `rt-${id}`, webhookEventId: `ev-${id}`, source: { type: 'group', groupId: LINE_GROUP, userId: 'U1' },
    message: { type: 'text', id, text, quoteToken: `q-${id}`, ...extra },
  });

  it('answers the first message of the day on its reply_token (quoting it), never by push, and takes a quoted reply as feedback', async () => {
    __resetChatMirrorForTests();
    const now = { t: taipei('2026-11-18T06:00:30') };
    const sink = vi.fn(async () => true);
    __setConceptDailyForTests(service(new MemoryBackend(), now, sink));
    const replies: { token: string; messages: { type: string; text: string; quoteToken?: string }[] }[] = [];
    const client = {
      replyMessage: async (token: string, messages: { type: string; text: string }[]) => {
        replies.push({ token, messages });
        return { sentMessages: messages.map((_, i) => ({ id: `sent-${token}-${i}`, quoteToken: 'x' })) };
      },
      pushMessage: async () => { throw new Error('push must never be used'); },
    } as unknown as Client;
    const bot = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client });

    let r = signed([textEvent('1', '早安')]);
    await bot.handleWebhook(r.req, r.res);
    expect(r.res.statusCode).toBe(200);
    expect(replies).toHaveLength(1);
    expect(replies[0].token).toBe('rt-1');
    expect(replies[0].messages[0].text.startsWith('[阿瓦隆百科小觀念]\n情境: ')).toBe(true);
    expect(replies[0].messages[0].quoteToken).toBe('q-1');

    r = signed([textEvent('2', '大家早')]);
    await bot.handleWebhook(r.req, r.res);
    expect(replies).toHaveLength(1);

    r = signed([textEvent('3', '情境那句少了前提', { quotedMessageId: 'sent-rt-1-0' })]);
    await bot.handleWebhook(r.req, r.res);
    expect(replies[1].messages.map((m) => m.text)).toEqual([CONCEPT_FEEDBACK_ACK]);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('shares the mirror group’s reply_token: card after the command answer, before the queued mirror items', async () => {
    const { initializeChatMirror } = await import('../bots/ChatMirror');
    const { LineReplyQueue } = await import('../bots/line/replyQueue');
    process.env.LOBBY_MIRROR_LINE_GROUP_ID = LINE_GROUP;
    const now = { t: taipei('2026-11-18T07:00:00') };
    __setConceptDailyForTests(service(new MemoryBackend(), now));
    const mirror = initializeChatMirror({
      lineGroupId: LINE_GROUP,
      discordChannelId: 'D1',
      discord: { fetchChannel: async () => ({ send: async () => ({}) }) },
      lineReplyQueue: new LineReplyQueue(),
      logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
      inboundRateLimit: { windowMs: 60_000, maxRequests: 100 },
    });
    for (let i = 0; i < 6; i++) await mirror.fanout({ id: `q${i}`, playerId: 'p', playerName: 'Bob', message: `msg${i}`, timestamp: Date.now(), source: 'lobby' });
    const replies: { messages: { text: string }[] }[] = [];
    const client = {
      replyMessage: async (_t: string, messages: { text: string }[]) => { replies.push({ messages }); return {}; },
      pushMessage: async () => { throw new Error('push must never be used'); },
      getGroupMemberProfile: async () => ({ displayName: 'X' }),
    } as unknown as Client;
    const bot = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client });
    const r = signed([textEvent('10', '早')]);
    await bot.handleWebhook(r.req, r.res);
    expect(replies).toHaveLength(1);
    const texts = replies[0].messages.map((m) => m.text);
    expect(texts).toHaveLength(5);
    expect(texts[0].startsWith('[阿瓦隆百科小觀念]')).toBe(true);
    expect(texts.slice(1).every((t) => t.includes('msg'))).toBe(true);
    // 剩下的 2 則同步訊息還在佇列，下一個 token 送。
    expect(mirror.lineReplyQueueSize()).toBe(2);
    __resetChatMirrorForTests();
  });
});

// ─── 真的題庫 ────────────────────────────────────────────────────────────

describe('with the real exercise bank and records list', () => {
  it('cuts the record at the same proposal the question stops at (sim_bank proposals ↔ records_cache rounds, one to one)', async () => {
    const path = await import('path');
    const { buildSimBank, readSimBankFile } = await import('../bots/simulation/bank');
    const { readRecordPosts } = await import('../bots/simulation/recordsIndex');
    const root = path.resolve(__dirname, '..', '..');
    const posts = readRecordPosts([path.join(root, 'records_cache.json')]) as { id: string; game: { rounds: { proposals: unknown[] }[] } }[];
    const file = readSimBankFile([path.join(root, 'sim_bank.json')]);
    if (!file || !posts) throw new Error('sim_bank.json / records_cache.json missing');
    const bank = buildSimBank(file, posts);
    const byId = new Map(posts.map((p) => [p.id, p]));
    let checked = 0;
    for (const [gi, postId] of bank.records) {
      const post = byId.get(postId);
      const flat = (post?.game.rounds ?? []).flatMap((r, ri) => r.proposals.map((_, ai) => `${ri + 1}-${ai + 1}`));
      expect(flat).toEqual(bank.games[gi].proposals.map((p) => `${p.round}-${p.attempt}`));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
    // 每一天都選得到卡；當天有 Threads 題目時，選的卡配得上那一題、連到那一題的牌譜。
    const { buildRecordIndex, buildRecordIndexAsync, cardMatchesExercise } = await import('../bots/conceptDaily/plan');
    const { threadsToday } = await import('../bots/conceptDaily/threadsToday');
    const index = buildRecordIndex(bank, CONCEPTS);
    // 分段算（伺服器用的）跟一次算完的一樣；大部分卡都有對得上的牌譜。
    expect(await buildRecordIndexAsync(bank, CONCEPTS, 500)).toEqual(index);
    expect(index.size).toBeGreaterThan(CONCEPTS.length * 0.8);
    const history: HistoryEntry[] = [];
    let date = '2026-11-18';
    for (let i = 0; i < 21; i++) {
      const th = threadsToday(bank, date, { picks: new Map(), liveFrom: null, states: new Map() });
      const plan = chooseDay({ date, concepts: CONCEPTS, history, threads: th, index }) as DayPlan;
      const card = CONCEPTS.find((c) => c.id === plan.cardId) as Concept;
      if (plan.source === 'threads' && th) {
        expect(cardMatchesExercise(card, th.exercise)).toBe(true);
        if (th.recordUrl) expect(plan.link).toEqual({ kind: 'record', url: th.recordUrl });
      }
      expect(history.slice(-RECENT_DAYS).map((h) => h.cardId)).not.toContain(plan.cardId);
      history.push({ date, cardId: plan.cardId });
      date = addDays(date, 1);
    }
  });
});
