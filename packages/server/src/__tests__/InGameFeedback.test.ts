/**
 * 遊戲內回饋（站長 2026-11-26「遊戲中的對話你也記得讀取並學習 有可能是玩家對你玩法的反饋」）— src/inGameFeedback。
 * 假資料：句子、座位、房間都是編的；沒有真名、沒有真實聊天。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  IN_GAME_CHAT_MAX_MESSAGES,
  IN_GAME_FEEDBACK_HEADER,
  IN_GAME_FEEDBACK_TAB,
  IN_GAME_FORWARD_WAIT_MS,
  IN_GAME_MAX_FORWARDS_PER_GAME,
  IN_GAME_POST_GAME_MS,
  InGameChatCapture,
  classifyInGameFeedback,
  createInGameFeedbackSheetWriter,
  inGameFeedbackEnabled,
  seatsMentioned,
  type InGameChatInput,
  type InGameFeedbackContext,
  type SheetRow,
} from '../inGameFeedback';
import { FeedbackService } from '../bots/feedback/service';
import { PRIVATE_CHAT_EXPORT_SHEET_ID, PUBLIC_STATS_SHEET_ID } from '../bots/chatExport/config';

const ctx = (over: Partial<InGameFeedbackContext> = {}): InGameFeedbackContext => ({
  botSeats: [3, 7],
  postGame: false,
  leaderIsBot: false,
  seatCount: 7,
  ...over,
});

describe('classifyInGameFeedback — flagged', () => {
  it.each([
    ['百科AI 這把好強', 'bot-word'],
    ['AI 為什麼要這樣派', 'bot-word'],
    ['那個 ai 亂打吧', 'bot-word'],
    ['電腦是不是在送', 'bot-word'],
    ['機器人好笨', 'bot-word'],
    ['the bot threw', 'bot-word'],
    ['3家亂打', 'bot-seat'],
    ['7號為什麼這樣投', 'bot-seat'],
    ['#3 好神', 'bot-seat'],
    ['3家怎麼會派這隊', 'bot-seat'],
  ] as const)('%s → %s', (text, reason) => {
    expect(classifyInGameFeedback(text, ctx())?.reason).toBe(reason);
  });

  it('lists the bot seats it mentions (0家 = seat 10)', () => {
    expect(classifyInGameFeedback('3家跟7家都亂打', ctx())?.botSeats).toEqual([3, 7]);
    expect(classifyInGameFeedback('0家好強', ctx({ botSeats: [10], seatCount: 10 }))?.botSeats).toEqual([10]);
    expect(classifyInGameFeedback('AI 好強', ctx())).toMatchObject({ botSeats: [], genericBot: true });
  });

  it('a plain judgement counts after the game, or mid-game when bots hold at least half the seats', () => {
    expect(classifyInGameFeedback('有人亂打', ctx({ postGame: true }))?.reason).toBe('judgement');
    expect(classifyInGameFeedback('有人亂打', ctx())).toBeNull(); // 2 bots of 7 seats, mid-game
    expect(classifyInGameFeedback('有人亂打', ctx({ botSeats: [2, 3, 4, 5] }))?.reason).toBe('judgement');
  });

  it('an unaddressed "why" counts after the game, or for 派 when the leader is a bot', () => {
    expect(classifyInGameFeedback('為什麼這樣派', ctx())).toBeNull();
    expect(classifyInGameFeedback('為什麼這樣派', ctx({ leaderIsBot: true }))?.reason).toBe('question');
    expect(classifyInGameFeedback('為什麼這樣投', ctx({ leaderIsBot: true }))).toBeNull();
    expect(classifyInGameFeedback('最後為什麼刺', ctx({ postGame: true }))?.reason).toBe('question');
  });
});

describe('classifyInGameFeedback — not flagged (prefer missing over noise)', () => {
  it.each([
    '3家是梅林', // a bot seat, but plain deduction
    '7號我覺得是紅',
    '4家亂打', // a human seat
    '4家為什麼這樣派',
    '我先出任務',
    '好',
    'main 不要', // "ai" inside a word
    'said ok',
    '/意見 AI 很強', // a command
    '',
  ])('%s → null', (text) => {
    expect(classifyInGameFeedback(text, ctx())).toBeNull();
  });

  it('no bots at the table → never', () => {
    expect(classifyInGameFeedback('AI 好強', ctx({ botSeats: [] }))).toBeNull();
  });

  it('very long messages are skipped', () => {
    expect(classifyInGameFeedback(`AI ${'嗯'.repeat(400)}`, ctx())).toBeNull();
  });
});

describe('seatsMentioned', () => {
  it('reads 家 / 號 / # forms; 0 and 10 are seat 10; ignores other numbers', () => {
    expect(seatsMentioned('3家 4號 #5 0家 10號')).toEqual([3, 4, 5, 10]);
    expect(seatsMentioned('第2局 3次')).toEqual([]);
  });
});

// ─── capture ──────────────────────────────────────────────────────────────

const chat = (over: Partial<InGameChatInput> = {}): InGameChatInput => ({
  seat: 4, text: '你好', phase: 'voting', round: 2, proposal: 1, leaderIsBot: false, ...over,
});

function setup(opts: { sink?: boolean } = {}) {
  let now = 1_700_000_000_000;
  const forwarded: string[] = [];
  const rows: SheetRow[][] = [];
  const warn = vi.fn();
  const cap = new InGameChatCapture({
    forward: async (c) => { forwarded.push(c); return 'sent'; },
    sink: opts.sink === false ? null : { appendRows: async (r) => { rows.push(r); } },
    now: () => now,
    enabled: () => true,
    logger: { warn },
  });
  return { cap, forwarded, rows, warn, tick: (ms: number) => { now += ms; } };
}

describe('InGameChatCapture', () => {
  it('only games with a bot are captured', () => {
    const { cap } = setup();
    cap.startGame('r1', { botSeats: [], seatCount: 7 });
    expect(cap.isCapturing('r1')).toBe(false);
    expect(cap.onChat('r1', chat({ text: 'AI 好強' }))).toBeNull();
    cap.startGame('r2', { botSeats: [3], seatCount: 7 });
    expect(cap.isCapturing('r2')).toBe(true);
    expect(cap.snapshot()).toMatchObject({ capturedGames: 1, openGames: 1 });
  });

  it('forwards a flagged line with up to 3 lines of context before and after (seats only, no names)', () => {
    const { cap, forwarded } = setup();
    cap.startGame('room-ab12', { botSeats: [3, 7], seatCount: 7 });
    for (const t of ['一', '二', '三', '四']) cap.onChat('room-ab12', chat({ seat: 2, text: `前面${t}` }));
    const hit = cap.onChat('room-ab12', chat({ seat: 4, text: '3家為什麼這樣派', round: 3 }));
    expect(hit?.reason).toBe('bot-seat');
    // Waits for the lines after it.
    expect(forwarded).toEqual([]);
    cap.onChat('room-ab12', chat({ seat: 5, text: '我也覺得', round: 3 }));
    cap.onChat('room-ab12', chat({ seat: 6, text: '對啊', round: 3 }));
    expect(forwarded).toEqual([]);
    cap.onChat('room-ab12', chat({ seat: 1, text: '下一個', round: 3 }));
    expect(forwarded).toEqual([[
      '📮 遊戲內回饋（房間 room-ab12，第1局任務3・派隊投票，4家→提到 3家百科AI）',
      '　 2家：前面二',
      '　 2家：前面三',
      '　 2家：前面四',
      '▶ 4家：3家為什麼這樣派',
      '　 5家：我也覺得',
      '　 6家：對啊',
      '　 1家：下一個',
    ].join('\n')]);
    // A post-game line with nothing after it goes out when the game closes; mentions never ping.
    cap.onChat('room-ab12', chat({ seat: 10, text: 'AI 好強 @everyone', phase: 'ended' }));
    expect(forwarded).toHaveLength(1);
    void cap.closeGame('room-ab12');
    expect(forwarded[1].split('\n')[0]).toBe('📮 遊戲內回饋（房間 room-ab12，第1局・局後，0家→提到 百科AI）');
    expect(forwarded[1].split('\n').at(-1)).toBe('▶ 0家：AI 好強 @\u200beveryone');
    expect(cap.snapshot()).toMatchObject({ messages: 9, flagged: 2, forwarded: 2, throttled: 0 });
  });

  it('a flagged line waits at most 2 minutes for context (sweep)', () => {
    const { cap, forwarded, tick } = setup();
    cap.startGame('r', { botSeats: [3], seatCount: 7 });
    cap.onChat('r', chat({ text: 'AI 亂打' }));
    cap.sweep(() => true);
    expect(forwarded).toHaveLength(0);
    tick(IN_GAME_FORWARD_WAIT_MS);
    cap.sweep(() => true);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toContain('▶ 4家：AI 亂打');
  });

  it('caps the forwards per game; the rest is counted as throttled and still goes into the one row', async () => {
    const { cap, forwarded, rows } = setup();
    cap.startGame('r', { botSeats: [3], seatCount: 7 });
    for (let i = 0; i < IN_GAME_MAX_FORWARDS_PER_GAME + 3; i += 1) cap.onChat('r', chat({ text: `AI 好強 ${i}` }));
    expect(cap.snapshot()).toMatchObject({ flagged: IN_GAME_MAX_FORWARDS_PER_GAME + 3, throttled: 3 });
    await cap.closeGame('r');
    expect(forwarded).toHaveLength(IN_GAME_MAX_FORWARDS_PER_GAME);
    expect(rows[0]).toHaveLength(1);
    expect(rows[0][0][4]).toBe(IN_GAME_MAX_FORWARDS_PER_GAME + 3);
    expect(String(rows[0][0][9]).match(/▶/g)).toHaveLength(IN_GAME_MAX_FORWARDS_PER_GAME + 3);
  });

  it('keeps post-game chat for 15 minutes, then writes one row for the game: the flagged lines as one conversation', async () => {
    const { cap, rows, tick } = setup();
    cap.startGame('r', { botSeats: [3, 7], seatCount: 7 });
    cap.onChat('r', chat({ seat: 2, text: '我覺得 4 可疑', round: 2, proposal: 2 }));
    cap.onChat('r', chat({ seat: 4, text: '7家好強', round: 2, proposal: 2 }));
    for (let i = 0; i < 8; i += 1) cap.onChat('r', chat({ seat: 1, text: `閒聊${i}`, round: 3 }));
    cap.endGame('r', { 3: 'assassin', 7: 'merlin' });
    tick(IN_GAME_POST_GAME_MS - 1000);
    cap.onChat('r', chat({ seat: 5, text: '為什麼刺我', phase: 'lobby' })); // back in the lobby: still post-game
    expect(cap.isCapturing('r')).toBe(true);
    tick(2000);
    expect(cap.isCapturing('r')).toBe(false);
    cap.sweep(() => true);
    await Promise.resolve();
    await Promise.resolve();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    const row = rows[0][0];
    expect(row).toHaveLength(IN_GAME_FEEDBACK_HEADER.length);
    expect(row.slice(1, 9)).toEqual(['r', 1, '3家、7家', 2, '派隊投票、局後', '7家百科AI、沒指名', '7家梅林', '講到百科AI 的座位、問為什麼這樣玩']);
    expect(row[9]).toBe([
      '【第1局任務2・派隊投票】',
      '　 2家：我覺得 4 可疑',
      '▶ 4家：7家好強（提到 7家百科AI・講到百科AI 的座位）',
      '【第1局任務3・派隊投票】',
      '　 1家：閒聊0',
      '　 1家：閒聊1',
      '　 1家：閒聊2',
      '……',
      '【第1局任務3・派隊投票】',
      '　 1家：閒聊5',
      '　 1家：閒聊6',
      '　 1家：閒聊7',
      '【第1局・局後】',
      '▶ 5家：為什麼刺我（提到 沒指名・問為什麼這樣玩）',
    ].join('\n'));
    expect(cap.snapshot()).toMatchObject({ openGames: 0, sheet: { rows: 1, failed: 0 } });
  });

  it('closes a game when its room is gone or a new game starts; numbers the games per room', async () => {
    const { cap, rows, forwarded } = setup();
    cap.startGame('r', { botSeats: [3], seatCount: 7 });
    cap.onChat('r', chat({ text: 'AI 亂打' }));
    cap.startGame('r', { botSeats: [3], seatCount: 7 }); // 第2局
    await Promise.resolve();
    expect(rows).toHaveLength(1);
    expect(forwarded).toHaveLength(1);
    cap.onChat('r', chat({ text: 'AI 亂打' }));
    cap.sweep(() => false);
    await Promise.resolve();
    expect(forwarded[1]).toContain('第2局任務2');
    expect(rows).toHaveLength(2);
    expect(cap.snapshot().openGames).toBe(0);
  });

  it('a game without feedback writes nothing; no sink → nothing written, nothing thrown', async () => {
    const a = setup();
    a.cap.startGame('r', { botSeats: [3], seatCount: 7 });
    a.cap.onChat('r', chat({ text: '我是好人' }));
    await a.cap.closeGame('r');
    expect(a.rows).toHaveLength(0);
    const b = setup({ sink: false });
    b.cap.startGame('r', { botSeats: [3], seatCount: 7 });
    b.cap.onChat('r', chat({ text: 'AI 亂打' }));
    await b.cap.closeGame('r');
    expect(b.cap.snapshot().sheet).toEqual({ status: 'none', rows: 0, failed: 0 });
  });

  it('keeps at most 300 messages per game in memory', () => {
    const { cap } = setup();
    cap.startGame('r', { botSeats: [3], seatCount: 7 });
    for (let i = 0; i < IN_GAME_CHAT_MAX_MESSAGES + 20; i += 1) cap.onChat('r', chat({ text: `嗨 ${i}` }));
    expect(cap.snapshot().messages).toBe(IN_GAME_CHAT_MAX_MESSAGES + 20);
    expect(cap.heldMessages('r')).toBe(IN_GAME_CHAT_MAX_MESSAGES);
    cap.onChat('r', chat({ text: '長'.repeat(800) }));
    expect(cap.heldMessages('r')).toBe(IN_GAME_CHAT_MAX_MESSAGES);
  });

  it('a sheet failure is counted and logged without the text', async () => {
    let now = 0;
    const warn = vi.fn();
    const cap = new InGameChatCapture({
      forward: async () => 'sent',
      sink: { appendRows: async () => { throw new Error('HTTP 403'); } },
      now: () => now,
      enabled: () => true,
      logger: { warn },
    });
    cap.startGame('r', { botSeats: [3], seatCount: 7 });
    cap.onChat('r', chat({ text: 'AI 秘密句子' }));
    now += 1;
    await cap.closeGame('r');
    expect(cap.snapshot().sheet.failed).toBe(1);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('秘密句子');
  });

  it('INGAME_FEEDBACK=off → nothing captured', () => {
    const cap = new InGameChatCapture({ enabled: () => false });
    cap.startGame('r', { botSeats: [3], seatCount: 7 });
    expect(cap.isCapturing('r')).toBe(false);
    expect(inGameFeedbackEnabled({})).toBe(true);
    expect(inGameFeedbackEnabled({ INGAME_FEEDBACK: 'off' })).toBe(false);
  });
});

describe('sheet writer config', () => {
  const key = JSON.stringify({ client_email: 'x@example.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' });

  it('defaults to the private sheet; refuses the public stats workbook; needs the service account', () => {
    expect(createInGameFeedbackSheetWriter({}).status).toBe('no-credentials');
    expect(createInGameFeedbackSheetWriter({ INGAME_FEEDBACK_SHEET_ID: 'off', GOOGLE_SERVICE_ACCOUNT_JSON: key }).status).toBe('disabled');
    expect(createInGameFeedbackSheetWriter({ INGAME_FEEDBACK_SHEET_ID: PUBLIC_STATS_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON: key }).status).toBe('public-refused');
    expect(createInGameFeedbackSheetWriter({ GOOGLE_SERVICE_ACCOUNT_JSON: 'nope' }).status).toBe('bad-credentials');
    expect(IN_GAME_FEEDBACK_TAB).toBe('遊戲內回饋');
    expect(PRIVATE_CHAT_EXPORT_SHEET_ID).not.toBe(PUBLIC_STATS_SHEET_ID);
  });
});

describe('FeedbackService.recordInGameFeedback', () => {
  it('posts to the admin channel with no pings and counts the outcome', async () => {
    const sent: Array<{ channelId: string; content: string; parse: unknown }> = [];
    const svc = new FeedbackService({
      discord: { send: async (channelId, p) => { sent.push({ channelId, content: p.content, parse: p.allowedMentions.parse }); return true; } },
      channelId: () => '123456789',
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await svc.recordInGameFeedback('📮 遊戲內回饋（…）：x')).toBe('sent');
    expect(sent).toEqual([{ channelId: '123456789', content: '📮 遊戲內回饋（…）：x', parse: [] }]);
    const none = new FeedbackService({ channelId: () => '', logger: { warn: () => undefined, error: () => undefined } });
    expect(await none.recordInGameFeedback('x')).toBe('skipped');
    expect(svc.snapshot().inGameForwards).toEqual({ sent: 1, skipped: 0, failed: 0, throttled: 0 });
    expect(none.snapshot().inGameForwards).toEqual({ sent: 0, skipped: 1, failed: 0, throttled: 0 });
  });
});
