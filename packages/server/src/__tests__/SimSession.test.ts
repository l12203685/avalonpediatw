/**
 * 模擬瓦（2026-10-14）— session 引擎：選題（角色／座位／題號、題目不夠）、一人一題、取代、
 * /派 /區間 /下一步 /公布 /結束 的轉移、期限（假時鐘）、上限與淘汰（一人跨聊天室最多 2 題、結束原因）、
 * 限流（slash 的用法也受限流）、送出後才 commit、同一題的指令排隊（withLock）、
 * LINE 重送已經回過的事件不再回、沒有任何 log（更不會有使用者打的字）、狀態頁只有數字和布林。
 * 題庫是編的（fixtures/simGames.ts），沒有真實玩家。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimBankLoader } from '../bots/simulation/bank';
import { SIM_CONFIG } from '../bots/simulation/config';
import { __setSimForTests, simulationStatus } from '../bots/simulation';
import { NO_SESSION_TEXT, RATE_LIMITED_TEXT, endedNoticeText } from '../bots/simulation/replies';
import { SimEngine, type SimRequest } from '../bots/simulation/session';
import { FAKE_NAMES, fixtureBank } from './fixtures/simGames';

const BANK = fixtureBank();
const clock = { now: 1_000_000_000 };
const MIN = 60_000;

function engine(opts: Partial<ConstructorParameters<typeof SimEngine>[0]> = {}): SimEngine {
  return new SimEngine({ bank: async () => BANK, now: () => clock.now, random: () => () => 0, ...opts });
}

const LINE_USER: SimRequest = { platform: 'line', chatId: 'U-chat', userId: 'U1' };

/** 送出成功 → commit；回傳文字。 */
async function say(e: SimEngine, text: string, req: SimRequest = LINE_USER): Promise<string | null> {
  clock.now += 1000;
  const r = await e.handleText(text, req);
  if (!r) return null;
  r.commit();
  return r.text;
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  // 引擎從不寫 log：使用者打的字、題號、id 都不可能出現在 log 裡。
  for (const s of consoleSpies) {
    expect(s).not.toHaveBeenCalled();
    s.mockRestore();
  }
  SIM_CONFIG.commandsEnabled = true;
});

describe('selection', () => {
  it('/模擬 忠臣 4 → the 百科 exercise, wiki format', async () => {
    const text = await say(engine(), '/模擬 忠臣 4');
    expect(text?.split('\n')).toEqual([
      '【模擬瓦 W0000-4】你是 4家・忠臣（沒有額外資訊）',
      '第 1 局派票（隊長依序；X+ 隊外贊成、X- 隊內反對，其他人照「隊內贊成、隊外反對」）：',
      '1家 460 1+',
      '2家 279',
      '3家 370',
      '輪到你派 3 人（第 1 局第 4 次）。',
      '作答：/派 + 座位（例：/派 123，0 = 10家）　區間（選填）：/區間 789=2 460=1',
      '/下一步 跳過｜/公布 看角色｜/結束',
    ]);
  });

  it('identity lines per role', async () => {
    const e = engine();
    expect(await say(e, '/模擬 派西 2')).toContain('你是 2家・派西維爾。拇指：1 5（一梅林一莫甘娜，不知道誰是誰）');
    expect(await say(e, '/模擬 梅林 1')).toContain('你是 1家・梅林。拇指（看到的紅）：5 7 9；莫德雷德看不到，還有 1 紅');
    expect(await say(e, '/模擬 莫德 3')).toContain('你是 3家・莫德雷德。隊友：5 7（奧伯倫不認隊友；梅林看不到你）');
    expect(await say(e, '/模擬 娜 5')).toContain('你是 5家・莫甘娜。隊友：3 7（奧伯倫不認隊友）');
  });

  it('seat 1 only when asked; the default pool is R1 seats 2–5', async () => {
    const e = engine({ random: () => () => 0.999 });
    for (let i = 0; i < 5; i++) {
      const text = (await say(e, '/模擬')) ?? '';
      expect(text).toMatch(/【模擬瓦 [WS]\d{4}-[2-5]】/);
    }
    expect(await say(e, '/模擬 1')).toMatch(/-1】你是 1家・/);
    expect(await say(e, '/模擬 梅林 1')).toContain('第 1 局第一個隊長，前面沒有派票');
  });

  it('seats 6–0 start at their first R2 proposal, after the R1 mission', async () => {
    const text = (await say(engine(), '/模擬 6')) ?? '';
    expect(text).toContain('任務 157：oox，1 張失敗 → 任務失敗');
    expect(text).toContain('輪到你派 4 人（第 2 局第 1 次）。');
  });

  it('紅 / 藍 pick a role of that camp', async () => {
    const red = (await say(engine({ random: () => () => 0 }), '/模擬 紅 3')) ?? '';
    expect(red).toMatch(/你是 3家・(刺客|莫甘娜|莫德雷德|奧伯倫)|只有 0 題/);
    const blue = (await say(engine(), '/模擬 藍 4')) ?? '';
    expect(blue).toMatch(/你是 4家・(梅林|派西維爾|忠臣)|只有 0 題/);
  });

  it('a thin role/seat says so and lists the seats that have enough', async () => {
    expect(await say(engine(), '/模擬 梅林 3')).toBe('梅林在 3家 只有 0 題（少於 20 題先不出）。這個角色題目夠的座位：1');
    expect(engine().activeSessions()).toBe(0);
  });

  it('題號: exact exercise, case-insensitive; unknown id; a seat without that round', async () => {
    const e = engine();
    expect(await say(e, '/模擬 題 w0003-4')).toContain('【模擬瓦 W0003-4】');
    expect(await say(e, '/模擬 題 ZZZZZ-4')).toContain('找不到這個題號');
    // S0000: 第 1 局第 2 次就出發，3家沒有第 1 局派票。
    expect(await say(e, '/模擬 題 S0000-3')).toBe('這一局 3家 沒有第 1 局的派票（那一局提早出發），換一題吧。');
  });

  it('bank not ready', async () => {
    const e = engine({ bank: async () => null });
    expect(await say(e, '/模擬')).toBe('模擬瓦題庫還沒準備好，請稍後再試。');
  });
});

describe('a whole exercise', () => {
  it('/派 feedback, /區間, /下一步 to the next decision, then /公布 ends it', async () => {
    const e = engine();
    await say(e, '/模擬 忠臣 4');
    const fb = (await say(e, '/派 469')) ?? '';
    // ④（每次作答都不一樣）在前，③ 邏輯在後，② 同位置真人最後。
    expect(fb.split('\n')).toEqual([
      '【W0000-4・4家忠臣】你派 469',
      '① 實際這位 4家派：469（跟你一樣）→ 否決',
      '④ 469 放出的資訊（後面的人讀你全好）：4 6 9 好 → 1 2 3 5 7 8 0 *4',
      '・對 1家 460：延伸（4 6）→ 都對：2 3 5 7 8 *4',
      '・對 2家 279：部分（9）→ 都對：1 3 5 8 0 *4',
      '・對 3家 370：打對邊 → 都對：只剩紅 1258',
      '・你在說：1、3 至少一個錯；2、3 至少一個錯 → 共同點 3：等於在說 3家 的讀法錯',
      '・對照：派 468 會跟 2家 279 打對邊 → 都對：只剩紅 1350（派 469：1 3 5 8 0 *4）',
      '③ 邏輯（純邏輯：只用確定資訊，還沒算派票行為）',
      '・你是好人，4 紅在其他 9 人（126 種）：任務前純邏輯分不出誰，區間要從派票讀',
      '・派票解讀：2家 279 跟 1家 打對邊｜3家 370 騎牆（挑 1家 的 0、2家 的 7）',
      '・不能都對：1家＋2家（7 人＞6）→ 1、2 至少一個錯',
      '・兩個都對：1家＋3家 只剩紅 2589；2家＋3家 只剩紅 1568',
      '② 同位置真人（第1局 4家忠臣，24 次，樣本少）：含自己 100%（你：有）',
      '\u3000跟上一次 3家 370 重疊 0 人 100%（你 0 人）',
      '/區間 寫下你的區間｜/下一步｜/公布｜/結束',
    ]);
    // 同一個決定點再派一次：③ 一行帶過。
    const again = (await say(e, '/派 468')) ?? '';
    expect(again).toContain('・對 2家 279：打對邊 → 都對：只剩紅 1350');
    expect(again).toContain('③ 邏輯與派票解讀跟這一題第一次 /派 的回覆一樣（還是同一個決定點）');
    expect(again).not.toContain('・派票解讀');

    const iv = (await say(e, '/區間 789=2 460=1')) ?? '';
    expect(iv.split('\n')).toEqual([
      '【W0000-4 區間】純邏輯只檢查有沒有矛盾，不判斷像不像（像不像要靠你讀派票，/公布 對答案）',
      '・789=2：可能（留 45/126 種）',
      '・460=1：你是好人 → 6 0 有 1 紅，可能（留 70/126 種）',
      '・全部一起：126 種縮到 24 種',
      '/派 作答（會照你的區間做最後檢查）｜/下一步｜/公布',
    ]);
    // 派票完的最後檢查：照你的區間，469 全好有幾種。
    expect(await say(e, '/派 469')).toMatch(/・最後檢查（照你的 \/區間，24 種）：469 全好 \d+ 種/);

    const next = (await say(e, '/下一步')) ?? '';
    expect(next).toContain('（之後照實際對局進行，你的答案不改變後面發生的事）');
    expect(next).toContain('4家 469\n5家 157（第 5 次，強制出發）\n任務 157：oox，1 張失敗 → 任務失敗');
    expect(next).toContain('0家 1460（第 5 次，強制出發）');
    expect(next).toContain('湖：0家 湖 4家，說好人（o）');
    expect(next).toContain('輪到你派 4 人（第 3 局第 4 次）。');
    // 只有出過失敗牌的任務有確定資訊（成功不代表全好），一行。
    expect(next).toContain('・確定：第 1 局 1 5 7 至少 1 紅');
    expect(next).not.toContain('全成功');
    expect(e.activeSessions()).toBe(1);

    const fb2 = (await say(e, '/派 1468')) ?? '';
    expect(fb2).toContain('① 實際這位 4家派：1468 20+（跟你一樣）→ 通過，任務 oooo');
    expect(fb2).toContain('② 同位置真人（第3局 忠臣，');
    expect(fb2).toContain('・區間：1 5 7 *1-3（第 1 局任務）｜2 3 6 8 9 0 *1-3');
    expect(fb2).toContain('・派票解讀：9家 4689 全換｜1家 1246 拆車（留 1 4 6）｜2家 1257 跟 9家 打對邊，回選 1，拆車（留 1）｜3家 3579 騎牆（挑 9家 的 9、2家 的 5 7），全換');
    // 0家 說你（好人）是好人：說實話的好人本來就會這樣說，不印。
    expect(fb2).not.toContain('湖讀法');
    expect(fb2.length).toBeLessThanOrEqual(900);

    const end = (await say(e, '/下一步')) ?? '';
    expect(end).not.toContain('（之後照實際對局進行'); // said once
    expect(end).toContain('湖：4家 湖 3家，說紅（x）（你看到的：紅）');
    expect(end).toContain('三藍：任務成功三次');
    expect(await say(e, '/派 123')).toContain('你在這局已經沒有下一次派票了');

    const reveal = (await say(e, '/公布')) ?? '';
    // 每一次 /派 都留著；角色附百科的代碼；從開局起每一次派票的隊長角色與隊上幾紅。
    expect(reveal.split('\n')).toEqual([
      '【W0000-4 公布】你是 4家・忠臣',
      '角色：梅林1 派西維爾2 莫德雷德3 莫甘娜5 刺客7 奧伯倫9；忠臣 4 6 8 0（刺7娜5莫3奧9派2梅1）',
      '紅：3 5 7 9',
      '你的派票：第 1 局 469：1 紅（9）✗、468：0 紅✓、469：1 紅（9）✗；第 3 局 1468：0 紅✓',
      '區間：789=2 ✓（紅 7 9）、460=1 ✗（0 紅）',
      '・真正的紅方不在你的區間留下的組合裡 ✗',
      '派票對答案（座位＋角色、隊伍、隊上幾紅）：',
      '第 1 局：1梅 460 全好、2派 279 2紅、3莫 370 2紅（含自己）、4忠 469 1紅、5娜 157 2紅（含自己）',
      '第 2 局：6忠 1246 全好、7刺 3579 4紅（含自己）、8忠 2468 全好、9奧 4689 1紅（含自己）、0忠 1460 全好',
      '第 3 局：1梅 1246 全好、2派 1257 2紅、3莫 3579 4紅（含自己）、4忠 1468 全好',
      '第 4 局：5娜 13579 4紅（含自己）、6忠 12468 全好',
      '這局結果：三藍死（刺 1家，刺中梅林）',
      '再來一題：/模擬',
    ]);
    expect(e.activeSessions()).toBe(0);
    expect(await say(e, '/公布')).toBe(NO_SESSION_TEXT);
    expect(e.counts).toMatchObject({
      started: { line: 1, discord: 0 }, answers: 4, sameAsReal: 3, intervals: 1, steps: 2, reveals: 1,
      intervalGroupsTotal: 2, intervalGroupsRight: 1, noSession: 1,
    });
    expect(e.counts.byRole.loyal).toBe(1);
  });

  it('wrong team size, usage, /派西 2, /結束', async () => {
    const e = engine();
    expect(await say(e, '/派 469')).toBe(NO_SESSION_TEXT);
    expect(await say(e, '/派西 2')).toBeNull(); // no session → plain chat
    await say(e, '/模擬 忠臣 4');
    expect(await say(e, '/派 46')).toContain('這次要派 3 人，你寫了 2 人。');
    expect(await say(e, '/派西 2')).toContain('用法：/派');
    expect(await say(e, '/區間 789=4')).toContain('只有 3 人');
    expect(await say(e, '/結束')).toBe('已結束 W0000-4（沒有公布）。再來一題：/模擬');
    expect(e.activeSessions()).toBe(0);
    expect(e.counts.ended).toBe(1);
  });

  it('a new /模擬 replaces the open one and says so in one line', async () => {
    const e = engine();
    await say(e, '/模擬 忠臣 4');
    const text = (await say(e, '/模擬 派西 2')) ?? '';
    expect(text.split('\n')[0]).toBe('（上一題 W0000-4 已結束，換這一題）');
    expect(e.activeSessions()).toBe(1);
  });

  it('one exercise per user per chat; a group event without userId shares one per chat', async () => {
    const e = engine();
    await say(e, '/模擬 忠臣 4', { platform: 'line', chatId: 'G1', userId: 'U1' });
    await say(e, '/模擬 忠臣 4', { platform: 'line', chatId: 'G1', userId: 'U2' });
    await say(e, '/模擬 忠臣 4', { platform: 'line', chatId: 'G2', userId: 'U1' });
    await say(e, '/模擬 忠臣 4', { platform: 'discord', chatId: 'G1', userId: 'U1' });
    expect(e.activeSessions()).toBe(4);
    await say(e, '/派 469', { platform: 'line', chatId: 'G1', userId: 'U1' });
    expect(await say(e, '/公布', { platform: 'line', chatId: 'G1', userId: 'U2' })).toContain('你這題沒有作答。');
    await say(e, '/模擬 忠臣 4', { platform: 'line', chatId: 'G3' });
    expect(await say(e, '/下一步', { platform: 'line', chatId: 'G3' })).toContain('下一步】');
  });
});

describe('lifetime, caps and rate limit', () => {
  it('30 idle minutes end the exercise (counted as expired); the next command says which one and how to restart', async () => {
    const e = engine({ ttlMs: 30 * MIN });
    await say(e, '/模擬 忠臣 4');
    clock.now += 29 * MIN;
    expect(await say(e, '/派 469')).toContain('你派 469');
    clock.now += 31 * MIN;
    expect(await say(e, '/下一步')).toBe(endedNoticeText('W0000-4', 'expired'));
    expect(endedNoticeText('W0000-4', 'expired')).toBe('你的模擬 W0000-4 已經結束（太久沒動作）。/模擬 題 W0000-4 從頭再做一次，或 /模擬 開新的一題');
    expect(e.counts.expired).toBe(1);
    // 沒有任何紀錄（例如伺服器重啟）時是一般的說明，講明會結束的原因。
    expect(await say(e, '/下一步', { platform: 'line', chatId: 'other', userId: 'U9' })).toBe(NO_SESSION_TEXT);
    expect(NO_SESSION_TEXT).toContain('伺服器重新啟動');
  });

  it('2 hours is the hard cap even when active', async () => {
    const e = engine({ ttlMs: 30 * MIN });
    await say(e, '/模擬 忠臣 4');
    for (let i = 0; i < 11; i++) {
      clock.now += 10 * MIN;
      expect(await say(e, '/區間 789=2')).toContain('區間】');
    }
    clock.now += 10 * MIN;
    expect(await say(e, '/區間 789=2')).toBe(endedNoticeText('W0000-4', 'expired'));
  });

  it('at most N sessions (least recently used goes) and at most M per chat', async () => {
    const e = engine({ maxSessions: 3, maxPerChat: 2 });
    for (const u of ['A', 'B', 'C']) await say(e, '/模擬 忠臣 4', { platform: 'line', chatId: `C-${u}`, userId: u });
    await say(e, '/區間 789=2', { platform: 'line', chatId: 'C-A', userId: 'A' }); // A is now the most recent
    await say(e, '/模擬 忠臣 4', { platform: 'line', chatId: 'C-D', userId: 'D' });
    expect(e.activeSessions()).toBe(3);
    expect(await say(e, '/下一步', { platform: 'line', chatId: 'C-B', userId: 'B' })).toBe(endedNoticeText('W0000-4', 'evicted'));
    expect(await say(e, '/下一步', { platform: 'line', chatId: 'C-A', userId: 'A' })).toContain('下一步】');

    const f = engine({ maxPerChat: 2 });
    for (const u of ['1', '2', '3']) await say(f, '/模擬 忠臣 4', { platform: 'discord', chatId: 'CH', userId: u });
    expect(f.activeSessions()).toBe(2);
    expect(await say(f, '/下一步', { platform: 'discord', chatId: 'CH', userId: '1' })).toContain('同時開的題目太多');
  });

  it('one person holds at most 2 open exercises across chats (one account cannot fill the global cap)', async () => {
    const e = engine();
    for (const ch of ['CH1', 'CH2', 'CH3', 'CH4']) await say(e, '/模擬 忠臣 4', { platform: 'discord', chatId: ch, userId: 'spam' });
    expect(e.activeSessions()).toBe(2);
    expect(await say(e, '/下一步', { platform: 'discord', chatId: 'CH1', userId: 'spam' })).toContain('同時開的題目太多');
    expect(await say(e, '/下一步', { platform: 'discord', chatId: 'CH4', userId: 'spam' })).toContain('下一步】');
    // 別人不受影響。
    await say(e, '/模擬 忠臣 4', { platform: 'discord', chatId: 'CH1', userId: 'other' });
    expect(e.activeSessions()).toBe(3);
  });

  it('rate limit: one notice, then silence, until the window passes', async () => {
    const e = engine({ rateLimit: { windowMs: 10 * MIN, max: 3 } });
    await say(e, '/模擬 忠臣 4');
    await say(e, '/區間 789=2');
    await say(e, '/區間 789=2');
    expect(await say(e, '/區間 789=2')).toBe(RATE_LIMITED_TEXT);
    expect(await say(e, '/區間 789=2')).toBeNull();
    expect(e.counts.rateLimited).toBe(2);
    clock.now += 11 * MIN;
    expect(await say(e, '/區間 789=2')).toContain('區間】');
  });

  it('the flag off → every 模擬 command is plain chat', async () => {
    SIM_CONFIG.commandsEnabled = false;
    expect(await say(engine(), '/模擬')).toBeNull();
  });
});

describe('commit after delivery, LINE redelivery', () => {
  it('nothing changes until commit(): a failed reply never skips a step', async () => {
    const e = engine();
    await say(e, '/模擬 忠臣 4');
    const lost = await e.handleText('/派 469', LINE_USER); // reply failed → no commit
    expect(lost?.text).toContain('你派 469');
    const lostStep = await e.handleText('/下一步', LINE_USER);
    expect(lostStep?.text).toContain('第 3 局第 4 次');
    expect(await say(e, '/公布')).toContain('你這題沒有作答。');
    expect(e.counts.answers).toBe(0);
    expect(e.counts.steps).toBe(0);
  });

  it('two /下一步 computed from the same state advance only once', async () => {
    const e = engine();
    await say(e, '/模擬 忠臣 4');
    const a = await e.handleText('/下一步', LINE_USER);
    const b = await e.handleText('/下一步', LINE_USER);
    a?.commit();
    b?.commit(); // stale: computed before a's commit → ignored
    expect(e.counts.steps).toBe(1);
    expect(await say(e, '/下一步')).toContain('三藍：任務成功三次');
  });

  it('withLock: a second command waits for the first one\'s reply and commit, so its reply matches the state', async () => {
    const e = engine();
    await say(e, '/模擬 忠臣 4');
    const order: string[] = [];
    const sendSlowly = (text: string, ms: number) => e.withLock(LINE_USER, async () => {
      const r = await e.handleText(text, LINE_USER);
      await new Promise((resolve) => setTimeout(resolve, ms)); // replyMessage in flight
      order.push(r?.text.split('\n')[0] ?? '');
      r?.commit();
      return r?.text ?? '';
    });
    const [propose, next] = await Promise.all([sendSlowly('/派 469', 30), sendSlowly('/下一步', 0)]);
    expect(propose).toContain('你派 469');
    expect(next).toContain('第 3 局第 4 次');
    expect(order).toEqual(['【W0000-4・4家忠臣】你派 469', '【W0000-4 下一步】（之後照實際對局進行，你的答案不改變後面發生的事）']);
    // 兩步都算數：現在在第 3 局的決定點。
    expect(await say(e, '/派 1468')).toContain('你派 1468');
    expect(e.counts).toMatchObject({ answers: 2, steps: 1 });
  });

  it('withLock never wedges a person: a stuck send is waited for at most lockWaitMs', async () => {
    const e = engine({ lockWaitMs: 20 });
    void e.withLock(LINE_USER, () => new Promise(() => undefined)); // never settles
    const t0 = Date.now();
    expect(await e.withLock(LINE_USER, async () => 'ran')).toBe('ran');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a LINE redelivery of an event whose reply already went out gets nothing (no second copy in the group)', async () => {
    const e = engine();
    const req = (eventKey: string, duplicate = false): SimRequest => ({ ...LINE_USER, eventKey, duplicate });
    await say(e, '/模擬 忠臣 4', req('e1'));
    await say(e, '/下一步', req('e2'));
    await say(e, '/區間 789=2', req('e3'));
    expect(await e.handleText('/下一步', req('e2', true))).toBeNull(); // an older event, out of order
    expect(await e.handleText('/模擬 忠臣 4', req('e1', true))).toBeNull();
    expect(e.counts.steps).toBe(1);
    // A redelivery whose first reply never went out (never committed) runs normally.
    const fresh = await e.handleText('/區間 789=2', req('e4', true));
    expect(fresh?.kind).toBe('interval');
  });

  it('Discord-style explicit commands: a malformed /派 without an exercise gets the usage, but only within the rate limit', async () => {
    const e = engine({ rateLimit: { windowMs: 10 * MIN, max: 1 } });
    const req: SimRequest = { platform: 'discord', chatId: 'CH', userId: 'u', explicit: true };
    const usage = { kind: 'usage', command: 'propose', problem: '同一個座位寫了兩次' } as const;
    expect((await e.handle(usage, req))?.text).toContain('用法：/派');
    expect((await e.handle(usage, req))?.text).toBe(RATE_LIMITED_TEXT);
    expect(await e.handle(usage, req)).toBeNull();
    expect(await e.handle(usage, req)).toBeNull();
    // LINE 打字（不是 explicit）沒有題目時當聊天。
    expect(await engine().handle(usage, LINE_USER)).toBeNull();
  });
});

describe('status', () => {
  it('only numbers and booleans; no ids, no text', async () => {
    const loader = new SimBankLoader(() => BANK);
    const e = new SimEngine({ bank: () => loader.get(), now: () => clock.now, random: () => () => 0 });
    __setSimForTests({ loader, engine: e });
    await say(e, '/模擬 忠臣 4', { platform: 'discord', chatId: 'CHAN-123', userId: 'USER-456' });
    await say(e, `/區間 789=2`, { platform: 'discord', chatId: 'CHAN-123', userId: 'USER-456' });
    const st = simulationStatus();
    expect(st).toMatchObject({
      enabled: true,
      weighsBehaviour: false,
      bank: { loaded: true, games: 26, dropped: 0, decisionPoints: 25 * 16 + 5 },
      sessions: { active: 1 },
    });
    const walk = (v: unknown, path: string): void => {
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
        return;
      }
      expect(['number', 'boolean'], path).toContain(typeof v);
    };
    walk(st, '');
    const json = JSON.stringify(st);
    for (const s of ['CHAN-123', 'USER-456', 'W0000', '789', ...FAKE_NAMES]) expect(json).not.toContain(s);
    __setSimForTests({ loader: null, engine: null });
  });
});
