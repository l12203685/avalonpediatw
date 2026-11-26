/**
 * 模擬瓦 /公布 的三個加項（站長 2026-11-26）：
 *   1. 「現行百科AI會派的組合前三種可能（若只有一種可能不用硬給到三種）」——aiRead.aiPicks（正式機器人換種子重派）＋ replies.aiPicksLine；
 *   2. 「公布時的圖上沒有玩家id」——recordImage 在角色下面寫名字（換行、截斷、拿掉字型沒有的 emoji）；
 *   3. 「玩家如果反饋是爛局或是吐槽的內容記得記錄下來」——feedback.ts ＋ SimEngine.feedbackFor ＋ FeedbackService.recordSimFeedback。
 * 題庫是編的（fixtures/simGames.ts），名字都是假的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_PICK_MIN_SHARE,
  aiPickOnce,
  aiPicks,
  aiReading,
  summarizePicks,
  type AiPicks,
} from '../bots/simulation/aiRead';
import { SIM_CONFIG } from '../bots/simulation/config';
import { answerSimFeedbackMessage } from '../bots/simulation/discordCommand';
import {
  SIM_FEEDBACK_ACK,
  SIM_FEEDBACK_WINDOW_MS,
  classifySimFeedback,
  formatSimFeedbackForward,
  type SimFeedbackRecord,
} from '../bots/simulation/feedback';
import { __setSimForTests } from '../bots/simulation';
import { buildRecordSvg, drawableName, renderRecordPng, wrapName } from '../bots/simulation/recordImage';
import { aiPicksLine } from '../bots/simulation/replies';
import { firstDecision } from '../bots/simulation/scenario';
import { SimEngine, type SimRequest } from '../bots/simulation/session';
import { FeedbackService, type FeedbackForwardPayload } from '../bots/feedback/service';
import { FAKE_NAMES, fixtureBank } from './fixtures/simGames';

const BANK = fixtureBank();
const W0 = BANK.games[BANK.byId.get('W0000') as number];
const clock = { now: 2_000_000_000 };
const MIN = 60_000;

function engine(opts: Partial<ConstructorParameters<typeof SimEngine>[0]> = {}): SimEngine {
  return new SimEngine({ bank: async () => BANK, now: () => clock.now, random: () => () => 0, rateLimit: { windowMs: 1, max: 1_000_000 }, ...opts });
}

async function say(e: SimEngine, text: string, req: SimRequest): Promise<string | null> {
  clock.now += 1000;
  const r = await e.handleText(text, req);
  if (!r) return null;
  r.commit();
  return r.text;
}

afterEach(() => {
  SIM_CONFIG.commandsEnabled = true;
});

// ─── 1. 百科AI 會派 ─────────────────────────────────────────────────────────

describe('aiPicksLine (owner 2026-11-26: top three, no padding when there is one)', () => {
  const pick = (seats: number[], p: number): AiPicks['picks'][number] => ({ seats, p });

  it('one choice → just the team, no percentages', () => {
    expect(aiPicksLine({ kind: 'team', picks: [pick([1, 3, 5], 1)], others: 0, samples: 8 })).toBe('百科AI 會派：135');
    // 其他都不到 5% 也算只有一種
    expect(aiPicksLine({ kind: 'team', picks: [pick([1, 3, 10], 0.96)], others: 0.04, samples: 24 })).toBe('百科AI 會派：130');
  });

  it('several → up to three with 約 on the first, plus 其他 when the rest is ≥ 5%', () => {
    expect(aiPicksLine({ kind: 'team', picks: [pick([1, 3, 5], 0.6), pick([1, 3, 6], 0.25), pick([1, 4, 5], 0.15)], others: 0, samples: 20 }))
      .toBe('百科AI 會派：135（約 60%）、136（25%）、145（15%）');
    expect(aiPicksLine({ kind: 'team', picks: [pick([1, 2], 0.125), pick([1, 3], 0.083)], others: 0.792, samples: 24 }))
      .toBe('百科AI 會派：12（約 13%）、13（8%）、其他 79%');
  });

  it('assassination → 會刺 N家; nothing → empty (the reveal skips the line)', () => {
    expect(aiPicksLine({ kind: 'assassinate', picks: [pick([7], 0.7), pick([3], 0.3)], others: 0, samples: 24 })).toBe('百科AI 會刺：7家（約 70%）、3家（30%）');
    expect(aiPicksLine({ kind: 'assassinate', picks: [pick([10], 1)], others: 0, samples: 8 })).toBe('百科AI 會刺：0家');
    expect(aiPicksLine(null)).toBe('');
    expect(aiPicksLine({ kind: 'team', picks: [], others: 1, samples: 0 })).toBe('');
  });
});

describe('summarizePicks', () => {
  it('ranks by share, drops < 5% (except the top one), keeps at most three', () => {
    const s = [...Array(10).fill([1, 2, 3]), ...Array(5).fill([1, 2, 4]), ...Array(3).fill([1, 2, 5]), ...Array(2).fill([1, 2, 6]), [1, 2, 7]];
    const r = summarizePicks('team', s);
    expect(r?.picks.map((p) => p.seats.join(''))).toEqual(['123', '124', '125']);
    expect(r?.samples).toBe(21);
    expect(r?.others).toBeCloseTo(3 / 21, 6);
    // 一個 4% 的不列
    const r2 = summarizePicks('team', [...Array(24).fill([1, 2, 3]).slice(0, 23), [4, 5, 6]]);
    expect(r2?.picks).toHaveLength(1);
    expect(1 / 24).toBeLessThan(AI_PICK_MIN_SHARE);
    expect(summarizePicks('team', [])).toBeNull();
  });
});

describe('aiPicks: the live bot (DEFAULT_AGENT_TUNING) re-drawn with fixed seeds', () => {
  const seat = 4;
  const d = firstDecision(W0, seat) as number;

  it('draw 0 is exactly what /區間 says 百科AI 會派', () => {
    expect(aiPickOnce(W0, seat, { kind: 'team_select', proposal: d }, 0)).toEqual(aiReading(W0, seat, d).teams[0].seats);
  });

  it('is deterministic, lists the /區間 team when it is the top pick, sizes match the mission', async () => {
    const a = await aiPicks(W0, seat, { kind: 'team_select', proposal: d }, { yieldFn: async () => undefined });
    const b = await aiPicks(W0, seat, { kind: 'team_select', proposal: d }, { yieldFn: async () => undefined });
    expect(a).toEqual(b);
    expect(a?.kind).toBe('team');
    expect(a!.picks.length).toBeGreaterThanOrEqual(1);
    expect(a!.picks.length).toBeLessThanOrEqual(3);
    for (const p of a!.picks) expect(p.seats).toHaveLength(W0.proposals[d].teamSeats.length);
    // 每次都一樣時只派 AI_PICK_PROBE 次就停
    if (a!.picks.length === 1 && a!.others === 0) expect(a!.samples).toBeLessThanOrEqual(8);
  });

  it('assassination exercise → one seat per pick', async () => {
    const assassin = W0.seatRoles.indexOf('assassin') + 1;
    const a = await aiPicks(W0, assassin, { kind: 'assassination' }, { yieldFn: async () => undefined });
    expect(a?.kind).toBe('assassinate');
    for (const p of a!.picks) expect(p.seats).toHaveLength(1);
  });

  it('stops at the time budget once the probe is done (never fewer than the probe)', async () => {
    let t = 0;
    const r = await aiPicks(W0, seat, { kind: 'team_select', proposal: d }, { samples: 24, probe: 2, budgetMs: 0, now: () => (t += 10), yieldFn: async () => undefined });
    expect(r!.samples).toBeGreaterThanOrEqual(1);
    expect(r!.samples).toBeLessThanOrEqual(2);
  });
});

describe('/公布 with the 百科AI line', () => {
  const req: SimRequest = { platform: 'line', chatId: 'C-ai', userId: 'U-ai' };

  it('prints the line from the injected picker, between the answers and 原始結果', async () => {
    const calls: unknown[] = [];
    const e = engine({
      aiPicks: async (game, seat, point) => {
        calls.push([game.id, seat, point]);
        return { kind: 'team', picks: [{ seats: [1, 3, 5], p: 0.6 }, { seats: [1, 3, 6], p: 0.4 }], others: 0, samples: 24 };
      },
    });
    await say(e, '/模擬 題 W0000-4', req);
    const text = (await say(e, '/公布', req)) ?? '';
    const lines = text.split('\n');
    const i = lines.indexOf('百科AI 會派：135（約 60%）、136（40%）');
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toMatch(/^原始結果: /u);
    expect(calls).toEqual([['W0000', 4, { kind: 'team_select', proposal: firstDecision(W0, 4) }]]);
  });

  it('the assassination exercise asks for assassin picks', async () => {
    const points: unknown[] = [];
    const e = engine({ aiPicks: async (_g, _s, point) => { points.push(point); return { kind: 'assassinate', picks: [{ seats: [7], p: 1 }], others: 0, samples: 8 }; } });
    await say(e, '/模擬 題 W0000-A', req);
    expect(await say(e, '/公布', req)).toContain('\n百科AI 會刺：7家\n');
    expect(points).toEqual([{ kind: 'assassination' }]);
  });

  it('no picker, or a picker that throws → the reveal is unchanged (no line)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const plain = engine();
    await say(plain, '/模擬 題 W0000-4', req);
    const a = (await say(plain, '/公布', req)) ?? '';
    const broken = engine({ aiPicks: async () => { throw new Error('boom'); } });
    await say(broken, '/模擬 題 W0000-4', req);
    const b = (await say(broken, '/公布', req)) ?? '';
    expect(a).not.toContain('百科AI');
    expect(b).toBe(a);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(['[sim] /公布 AI picks failed (Error)']);
    warn.mockRestore();
  });

  it('the real picker end to end: the line is there and short', async () => {
    const e = engine({ aiPicks: (g, s, p) => aiPicks(g, s, p, { yieldFn: async () => undefined }) });
    await say(e, '/模擬 題 W0000-4', req);
    const line = ((await say(e, '/公布', req)) ?? '').split('\n').find((l) => l.startsWith('百科AI 會派：'));
    expect(line).toMatch(/^百科AI 會派：\d{2,5}(?:（約 \d+%）(?:、\d{2,5}（\d+%）){0,2}(?:、其他 \d+%)?)?$/u);
  });
});

// ─── 2. 圖上的名字 ──────────────────────────────────────────────────────────

describe('record image: player names under the roles (owner 2026-11-26)', () => {
  it('wrapName: two lines at most, … when cut, emoji the font lacks dropped', () => {
    expect(wrapName('假名01', 55.6, 18)).toEqual(['假名0', '1']);
    expect(wrapName('測試', 55.6, 18)).toEqual(['測試']);
    const long = wrapName('一二三四五六七八九十', 55.6, 18);
    expect(long).toHaveLength(2);
    expect(long[1].endsWith('…')).toBe(true);
    expect(wrapName('Abcdefghijklmnopqrstuvwxyz', 55.6, 18).at(-1)?.endsWith('…')).toBe(true);
    expect(drawableName('🐱貓👍🏽')).toBe('貓');
    expect(wrapName('😀😀', 55.6, 18)).toEqual([]);
    expect(wrapName('', 55.6, 18)).toEqual([]);
  });

  it('the SVG carries each seat\'s name (unknown seats stay blank), and no names = the old image', () => {
    const names = [...FAKE_NAMES.slice(0, 9), ''];
    names[2] = '百科AI_3';
    const svg = buildRecordSvg(W0, 'W0000-4', names);
    expect(svg).toContain('>假名0<');
    expect(svg).toContain('>百科AI<');
    expect(buildRecordSvg(W0, 'W0000-4')).toBe(buildRecordSvg(W0, 'W0000-4', undefined));
    expect(buildRecordSvg(W0, 'W0000-4', Array(10).fill(''))).toBe(buildRecordSvg(W0, 'W0000-4'));
    expect(buildRecordSvg(W0, 'W0000-4')).not.toContain('假名');
    // 名字讓表格往下移，但整張圖還是一張
    const png = renderRecordPng(W0, 'W0000-4', { names });
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(renderRecordPng(W0, 'W0000-4')).not.toEqual(png);
  });

  it('/公布 hands the same names as the text line to the image', async () => {
    const names = [...FAKE_NAMES];
    const bank = { ...BANK, names: new Map([[BANK.byId.get('W0000') as number, names]]) };
    const e = new SimEngine({ bank: async () => bank, now: () => clock.now, random: () => () => 0 });
    const req: SimRequest = { platform: 'line', chatId: 'C-img', userId: 'U-img' };
    await say(e, '/模擬 題 W0000-4', req);
    clock.now += 1000;
    const r = await e.handleText('/公布', req);
    expect(r?.image?.names).toEqual(names);
    expect(r?.text).toContain(`1.${FAKE_NAMES[0]} 2.${FAKE_NAMES[1]}`);
  });
});

// ─── 3. 玩家回饋 ────────────────────────────────────────────────────────────

describe('classifySimFeedback (conservative keywords)', () => {
  it.each([
    ['這局很爛', 'bad'], ['爛局', 'bad'], ['這題怪怪的', 'bad'], ['紀錄有問題吧', 'bad'], ['牌譜錯了', 'bad'], ['那個紅方根本亂打', 'bad'],
    ['拇指記錯', 'bad'], ['題目有問題', 'bad'], ['吐槽一下 這個百科AI', 'complaint'], ['百科AI 好怪', 'complaint'], ['這樣派不合理', 'complaint'],
  ])('%s → %s', (text, kind) => {
    expect(classifySimFeedback(text)).toBe(kind);
  });

  it.each(['我亂派的', '我記錯了', '好難喔', '我好爛', '晚上要打嗎', '/公布', '/意見 這局很爛', '', 'x'.repeat(400) + '爛局'])('%s → null', (text) => {
    expect(classifySimFeedback(text)).toBeNull();
  });
});

describe('SimEngine.feedbackFor', () => {
  const G = (userId: string): SimRequest => ({ platform: 'line', chatId: 'G-fb', userId, shared: true });
  let records: SimFeedbackRecord[];
  let e: SimEngine;
  beforeEach(async () => {
    records = [];
    e = engine({ feedbackSink: (r) => records.push(r) });
    await say(e, '/模擬 題 W0000-4', G('U1'));
    await say(e, '/公布', G('U1'));
  });

  it('right after /公布: records it, acknowledges once per person per exercise', async () => {
    expect(await say(e, '這局很爛', G('U2'))).toBe(SIM_FEEDBACK_ACK);
    expect(await say(e, '真的爛局', G('U2'))).toBeNull();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ exerciseId: 'W0000-4', gameId: 'W0000', platform: 'line', kind: 'bad', text: '這局很爛', badReporters: 1, flagged: false });
    expect(records[0].user).toMatch(/^[0-9a-f]{12}$/u);
    expect(records[0].user).not.toBe('U2');
    expect(e.counts.feedback).toEqual({ recorded: 2, bad: 2, flaggedGames: 0 });
  });

  it('two different people saying it is a bad game → flagged once (never removed from the bank)', async () => {
    await say(e, '爛局', G('U2'));
    await say(e, '紀錄有問題', G('U3'));
    await say(e, '亂打的局', G('U4'));
    expect(records.map((r) => [r.badReporters, r.flagged])).toEqual([[1, false], [2, true], [3, false]]);
    expect(e.counts.feedback.flaggedGames).toBe(1);
    expect(BANK.byId.has('W0000')).toBe(true);
    // 吐槽只記錄，不算爛局
    await say(e, '吐槽一下', G('U5'));
    expect(records.at(-1)).toMatchObject({ kind: 'complaint', flagged: false });
  });

  it('ordinary chatter, a command, or a message after the window → nothing', async () => {
    expect(await say(e, '晚上要打嗎', G('U2'))).toBeNull();
    expect(await say(e, '我亂派的哈哈', G('U2'))).toBeNull();
    clock.now += SIM_FEEDBACK_WINDOW_MS + MIN;
    expect(await say(e, '這局很爛', G('U2'))).toBeNull();
    expect(records).toEqual([]);
  });

  it('another chat, or a LINE redelivery → nothing', async () => {
    expect(await say(e, '這局很爛', { platform: 'line', chatId: 'G-other', userId: 'U2', shared: true })).toBeNull();
    expect(await e.handleText('這局很爛', { ...G('U2'), duplicate: true })).toBeNull();
    expect(records).toEqual([]);
  });

  it('while an exercise is open and was just touched, the feedback goes to it', async () => {
    await say(e, '/模擬 題 W0001-4', G('U1'));
    clock.now += SIM_FEEDBACK_WINDOW_MS + MIN;
    await say(e, '/派 123', G('U1'));
    expect(await say(e, '這題怪', G('U9'))).toBe(SIM_FEEDBACK_ACK);
    expect(records[0]).toMatchObject({ exerciseId: 'W0001-4', gameId: 'W0001' });
  });

  it('the ack is not committed until sent: a failed send gets the ack again next time', async () => {
    clock.now += 1000;
    const first = e.feedbackFor('這局很爛', G('U7'));
    expect(first?.text).toBe(SIM_FEEDBACK_ACK);
    // 沒 commit（送出失敗）
    expect(e.feedbackFor('這局很爛', G('U7'))?.text).toBe(SIM_FEEDBACK_ACK);
  });

  it('a sink that throws never breaks the reply', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = engine({ feedbackSink: () => { throw new Error('x'); } });
    await say(bad, '/模擬 題 W0000-4', G('U1'));
    await say(bad, '/公布', G('U1'));
    expect(await say(bad, '爛局', G('U2'))).toBe(SIM_FEEDBACK_ACK);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(['[sim] feedback sink failed (Error)']);
    warn.mockRestore();
  });
});

describe('FeedbackService.recordSimFeedback: the /意見 admin channel, no names', () => {
  const rec: SimFeedbackRecord = {
    exerciseId: 'W0000-4', gameId: 'W0000', platform: 'line', user: 'abcdef123456', at: Date.UTC(2026, 10, 26, 6, 3), kind: 'bad', text: '這局很爛', badReporters: 2, flagged: true,
  };

  it('formats one message with exercise, user hash, Taipei time and the text, plus the review note when flagged', () => {
    expect(formatSimFeedbackForward(rec)).toBe(
      '🎲 模擬瓦回饋（LINE）｜爛局／紀錄有問題｜題 W0000-4｜使用者 abcdef123456｜2026-11-26 14:03：這局很爛\n'
        + '⚠️ 局 W0000 已有 2 位說是爛局或紀錄有問題，請看要不要加進 sim_bank_exclude.json（不會自動從題庫拿掉）',
    );
    expect(formatSimFeedbackForward({ ...rec, kind: 'complaint', flagged: false, platform: 'discord' })).toBe(
      '🎲 模擬瓦回饋（Discord）｜吐槽｜題 W0000-4｜使用者 abcdef123456｜2026-11-26 14:03：這局很爛',
    );
  });

  it('sends to the admin channel with no pings; without Discord it is skipped and counted; logs carry no text', async () => {
    const sent: { channelId: string; payload: FeedbackForwardPayload }[] = [];
    const logs: string[] = [];
    const logger = { warn: (m: string): void => { logs.push(m); }, error: (m: string): void => { logs.push(m); } };
    const svc = new FeedbackService({ channelId: () => 'ADMIN', logger, discord: { send: async (channelId, payload) => { sent.push({ channelId, payload }); return true; } } });
    expect(await svc.recordSimFeedback(rec)).toBe('sent');
    expect(sent[0]).toEqual({ channelId: 'ADMIN', payload: { content: formatSimFeedbackForward(rec), allowedMentions: { parse: [] } } });
    const none = new FeedbackService({ channelId: () => 'ADMIN', logger });
    expect(await none.recordSimFeedback(rec)).toBe('skipped');
    expect(none.snapshot().simFeedback).toEqual({ sent: 0, skipped: 1, failed: 0, throttled: 0 });
    expect(svc.snapshot().simFeedback).toEqual({ sent: 1, skipped: 0, failed: 0, throttled: 0 });
    // /意見 的計數不受影響
    expect(svc.snapshot().opinions).toEqual({ line: 0, discord: 0 });
    expect(logs.join('\n')).not.toContain('這局很爛');
  });
});

describe('Discord: a typed message after a public /公布', () => {
  afterEach(() => {
    __setSimForTests({ engine: null });
  });

  it('records and replies once without pinging; bots, DMs and other channels are ignored', async () => {
    const records: SimFeedbackRecord[] = [];
    const e = engine({ feedbackSink: (r) => records.push(r) });
    __setSimForTests({ engine: e });
    const req: SimRequest = { platform: 'discord', chatId: 'CH1', userId: 'D1', shared: true, explicit: true };
    clock.now += 1000;
    (await e.handle({ kind: 'start', exerciseId: 'W0000-4' }, req))?.commit();
    clock.now += 1000;
    (await e.handle({ kind: 'reveal' }, req))?.commit();
    const replies: unknown[] = [];
    const msg = (over: Record<string, unknown> = {}): Parameters<typeof answerSimFeedbackMessage>[0] => ({
      author: { bot: false, id: 'D2' }, channelId: 'CH1', guildId: 'GUILD', content: '這局很爛', webhookId: null,
      reply: async (o) => { replies.push(o); return undefined; },
      ...over,
    }) as Parameters<typeof answerSimFeedbackMessage>[0];
    expect(await answerSimFeedbackMessage(msg())).toBe(true);
    expect(await answerSimFeedbackMessage(msg())).toBe(false);
    expect(await answerSimFeedbackMessage(msg({ author: { bot: true, id: 'B' } }))).toBe(false);
    expect(await answerSimFeedbackMessage(msg({ guildId: null, author: { bot: false, id: 'D3' } }))).toBe(false);
    expect(await answerSimFeedbackMessage(msg({ channelId: 'CH2', author: { bot: false, id: 'D3' } }))).toBe(false);
    expect(replies).toEqual([{ content: SIM_FEEDBACK_ACK, allowedMentions: { parse: [], repliedUser: false } }]);
    expect(records.map((r) => [r.platform, r.exerciseId])).toEqual([['discord', 'W0000-4'], ['discord', 'W0000-4']]);
  });
});
