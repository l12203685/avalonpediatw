/**
 * 模擬瓦（2026-10-14）— session 引擎：選題（角色／座位／題號、題目不夠）、一人一題、取代、
 * /派 /區間 /下一步 /公布 /結束 的轉移、期限（假時鐘）、上限與淘汰（一人跨聊天室最多 2 題、結束原因）、
 * 限流（slash 的用法也受限流）、送出後才 commit、同一個聊天室的指令排隊（withLock）、
 * LINE 重送已經回過的事件不再回（題目結束了也一樣，也不代答）、代答（只在 shared 的聊天室、只有寫對的指令、
 * 剛聽過結束說明時 /公布 /結束 不代答、代答的區間與派票怎麼寫）、沒有任何 log（更不會有使用者打的字）、
 * 狀態頁只有數字和布林。
 * 題庫是編的（fixtures/simGames.ts），沒有真實玩家。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimBankLoader } from '../bots/simulation/bank';
import { SIM_CONFIG } from '../bots/simulation/config';
import { __setSimForTests, simulationStatus } from '../bots/simulation';
import { parseSimCommand, type SimCommand } from '../bots/simulation/commands';
import {
  ANSWER_FOOTER,
  CO_ANSWER_MARK,
  NO_SESSION_TEXT,
  PROPOSE_USAGE,
  RATE_LIMITED_TEXT,
  SIM_HELP_TEXT,
  SIM_HELP_TEXT_DISCORD,
  endedNoticeText,
  sharedNote,
  simHelpText,
} from '../bots/simulation/replies';
import { SimEngine, type SimRequest } from '../bots/simulation/session';
import { FAKE_NAMES, fixtureBank, fixtureBankWithMid } from './fixtures/simGames';

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
    // 2026-11-16 精簡（Edward：重複的說明、例子不用打）：身分、牌譜、輪到你、一行指令。
    expect(text?.split('\n')).toEqual([
      '【模擬瓦 W0000-4】你是 4家・忠臣',
      '第 1 局：',
      '1家 460 1+',
      '2家 279',
      '3家 370',
      '輪到你派 3 人（第 1 局第 4 次）',
      '/派 座位 作答｜/區間｜/下一步｜/公布｜/結束｜/模擬 說明',
    ]);
  });
  it('identity lines per role', async () => {
    const e = engine();
    expect(await say(e, '/模擬 派西 2')).toContain('你是 2家・派西維爾，拇指 1 5\n');
    expect(await say(e, '/模擬 梅林 1')).toContain('你是 1家・梅林，看到的紅 5 7 9\n');
    expect(await say(e, '/模擬 莫德 3')).toContain('你是 3家・莫德雷德，隊友 5 7\n');
    expect(await say(e, '/模擬 娜 5')).toContain('你是 5家・莫甘娜，隊友 3 7\n');
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
    expect(text).toContain('輪到你派 4 人（第 2 局第 1 次）');
    expect(text).toContain('・確定的事：第 1 局任務隊 1 5 7 裡至少 1 紅');
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

describe('2-5 and 3-5 starts, linked games first (Edward 2026-11-16)', () => {
  const MID = fixtureBankWithMid();

  it('/模擬 3-5 starts at round 3, 5th proposal, as its leader; the full record so far and the known mission facts', async () => {
    const e = engine({ bank: async () => MID });
    const text = (await say(e, '/模擬 3-5')) ?? '';
    expect(text.split('\n')[0]).toBe('【模擬瓦 M0000-3-5】你是 5家・莫甘娜，隊友 3 7');
    expect(text).toContain('第 2 局：\n6家 1246');
    expect(text).toContain('0家 1450（第 5 次，強制出發）\n任務 1450：ooox，1 張失敗 → 任務失敗\n湖：0家 湖 4家，說好人（o）\n第 3 局：\n1家 1246');
    expect(text).toContain('輪到你派 4 人（第 3 局第 5 次，強制出發）');
    expect(text).toContain('・確定的事：第 2 局任務隊 1 4 5 0 裡至少 1 紅');
    expect(await say(e, '/派 1458')).toBe('【M0000-3-5】你派 1458：3 好 1 壞\n/分析 看完整解讀｜/下一步｜/公布');
    expect(await say(e, '/下一步')).toContain('三藍，接著刺殺');
    expect(await say(e, '/公布')).toContain('【M0000-3-5 公布】你是 5家・莫甘娜');
    expect(e.counts.midStarts).toBe(1);
  });

  it('3-5 only when the round-2 mission failed (藍紅 or 紅紅); /模擬 2-5 (+ role, + seat); ids 題庫-局-次', async () => {
    const e = engine({ bank: async () => MID });
    // W0000 has no round-3 5th proposal (and its round 2 succeeded); S0000 ended early: only the M games are in the 3-5 pool.
    expect(MID.midPool.get('3:morgana')?.length).toBe(3);
    expect([...MID.midPool.keys()].filter((k) => k.startsWith('3:'))).toEqual(['3:morgana']);
    expect(await say(e, '/模擬 3-5 梅林')).toBe('題庫裡沒有符合的3-5題目（3-5 只出第 2 局任務失敗的局），換個角色或座位試試。');
    expect(await say(e, '/模擬 2-5')).toContain('【模擬瓦 W0000-2-5】你是 0家・忠臣');
    expect(await say(e, '/模擬 2-5 忠臣 0')).toContain('輪到你派 4 人（第 2 局第 5 次，強制出發）');
    expect(await say(e, '/模擬 2-5 3')).toContain('沒有符合的2-5題目');
    expect(await say(e, '/模擬 題 m0002-3-5')).toContain('【模擬瓦 M0002-3-5】');
    expect(await say(e, '/模擬 題 S0000-2-5')).toBe('這一局沒有第 2 局第 5 次派票，換一題吧。');
    // An old id keeps meaning the seat's first decision.
    expect(await say(e, '/模擬 題 M0000-4')).toContain('輪到你派 3 人（第 1 局第 4 次）');
  });

  it('a random /模擬 (no seat) is occasionally a 2-5 or 3-5 (the high end of the roll); with a seat never', async () => {
    const roll = (x: number) => engine({ bank: async () => MID, random: () => () => x });
    expect(await say(roll(0), '/模擬')).toMatch(/【模擬瓦 [WSM]\d{4}-[2-5]】/u);
    expect(await say(roll(0.75), '/模擬')).toMatch(/-2-5】/u);
    expect(await say(roll(0.95), '/模擬')).toMatch(/-3-5】/u);
    expect(await say(roll(0.95), '/模擬 4')).toMatch(/-4】/u);
    // No 3-5 for this role: falls back to the usual first decision.
    expect(await say(roll(0.95), '/模擬 忠臣')).toMatch(/-[2-5]】你是 \d家・忠臣/u);
  });

  it('/模擬 1-5, 4-5, 5局: the tail of that round or any round-5 proposal; 4-5 says so when none fits', async () => {
    const e = engine({ bank: async () => MID });
    const one = (await say(e, '/模擬 1-5')) ?? '';
    expect(one.split('\n')[0]).toBe('【模擬瓦 W0000-1-5】你是 5家・莫甘娜，隊友 3 7');
    expect(one).toContain('輪到你派 3 人（第 1 局第 5 次，強制出發）');
    expect(await say(e, '/模擬 4-5')).toBe('題庫裡沒有符合的4-5題目，換個角色或座位試試。');
    const five = (await say(e, '/模擬 5局')) ?? '';
    expect(five).toContain('【模擬瓦 M0000-5-1】你是 7家・刺客，隊友 3 5');
    expect(five).toContain('輪到你派 5 人（第 5 局第 1 次）');
    expect(five).toContain('・確定的事：第 2 局任務隊 1 4 5 0 裡至少 1 紅；第 3 局任務隊 1 4 5 8 裡至少 1 紅');
    expect(await say(e, '/派 12468')).toBe('【M0000-5-1】你派 12468：5 好 0 壞\n/分析 看完整解讀｜/下一步｜/公布');
  });

  it('刺殺: you are the assassin, see the whole record; only /刺 /公布 /結束; teammates refused; 公布 says hit/miss, Merlin and the real pick', async () => {
    const e = engine({ bank: async () => MID });
    const start = (await say(e, '/模擬 刺殺')) ?? '';
    expect(start.split('\n')[0]).toBe('【模擬瓦 W0000-A】你是 7家・刺客，隊友 3 5');
    expect(start).toContain('第 4 局：\n5家 13579\n6家 12468 0+ → 出發\n任務 12468：ooooo，任務成功');
    expect(start.split('\n').slice(-2)).toEqual(['三藍：輪到你刺殺（刺中梅林紅方獲勝）', '/刺 座位 作答｜/公布｜/結束｜/模擬 說明']);
    for (const t of ['/派 123', '/分析', '/下一步', '/區間 12=1']) expect(await say(e, t)).toBe('W0000-A 是刺殺題：用 /刺 座位 作答，/公布 看結果');
    expect(await say(e, '/刺 3')).toBe('3家 是你的隊友，換一個座位。');
    expect(await say(e, '/刺 7')).toBe('你就是刺客，換一個座位。');
    expect(await say(e, '/刺 2')).toBe('【W0000-A】你刺 2家（可以再刺一次改答案）\n/公布 看結果｜/結束');
    const miss = (await say(e, '/公布')) ?? '';
    expect(miss).toContain('你刺 2家：沒刺中 ✗（梅林 1家）');
    expect(miss).toContain('當時真人刺 1家（刺中）');
    expect(miss).not.toContain('結果：');
    await say(e, '/模擬 題 W0001-A');
    await say(e, '/刺 2');
    await say(e, '/刺 1'); // the last one counts
    expect(await say(e, '/公布')).toContain('你刺 1家：刺中梅林 ✓');
    await say(e, '/模擬 題 W0002-A');
    expect(await say(e, '/公布')).toContain('你沒有刺（梅林 1家）');
    // /刺 on a proposal exercise; a game without an assassination.
    await say(e, '/模擬 忠臣 4');
    expect(await say(e, '/刺 1')).toBe('W0000-4 不是刺殺題：用 /派 座位 作答（刺殺題：/模擬 刺殺）');
    expect(await say(e, '/模擬 題 S0000-A')).toContain('【模擬瓦 S0000-A】'); // S0000 is 三藍活 with a kill on 6
    expect(e.counts).toMatchObject({ assassinStarts: 4, kills: 3 });
  });

  it('a co-answered /刺 is marked; /公布 tags it', async () => {
    const e = engine({ bank: async () => MID });
    await say(e, '/模擬 刺殺', G('A'));
    expect(await say(e, '/刺 2', G('B'))).toBe(`${CO_ANSWER_MARK}\n【W0000-A】你刺 2家（可以再刺一次改答案）\n/公布 看結果｜/結束`);
    expect(await say(e, '/公布', G('A'))).toContain('這題刺 2家（代答）：沒刺中 ✗（梅林 1家）');
  });

  it('/模擬 今天 follows the Threads week (Taipei date): 日 第五局、一 刺殺、二 派西（第 2 局起）、三 1-5、四 1-5 接 3-5、五 2-5、六 2-5（沒有接 4-5 的局）', async () => {
    const at = (iso: string) => engine({ bank: async () => MID, now: () => Date.parse(iso) });
    // 2026-11-16 is a Monday. 23:30 UTC on Sunday is already Monday in Taipei.
    const cases: [string, RegExp, string][] = [
      ['2026-11-15T04:00:00Z', /-5-1】/u, '（今天週日：第五局決策（派 5 人））'],
      ['2026-11-15T23:30:00Z', /-A】你是 7家・刺客/u, '（今天週一：刺殺梅林）'],
      ['2026-11-17T04:00:00Z', /-[2-5]-\d】你是 2家・派西維爾/u, '（今天週二：派西維爾思考）'],
      ['2026-11-18T04:00:00Z', /-1-5】/u, '（今天週三：1-5 尾派（派 3 人））'],
      ['2026-11-19T04:00:00Z', /M0000-1-5】/u, '（今天週四：1-5 接到 3-5 尾派（/下一步 會走到 3-5，派 4 人））'],
      ['2026-11-20T04:00:00Z', /-2-5】/u, '（今天週五：2-5 尾派）'],
      ['2026-11-21T04:00:00Z', /-2-5】/u, '（今天週六：2-5 尾派）'],
    ];
    for (const [iso, id, theme] of cases) {
      const e = at(iso);
      const text = (await say(e, '/模擬 今天')) ?? '';
      expect(text, iso).toMatch(id);
      expect(text.split('\n')[1], iso).toBe(theme);
      expect(e.counts.todayStarts).toBe(1);
    }
    // 週四: the next /下一步 lands on that seat's 3-5.
    const thu = at('2026-11-19T04:00:00Z');
    await say(thu, '/模擬 今天');
    expect(await say(thu, '/下一步')).toContain('輪到你派 4 人（第 3 局第 5 次，強制出發）');
  });

  it('with a records index, random picks prefer games that have a site page; an explicit id still works for any game', async () => {
    const linked = { ...BANK, records: new Map([[BANK.byId.get('W0003') as number, 'S9ABC']]) };
    const e = engine({ bank: async () => linked });
    expect(await say(e, '/模擬 忠臣 4')).toContain('【模擬瓦 W0003-4】');
    expect(await say(e, '/模擬 派西 2')).toContain('【模擬瓦 W0003-2】');
    expect(await say(e, '/模擬 題 W0001-4')).toContain('【模擬瓦 W0001-4】');
    // Ids are opaque (a sheet-only game may get a non-numeric id): the link carries it as-is.
    await say(e, '/模擬 題 W0003-4');
    expect(await say(e, '/公布')).toContain('完整牌譜：https://avalon-game-platform.web.app/#records=S9ABC');
  });
});

describe('a whole exercise', () => {
  it('/派 answers 幾好幾壞, /分析 the full reading, /區間, /下一步 to the next decision, then /公布 ends it', async () => {
    const e = engine();
    await say(e, '/模擬 忠臣 4');
    // 2026-11-16（Edward：「/派 之後直接顯示結果就好（派到幾好幾壞這樣）」）。
    expect((await say(e, '/派 469'))?.split('\n')).toEqual(['【W0000-4】你派 469：2 好 1 壞', '/分析 看完整解讀｜/下一步｜/公布']);
    // /分析 = 這個決定點最後一次 /派 的完整解讀：④ 先講你等於在否定誰，兩兩合讀只留「只剩紅」「不能都對」，
    // 沒有補集的廢話（「4 6 9 是好人，其他 7 人有 4 紅」），術語不在回覆裡括號解釋。
    const fb = (await say(e, '/分析')) ?? '';
    expect(fb.split('\n')).toEqual([
      '【W0000-4 分析】你派 469',
      '① 真人：4家 派 469（跟你一樣）→ 被否決',
      '④ 你放出的資訊：等於在說 3家 的派票不是好人派的',
      '・跟 1家 460：延伸（4 6）',
      '・跟 2家 279：部分（9）',
      '・跟 3家 370：打對邊 → 都對時只剩紅 1258',
      '・對照：改派 468 跟 2家 279 打對邊 → 都對時只剩紅 1350',
      '③ 邏輯（只用確定資訊）：紅方剩 126 種組合',
      '・派票解讀：2家 279 跟 1家 打對邊｜3家 370 騎牆（挑 1家 的 0、2家 的 7）',
      '・不能都對：1家＋2家（加起來 7 人＞6）→ 1家、2家 至少一個錯',
      '・兩個都對時：1家＋3家 只剩紅 2589；2家＋3家 只剩紅 1568',
      '② 同位置真人（第 1 局 4家忠臣，24 次，樣本少）：派自己 100%（你：有）',
      '　跟上一次 3家 370 重疊 0 人 100%（你 0 人）',
      '/派 再派一次比較｜/下一步｜/公布',
    ]);
    expect(fb).not.toMatch(/有 4 紅|把隊長和隊員全當好人|完全沒有一樣的人/u);
    // 再派一次：/分析 看的是最後一次。
    expect(await say(e, '/派 468')).toBe('【W0000-4】你派 468：3 好 0 壞\n/分析 看完整解讀｜/下一步｜/公布');
    const again = (await say(e, '/分析')) ?? '';
    expect(again).toContain('【W0000-4 分析】你派 468');
    expect(again).toContain('・跟 2家 279：打對邊 → 都對時只剩紅 1350');
    expect(again).toContain('・跟 3家 370：打對邊 → 都對時只剩紅 1259');

    const iv = (await say(e, '/區間 789=2 460=1')) ?? '';
    expect(iv.split('\n')).toEqual([
      '【W0000-4 區間】沒有矛盾，126 種縮到 24 種',
      '・789=2：可能（45/126 種）',
      '・460=1：扣掉你等於 60=1，可能（70/126 種）',
      '/派｜/下一步｜/公布',
    ]);
    // /分析 的最後檢查：照你的區間，469 全好有幾種。
    await say(e, '/派 469');
    expect(await say(e, '/分析')).toContain('・照你寫的區間（24 種）：469 全好 4 種（17%）');

    const next = (await say(e, '/下一步')) ?? '';
    expect(next).not.toContain('（之後照實際對局進行');
    expect(next).toContain('4家 469\n5家 157（第 5 次，強制出發）\n任務 157：oox，1 張失敗 → 任務失敗');
    expect(next).toContain('0家 1460（第 5 次，強制出發）');
    expect(next).toContain('湖：0家 湖 4家，說好人（o）');
    expect(next).toContain('輪到你派 4 人（第 3 局第 4 次）');
    // 只有出過失敗牌的任務有確定資訊（成功不代表全好），一行。
    expect(next).toContain('・確定的事：第 1 局任務隊 1 5 7 裡至少 1 紅');
    expect(next).not.toContain('例：');
    expect(next.split('\n').at(-1)).toBe(ANSWER_FOOTER);
    expect(e.activeSessions()).toBe(1);

    expect(await say(e, '/派 1468')).toContain('你派 1468：4 好 0 壞');
    const fb2 = (await say(e, '/分析')) ?? '';
    expect(fb2).toContain('① 真人：4家 派 1468，隊外 2 0家 投贊成（跟你一樣）→ 通過出發，任務牌 oooo');
    expect(fb2).toContain('② 同位置真人（第 3 局 忠臣，');
    expect(fb2).toContain('・區間：1 5 7 有 1-3 紅（第 1 局任務）｜2 3 6 8 9 0 有 1-3 紅');
    expect(fb2).toContain('・2家 1257 不可能全好：跟任務結果矛盾');
    expect(fb2).toContain('・派票解讀：9家 4689 全換｜1家 1246 拆車（留 1 4 6）｜2家 1257 跟 9家 打對邊，回選 1，拆車（留 1）｜3家 3579 騎牆（挑 9家 的 9、2家 的 5 7），全換');
    expect(fb2).toContain('；跟 3家 是打對邊');
    // 0家 說你（好人）是好人：說實話的好人本來就會這樣說，不印。
    expect(fb2).not.toContain('湖讀法');

    const end = (await say(e, '/下一步')) ?? '';
    expect(end).toContain('湖：4家 湖 3家，說紅（x）（你看到的：紅）');
    expect(end).toContain('三藍，接著刺殺（結果看 /公布）。');
    expect(await say(e, '/派 123')).toContain('你在這局已經沒有下一次派票了');

    const reveal = (await say(e, '/公布')) ?? '';
    // 每一次 /派 都留著（幾好幾壞）；角色是百科的代碼；fixture 的局在網站上沒有那一篇 → 附文字牌譜。
    expect(reveal.split('\n')).toEqual([
      '【W0000-4 公布】你是 4家・忠臣',
      '刺7娜5莫3奧9派2梅1（紅 3 5 7 9）',
      '你的派票：第 1 局 469 2 好 1 壞✗、468 3 好 0 壞✓、469 2 好 1 壞✗；第 3 局 1468 4 好 0 壞✓',
      '區間：789=2 ✓、460=1 ✗；真正的紅方不在你的區間留下的組合裡 ✗',
      '結果：三藍死（刺 1家，刺中梅林）',
      '完整牌譜（網站上沒有這一局）：',
      '460 1+', '279', '370', '469', '157', 'oox',
      '1246', '3579', '2468', '4689', '1460', 'oooo', '0>4 o',
      '1246', '1257', '3579', '1468 20+', 'oooo', '4>3 x',
      '13579', '12468 0+', 'ooooo',
      '/模擬 再來一題',
    ]);
    expect(e.activeSessions()).toBe(0);
    expect(await say(e, '/公布')).toBe(NO_SESSION_TEXT);
    expect(e.counts).toMatchObject({
      started: { line: 1, discord: 0 }, answers: 4, sameAsReal: 3, analyses: 4, intervals: 1, steps: 2, reveals: 1,
      intervalGroupsTotal: 2, intervalGroupsRight: 1, noSession: 1,
    });
    expect(e.counts.byRole.loyal).toBe(1);
  });

  it('/公布 links the site 牌譜 page when the bank game has one (records index)', async () => {
    const linked = { ...BANK, records: new Map([[BANK.byId.get('W0000') as number, '1397438863340998720']]) };
    const e = engine({ bank: async () => linked });
    await say(e, '/模擬 忠臣 4');
    const reveal = (await say(e, '/公布')) ?? '';
    expect(reveal).toContain('完整牌譜：https://avalon-game-platform.web.app/#records=1397438863340998720');
    expect(reveal).not.toContain('網站上沒有這一局');
    expect(reveal).not.toContain('460 1+');
  });

  it('/分析 before any /派 says so in one line; /派 replies stay a two-line result', async () => {
    const e = engine();
    await say(e, '/模擬 忠臣 4');
    expect(await say(e, '/分析')).toBe('W0000-4：這一次還沒 /派，先派再 /分析');
    await say(e, '/派 469');
    await say(e, '/下一步');
    // 新的決定點還沒派：一樣說還沒派（不拿上一次的答案）。
    expect(await say(e, '/分析')).toBe('W0000-4：這一次還沒 /派，先派再 /分析');
  });
  it('every /派 reply is the two-line result; every /分析 keeps its sections, no gloss explanations, no marker leaks', async () => {
    const e = engine({ rateLimit: { windowMs: 1, max: 1_000_000 } });
    const sayN = (text: string): Promise<string | null> => say(e, text, { platform: 'line', chatId: 'cap', userId: 'cap', shared: true });
    const markers = new RegExp(`[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xe002)}]`, 'u');
    let proposals = 0;
    for (const id of ['W0000', 'S0000']) {
      for (let seat = 1; seat <= 10; seat++) {
        const start = (await sayN(`/模擬 題 ${id}-${seat}`)) ?? '';
        if (!start.includes('【模擬瓦')) continue; // a seat without a decision in that game
        expect(start.split('\n').slice(-2)).toEqual([ANSWER_FOOTER, sharedNote('line')]); // the group line last, only here
        expect(start).not.toMatch(/例：|怎麼讀/u);
        let prompt = start;
        while (/輪到你派 (\d) 人/u.test(prompt)) {
          const size = Number(/輪到你派 (\d) 人/u.exec(prompt)?.[1]);
          const team = [1, 2, 3, 4, 5].slice(0, size).map((s) => (s === seat ? 6 : s)).join('');
          const fb = (await sayN(`/派 ${team}`)) ?? '';
          proposals++;
          expect(fb, `${id}-${seat}`).toMatch(new RegExp(`^【${id}-${seat === 10 ? 0 : seat}】你派 \\d+：\\d 好 \\d 壞\\n/分析 看完整解讀｜/下一步｜/公布$`, 'u'));
          expect(fb).not.toContain(sharedNote('line'));
          const an = (await sayN('/分析')) ?? '';
          expect(an.length, `${id}-${seat}`).toBeLessThanOrEqual(1800);
          expect(an).not.toMatch(markers);
          for (const head of ['①', '④', '③ 邏輯', '② 同位置真人', '/派 再派一次比較']) expect(an, `${id}-${seat} ${head}`).toContain(head);
          for (const say1 of ['把隊長和隊員全當好人', '有 2 人以上一樣', '只有 1 人一樣', '完全沒有一樣的人', '兩邊各挑了人', '把前面的隊長派進隊裡', '哪幾個座位裡有幾個紅', '兩次派票的人全是好人', '兩次派票不可能同時全是好人', '紅方就只能是這幾個']) {
            expect(an, `${id}-${seat} ${say1}`).not.toContain(say1);
          }
          prompt = (await sayN('/下一步')) ?? '';
        }
        await sayN('/結束');
      }
    }
    expect(proposals).toBeGreaterThanOrEqual(15);
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

/** A LINE group: everyone sees the replies, so co-answering is on (`shared`). */
const G = (userId: string, extra: Partial<SimRequest> = {}): SimRequest => ({ platform: 'line', chatId: 'G', userId, shared: true, ...extra });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('help and co-answering (2026-10-22, first real players)', () => {
  it('/模擬 說明 (幫助、指令、?) lists every command in one plain line each, with or without an open exercise', async () => {
    const e = engine();
    expect(await say(e, '/模擬 說明')).toBe(SIM_HELP_TEXT);
    expect(e.activeSessions()).toBe(0);
    await say(e, '/模擬 忠臣 4');
    for (const t of ['/模擬 幫助', '/模擬 指令', '/模擬 ?', '／模擬　？']) expect(await say(e, t)).toBe(SIM_HELP_TEXT);
    expect(e.activeSessions()).toBe(1); // help never touches the exercise
    expect(e.counts.help).toBe(5);
    for (const cmd of ['/模擬', '/派 469', '/區間 789=2 460=1', '/下一步', '/公布', '/解答', '/結束', '/模擬 說明', '代答']) expect(SIM_HELP_TEXT).toContain(cmd);
    // 2026-11-16：術語和牌譜讀法從回覆裡移到這裡（回覆不再括號解釋），說明變長一點。
    expect(SIM_HELP_TEXT.length).toBeLessThanOrEqual(1100);
    for (const cmd of ['/分析', '/模擬 1-5～4-5', '/模擬 5局', '/模擬 刺殺', '/刺 3', '/模擬 今天', '術語：', '牌譜：']) expect(SIM_HELP_TEXT).toContain(cmd);
  });

  it('Discord gets the help in the slash UI\'s own words (option names, no /解答); LINE gets the typed form', async () => {
    const e = engine();
    const discord = (await e.handle({ kind: 'help' }, { platform: 'discord', chatId: 'CH', userId: 'u', explicit: true }))?.text ?? '';
    expect(discord).toBe(SIM_HELP_TEXT_DISCORD);
    expect(simHelpText('discord')).toBe(SIM_HELP_TEXT_DISCORD);
    expect(simHelpText('line')).toBe(SIM_HELP_TEXT);
    for (const form of ['/模擬 角色:派西維爾 座位:2', '/模擬 題號:K7Q2M-4', '/派 隊伍:469', '/區間 內容:789=2 460=1', '/下一步', '/公布', '/結束', '/模擬 說明:True', '代答']) {
      expect(discord).toContain(form);
    }
    for (const form of ['/分析', '/模擬 局面:3-5', '局面:刺殺', '/刺 座位:3', '局面:今天']) expect(discord).toContain(form);
    for (const lineOnly of ['/解答', '/模擬 題 ', '/派 469　', '/模擬 說明　']) expect(discord).not.toContain(lineOnly);
    expect(discord.length).toBeLessThanOrEqual(1100);
  });

  it('a member without an exercise answers the newest open one in a group; marked 代答, names nobody; the owner is told on start only', async () => {
    const e = engine();
    const [A, B, C] = [G('A'), G('B'), G('C')];
    const start = (await say(e, '/模擬 忠臣 4', A)) ?? '';
    // (2) one line: others may help, and /公布 or /結束 ends the exercise for everyone.
    expect(start.split('\n').at(-1)).toBe(sharedNote('line'));
    expect(sharedNote('line')).toBe('群組裡沒開題的人也能幫忙答；誰打 /公布 或 /結束 都會結束這題');
    // 2026-11-16：群組代答的提醒只在開題講一次；/派 只回幾好幾壞。
    const fb = (await say(e, '/派 468', B)) ?? '';
    expect(fb.split('\n')).toEqual([CO_ANSWER_MARK, '【W0000-4】你派 468：3 好 0 壞', '/分析 看完整解讀｜/下一步｜/公布']);
    expect(fb).not.toMatch(/[ABC]\b/u);
    expect((await say(e, '/分析', B)) ?? '').toMatch(/^（代答：[^\n]*\n【W0000-4 分析】你派 468/u);
    expect((await say(e, '/區間 789=2', B)) ?? '').toMatch(/^（代答：[^\n]*\n【W0000-4 區間】/u);
    expect((await say(e, '/下一步', C)) ?? '').toMatch(/^（代答：[^\n]*\n【W0000-4 下一步】/u);
    // The shared exercise really advanced, for its owner too (no 代答 mark on the owner's own reply).
    expect(((await say(e, '/派 1468', A)) ?? '').startsWith('【W0000-4】你派 1468：4 好 0 壞')).toBe(true);
    const own = (await say(e, '/分析', A)) ?? '';
    expect(own.startsWith('【W0000-4 分析】你派 1468')).toBe(true);
    // (1) B wrote the 區間: the owner is not told 「你寫的」.
    expect(own).toContain('・照這題目前的區間（39 種）');
    expect(own).not.toContain('你寫的區間');
    // A wrong-sized /派 is well-formed: it co-answers with the size hint, marked too.
    expect(await say(e, '/派 12', B)).toBe(`${CO_ANSWER_MARK}\n這次要派 4 人，你寫了 2 人。\n${PROPOSE_USAGE}`);
    // (3) /公布 by a co-answerer ends the exercise; answers given by co-answerers are marked 「（代答）」, the 區間 too.
    const reveal = (await say(e, '/公布', C)) ?? '';
    expect(reveal.split('\n')[0]).toBe(CO_ANSWER_MARK);
    expect(reveal).toContain('這題的派票：第 1 局 468（代答） 3 好 0 壞✓；第 3 局 1468 4 好 0 壞✓');
    expect(reveal).toContain('區間（代答）：789=2 ✓；真正的紅方在這題目前的區間留下的 45 種裡 ✓');
    expect(e.activeSessions()).toBe(0);
    expect(await say(e, '/派 469', A)).toBe(NO_SESSION_TEXT);
    expect(e.counts).toMatchObject({ coAnswers: 6, answers: 2, analyses: 2, intervals: 1, steps: 1, reveals: 1, usage: 1 });
  });

  it('the owner\'s own 區間 stays 「你寫的」 for the owner, and is 「這題目前的區間」 in a co-answer; the owner\'s own answers carry no tag', async () => {
    const e = engine();
    await say(e, '/模擬 忠臣 4', G('A'));
    await say(e, '/區間 789=2 460=1', G('A'));
    await say(e, '/派 469', G('B'));
    expect(await say(e, '/分析', G('B'))).toMatch(/・照這題目前的區間（24 種）/u);
    await say(e, '/派 468', G('A'));
    expect(await say(e, '/分析', G('A'))).toMatch(/・照你寫的區間（24 種）/u);
    const reveal = (await say(e, '/公布', G('A'))) ?? '';
    expect(reveal).toContain('這題的派票：469（代答） 2 好 1 壞✗、468 3 好 0 壞✓');
    expect(reveal).toContain('區間：789=2 ✓、460=1 ✗；真正的紅方不在你的區間留下的組合裡 ✗');
  });

  it('a co-answerer\'s /公布 does not tag the owner\'s own 區間 as 代答, but words it 「這題目前的區間」', async () => {
    const e = engine();
    await say(e, '/模擬 忠臣 4', G('A'));
    await say(e, '/區間 789=2 460=1', G('A'));
    const reveal = (await say(e, '/公布', G('B'))) ?? '';
    expect(reveal.split('\n')[0]).toBe(CO_ANSWER_MARK);
    expect(reveal).toContain('區間：789=2 ✓、460=1 ✗；真正的紅方不在這題目前的區間留下的組合裡 ✗');
    expect(reveal).not.toContain('區間（代答）');
  });

  it('co-answering only where everyone sees the replies: never without `shared` (1:1 chats, Discord channels whose replies are only-you)', async () => {
    const e = engine();
    await say(e, '/模擬 忠臣 4', G('A'));
    for (const t of ['/派 469', '/區間 789=2', '/下一步', '/公布', '/結束']) {
      expect(await say(e, t, { platform: 'line', chatId: 'G', userId: 'B' })).toBe(NO_SESSION_TEXT);
      expect(e.answersFollowUp({ platform: 'line', chatId: 'G', userId: 'B' }, parseSimCommand(t) as SimCommand)).toBe(false);
    }
    expect(e.activeSessions()).toBe(1);
    expect(await say(e, '/公布', G('A'))).toContain('你這題沒有作答。');
    // A start outside a group says nothing about co-answering.
    expect(await say(e, '/模擬 忠臣 4', LINE_USER)).not.toContain('幫忙答');
    expect(await say(e, '/派 469', LINE_USER)).not.toContain('幫忙答');
  });

  it('only well-formed follow-ups co-answer: a malformed /派 or /區間 from a member without an exercise gets nothing, is not hidden, and does not keep the owner\'s exercise alive', async () => {
    const e = engine({ ttlMs: 30 * MIN });
    await say(e, '/模擬 忠臣 4', G('A'));
    expect(e.answersFollowUp(G('A'), parseSimCommand('/派西 2') as SimCommand)).toBe(true); // the owner's own: as before
    clock.now += 20 * MIN;
    for (const t of ['/派西 2', '/區間 12=1 我覺得', '/派 4 4 6', '/區間 789=9']) {
      expect(parseSimCommand(t)?.kind).toBe('usage');
      expect(await say(e, t, G('B'))).toBeNull();
      expect(e.answersFollowUp(G('B'), parseSimCommand(t) as SimCommand)).toBe(false);
    }
    expect(e.answersFollowUp(G('B'), parseSimCommand('/派 469') as SimCommand)).toBe(true);
    clock.now += 15 * MIN; // 35 minutes after the owner's last command
    expect(await say(e, '/下一步', G('A'))).toBe(endedNoticeText('W0000-4', 'expired'));
    expect(e.counts).toMatchObject({ coAnswers: 0, usage: 0 });
  });

  it('a member with their own exercise keeps acting on it; the newest exercise in the chat is the one co-answered; other chats are separate', async () => {
    const e = engine();
    const [A, B, C] = [G('A'), G('B'), G('C')];
    await say(e, '/模擬 忠臣 4', A);
    await say(e, '/模擬 派西 2', B);
    expect((await say(e, '/派 469', A)) ?? '').toMatch(/^【W0000-4】你派 469/u);
    expect((await say(e, '/派 279', B)) ?? '').toMatch(/^【W0000-2】你派 279/u);
    // C has none: the newest (B's) is answered. A's is untouched.
    expect((await say(e, '/派 279', C)) ?? '').toMatch(/^（代答：[^\n]*\n【W0000-2】你派 279/u);
    expect(await say(e, '/公布', C)).toContain('這題的派票：279 1 好 2 壞✗、279（代答） 1 好 2 壞✗');
    expect((await say(e, '/下一步', C)) ?? '').toMatch(/^（代答：[^\n]*\n【W0000-4 下一步】/u); // now A's is the newest
    expect(await say(e, '/下一步', G('C', { chatId: 'other' }))).toBe(NO_SESSION_TEXT);
    expect(await say(e, '/結束', C)).toBe(`${CO_ANSWER_MARK}\n已結束 W0000-4（沒有公布）。再來一題：/模擬`);
    expect(e.activeSessions()).toBe(0);
  });

  it('an exercise that expired or was evicted is explained to its owner once; the next follow-up co-answers', async () => {
    const e = engine({ maxPerChat: 1 });
    const [A, B] = [G('A'), G('B')];
    await say(e, '/模擬 忠臣 4', A);
    await say(e, '/模擬 派西 2', B); // A's is evicted (one per chat)
    expect(await say(e, '/派 279', A)).toBe(endedNoticeText('W0000-4', 'evicted'));
    expect((await say(e, '/派 279', A)) ?? '').toMatch(/^（代答：[^\n]*\n【W0000-2】你派 279/u);
    // With nobody else's exercise in the chat the notice keeps coming (unchanged behaviour).
    await say(e, '/結束', B);
    await say(e, '/模擬 忠臣 4', A);
    await say(e, '/模擬 派西 2', B);
    await say(e, '/結束', B);
    expect(await say(e, '/派 469', A)).toBe(endedNoticeText('W0000-4', 'evicted'));
    expect(await say(e, '/派 469', A)).toBe(endedNoticeText('W0000-4', 'evicted'));
  });

  it('right after that notice, /公布 and /結束 never act on someone else\'s exercise; another command first, then they co-answer', async () => {
    const e = engine({ maxPerChat: 1 });
    const [A, B] = [G('A'), G('B')];
    await say(e, '/模擬 忠臣 4', A);
    await say(e, '/模擬 派西 2', B); // A's is evicted
    expect(await say(e, '/公布', A)).toBe(endedNoticeText('W0000-4', 'evicted'));
    expect(await say(e, '/公布', A)).toBe(NO_SESSION_TEXT);
    expect(await say(e, '/結束', A)).toBe(NO_SESSION_TEXT);
    expect(await say(e, '/公布', A)).toBe(NO_SESSION_TEXT);
    expect(e.activeSessions()).toBe(1); // B's is still open
    expect((await say(e, '/下一步', A)) ?? '').toMatch(/^（代答：[^\n]*\n【W0000-2 下一步】/u);
    expect(await say(e, '/結束', A)).toBe(`${CO_ANSWER_MARK}\n已結束 W0000-2（沒有公布）。再來一題：/模擬`);
  });

  it('a LINE redelivery is never re-targeted: an /結束 or /公布 that already went out is remembered after its exercise is gone, and a redelivery never co-answers', async () => {
    const e = engine();
    const ev = (r: SimRequest, eventKey: string, duplicate = false): SimRequest => ({ ...r, eventKey, duplicate });
    await say(e, '/模擬 忠臣 4', ev(G('A'), 'a1'));
    await say(e, '/模擬 派西 2', ev(G('B'), 'b1'));
    expect(await say(e, '/結束', ev(G('A'), 'a2'))).toBe('已結束 W0000-4（沒有公布）。再來一題：/模擬');
    // The owner's /結束 redelivered: nothing, and B's exercise (the newest in the chat) is not ended.
    expect(await e.handleText('/結束', ev(G('A'), 'a2', true))).toBeNull();
    expect(e.activeSessions()).toBe(1);
    // B reveals; a new exercise starts; B's /公布 redelivered does not reveal the new one.
    expect(await say(e, '/公布', ev(G('B'), 'b2'))).toContain('【W0000-2 公布】');
    await say(e, '/模擬 梅林 1', ev(G('C'), 'c1'));
    expect(await e.handleText('/公布', ev(G('B'), 'b2', true))).toBeNull();
    // A co-answer that went out is not repeated on another exercise.
    expect(await say(e, '/下一步', ev(G('D'), 'd1'))).toMatch(/^（代答：[^\n]*\n【W0000-1 下一步】/u);
    await say(e, '/模擬 忠臣 4', ev(G('A'), 'a3')); // now A's is the newest
    expect(await e.handleText('/下一步', ev(G('D'), 'd1', true))).toBeNull();
    // A redelivery whose first copy never went out does not co-answer (it may have been meant for another exercise).
    expect(await e.handleText('/派 469', ev(G('D'), 'd2', true))).toBeNull();
    expect(await e.handleText('/公布', ev(G('D'), 'd3', true))).toBeNull();
    expect(e.counts).toMatchObject({ ended: 1, reveals: 1, steps: 1, answers: 0, coAnswers: 1 });
    expect(e.activeSessions()).toBe(2);
  });

  it('commands of one chat run one at a time: a co-answer queued behind an /結束 acts on the exercise that is newest when its turn comes, and every commit lands', async () => {
    const e = engine();
    const [A, B, C] = [G('A'), G('B'), G('C')];
    await say(e, '/模擬 忠臣 4', A);
    await say(e, '/模擬 派西 2', B); // the newest
    const order: string[] = [];
    const slow = (req: SimRequest, text: string, ms: number): Promise<string> => e.withLock(req, async () => {
      const r = await e.handleText(text, req);
      await sleep(ms); // replyMessage in flight
      order.push(`${req.userId}:${r?.kind}`);
      r?.commit();
      return r?.text ?? '';
    });
    const [, co] = await Promise.all([slow(B, '/結束', 30), slow(C, '/派 469', 0), slow(A, '/區間 789=2', 20), slow(C, '/下一步', 0)]);
    expect(order).toEqual(['B:end', 'C:propose', 'A:interval', 'C:next']);
    expect(co).toMatch(/^（代答：[^\n]*\n【W0000-4】你派 469/u); // B's was gone by then: A's is the newest
    expect(e.counts).toMatchObject({ ended: 1, answers: 1, intervals: 1, steps: 1, coAnswers: 2 });
    expect(await say(e, '/公布', A)).toContain('這題的派票：469（代答） 2 好 1 壞✗');
  });

  it('an exercise that starts before any proposal: no notation note anywhere (it lives in /模擬 說明 since 2026-11-16)', async () => {
    const e = engine();
    const start = (await say(e, '/模擬 梅林 1')) ?? '';
    expect(start).toContain('第 1 局第一個隊長，前面沒有派票');
    const next = (await say(e, '/下一步')) ?? '';
    expect(next).toContain('1家 460');
    for (const t of [start, next]) expect(t).not.toContain('怎麼讀');
    expect(SIM_HELP_TEXT).toContain('牌譜：「1家 460 1+」= 1家派 4、6、0家');
  });
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
    expect(await say(e, '/下一步')).toContain('三藍，接著刺殺');
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
    expect(order).toEqual(['【W0000-4】你派 469：2 好 1 壞', '【W0000-4 下一步】']);
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
