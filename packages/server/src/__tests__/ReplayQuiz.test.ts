import express from 'express';
import fs from 'fs';
import path from 'path';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { BOT_GAME_CATEGORY } from '@avalon/shared/stats';
import { createReplayQuizRouter } from '../routes/replayQuiz';
import type { AccountRecord } from '../services/githubAuthAccounts';
import {
  MemoryPlayerKnightsBackend,
  PlayerKnightsStore,
} from '../services/playerKnightsStore';
import {
  buildQuizPoolFromDataset,
  computeReplayQuizStats,
  GitHubReplayQuizBackend,
  isGameOlderThanDays,
  MemoryReplayQuizBackend,
  REPLAY_QUIZ_ACTIONS,
  REPLAY_QUIZ_PATH,
  replayQuizRepoConfig,
  ReplayQuizService,
  ReplayQuizStore,
  seatLabel,
  type ReplayQuizAction,
  type ReplayQuizDataset,
} from '../services/replayQuizService';

const TEST_JWT_SECRET = 'test-replay-quiz-secret';
const FIXED_NOW = new Date('2026-11-27T12:00:00.000Z');

const DATASET_FIELDS = [
  'id', 'src', 'date', 'cat', 'slot', 'note', 'config', 'outcome', 'kill',
  'seats', 'missions', 'rounds', 'state', 'firstTeam', 'lakes', 'claims',
  'captains', 'votes', 'lineup',
] as const;

const TEST_PLAYERS = [
  'ED',
  '秘銀騎士',
  '阿瓦隆王',
  '神秘路人甲',
  '湖中仙子測試員',
  '梅林大師',
  '派西維爾專家',
  '莫甘娜幻術師',
  '莫德雷德暗影',
  '奧伯倫孤狼',
] as const;

function makeToken(payload: { sub: string; displayName: string; provider?: string }): string {
  return sign(
    { sub: payload.sub, displayName: payload.displayName, provider: payload.provider ?? 'email' },
    TEST_JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeAccount(userId: string, primaryEmail: string): AccountRecord {
  return {
    userId,
    accountName: userId,
    primaryEmail,
    emails: [primaryEmail],
    emailsVerified: [primaryEmail],
    displayName: userId,
    photoUrl: null,
  };
}

/**
 * 構造一局完整的 10 人局：
 * - config = '123456' → 1家=刺客, 2家=莫甘娜, 3家=莫德雷德, 4家=奧伯倫, 5家=派西維爾, 6家=梅林, 7~0家=忠臣
 * - ED 坐在 1家（刺客），且 0家先湖 1家、1家再湖 7家（宣告藍）
 * - 三藍死（outcome = 1），刺客 1家刺 6家（梅林）
 * - 因此 1家（ED）在單一局裡就同時涵蓋 team、vote、lakeTarget、lakeClaim、assassinate 五種動作！
 */
function makeSyntheticRow(opts: {
  id: string;
  date: string;
  catIndex?: number;
  edSeat?: number; // 1..10, default 1
}): unknown[] {
  const edSeat = opts.edSeat ?? 1;
  const seats = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
  // Put player index 0 ('ED') at edSeat - 1
  const edPos = seats.indexOf(0);
  const targetPos = edSeat - 1;
  [seats[edPos], seats[targetPos]] = [seats[targetPos], seats[edPos]];

  // src=0 → leader rotates 1, 2, 3, 4...
  // Round 1 (3): proposal 1 by seat 1 (team 156, rejected), proposal 2 by seat 2 (team 567, approved → ooo)
  // Round 2 (4): proposal 3 by seat 3 (team 5678, approved → oooo) → lake after R2: 0>1 x
  // Round 3 (4): proposal 4 by seat 4 (team 1567, approved → ooox) → lake after R3: 1>7 o (seat 1 picks 7 and claims good)
  // Round 4 (5, 2 fails needed): proposal 5 by seat 5 (team 56789, approved → ooooo)
  // Outcome: 三藍死 (1), kill = '6' (Merlin at seat 6)
  const votes: Array<[number, number, string, string]> = [
    [1, 1, '156', '156'],
    [1, 2, '567', '125678'],
    [2, 1, '5678', '156789'],
    [3, 1, '1567', '156780'],
    [4, 1, '56789', '567890'],
  ];

  return [
    opts.id,                // id
    0,                      // src (0 = 牌譜, leader starts at seat 1, lake starts at seat 10)
    opts.date,              // date
    opts.catIndex ?? 0,     // cat
    1,                      // slot
    [],                     // note
    '123456',               // config: 刺=1, 娜=2, 德=3, 奧=4, 派=5, 梅=6
    1,                      // outcome: 1 = 三藍死
    '6',                    // kill: seat 6 (Merlin)
    seats,                  // seats
    'ooo|oooo|ooox|ooooo|', // missions
    'BBRB-',                // rounds
    0,                      // state
    '156',                  // firstTeam
    '0117--',               // lakes: after R2 0>1, after R3 1>7
    '01x17o',               // claims: 0>1 evil, 1>7 good
    '2111',                 // captains
    votes,                  // votes
    [],                     // lineup
  ];
}

function makeTestDataset(): ReplayQuizDataset {
  return {
    fields: [...DATASET_FIELDS],
    vocab: {
      category: ['一般', BOT_GAME_CATEGORY],
      outcome: ['三紅', '三藍死', '三藍活'],
      noteTags: [],
    },
    players: [...TEST_PLAYERS],
    aliases: {
      'ED_ALIAS': 'ED',
    },
    games: [
      makeSyntheticRow({ id: 'GAME_OLD_SECRET_999', date: '2026-10-01' }),
      makeSyntheticRow({ id: 'GAME_TOO_RECENT_1', date: '2026-11-10' }),
      makeSyntheticRow({ id: 'GAME_EXACT_30D', date: '2026-10-28' }),
      makeSyntheticRow({ id: 'GAME_NO_DATE', date: '' }),
      makeSyntheticRow({ id: 'GAME_OLD_BOT', date: '2026-09-01', catIndex: 1 }),
    ],
  };
}

function createTestApp(opts: {
  dataset?: ReplayQuizDataset;
  now?: Date;
  accounts?: Record<string, AccountRecord | null>;
} = {}) {
  const store = new ReplayQuizStore(new MemoryReplayQuizBackend());
  const knightsStore = new PlayerKnightsStore(new MemoryPlayerKnightsBackend());
  const service = new ReplayQuizService({
    store,
    loadDataset: () => opts.dataset ?? makeTestDataset(),
    now: () => opts.now ?? FIXED_NOW,
    random: () => 0,
  });

  const accounts = opts.accounts ?? {
    'uid-admin': makeAccount('uid-admin', 'L12203685@gmail.com'),
    'uid-alice': makeAccount('uid-alice', 'alice@example.com'),
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/api/replay-quiz',
    createReplayQuizRouter({
      service,
      playerKnightsStore: knightsStore,
      disableRateLimit: true,
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        findAccountByUserId: async (uid) => accounts[uid] ?? null,
      },
    }),
  );

  return { app, service, store, knightsStore };
}

describe('ReplayQuiz — 權限控管（僅限站長）', () => {
  it('未登入、訪客與一般登入玩家皆不得存取 /next、/answer、/stats', async () => {
    const { app } = createTestApp();
    const guestToken = makeToken({ sub: 'guest-1', displayName: '訪客', provider: 'guest' });
    const userToken = makeToken({ sub: 'uid-alice', displayName: 'Alice', provider: 'email' });
    const adminToken = makeToken({ sub: 'uid-admin', displayName: 'Edward', provider: 'email' });

    // 1. 未帶 token → 401
    expect((await request(app).get('/api/replay-quiz/next')).status).toBe(401);
    expect((await request(app).get('/api/replay-quiz/stats')).status).toBe(401);
    expect((await request(app).post('/api/replay-quiz/answer').send({ questionId: 'x', answer: true })).status).toBe(401);

    // 2. 訪客 token → 401
    expect((await request(app).get('/api/replay-quiz/next').set('Authorization', `Bearer ${guestToken}`)).status).toBe(401);

    // 3. 一般非站長帳號 → 403
    expect((await request(app).get('/api/replay-quiz/next').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
    expect((await request(app).get('/api/replay-quiz/stats').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
    expect(
      (await request(app)
        .post('/api/replay-quiz/answer')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ questionId: 'x', answer: true })).status,
    ).toBe(403);

    // 4. 站長帳號 → 200
    const okRes = await request(app)
      .get('/api/replay-quiz/next')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(okRes.status).toBe(200);
    expect(okRes.body.question).toBeTruthy();
  });
});

describe('ReplayQuiz — 30 天以上舊局篩選、完全匿名化與不洩漏答案', () => {
  it('只挑選嚴格超過 30 天的非機器人歷史局，排除近期局、空日期與百科AI局', () => {
    expect(isGameOlderThanDays('2026-10-01', FIXED_NOW)).toBe(true);
    expect(isGameOlderThanDays('2026-10-27', FIXED_NOW)).toBe(true);
    expect(isGameOlderThanDays('2026-10-28', FIXED_NOW)).toBe(true); // 30d + 12h > 30d
    expect(isGameOlderThanDays('2026-10-28', new Date('2026-11-27T00:00:00.000Z'))).toBe(false);
    expect(isGameOlderThanDays('2026-11-10', FIXED_NOW)).toBe(false);
    expect(isGameOlderThanDays('', FIXED_NOW)).toBe(false);

    const ds = makeTestDataset();
    const pool = buildQuizPoolFromDataset(ds, 'ED', { now: new Date('2026-11-27T00:00:00.000Z') });
    expect(pool.length).toBeGreaterThan(0);
    // 全部題目都只能來自 GAME_OLD_SECRET_999
    expect(new Set(pool.map((item) => item.gameId))).toEqual(new Set(['GAME_OLD_SECRET_999']));
    // 涵蓋全部 5 種動作
    const actions = new Set(pool.map((item) => item.question.action));
    expect(actions).toEqual(new Set<ReplayQuizAction>(['team', 'vote', 'lakeTarget', 'lakeClaim', 'assassinate']));

    // 透過 alias 查詢也能對應到同一位玩家
    const aliasPool = buildQuizPoolFromDataset(ds, 'ED_ALIAS', { now: new Date('2026-11-27T00:00:00.000Z') });
    expect(aliasPool.length).toBe(pool.length);
  });

  it('題目 payload 將所有名字完全換成座位（1家～9家、0家），且絕不洩漏真實答案、對局 ID 或日期', async () => {
    expect(seatLabel(1)).toBe('1家');
    expect(seatLabel(9)).toBe('9家');
    expect(seatLabel(10)).toBe('0家');

    const { app } = createTestApp({ now: new Date('2026-11-27T00:00:00.000Z') });
    const adminToken = makeToken({ sub: 'uid-admin', displayName: 'Edward' });

    for (const action of REPLAY_QUIZ_ACTIONS) {
      const res = await request(app)
        .get(`/api/replay-quiz/next?action=${action}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const q = res.body.question;
      expect(q).toBeTruthy();
      expect(q.action).toBe(action);

      const serialized = JSON.stringify(q);
      // 所有玩家名字都不得出現在題目 payload 裡
      for (const name of TEST_PLAYERS) {
        expect(serialized).not.toContain(name);
      }
      // 不得洩漏對局 ID、日期、真實答案欄位
      expect(serialized).not.toContain('GAME_OLD_SECRET_999');
      expect(serialized).not.toContain('2026-10-01');
      expect(q).not.toHaveProperty('actualAnswer');
      expect(q).not.toHaveProperty('actualAnswerLabel');
      expect(q).not.toHaveProperty('assassinTargetSeat');
      expect(q).not.toHaveProperty('gameId');
      expect(q).not.toHaveProperty('gameDate');

      // 座位表包含 1家～9家、0家
      expect(q.seats.map((s: { label: string }) => s.label)).toEqual([
        '1家', '2家', '3家', '4家', '5家', '6家', '7家', '8家', '9家', '0家',
      ]);
    }
  });
});

describe('ReplayQuiz — 作答、理由紀錄與逐動作一致率統計', () => {
  it('逐動作送出作答並驗證一致率計算與不重複出題', async () => {
    const { app } = createTestApp({ now: new Date('2026-11-27T00:00:00.000Z') });
    const adminToken = makeToken({ sub: 'uid-admin', displayName: 'Edward' });

    // 1. team（歷史：1家派 1,5,6）→ 答對 [1, 5, 6]
    const teamQ = (await request(app)
      .get('/api/replay-quiz/next?action=team')
      .set('Authorization', `Bearer ${adminToken}`)).body.question;
    const teamAns = await request(app)
      .post('/api/replay-quiz/answer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ questionId: teamQ.questionId, answer: [6, 1, 5], reason: '帶自己與疑似藍方' });
    expect(teamAns.status).toBe(200);
    expect(teamAns.body.matched).toBe(true);
    expect(teamAns.body.actualAnswer).toEqual([1, 5, 6]);
    expect(teamAns.body.actualAnswerLabel).toBe('1家、5家、6家');
    expect(teamAns.body.gameDate).toBe('2026-10-01');
    expect(teamAns.body.record.reason).toBe('帶自己與疑似藍方');

    // 2. vote（R1-1 歷史：1家贊成 true）→ 故意答錯 false
    const voteQ = (await request(app)
      .get('/api/replay-quiz/next?action=vote')
      .set('Authorization', `Bearer ${adminToken}`)).body.question;
    const voteAns = await request(app)
      .post('/api/replay-quiz/answer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ questionId: voteQ.questionId, answer: false });
    expect(voteAns.status).toBe(200);
    expect(voteAns.body.matched).toBe(false);
    expect(voteAns.body.actualAnswer).toBe(true);

    // 3. lakeTarget（歷史：1家驗 7家）→ 答對 7
    const lakeTargetQ = (await request(app)
      .get('/api/replay-quiz/next?action=lakeTarget')
      .set('Authorization', `Bearer ${adminToken}`)).body.question;
    expect(lakeTargetQ.validTargetSeats).toContain(7);
    const lakeTargetAns = await request(app)
      .post('/api/replay-quiz/answer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ questionId: lakeTargetQ.questionId, answer: 7 });
    expect(lakeTargetAns.status).toBe(200);
    expect(lakeTargetAns.body.matched).toBe(true);

    // 4. lakeClaim（歷史：1家驗 7家藍方，宣告 'good'）→ 故意答錯 'evil'
    const lakeClaimQ = (await request(app)
      .get('/api/replay-quiz/next?action=lakeClaim')
      .set('Authorization', `Bearer ${adminToken}`)).body.question;
    expect(lakeClaimQ.inspectedTargetSeat).toBe(7);
    expect(lakeClaimQ.inspectedTargetLabel).toBe('7家');
    expect(lakeClaimQ.inspectedResult).toBe('good');
    const lakeClaimAns = await request(app)
      .post('/api/replay-quiz/answer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ questionId: lakeClaimQ.questionId, answer: 'evil', reason: '想發查殺混水' });
    expect(lakeClaimAns.status).toBe(200);
    expect(lakeClaimAns.body.matched).toBe(false);
    expect(lakeClaimAns.body.actualAnswer).toBe('good');

    // 5. assassinate（歷史：1家刺 6家梅林）→ 答對 6
    const killQ = (await request(app)
      .get('/api/replay-quiz/next?action=assassinate')
      .set('Authorization', `Bearer ${adminToken}`)).body.question;
    expect(killQ.validTargetSeats).toEqual([5, 6, 7, 8, 9, 10]);
    expect(killQ.vision.allEvilSeats).toEqual([1, 2, 3, 4]);
    const killAns = await request(app)
      .post('/api/replay-quiz/answer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ questionId: killQ.questionId, answer: 6 });
    expect(killAns.status).toBe(200);
    expect(killAns.body.matched).toBe(true);

    // 驗證統計：整體 3/5 = 0.6，逐動作精準對應
    const statsRes = await request(app)
      .get('/api/replay-quiz/stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.stats.overall).toEqual({ answered: 5, matched: 3, rate: 0.6 });
    expect(statsRes.body.stats.byAction.team).toEqual({ answered: 1, matched: 1, rate: 1 });
    expect(statsRes.body.stats.byAction.vote).toEqual({ answered: 1, matched: 0, rate: 0 });
    expect(statsRes.body.stats.byAction.lakeTarget).toEqual({ answered: 1, matched: 1, rate: 1 });
    expect(statsRes.body.stats.byAction.lakeClaim).toEqual({ answered: 1, matched: 0, rate: 0 });
    expect(statsRes.body.stats.byAction.assassinate).toEqual({ answered: 1, matched: 1, rate: 1 });
    expect(statsRes.body.recent.length).toBe(5);
    expect(statsRes.body.recent.some((r: { reason?: string }) => r.reason === '帶自己與疑似藍方')).toBe(true);

    // team 題已答完，再取 team 應回 question: null
    const nextTeam = await request(app)
      .get('/api/replay-quiz/next?action=team')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(nextTeam.body.question).toBeNull();
    expect(nextTeam.body.remainingCount).toBe(0);
  });

  it('computeReplayQuizStats 對空陣列回傳 rate: null', () => {
    const empty = computeReplayQuizStats([]);
    expect(empty.overall).toEqual({ answered: 0, matched: 0, rate: null });
    for (const a of REPLAY_QUIZ_ACTIONS) {
      expect(empty.byAction[a]).toEqual({ answered: 0, matched: 0, rate: null });
    }
  });
});

describe('ReplayQuiz — GitHubJsonFile 私人儲存設定與 409 合併', () => {
  it('沿用 GITHUB_ACCOUNTS_* 且不新增環境變數，指向 bot-state/replay-quiz.json', () => {
    expect(replayQuizRepoConfig({})).toBeNull();
    const cfg = replayQuizRepoConfig({
      GITHUB_ACCOUNTS_TOKEN: 'ghp_secret',
      GITHUB_ACCOUNTS_REPO: 'l12203685/private-state',
      GITHUB_ACCOUNTS_BRANCH: 'main',
    });
    expect(cfg).toEqual({
      token: 'ghp_secret',
      repo: 'l12203685/private-state',
      branch: 'main',
      path: REPLAY_QUIZ_PATH,
      api: 'https://api.github.com',
    });
    expect(REPLAY_QUIZ_PATH).toBe('bot-state/replay-quiz.json');
  });

  it('寫入遇 409 衝突時會重新讀取遠端並合併雙邊作答紀錄', async () => {
    let remote = {
      version: 1,
      updatedAt: '2026-11-27T01:00:00.000Z',
      answers: [
        {
          id: 'remote-1',
          questionId: 'q-remote',
          gameId: 'G1',
          gameDate: '2026-09-01',
          playerId: 'ED',
          adminEmail: 'l12203685@gmail.com',
          uid: 'uid-admin',
          seat: 1,
          role: 'merlin',
          action: 'vote',
          userAnswer: true,
          actualAnswer: true,
          matched: true,
          answeredAt: '2026-11-27T01:00:00.000Z',
        },
      ],
    };
    let sha = 'sha-v1';
    let firstPut = true;

    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        const content = Buffer.from(JSON.stringify(remote)).toString('base64');
        return new Response(JSON.stringify({ sha, content }), { status: 200 });
      }
      if (firstPut) {
        firstPut = false;
        return new Response(JSON.stringify({ message: 'conflict' }), { status: 409 });
      }
      const parsedBody = JSON.parse(String(init?.body ?? '{}')) as { content: string };
      remote = JSON.parse(Buffer.from(parsedBody.content, 'base64').toString('utf8'));
      sha = 'sha-v2';
      return new Response(JSON.stringify({ content: { sha } }), { status: 200 });
    });

    const backend = new GitHubReplayQuizBackend(
      {
        token: 'tok',
        repo: 'owner/private',
        branch: 'main',
        path: REPLAY_QUIZ_PATH,
        api: 'https://api.github.example',
      },
      fakeFetch as unknown as typeof fetch,
    );

    const store = new ReplayQuizStore(backend);
    await store.appendAnswer({
      id: 'local-1',
      questionId: 'q-local',
      gameId: 'G2',
      gameDate: '2026-09-02',
      playerId: 'ED',
      adminEmail: 'l12203685@gmail.com',
      uid: 'uid-admin',
      seat: 2,
      role: 'assassin',
      action: 'assassinate',
      userAnswer: 6,
      actualAnswer: 6,
      matched: true,
      answeredAt: '2026-11-27T02:00:00.000Z',
    });

    expect(remote.answers.map((a) => a.id)).toEqual(['remote-1', 'local-1']);
  });
});

describe('ReplayQuiz — 真實 games_cache.json 冒煙測試', () => {
  it('能從 repo 內的 games_cache.json 抽出 ED 超過 30 天的匿名題庫', () => {
    const datasetPath = path.resolve(__dirname, '..', '..', 'games_cache.json');
    if (!fs.existsSync(datasetPath)) return;
    const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8')) as ReplayQuizDataset;
    const pool = buildQuizPoolFromDataset(dataset, 'ED', { now: FIXED_NOW });
    expect(pool.length).toBeGreaterThan(100);
    for (const item of pool.slice(0, 20)) {
      expect(isGameOlderThanDays(item.gameDate, FIXED_NOW)).toBe(true);
      const text = JSON.stringify(item.question);
      expect(text).not.toContain('"ED"');
      expect(text).not.toContain(item.gameId);
    }
  });
});
