/**
 * 模擬瓦（2026-11-25）— 進行中的題目存檔（bots/simulation/persist.ts）：重啟後接得回來。
 *
 * Edward 2026-11-25：「有些人送出後發現正在進行的未公布的結束了」（伺服器每部署一次就清空記憶體裡的題目）。
 *
 * 這裡確認：每個階段存下來再讀回來一模一樣；重啟後接著做，回覆跟沒重啟過的一樣（題庫順序變了也一樣）；
 * 25 秒內只寫一次、只更新「最後一次動的時間」不單獨寫；關機把沒寫的寫完；兩台伺服器同時活著時的合併與寫入衝突；
 * 沒設定存檔的 repo 時照舊；存檔格式的版本不同／檔案不在／讀不到時講明題目沒留下來、怎麼重開；
 * 還在讀的時候不會回「你沒有題目」；存檔和 log 裡沒有原本的 id。
 * 不連網路：存檔的地方是假的（FakeRepo）；題庫是編的（fixtures/simGames.ts），沒有真實玩家。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimBank } from '../bots/simulation/bank';
import { __setSimForTests, flushSimulation, simulationStatus } from '../bots/simulation';
import { SimBankLoader } from '../bots/simulation/bank';
import {
  GitHubSimBackend,
  SIM_SESSIONS_FILE,
  SIM_SESSIONS_VERSION,
  SimPersistence,
  mergeSnapshots,
  parseStoredSession,
  simIdHash,
  simStateRepoConfig,
  snapshotFromFile,
  snapshotToFileText,
  type SimStateBackend,
} from '../bots/simulation/persist';
import { NO_SESSION_KEPT_TEXT, NO_SESSION_TEXT, RESTORING_TEXT, SIM_HELP_TEXT, endedNoticeText, restartLostText } from '../bots/simulation/replies';
import { SimEngine, emptySnapshot, type SimRequest, type SimSession, type SimSessionStore, type SimStoreSnapshot } from '../bots/simulation/session';
import { repoWriteKey, serializeRepoWrite } from '../services/githubRepoWrites';
import { fixtureBankWithMid } from './fixtures/simGames';

const BANK = fixtureBankWithMid();
const T0 = Date.UTC(2026, 10, 25, 8, 30); // 2026-11-25 16:30 台北
const clock = { now: T0 };

/** 假的存檔位置：一個字串＋版本號；可以讓讀取失敗、卡住，或數讀寫次數。 */
class FakeRepo implements SimStateBackend {
  readonly name = 'fake';
  text: string | null = null;
  sha = 0;
  loads = 0;
  saves = 0;
  failLoads = 0;
  hold: Promise<void> | null = null;

  async load(): Promise<{ json: unknown; version: string | null } | null> {
    this.loads += 1;
    if (this.hold) await this.hold;
    if (this.failLoads > 0) { this.failLoads -= 1; throw new Error('state GET 503'); }
    return this.text === null ? null : { json: JSON.parse(this.text), version: String(this.sha) };
  }

  async save(text: string, version: string | null): Promise<{ ok: true; version: string | null } | { ok: false; conflict: boolean }> {
    if (this.text !== null && version !== String(this.sha)) return { ok: false, conflict: true };
    this.text = text;
    this.sha += 1;
    this.saves += 1;
    return { ok: true, version: String(this.sha) };
  }

  file(): { version: number; sessions: { key: string; exerciseId: string }[]; ended: [string, { exerciseId: string; reason: string }][] } {
    return JSON.parse(this.text ?? 'null');
  }
}

interface Server {
  engine: SimEngine;
  persist: SimPersistence;
  logs: string[];
}

const servers: Server[] = [];

/** 一台「伺服器」：自己的引擎＋存檔，接在同一個假 repo 上。計時器全關（要測的那幾題自己開）。 */
function boot(repo: SimStateBackend | null, opts: { bank?: SimBank; timers?: boolean; ttlMs?: number; maxBytes?: number; restoreWaitMs?: number; handoverMs?: number } = {}): Server {
  const logs: string[] = [];
  const persist = new SimPersistence({
    backend: repo,
    now: () => clock.now,
    loadRetryDelaysMs: [1, 1],
    catchUpDelaysMs: [],
    handoverMs: opts.handoverMs ?? 0,
    ...(opts.timers ? {} : { debounceMs: 3_600_000, firstDelayMs: 3_600_000 }),
    ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  const engine = new SimEngine({
    bank: async () => opts.bank ?? BANK,
    now: () => clock.now,
    random: () => () => 0,
    persistence: persist,
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.restoreWaitMs ? { restoreWaitMs: opts.restoreWaitMs } : {}),
  });
  const s = { engine, persist, logs };
  servers.push(s);
  return s;
}

async function restart(repo: SimStateBackend | null, opts: Parameters<typeof boot>[1] = {}): Promise<Server> {
  const s = boot(repo, opts);
  await s.persist.restore();
  return s;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.persist.stop();
  vi.useRealTimers();
  clock.now = T0;
});

async function say(s: Server, text: string, req: SimRequest): Promise<string | null> {
  clock.now += 1000;
  const r = await s.engine.handleText(text, req);
  if (!r) return null;
  r.commit();
  return r.text;
}

/** 已經有一份空存檔的 repo（不是第一次上線）。 */
function seeded(): FakeRepo {
  const repo = new FakeRepo();
  repo.text = snapshotToFileText(emptySnapshot(), T0);
  return repo;
}

const storeOf = (s: Server): SimSessionStore => (s.engine as unknown as { store: SimSessionStore }).store;
const DM: SimRequest = { platform: 'line', chatId: 'U-raw-chat-id', userId: 'U-raw-user-id' };
const G = (userId: string): SimRequest => ({ platform: 'line', chatId: 'C-raw-group-id', userId, shared: true });
const D = (userId: string, privateReply = false): SimRequest => ({ platform: 'discord', chatId: '900000000000000001', userId, shared: true, ...(privateReply ? { privateReply } : {}) });

type Step = [text: string, req: SimRequest];

/** 幾種題目從頭到尾：1 對 1 的派票題、LINE 群組（代答、每個人各自作答）、Discord 公開頻道、刺殺題、3-5。 */
const SCRIPTS: Record<string, Step[]> = {
  '1 對 1 派票題': [
    ['/模擬 忠臣 4', DM], ['/區間 789=2 460=1', DM], ['/派 469', DM], ['/分析', DM], ['/派 123', DM], ['/區間', DM], ['/分析', DM], ['/公布', DM],
  ],
  'LINE 群組：代答、每個人各自作答': [
    ['/模擬 忠臣 4', G('A')], ['/派 469', G('B')], ['/派 123', G('A')], ['/區間 789=2', G('C')], ['/派 460', G('B')], ['/分析', G('A')], ['/公布', G('C')],
  ],
  'Discord 公開頻道：作答只有本人看得到': [
    ['/模擬 忠臣 4', D('u1')], ['/派 469', D('u2', true)], ['/派 370', D('u1', true)], ['/分析', D('u1', true)], ['/公布', D('u1')],
  ],
  '刺殺題': [
    ['/模擬 刺殺', G('A')], ['/刺 2', G('B')], ['/刺 1', G('A')], ['/派 123', G('A')], ['/公布', G('B')],
  ],
  '3-5': [
    ['/模擬 3-5', DM], ['/派 1458', DM], ['/區間 12=1', DM], ['/分析', DM], ['/結束', DM],
  ],
  '同一個人兩個聊天室各一題': [
    ['/模擬 忠臣 4', DM], ['/模擬 W0001-4', G('U-raw-user-id')], ['/派 469', DM], ['/派 123', G('U-raw-user-id')], ['/公布', DM], ['/公布', G('U-raw-user-id')],
  ],
};

/** 存檔裡看得到的東西：不看 games[] 的索引（重啟後才重新對）。 */
const comparable = (snap: SimStoreSnapshot): unknown => ({
  ...snap,
  sessions: snap.sessions.map((s) => ({ ...s, game: 0, answers: [...s.answers.entries()] })),
});

describe('存下來再讀回來', () => {
  for (const [name, steps] of Object.entries(SCRIPTS)) {
    it(`${name}：每一步之後存檔 → 讀回來一模一樣，再存一次也是同一份`, async () => {
      const repo = new FakeRepo();
      const a = await restart(repo);
      for (const [text, req] of steps) {
        expect(await say(a, text, req), text).not.toBeNull();
        await a.persist.flush();
        const live = storeOf(a).snapshot();
        const parsed = snapshotFromFile(JSON.parse(repo.text as string));
        if (parsed === 'version') throw new Error('version');
        expect(parsed.dropped).toBe(0);
        expect(comparable(parsed.snapshot), text).toEqual(comparable(live));
        for (const s of parsed.snapshot.sessions) expect(s.game).toBe(-1);
        expect(JSON.parse(snapshotToFileText(parsed.snapshot, clock.now))).toEqual(JSON.parse(repo.text as string));
      }
    });
  }

  it('壞掉的題目整題不要（其他的照讀）；不是這一版的檔案不讀', () => {
    const good = { key: 'line:a:b', chatKey: 'line:a', exerciseId: 'W0000-4', gameId: 'W0000', seat: 4, role: 'loyal', decision: 3, cursor: 3, answers: [[3, [{ team: [4, 6, 9], coAnswer: false, by: 'line:b' }]]], phase: 'answered', startedAt: 1, lastActiveAt: 2, version: 2 };
    expect(parseStoredSession(good)).toMatchObject({ exerciseId: 'W0000-4', game: -1, seat: 4 });
    for (const bad of [
      null, 'x', { ...good, key: '' }, { ...good, seat: 11 }, { ...good, role: 'king' }, { ...good, phase: 'done' }, { ...good, decision: -1 }, { ...good, version: 0 },
      { ...good, answers: [[3, [{ team: [4, 6, 99], coAnswer: false }]]] }, { ...good, answers: 'x' }, { ...good, interval: [{ seats: [1], min: 0 }] },
      { ...good, kill: { target: 0, coAnswer: false } }, { ...good, startedAt: 'yesterday' }, { ...good, gameId: undefined },
    ]) expect(parseStoredSession(bad), JSON.stringify(bad)).toBeNull();
    const parsed = snapshotFromFile({ version: SIM_SESSIONS_VERSION, sessions: [good, { ...good, seat: 0 }, good], ended: [['k', { exerciseId: 'W0001-4', reason: 'expired', at: 5 }], ['bad', {}]], closed: [['k2', 9], ['bad']], noticed: ['n', 3], events: ['e', null] });
    if (parsed === 'version') throw new Error('version');
    expect(parsed.snapshot.sessions).toHaveLength(1);
    expect(parsed.dropped).toBe(2); // 一題壞掉、一題重複
    expect(parsed.snapshot.ended).toEqual([['k', { exerciseId: 'W0001-4', reason: 'expired', at: 5 }]]);
    expect(parsed.snapshot.closed).toEqual([['k2', 9]]);
    expect(parsed.snapshot.noticed).toEqual(['n']);
    expect(parsed.snapshot.events).toEqual(['e']);
    for (const other of [null, [], { version: SIM_SESSIONS_VERSION + 1, sessions: [good] }, { sessions: [good] }]) expect(snapshotFromFile(other)).toBe('version');
  });
});

describe('重啟後接著做', () => {
  /** 題庫重建後順序不一樣（索引全變）；題目照題庫代號重新對。 */
  const reordered = (): SimBank => {
    const games = [...BANK.games].reverse();
    return { ...BANK, games, byId: new Map(games.map((g, i) => [g.id, i])) };
  };

  for (const [name, steps] of Object.entries(SCRIPTS)) {
    it(`${name}：在任何一步重啟，後面的回覆跟沒重啟過的一樣（題庫順序變了也一樣）`, async () => {
      const straight = await restart(seeded());
      const expected: (string | null)[] = [];
      for (const [text, req] of steps) expected.push(await say(straight, text, req));
      expect(expected.every((t) => t !== null)).toBe(true);

      const startsLater = (from: number): boolean => steps.slice(from).some(([text]) => text.startsWith('/模擬'));
      for (let cut = 1; cut < steps.length; cut++) {
        clock.now = T0;
        const repo = seeded();
        const before = await restart(repo);
        for (let i = 0; i < cut; i++) expect(await say(before, steps[i][0], steps[i][1]), `${cut}/${i}`).toBe(expected[i]);
        await before.persist.flush(); // 關機
        // 之後還要開新題的腳本用同一份題庫（選題照索引）；其他的用順序反過來的題庫。
        const after = await restart(repo, { bank: startsLater(cut) ? BANK : reordered() });
        for (let i = cut; i < steps.length; i++) expect(await say(after, steps[i][0], steps[i][1]), `${cut}/${i}`).toBe(expected[i]);
        expect(after.engine.activeSessions()).toBe(straight.engine.activeSessions());
      }
    });
  }

  it('每一步都重啟一次（連續部署 9 次的那種日子）也一樣', async () => {
    const steps = SCRIPTS['LINE 群組：代答、每個人各自作答'];
    const straight = await restart(seeded());
    const expected: (string | null)[] = [];
    for (const [text, req] of steps) expected.push(await say(straight, text, req));
    clock.now = T0;
    const repo = seeded();
    for (let i = 0; i < steps.length; i++) {
      const s = await restart(repo);
      expect(await say(s, steps[i][0], steps[i][1]), String(i)).toBe(expected[i]);
      await s.persist.flush();
    }
    expect(repo.file().sessions).toEqual([]);
  });

  it('重啟後：有題目的人不會被說沒有題目；沒有題目的人照常（不提重啟）；結束說明、LINE 重送紀錄都還在', async () => {
    const repo = new FakeRepo();
    const a = await restart(repo, { ttlMs: 60_000 });
    await say(a, '/模擬 忠臣 4', DM);
    await say(a, '/模擬 W0001-4', G('A'));
    expect(await say(a, '/派 469', { ...DM, eventKey: 'e:raw-event-1' })).toContain('你派 469');
    await a.persist.flush();

    const b = await restart(repo, { ttlMs: 60_000 });
    expect(b.engine.activeSessions()).toBe(2);
    expect(b.persist.status()).toMatchObject({ configured: true, ready: true, restored: true, restoredSessions: 2, droppedSessions: 0 });
    // LINE 重送重啟前已經回過的那個事件：不再回。
    expect(await b.engine.handleText('/派 469', { ...DM, eventKey: 'e:raw-event-1', duplicate: true })).toBeNull();
    expect(await say(b, '/公布', { platform: 'line', chatId: 'U-someone-else', userId: 'U-someone-else' })).toBe(NO_SESSION_KEPT_TEXT);
    expect(await say(b, '/分析', DM)).toContain('W0000-4');

    // 有設閒置期限時，太久沒動的題目重啟後照舊算過期：講明是哪一題、怎麼重開（跟沒重啟過的一樣）。
    clock.now += 5 * 60_000;
    await b.persist.flush();
    const c = await restart(repo, { ttlMs: 60_000 });
    expect(c.engine.activeSessions()).toBe(0);
    expect(await say(c, '/公布', DM)).toBe(endedNoticeText('W0000-4', 'expired'));
    await c.persist.flush();
    const d = await restart(repo, { ttlMs: 60_000 });
    expect(await say(d, '/派 469', DM)).toBe(endedNoticeText('W0000-4', 'expired'));
  });

  it('那一局從題庫拿掉了：講明是哪一題沒能接回來、怎麼重開；只講一次，這一題結束', async () => {
    const repo = new FakeRepo();
    const a = await restart(repo);
    await say(a, '/模擬 忠臣 4', DM);
    await say(a, '/模擬 W0000-6', G('A'));
    await a.persist.flush();

    const games = BANK.games.filter((g) => g.id !== 'W0000');
    const b = await restart(repo, { bank: { ...BANK, games, byId: new Map(games.map((g, i) => [g.id, i])) } });
    const lost = endedNoticeText('W0000-4', 'lost');
    expect(lost).toContain('W0000-4');
    expect(lost).toContain('伺服器更新後沒能接回來');
    expect(lost).toContain('/模擬 題 W0000-4');
    expect(await say(b, '/派 469', DM)).toBe(lost);
    expect(await say(b, '/派 469', DM)).toBe(NO_SESSION_KEPT_TEXT);
    // 群組裡別人代答那一題也一樣講明（不會當成題庫沒準備好）。
    expect(await say(b, '/派 123', G('B'))).toContain('W0000-6 在伺服器更新後沒能接回來');
    expect(b.engine.activeSessions()).toBe(0);
    await b.persist.flush();
    expect(repo.file().sessions).toEqual([]);
  });

  it('同一局但存下來的位置對不上（角色不同）：一樣講明沒能接回來', async () => {
    const repo = new FakeRepo();
    const a = await restart(repo);
    await say(a, '/模擬 忠臣 4', DM);
    await a.persist.flush();
    const file = JSON.parse(repo.text as string);
    file.sessions[0].role = 'merlin';
    repo.text = JSON.stringify(file);
    const b = await restart(repo);
    expect(await say(b, '/公布', DM)).toBe(endedNoticeText('W0000-4', 'lost'));
  });
});

describe('什麼時候寫', () => {
  it('變動後 2 秒寫第一次；之後 25 秒內不管幾個指令只再寫一次；沒有變動不寫', async () => {
    vi.useFakeTimers({ now: T0 });
    const real = clock.now;
    const repo = new FakeRepo();
    const persist = new SimPersistence({ backend: repo, now: () => Date.now(), catchUpDelaysMs: [], handoverMs: 0, logger: { info: () => undefined, warn: () => undefined } });
    const engine = new SimEngine({ bank: async () => BANK, now: () => Date.now(), random: () => () => 0, persistence: persist });
    servers.push({ engine, persist, logs: [] });
    const run = async (text: string): Promise<void> => { (await engine.handleText(text, DM))?.commit(); };
    await persist.restore();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(repo.saves).toBe(1); // 檔案原本不在：開機後先寫一份空的

    await vi.advanceTimersByTimeAsync(60_000);
    expect(repo.saves).toBe(1);
    await run('/模擬 忠臣 4');
    await vi.advanceTimersByTimeAsync(1_900);
    expect(repo.saves).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(repo.saves).toBe(2);
    expect(repo.file().sessions).toHaveLength(1);

    // 接下來 20 秒裡 4 個指令：不寫；上一次寫的 25 秒後寫一次，內容是最新的。
    for (const text of ['/派 469', '/派 123', '/區間 789=2', '/派 468']) {
      await vi.advanceTimersByTimeAsync(5_000);
      await run(text);
    }
    expect(repo.saves).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(repo.saves).toBe(3);
    const saved = JSON.parse(repo.text as string).sessions[0];
    expect(saved.answers[0][1].map((a: { team: number[] }) => a.team.join(''))).toEqual(['469', '123', '468']);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(repo.saves).toBe(3);

    // 只更新「最後一次動的時間」的指令（/分析、不帶內容的 /區間）不單獨寫；下一次有變動或關機時一起寫。
    await run('/分析');
    await run('/區間');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(repo.saves).toBe(3);
    expect(persist.status().pending).toBe(true);
    await persist.flush();
    expect(repo.saves).toBe(4);
    expect(persist.status()).toMatchObject({ pending: false, writes: 4, writeFailures: 0, conflicts: 0 });
    clock.now = real;
  });

  it('寫失敗：留著下次再寫，越失敗隔越久；恢復後寫進去', async () => {
    vi.useFakeTimers({ now: T0 });
    const repo = new FakeRepo();
    repo.text = snapshotToFileText(emptySnapshot(), T0);
    const flaky = { down: true };
    const backend: SimStateBackend = {
      name: 'fake',
      load: () => repo.load(),
      save: async (text, version) => (flaky.down ? { ok: false, conflict: false } : repo.save(text, version)),
    };
    const logs: string[] = [];
    const persist = new SimPersistence({ backend, now: () => Date.now(), catchUpDelaysMs: [], handoverMs: 0, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
    const engine = new SimEngine({ bank: async () => BANK, now: () => Date.now(), random: () => () => 0, persistence: persist });
    servers.push({ engine, persist, logs });
    await persist.restore();
    (await engine.handleText('/模擬 忠臣 4', DM))?.commit();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(persist.status()).toMatchObject({ writes: 0, writeFailures: 1, pending: true });
    await vi.advanceTimersByTimeAsync(49_000); // 第二次要等 50 秒
    expect(persist.status().writeFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(persist.status().writeFailures).toBe(2);
    flaky.down = false;
    await vi.advanceTimersByTimeAsync(101_000);
    expect(persist.status()).toMatchObject({ writes: 1, pending: false });
    expect(repo.file().sessions).toHaveLength(1);
    expect(logs.filter((m) => m.includes('failed'))).toEqual(Array(2).fill('saving open exercises to fake failed (rejected); will retry'));
  });

  it('關機（flushSimulation）：剛送出、還沒到寫入時間的那一步也寫進去；重啟後接得回來', async () => {
    const repo = new FakeRepo();
    const a = await restart(repo);
    __setSimForTests({ engine: a.engine, persistence: a.persist });
    await say(a, '/模擬 忠臣 4', DM);
    await say(a, '/派 469', DM);
    expect(repo.saves).toBe(0);
    await flushSimulation();
    expect(repo.saves).toBe(1);
    __setSimForTests({ engine: null, persistence: null });
    const b = await restart(repo);
    expect(await say(b, '/分析', DM)).toContain('你派 469');
  });

  it('關機時還沒讀回來：不寫（不會拿空的蓋掉檔案）；卡住的寫入不會讓關機等超過期限', async () => {
    const repo = new FakeRepo();
    const a = await restart(repo);
    await say(a, '/模擬 忠臣 4', DM);
    await a.persist.flush();
    const before = repo.text;

    let release: () => void = () => undefined;
    repo.hold = new Promise<void>((resolve) => { release = resolve; });
    const b = boot(repo);
    void b.persist.restore();
    await b.persist.flush();
    expect(repo.text).toBe(before);
    release();
    repo.hold = null;
    await b.persist.restore();
    expect(b.engine.activeSessions()).toBe(1);

    const stuck: SimStateBackend = { name: 'fake', load: async () => null, save: () => new Promise(() => undefined) };
    const c = await restart(stuck);
    __setSimForTests({ engine: c.engine, persistence: c.persist });
    await say(c, '/模擬 忠臣 4', DM);
    const started = Date.now();
    await flushSimulation(50);
    expect(Date.now() - started).toBeLessThan(2_000);
    __setSimForTests({ engine: null, persistence: null });
  });
});

describe('兩台伺服器同時活著（Render 先開新的、再關舊的）', () => {
  it('寫入衝突：重讀、合併、再寫——兩邊的題目都在，舊的那台已經 /公布 的不會被救回來', async () => {
    const repo = new FakeRepo();
    const old = await restart(repo);
    await say(old, '/模擬 忠臣 4', DM);
    await say(old, '/模擬 W0001-4', G('A'));
    await say(old, '/模擬 W0002-4', D('u1'));
    await old.persist.flush();

    // 新的那台開機讀檔；舊的那台還在收指令：一題作答、一題公布、一題新開，關機時寫進去。
    const fresh = await restart(repo);
    expect(fresh.engine.activeSessions()).toBe(3);
    await say(old, '/派 469', DM);
    await say(old, '/公布', G('A'));
    await say(old, '/模擬 W0003-4', G('B'));
    await old.persist.flush();
    const shaAfterOld = repo.sha;

    // 新的那台自己也有變動（另一個人開題）→ 寫的時候發現檔案被改過。
    await say(fresh, '/模擬 W0004-4', D('u2'));
    await fresh.persist.flush();
    expect(fresh.persist.status()).toMatchObject({ conflicts: 1, writes: 1, writeFailures: 0 });
    expect(repo.sha).toBe(shaAfterOld + 1);
    const ids = repo.file().sessions.map((s) => s.exerciseId).sort();
    expect(ids).toEqual(['W0000-4', 'W0002-4', 'W0003-4', 'W0004-4']);
    expect(fresh.engine.activeSessions()).toBe(4);
    // 舊的那台收到的 /派 469 在新的這台看得到；已經公布的那一題不在了。
    expect(await say(fresh, '/分析', DM)).toContain('你派 469');
    expect(await say(fresh, '/公布', G('A'))).toContain('代答');
    expect(await say(fresh, '/公布', G('A'))).toBe(NO_SESSION_KEPT_TEXT);
  });

  it('新的那台沒有變動也會回頭再讀（catchUp）：接住舊的那台關機前最後寫的那一次', async () => {
    const repo = new FakeRepo();
    const old = await restart(repo);
    await say(old, '/模擬 忠臣 4', DM);
    await old.persist.flush();
    const fresh = await restart(repo);
    await say(old, '/派 469', DM);
    await say(old, '/模擬 W0001-4', G('A'));
    await old.persist.flush();

    expect(fresh.engine.activeSessions()).toBe(1);
    const loads = repo.loads;
    await fresh.persist.catchUp();
    expect(repo.loads).toBe(loads + 1);
    expect(fresh.engine.activeSessions()).toBe(2);
    expect(await say(fresh, '/分析', DM)).toContain('你派 469');
    // 檔案沒再變：回頭讀不會動任何東西。
    await fresh.persist.flush();
    const sha = repo.sha;
    await fresh.persist.catchUp();
    await fresh.persist.flush();
    expect(repo.sha).toBe(sha);
  });

  it('剛開機的 3 分鐘內，每個模擬指令回答之前先看一眼存檔：舊的那台剛開的題目、剛作的答，新的這台馬上接得到', async () => {
    const repo = seeded();
    const old = await restart(repo);
    const fresh = await restart(repo, { handoverMs: 180_000 });
    // 新的那台已經開機讀過檔案（空的）；之後才在舊的那台開題、作答（舊的那台寫了檔）。
    await say(old, '/模擬 忠臣 4', G('A'));
    await say(old, '/派 469', G('A'));
    await old.persist.flush();
    expect(fresh.engine.activeSessions()).toBe(0);
    // 下一個指令落在新的那台：不會回「你沒有題目」。
    expect(await say(fresh, '/派 123', G('A'))).toBe('【W0000-4】收到（第 1 位作答，第 2 次作答，最後一次算數）\n結果 /公布 時一起看');
    // 公布時，在舊的那台作的答和在新的這台作的答都在。
    const reveal = await say(fresh, '/公布', G('B'));
    for (const team of ['469', '123']) expect(reveal, team).toContain(team);
    expect(fresh.persist.status().conflicts).toBe(0);

    // 檔案沒被改過：看一眼就好，不合併、不寫。3 分鐘之後不再每個指令都看。
    await fresh.persist.flush();
    const { sha, loads } = repo;
    expect(await say(fresh, '/公布', G('A'))).toBe(NO_SESSION_KEPT_TEXT);
    expect(repo.loads).toBe(loads + 1);
    clock.now += 180_000;
    expect(await say(fresh, '/公布', G('A'))).toBe(NO_SESSION_KEPT_TEXT);
    expect(repo.loads).toBe(loads + 1);
    await fresh.persist.flush();
    expect(repo.sha).toBe(sha);
  });

  it('開機後自己排好回頭讀的時間（5 分、10 分）', async () => {
    vi.useFakeTimers({ now: T0 });
    const repo = new FakeRepo();
    repo.text = snapshotToFileText(emptySnapshot(), T0);
    const persist = new SimPersistence({ backend: repo, now: () => Date.now(), logger: { info: () => undefined, warn: () => undefined } });
    const engine = new SimEngine({ bank: async () => BANK, now: () => Date.now(), random: () => () => 0, persistence: persist });
    servers.push({ engine, persist, logs: [] });
    await persist.restore();
    expect(repo.loads).toBe(1);
    for (const [ms, loads] of [[299_000, 1], [2_000, 2], [300_000, 3], [3_600_000, 3]]) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(repo.loads).toBe(loads);
    }
    expect(repo.saves).toBe(0);
  });

  const session = (key: string, lastActiveAt: number, version = 1): SimSession => ({
    key, chatKey: 'line:c', exerciseId: `X-${key}`, gameId: 'X', game: -1, seat: 4, role: 'loyal', decision: 0, cursor: 0, answers: new Map(), phase: 'answering', startedAt: 10, lastActiveAt, version,
  });
  const snap = (over: Partial<SimStoreSnapshot>): SimStoreSnapshot => ({ ...emptySnapshot(), ...over });

  it('mergeSnapshots：每一題取比較晚動過的；結束過的不留；一樣新取自己手上的那一份', () => {
    const mineA = session('a', 100, 3);
    const merged = mergeSnapshots(
      snap({ sessions: [session('a', 100, 3), session('b', 50), session('c', 80), session('d', 70)], closed: [['e', 95]], ended: [['f', { exerciseId: 'X-f', reason: 'evicted', at: 60 }], ['g', { exerciseId: 'X-g', reason: 'expired', at: 40 }]], events: ['e1'], noticed: ['n1', 'h'] }),
      snap({ sessions: [mineA, session('b', 60, 2), session('e', 90), session('f', 55), session('h', 99)], closed: [['c', 85], ['g', 45]], ended: [['d', { exerciseId: 'X-d', reason: 'evicted', at: 75 }]], events: ['e1', 'e2'], noticed: ['n2'] }),
    );
    expect(merged.sessions.map((s) => `${s.key}@${s.lastActiveAt}`)).toEqual(['b@60', 'h@99', 'a@100']);
    expect(merged.sessions.find((s) => s.key === 'a')).toBe(mineA); // 同一個物件：進行中的回覆照常 commit
    // c：之後 /公布 了；d：之後被擠掉；e：之後 /結束 了；f：比它晚的「被擠掉」贏；g：已經講過了。
    expect(merged.ended).toEqual([['f', { exerciseId: 'X-f', reason: 'evicted', at: 60 }], ['d', { exerciseId: 'X-d', reason: 'evicted', at: 75 }]]);
    expect(Object.fromEntries(merged.closed)).toEqual({ c: 85, e: 95, g: 45 });
    expect(merged.events).toEqual(['e1', 'e2']);
    expect(merged.noticed).toEqual(['n1', 'n2']); // h 又開了新題
    // 結束之後又開的新題留著，舊的結束說明不留。
    const reopened = mergeSnapshots(snap({ closed: [['a', 100]], ended: [['b', { exerciseId: 'X-b', reason: 'expired', at: 100 }]] }), snap({ sessions: [session('a', 101), session('b', 101)] }));
    expect(reopened.sessions.map((s) => s.key)).toEqual(['a', 'b']);
    expect(reopened.ended).toEqual([]);
  });
});

describe('沒能讀回來的時候', () => {
  const lostText = restartLostText(T0);

  it('restartLostText：講明伺服器什麼時候更新過、題目沒留下來、怎麼重開', () => {
    expect(lostText).toBe('你目前沒有進行中的模擬。伺服器在 11/25 16:30 更新過，那之前還沒公布的題目這次沒能留下來。原本有題目的話，打 /模擬 題號 重開同一題（題號在題目的第一行，例：/模擬 K7Q2M-4），或 /模擬 開新的一題');
  });

  it('存檔格式的版本不同：不讀；沒有題目的人打指令時講明；之後照新的格式寫回去', async () => {
    const repo = new FakeRepo();
    const a = await restart(repo);
    await say(a, '/模擬 忠臣 4', DM);
    await a.persist.flush();
    repo.text = JSON.stringify({ ...JSON.parse(repo.text as string), version: SIM_SESSIONS_VERSION + 1 });

    const b = await restart(repo);
    expect(b.engine.activeSessions()).toBe(0);
    expect(b.persist.status()).toMatchObject({ ready: true, restored: false });
    expect(b.logs).toEqual(['saved exercises have another format version; starting empty']);
    expect(await say(b, '/派 469', DM)).toBe(lostText);
    expect(await say(b, '/公布', G('A'))).toBe(lostText);
    // 照題號重開就接著玩；這個人之後不會再看到那句話。
    expect(await say(b, '/模擬 W0000-4', DM)).toContain('【模擬瓦 W0000-4】');
    expect(await say(b, '/派 469', DM)).toContain('你派 469');
    await b.persist.flush();
    expect(repo.file().version).toBe(SIM_SESSIONS_VERSION);

    const c = await restart(repo);
    expect(c.persist.status().restored).toBe(true);
    expect(await say(c, '/公布', G('A'))).toBe(NO_SESSION_KEPT_TEXT);
    expect(await say(c, '/分析', DM)).toContain('你派 469');
  });

  it('檔案不在（第一次上線）：講明；開機後就寫一份，下一次重啟不會再這樣說', async () => {
    const repo = new FakeRepo();
    const a = await restart(repo);
    expect(a.logs).toEqual(['no saved exercises in fake yet; starting empty']);
    expect(await say(a, '/派 469', DM)).toBe(lostText);
    expect(a.persist.status().pending).toBe(true);
    await a.persist.flush();
    expect(repo.file()).toMatchObject({ version: SIM_SESSIONS_VERSION, sessions: [] });
    const b = await restart(repo);
    expect(await say(b, '/派 469', DM)).toBe(NO_SESSION_KEPT_TEXT);
  });

  it('讀不到（試三次）：講明；之後第一次寫的時候發現檔案還在 → 合併，題目接回來', async () => {
    const repo = new FakeRepo();
    const a = await restart(repo);
    await say(a, '/模擬 忠臣 4', DM);
    await say(a, '/派 469', DM);
    await a.persist.flush();

    repo.failLoads = 3;
    const b = await restart(repo);
    expect(repo.failLoads).toBe(0);
    expect(b.logs).toEqual(['reading open exercises from fake failed (state GET 503); starting empty']);
    expect(await say(b, '/公布', G('A'))).toBe(lostText);
    await b.persist.flush();
    expect(b.persist.status()).toMatchObject({ restored: true, conflicts: 1, writes: 1 });
    expect(await say(b, '/公布', G('A'))).toBe(NO_SESSION_KEPT_TEXT);
    expect(await say(b, '/分析', DM)).toContain('你派 469');

    // 讀兩次失敗、第三次成功：照常讀回來。
    await b.persist.flush();
    repo.failLoads = 2;
    const c = await restart(repo);
    expect(c.persist.status().restored).toBe(true);
    expect(c.logs).toEqual(['restored 1 open exercises from fake']);
  });

  it('還在讀的時候：不回「你沒有題目」——等一下；等不到就請他過幾秒再打一次；讀回來之後照常', async () => {
    const repo = new FakeRepo();
    const a = await restart(repo);
    await say(a, '/模擬 忠臣 4', DM);
    await a.persist.flush();

    let release: () => void = () => undefined;
    repo.hold = new Promise<void>((resolve) => { release = resolve; });
    const b = boot(repo, { restoreWaitMs: 30 });
    void b.persist.restore();
    expect(b.persist.isReady()).toBe(false);
    const waiting = await b.engine.handleText('/派 469', DM);
    expect(waiting).toMatchObject({ text: RESTORING_TEXT, kind: 'restoring', sessionOpen: false });
    waiting?.commit();
    expect((await b.engine.handleText('/模擬', DM))?.text).toBe(RESTORING_TEXT);
    // 說明不用等；像聊天的斜線句子照舊不回。
    expect((await b.engine.handleText('/模擬 說明', DM))?.text).toBe(SIM_HELP_TEXT);
    expect(await b.engine.handleText('/派西 2', DM)).toBeNull();
    expect(b.engine.activeSessions()).toBe(0);

    // 指令在等的時候讀完了：直接回答，不用再打一次。
    const c = boot(repo, { restoreWaitMs: 5_000 });
    const pending = c.engine.handleText('/派 469', DM);
    setTimeout(release, 20);
    const answered = await pending;
    expect(answered?.text).toContain('你派 469');
    repo.hold = null;
    await b.persist.restore();
    expect((await b.engine.handleText('/派 469', DM))?.text).toContain('你派 469');
  });

  it('檔案放不下：最久沒動的題目不存，重啟後講明是哪一題沒能接回來；還在這台伺服器上時照常玩', async () => {
    const repo = new FakeRepo();
    const a = await restart(repo, { maxBytes: 1_200 });
    const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
    for (const [i, u] of users.entries()) await say(a, `/模擬 W000${i}-4`, D(u));
    await a.persist.flush();
    const file = repo.file();
    expect(Buffer.byteLength(repo.text as string, 'utf8')).toBeLessThanOrEqual(1_200);
    expect(file.sessions.length).toBeGreaterThan(0);
    expect(file.sessions.length).toBeLessThan(users.length);
    const droppedIds = file.ended.map(([, info]) => info.exerciseId);
    expect(droppedIds).toEqual(users.slice(0, users.length - file.sessions.length).map((_, i) => `W000${i}-4`));
    expect(file.ended.every(([, info]) => info.reason === 'lost')).toBe(true);
    // 這台還開著：照常作答。
    expect(await say(a, '/派 469', D('u1', true))).toContain('你派 469');

    const b = await restart(repo, { maxBytes: 1_200 });
    expect(b.engine.activeSessions()).toBe(file.sessions.length);
    expect(await say(b, '/派 469', D('u2', true))).toBe(endedNoticeText('W0001-4', 'lost'));
    expect(await say(b, '/派 469', D('u6', true))).toContain('你派 469');
  });
});

describe('沒設定存檔的 repo', () => {
  it('simStateRepoConfig：跟每日小觀念同一個 repo、同一個資料夾，檔名 sim-sessions.json；沒有權杖或 repo → null', () => {
    expect(simStateRepoConfig({})).toBeNull();
    expect(simStateRepoConfig({ GITHUB_ACCOUNTS_REPO: 'o/r' })).toBeNull();
    expect(simStateRepoConfig({ GITHUB_ACCOUNTS_TOKEN: 't', GITHUB_ACCOUNTS_REPO: 'o/r' })).toEqual({ token: 't', repo: 'o/r', branch: 'main', path: `bot-state/${SIM_SESSIONS_FILE}`, api: 'https://api.github.com' });
    expect(simStateRepoConfig({ CONCEPT_DAILY_STATE_TOKEN: 't2', CONCEPT_DAILY_STATE_REPO: 'o/state', CONCEPT_DAILY_STATE_BRANCH: 'data', CONCEPT_DAILY_STATE_PATH: 'x/y/concept.json' }))
      .toMatchObject({ token: 't2', repo: 'o/state', branch: 'data', path: 'x/y/sim-sessions.json' });
    expect(simStateRepoConfig({ GITHUB_ACCOUNTS_TOKEN: 't', GITHUB_ACCOUNTS_REPO: 'o/r', CONCEPT_DAILY_STATE_PATH: 'concept.json' })?.path).toBe('sim-sessions.json');
  });

  it('照舊只在記憶體：指令不用等、沒有題目時的說法照舊（會提重啟）、開機 log 寫一次、不寫任何東西', async () => {
    const a = boot(null);
    expect(a.persist.isReady()).toBe(true);
    expect(a.persist.keeps()).toBe(false);
    expect(a.persist.lostAt()).toBeNull();
    await a.persist.restore();
    await a.persist.restore();
    expect(a.logs).toEqual(['no state repo configured: open 模擬 exercises live in memory only (a restart or deploy clears them)']);
    expect(await say(a, '/派 469', DM)).toBe(NO_SESSION_TEXT);
    expect(NO_SESSION_TEXT).toContain('伺服器重新啟動');
    expect(NO_SESSION_KEPT_TEXT).not.toContain('重新啟動');
    expect(await say(a, '/模擬 忠臣 4', DM)).toContain('【模擬瓦 W0000-4】');
    expect(await say(a, '/派 469', DM)).toContain('你派 469');
    await a.persist.flush();
    await a.persist.catchUp();
    expect(a.persist.status()).toEqual({ configured: false, ready: true, restored: false, restoredSessions: 0, droppedSessions: 0, writes: 0, writeFailures: 0, conflicts: 0, pending: false });
    // 沒有存檔的引擎（測試、工具）也一樣。
    const bare = new SimEngine({ bank: async () => BANK, now: () => clock.now, random: () => () => 0 });
    expect((await bare.handleText('/派 469', DM))?.text).toBe(NO_SESSION_TEXT);
  });
});

describe('隱私', () => {
  it('存檔、log、狀態頁裡沒有原本的聊天室／使用者 id、LINE 事件代號；log 裡也沒有題號', async () => {
    const repo = new FakeRepo();
    const a = await restart(repo);
    const loader = new SimBankLoader(() => BANK);
    await loader.get();
    __setSimForTests({ loader, engine: a.engine, persistence: a.persist });
    await say(a, '/模擬 忠臣 4', { ...DM, eventKey: 'e:01HXRAWEVENTID' });
    await say(a, '/模擬 W0001-4', G('U-group-member-a'));
    await say(a, '/派 469', { ...G('U-group-member-b'), eventKey: 'm:5550001112223' });
    await say(a, '/模擬 刺殺', D('800000000000000042'));
    await say(a, '/刺 2', D('800000000000000043', true));
    await say(a, '/區間 789=2', DM);
    await a.persist.flush();
    const b = await restart(repo);
    await say(b, '/公布', DM);
    await b.persist.flush();

    const raw = ['U-raw-chat-id', 'U-raw-user-id', 'C-raw-group-id', 'U-group-member-a', 'U-group-member-b', '900000000000000001', '800000000000000042', '800000000000000043', '01HXRAWEVENTID', '5550001112223'];
    const text = repo.text as string;
    for (const id of raw) expect(text, id).not.toContain(id);
    // key 是「平台:雜湊:雜湊」，查的時候把進來的 id 雜湊後比對。
    const file = JSON.parse(text) as { sessions: { key: string; chatKey: string; userKey?: string; answers: [number, { by?: string }[]][] }[]; events: string[] };
    expect(file.sessions.map((s) => s.key)).toContain(`line:${simIdHash('C-raw-group-id')}:${simIdHash('U-group-member-a')}`);
    for (const s of file.sessions) {
      expect(s.key).toMatch(/^(line|discord):[0-9a-f]{12}:[0-9a-f]{12}$/u);
      expect(s.chatKey).toMatch(/^(line|discord):[0-9a-f]{12}$/u);
      expect(s.userKey).toMatch(/^(line|discord):[0-9a-f]{12}$/u);
      for (const [, list] of s.answers) for (const ans of list) expect(ans.by).toMatch(/^(line|discord):[0-9a-f]{12}$/u);
    }
    for (const e of file.events) expect(e).toMatch(/^[0-9a-f]{12}$/u);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['closed', 'ended', 'events', 'noticed', 'savedAt', 'sessions', 'version']);

    const logs = [...a.logs, ...b.logs].join('\n');
    expect(logs).toBe('no saved exercises in fake yet; starting empty\nrestored 3 open exercises from fake');
    for (const s of [...raw, 'W0000', '469']) expect(logs).not.toContain(s);

    const status = JSON.stringify(simulationStatus());
    for (const s of [...raw, 'W0000']) expect(status).not.toContain(s);
    expect(simulationStatus().sessions).toMatchObject({ active: 3, persistence: { configured: true, ready: true, restored: false, writes: 1 } });
    __setSimForTests({ loader: null, engine: null, persistence: null });
  });
});

describe('GitHubSimBackend（假的 fetch，不連網路）', () => {
  const cfg = { token: 'tok', repo: 'o/private', branch: 'main', path: 'bot-state/sim-sessions.json', api: 'https://api.example.test' };
  type Call = { url: string; method: string; headers: Record<string, string>; body?: { message: string; content: string; branch: string; sha?: string }; signal: unknown };

  function fakeGitHub(): { calls: Call[]; fetchImpl: typeof fetch; state: { content: string | null; sha: number; status?: number } } {
    const calls: Call[] = [];
    const state: { content: string | null; sha: number; status?: number } = { content: null, sha: 0 };
    const fetchImpl = (async (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal?: unknown } = { headers: {} }) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body, signal: init.signal });
      const json = (status: number, data: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => data }) as unknown as Response;
      if (state.status) return json(state.status, {});
      if ((init.method ?? 'GET') === 'GET') return state.content === null ? json(404, {}) : json(200, { content: state.content, sha: `sha${state.sha}` });
      if (state.content !== null && body.sha !== `sha${state.sha}`) return json(body.sha ? 409 : 422, {});
      state.content = body.content;
      state.sha += 1;
      return json(200, { content: { sha: `sha${state.sha}` } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl, state };
  }

  it('讀：沒有檔案 → null；寫：帶 sha、一行 JSON、固定的 commit 訊息；被別人改過 → conflict；其他錯誤不是 conflict', async () => {
    const gh = fakeGitHub();
    const backend = new GitHubSimBackend(cfg, gh.fetchImpl);
    expect(await backend.load()).toBeNull();
    const text = snapshotToFileText(emptySnapshot(), T0);
    expect(await backend.save(text, null)).toEqual({ ok: true, version: 'sha1' });
    expect(await backend.load()).toEqual({ json: JSON.parse(text), version: 'sha1' });
    expect(await backend.save(text, 'sha1')).toEqual({ ok: true, version: 'sha2' });
    expect(await backend.save(text, 'sha1')).toEqual({ ok: false, conflict: true });
    expect(await backend.save(text, null)).toEqual({ ok: false, conflict: true });
    gh.state.status = 500;
    expect(await backend.save(text, 'sha2')).toEqual({ ok: false, conflict: false });
    await expect(backend.load()).rejects.toThrow('state GET 500');

    expect(gh.calls[0]).toMatchObject({ url: 'https://api.example.test/repos/o/private/contents/bot-state/sim-sessions.json?ref=main', method: 'GET', headers: { Authorization: 'Bearer tok' } });
    expect(gh.calls[1]).toMatchObject({ url: 'https://api.example.test/repos/o/private/contents/bot-state/sim-sessions.json', method: 'PUT', body: { message: 'bot-state: sim sessions', branch: 'main' } });
    expect(gh.calls[1].body?.sha).toBeUndefined();
    expect(Buffer.from(gh.calls[1].body?.content ?? '', 'base64').toString('utf8')).toBe(text);
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(gh.calls[3].body?.sha).toBe('sha1');
    // 每個請求都有期限（GitHub 卡住時不會把開機的讀檔永遠卡住）。
    for (const c of gh.calls) expect(c.signal).toBeInstanceOf(AbortSignal);
  });

  it('整條路：引擎 → 存檔 → 假的 GitHub → 重啟讀回來', async () => {
    const gh = fakeGitHub();
    const a = await restart(new GitHubSimBackend(cfg, gh.fetchImpl));
    await say(a, '/模擬 忠臣 4', DM);
    await say(a, '/派 469', DM);
    await a.persist.flush();
    const b = await restart(new GitHubSimBackend(cfg, gh.fetchImpl));
    expect(b.logs).toEqual(['restored 1 open exercises from github']);
    expect(await say(b, '/分析', DM)).toContain('你派 469');
  });
});

describe('同一個 repo 的寫入排隊（帳號庫的註冊跟機器人的狀態檔寫同一個 private repo）', () => {
  it('同一個 repo、同一個分支一次只送一個；不同的 repo 互不相干；出錯不會卡住後面的', async () => {
    const key = repoWriteKey('Owner/Private', 'main');
    expect(key).toBe(repoWriteKey('owner/private', 'MAIN'));
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) => async (): Promise<string> => {
      log.push(`${name} 開始`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`${name} 結束`);
      if (fail) throw new Error(name);
      return name;
    };
    const results = await Promise.allSettled([
      serializeRepoWrite(key, job('a', 30)),
      serializeRepoWrite(key, job('b', 5, true)),
      serializeRepoWrite(key, job('c', 1)),
      serializeRepoWrite(repoWriteKey('owner/other', 'main'), job('x', 1)),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    const same = log.filter((l) => !l.startsWith('x'));
    expect(same).toEqual(['a 開始', 'a 結束', 'b 開始', 'b 結束', 'c 開始', 'c 結束']);
    expect(log.indexOf('x 開始')).toBeLessThan(log.indexOf('a 結束'));
    // 前一個卡住：最久等 maxWaitMs，之後照樣送。
    void serializeRepoWrite(key, () => new Promise<void>(() => undefined));
    expect(await serializeRepoWrite(key, async () => 'after', 20)).toBe('after');
  });

  it('模擬瓦寫檔的時候，別的寫入（例如註冊）等它寫完才送', async () => {
    const log: string[] = [];
    let finish: () => void = () => undefined;
    const slow = (async (_url: string, init: { method?: string } = {}) => {
      if (init.method === 'PUT') {
        log.push('sim PUT 開始');
        await new Promise<void>((resolve) => { finish = resolve; });
        log.push('sim PUT 結束');
      }
      return { ok: true, status: 200, json: async () => ({ content: { sha: 's1' } }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const backend = new GitHubSimBackend({ token: 't', repo: 'o/private', branch: 'main', path: 'bot-state/sim-sessions.json', api: 'https://api.example.test' }, slow);
    const saving = backend.save('{}', null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const other = serializeRepoWrite(repoWriteKey('o/private', 'main'), async () => { log.push('註冊 PUT'); });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(log).toEqual(['sim PUT 開始']);
    finish();
    await Promise.all([saving, other]);
    expect(log).toEqual(['sim PUT 開始', 'sim PUT 結束', '註冊 PUT']);
  });
});
