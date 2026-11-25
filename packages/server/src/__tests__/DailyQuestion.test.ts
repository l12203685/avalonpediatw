/**
 * /每日一題（2026-11-25，bots/dailyQuestion）：指令解析、回覆文字、讀取（快取、等太久、讀不到）、
 * Discord 斜線指令、以及用 repo 裡真的題庫跑幾天（題目跟 Threads 草稿同一套選法）。
 * 不連網：GitHub 的輸入一律用假的（空的選題、沒有存下來的草稿）。回覆裡沒有任何人的名字。
 */
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS, DAILY_QUESTION_OPTIONS } from '../bots/discord/config';
import { buildSlashCommands } from '../bots/discord/client';
import { RELAYED_DISCORD_COMMANDS } from '../bots/discord/replyRelay';
import {
  DAILY_QUESTION_HELP_TEXT,
  DAILY_QUESTION_LOADING_TEXT,
  DAILY_QUESTION_RETRY_MS,
  DAILY_QUESTION_TTL_MS,
  DAILY_QUESTION_UNAVAILABLE_TEXT,
  DAILY_QUESTION_USAGE,
  DAILY_QUESTION_USAGE_HINT,
  DAILY_QUESTION_YESTERDAY_LOADING_TEXT,
  DAILY_QUESTION_YESTERDAY_UNAVAILABLE_TEXT,
  YESTERDAY_STATE_DAYS,
  __resetDailyQuestionForTests,
  answerDailyQuestion,
  answerDailyQuestionTextCommand,
  dailyQuestionOf,
  dateLabel,
  formatDailyQuestion,
  formatDailyQuestionLoad,
  formatNoDailyQuestion,
  isDailyQuestionCommandText,
  loadDailyQuestion,
  loadYesterdayAnswer,
  dailyQuestionDayOf,
  formatNoYesterdayQuestion,
  formatYesterdayAnswer,
  formatYesterdayLoad,
  parseDailyQuestionCommand,
  parseDailyQuestionText,
  seatName,
  yesterdayAnswerOf,
  type DailyQuestion,
  type DailyQuestionDeps,
  type YesterdayAnswer,
} from '../bots/dailyQuestion/commands';
import { handleDailyQuestionCommand } from '../bots/dailyQuestion/discordCommand';
import { fetchThreadsInputs, type ThreadsInputs, type ThreadsStateLike } from '../bots/conceptDaily/threadsToday';
import { basicHelpText, parseHelpCommand, topicHelpText } from '../bots/help';
import { __setSimForTests } from '../bots/simulation';
import { SimBankLoader, buildSimBank, readSimBankFile, type SimBank } from '../bots/simulation/bank';
import { normalizeExerciseId, parseSimCommand } from '../bots/simulation/commands';
import { SIM_CONFIG } from '../bots/simulation/config';
import { readRecordPosts } from '../bots/simulation/recordsIndex';
import { getFeedbackService } from '../bots/feedback/service';
import { hookQuestion } from '../bots/threads/draft';
import { addDays, weekdayOf } from '../bots/threads/plan';

const NO_INPUTS: ThreadsInputs = { picks: new Map(), liveFrom: null, states: new Map() };
/** 2026-11-25 12:00 台北。 */
const NOON = Date.UTC(2026, 10, 25, 4, 0, 0);

const SAMPLE: DailyQuestion = {
  date: '2026-11-25',
  exerciseId: 'K7Q2M-1-5',
  question: '第 1 局前四隊都沒過，最後一隊輪到你派，派誰？',
  seat: 10,
  role: 'loyal',
  assassin: false,
  recordUrl: 'https://avalon-game-platform.web.app/#records=123456789012345678&upto=4&seat=0',
};

beforeEach(() => {
  __resetDailyQuestionForTests();
});

afterEach(() => {
  __resetDailyQuestionForTests();
  __setSimForTests({ loader: null, engine: null });
  SIM_CONFIG.commandsEnabled = true;
  vi.useRealTimers();
});

describe('parseDailyQuestionText', () => {
  it.each(['/每日一題', '／每日一題', '/今日一題', '/ 每日一題', '/每日一题', '/每日一題 ', '/每日一題 今天'])('%s is the command', (text) => {
    expect(parseDailyQuestionText(text)).toBe(true);
    expect(isDailyQuestionCommandText(text)).toBe(true);
  });
  it.each(['每日一題', '/每日一題好難', '今天的 /每日一題 看了嗎', '/每日', '/一題', '', '/模擬 今天'])('%s is not', (text) => {
    expect(parseDailyQuestionText(text)).toBe(false);
  });
  it('is not counted as a community topic (it is a lookup, like /戰績)', () => {
    expect(getFeedbackService().observe('line', '/每日一題')).toEqual([]);
  });
});

describe('texts', () => {
  it('date and seat wording: 11/25 週三, N家, 0家 for the tenth seat', () => {
    expect(dateLabel('2026-11-25')).toBe('11/25 週三');
    expect(dateLabel('2026-12-06')).toBe('12/6 週日');
    expect(seatName(3)).toBe('3家');
    expect(seatName(10)).toBe('0家');
  });

  it('LINE: title, the question, who you are + 題號, the record cut at the decision, how to answer here', () => {
    expect(formatDailyQuestion(SAMPLE, 'line').split('\n')).toEqual([
      '📌 阿瓦隆每日一題（11/25 週三）',
      '第 1 局前四隊都沒過，最後一隊輪到你派，派誰？',
      '你是 0家 忠臣｜題號 K7Q2M-1-5',
      '牌譜（只到出題那一刻）：https://avalon-game-platform.web.app/#records=123456789012345678&upto=4&seat=0',
      '在這裡作答：/模擬 K7Q2M-1-5 → /派 座位（例 /派 469）→ /公布 對答案',
    ]);
  });

  it('the answer line is a command the bot really understands', () => {
    const text = formatDailyQuestion(SAMPLE, 'line');
    const cmd = /(\/模擬 \S+)/u.exec(text)?.[1] ?? '';
    expect(parseSimCommand(cmd)).toEqual({ kind: 'start', exerciseId: 'K7Q2M-1-5' });
    const kill = formatDailyQuestion({ ...SAMPLE, exerciseId: 'K7Q2M-A', assassin: true, role: 'assassin' }, 'line');
    expect(parseSimCommand(/(\/模擬 \S+)/u.exec(kill)?.[1] ?? '')).toEqual({ kind: 'start', exerciseId: 'K7Q2M-A' });
    expect(kill).toContain('→ /刺 座位 →');
    expect(kill).toContain('你是 0家 刺客');
  });

  it('Discord: the same lines, the answer line in slash-option wording', () => {
    const lines = formatDailyQuestion(SAMPLE, 'discord').split('\n');
    expect(lines.slice(0, 4)).toEqual(formatDailyQuestion(SAMPLE, 'line').split('\n').slice(0, 4));
    expect(lines.at(-1)).toBe('在這裡作答：/模擬 題號:K7Q2M-1-5 → /派 隊伍:座位 → /公布 對答案');
    expect(formatDailyQuestion({ ...SAMPLE, assassin: true }, 'discord')).toContain('/刺 座位:幾家');
  });

  it('the Threads link only once the post is out; no record page → says so; 模擬瓦 off → no answer line', () => {
    const withPost = formatDailyQuestion({ ...SAMPLE, threadsUrl: 'https://www.threads.com/@example/post/abc' }, 'line');
    expect(withPost).toContain('Threads 貼文：https://www.threads.com/@example/post/abc');
    expect(formatDailyQuestion(SAMPLE, 'line')).not.toContain('Threads 貼文');
    expect(formatDailyQuestion({ ...SAMPLE, recordUrl: null }, 'line')).toContain('牌譜：網站上沒有這一局的牌譜頁');
    expect(formatDailyQuestion(SAMPLE, 'line', { simEnabled: false })).not.toContain('/模擬');
    expect(formatDailyQuestion({ ...SAMPLE, question: null }, 'line').split('\n')[1]).toBe('你是 0家 忠臣｜題號 K7Q2M-1-5');
  });

  it('no question today / still loading / unreadable: one plain line each, never an error dump', () => {
    expect(formatNoDailyQuestion('2026-11-25')).toBe('今天（11/25 週三）沒有每日一題。想練習可以打 /模擬 今天（照每週主題出一題）。');
    expect(formatNoDailyQuestion('2026-11-25', { simEnabled: false })).toBe('今天（11/25 週三）沒有每日一題。');
    expect(formatDailyQuestionLoad({ kind: 'loading' }, 'line')).toBe(DAILY_QUESTION_LOADING_TEXT);
    expect(formatDailyQuestionLoad({ kind: 'unavailable' }, 'discord')).toBe(DAILY_QUESTION_UNAVAILABLE_TEXT);
    for (const t of [DAILY_QUESTION_LOADING_TEXT, DAILY_QUESTION_UNAVAILABLE_TEXT]) {
      expect(t).toContain('/每日一題');
      expect(t.split('\n')).toHaveLength(1);
    }
  });

  it('is listed in /help (both platforms) and has its own topic', () => {
    for (const p of ['line', 'discord'] as const) expect(basicHelpText(p)).toContain(`${DAILY_QUESTION_USAGE}\u3000今天的每日一題`);
    expect(parseHelpCommand('/help 每日一題')?.topic).toBe('每日一題');
    expect(parseHelpCommand('/help 今日一題')?.topic).toBe('每日一題');
    expect(topicHelpText('每日一題', 'line')).toContain(`📌 /每日一題\u3000${DAILY_QUESTION_HELP_TEXT}`);
    SIM_CONFIG.commandsEnabled = false;
    expect(topicHelpText('每日一題', 'line')).not.toContain('/模擬');
  });
});

describe('loadDailyQuestion', () => {
  const found = (): DailyQuestionDeps & { bankCalls: number; inputCalls: number } => {
    const deps = {
      bankCalls: 0,
      inputCalls: 0,
      now: () => NOON,
      bank: async () => {
        deps.bankCalls += 1;
        return null;
      },
      inputs: async () => {
        deps.inputCalls += 1;
        return NO_INPUTS;
      },
    };
    return deps;
  };

  it('no bank → unavailable, without asking GitHub; retried after a minute, not before', async () => {
    const deps = found();
    let now = NOON;
    deps.now = () => now;
    expect(await loadDailyQuestion(deps)).toEqual({ kind: 'unavailable' });
    expect(deps.inputCalls).toBe(0);
    expect(await loadDailyQuestion(deps)).toEqual({ kind: 'unavailable' });
    expect(deps.bankCalls).toBe(1);
    now += DAILY_QUESTION_RETRY_MS + 1;
    await loadDailyQuestion(deps);
    expect(deps.bankCalls).toBe(2);
  });

  it('a throwing loader becomes unavailable (never rejects, logs the error kind only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const load = await loadDailyQuestion({ now: () => NOON, bank: async () => { throw new TypeError('secret-ish detail'); } });
    expect(load).toEqual({ kind: 'unavailable' });
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-ish detail');
    warn.mockRestore();
  });

  it('slower than waitMs → loading now, the answer on the next call (one load only)', async () => {
    let release: (b: null) => void = () => undefined;
    let calls = 0;
    const deps: DailyQuestionDeps = {
      now: () => NOON,
      bank: () => {
        calls += 1;
        return new Promise<null>((resolve) => { release = resolve; });
      },
    };
    expect(await loadDailyQuestion(deps, 20)).toEqual({ kind: 'loading' });
    const second = loadDailyQuestion(deps, 5000);
    release(null);
    expect(await second).toEqual({ kind: 'unavailable' });
    expect(calls).toBe(1);
  });

  it('typed command: null for other text; the reply for the command', async () => {
    const deps = found();
    expect(await answerDailyQuestionTextCommand('/戰績 測試玩家甲', 'line', deps)).toBeNull();
    expect(deps.bankCalls).toBe(0);
    expect(await answerDailyQuestionTextCommand('/每日一題', 'line', deps)).toBe(DAILY_QUESTION_UNAVAILABLE_TEXT);
  });
});

describe('with the real question bank (sim_bank.json + records_cache.json, no network)', () => {
  const root = path.resolve(__dirname, '..', '..');
  let bank: SimBank;
  const realBank = (): SimBank => {
    if (!bank) {
      const posts = readRecordPosts([path.join(root, 'records_cache.json')]);
      const file = readSimBankFile([path.join(root, 'sim_bank.json')]);
      if (!file || !posts) throw new Error('sim_bank.json / records_cache.json missing');
      bank = buildSimBank(file, posts);
    }
    return bank;
  };

  it('two weeks of days: every reply is a well-formed question (no names, 題號 the bot can open, record cut at the decision)', async () => {
    let date = '2026-11-23';
    let seen = 0;
    const kinds = new Set<string>();
    for (let i = 0; i < 14; i++) {
      __resetDailyQuestionForTests();
      const [y, m, d] = date.split('-').map(Number);
      const deps: DailyQuestionDeps = { now: () => Date.UTC(y, m - 1, d, 4, 0, 0), bank: async () => realBank(), inputs: async () => NO_INPUTS };
      const load = await loadDailyQuestion(deps);
      expect(['found', 'none']).toContain(load.kind);
      if (load.kind === 'found') {
        seen += 1;
        const q = load.question;
        expect(q.date).toBe(date);
        expect(normalizeExerciseId(q.exerciseId)).toBe(q.exerciseId);
        expect(q.assassin).toBe(q.exerciseId.endsWith('-A'));
        if (q.assassin) expect(q.role).toBe('assassin');
        kinds.add(q.assassin ? 'assassin' : 'proposal');
        // /模擬 題號 坐的是那一次派票的隊長：要跟題目說的「你是 N家」同一個人，在這裡作答才是同一題。
        const spot = /^([0-9A-Z]+)-([1-5])-([1-5])$/.exec(q.exerciseId);
        if (spot) {
          const game = realBank().games[realBank().byId.get(spot[1]) as number];
          const proposal = game.proposals.find((p) => p.round === Number(spot[2]) && p.attempt === Number(spot[3]));
          expect(proposal?.leaderSeat).toBe(q.seat);
          expect(game.seatRoles[q.seat - 1]).toBe(q.role);
        }
        const lines = formatDailyQuestion(q, 'line').split('\n');
        expect(lines[0]).toBe(`📌 阿瓦隆每日一題（${dateLabel(date)}）`);
        expect(lines[1]).toBe(q.question);
        expect(lines[2]).toMatch(/^你是 [0-9]家 (梅林|派西維爾|忠臣|刺客|莫甘娜|莫德雷德|奧伯倫)｜題號 [0-9A-Z]{5,8}-(?:A|[1-5]-[1-5])$/u);
        expect(lines[3]).toMatch(/^牌譜（只到出題那一刻）：https:\/\/avalon-game-platform\.web\.app\/#records=[0-9A-Za-z]+&upto=(?:A|\d+)&seat=[0-9]$|^牌譜：網站上沒有這一局的牌譜頁$/u);
        expect(lines[4]).toMatch(/^在這裡作答：\/模擬 \S+ → \/(派|刺) /u);
        expect(lines).toHaveLength(5);
      }
      date = addDays(date, 1);
    }
    expect(seen).toBeGreaterThanOrEqual(10);
    expect(kinds).toEqual(new Set(['assassin', 'proposal']));
  }, 60_000);

  it('the question line is the first line of the Threads post (hookQuestion), per theme', () => {
    expect(dailyQuestionOf('2026-11-25', {
      exerciseId: 'K7Q2M-1-5',
      exercise: { decision: '派隊', round: 1, attempt: 5, seat: 5, role: 'loyal', score: '0:0', lakeHolder: false, lastQuestMember: null, lastQuestFails: null, thumbsLed: null },
      recordUrl: null,
      question: hookQuestion({ kind: 'tail', round: 1 }),
    })).toEqual({
      date: '2026-11-25', exerciseId: 'K7Q2M-1-5', question: '第 1 局前四隊都沒過，最後一隊輪到你派，派誰？', seat: 5, role: 'loyal', assassin: false, recordUrl: null,
    });
  });

  it('a found question is kept for ten minutes, then read again', async () => {
    let now = NOON;
    let calls = 0;
    const deps: DailyQuestionDeps = { now: () => now, bank: async () => { calls += 1; return realBank(); }, inputs: async () => NO_INPUTS };
    const first = await loadDailyQuestion(deps);
    expect(first.kind).toBe('found');
    now += DAILY_QUESTION_TTL_MS - 1000;
    expect(await loadDailyQuestion(deps)).toBe(first);
    expect(calls).toBe(1);
    now += 2000;
    await loadDailyQuestion(deps);
    expect(calls).toBe(2);
  }, 60_000);
});

describe('/每日一題 昨天（2026-11-25 第二批）：指令與回覆文字', () => {
  const ANSWER: YesterdayAnswer = {
    date: '2026-11-24',
    exerciseId: 'K7Q2M-3-4',
    question: '你是派西維爾，兩根拇指分不出誰是梅林，這一隊派誰？',
    seat: 10,
    role: 'percival',
    lines: ['真人（0家・派西維爾）派 C 4789：1 好 3 壞，沒有出發', '角色 刺9娜7莫8奧5派0梅3（紅 5 7 8 9）｜三紅', '牌譜：https://avalon-game-platform.web.app/#records=123456789012345678'],
    held: false,
  };

  it.each([
    ['/每日一題', 'today'],
    ['/每日一題 今天', 'today'],
    ['／今日一題 今日', 'today'],
    ['/每日一題 昨天', 'yesterday'],
    ['／每日一題　昨天', 'yesterday'],
    ['/每日一題 昨日', 'yesterday'],
    ['/每日一題昨天', 'yesterday'],
    ['/今日一題 昨天', 'yesterday'],
    ['/每日一题 昨天 ', 'yesterday'],
  ] as const)('%s → %s', (text, day) => {
    expect(parseDailyQuestionCommand(text)).toEqual({ day });
  });

  it.each(['/每日一題 前天', '/每日一題 答案', '/每日一題 昨天 的答案', '/每日一題 11/24', '/每日一題 測試玩家甲'])('%s → the usage line (fixed text, nothing typed is echoed)', async (text) => {
    expect(parseDailyQuestionCommand(text)).toEqual({ usage: true });
    expect(parseDailyQuestionText(text)).toBe(true);
    let asked = 0;
    const deps: DailyQuestionDeps = { bank: async () => { asked += 1; return null; } };
    expect(await answerDailyQuestionTextCommand(text, 'line', deps)).toBe(DAILY_QUESTION_USAGE_HINT);
    expect(asked).toBe(0);
  });

  it('the usage line names both forms and says today has no answer yet', () => {
    expect(DAILY_QUESTION_USAGE_HINT).toBe('用法：/每日一題（今天的題目）、/每日一題 昨天（昨天的題目和答案）。今天的答案明天才看得到。');
    expect(DAILY_QUESTION_USAGE_HINT).not.toContain('測試玩家甲');
  });

  it.each(['/每日一題好難', '/每日一題昨天的呢', '每日一題 昨天', '/昨天'])('%s is chatter, not the command', (text) => {
    expect(parseDailyQuestionCommand(text)).toBeNull();
  });

  it('the reply: yesterday in the title, the question, who you were + 題號, the answer lines, how to see today', () => {
    expect(formatYesterdayAnswer(ANSWER).split('\n')).toEqual([
      '📌 阿瓦隆每日一題・昨天（11/24 週二）的答案',
      '你是派西維爾，兩根拇指分不出誰是梅林，這一隊派誰？',
      '你是 0家 派西維爾｜題號 K7Q2M-3-4',
      ...ANSWER.lines,
      '今天的題目：/每日一題',
    ]);
    expect(formatYesterdayAnswer(ANSWER)).not.toMatch(/10\s*家/u);
  });

  it('no question yesterday / still loading / unreadable', () => {
    expect(formatNoYesterdayQuestion('2026-11-24')).toBe('昨天（11/24 週二）沒有每日一題。今天的題目：/每日一題');
    expect(formatYesterdayLoad({ kind: 'none', date: '2026-11-24' })).toBe(formatNoYesterdayQuestion('2026-11-24'));
    expect(formatYesterdayLoad({ kind: 'loading' })).toBe(DAILY_QUESTION_YESTERDAY_LOADING_TEXT);
    expect(DAILY_QUESTION_YESTERDAY_LOADING_TEXT).toContain('/每日一題 昨天');
    expect(formatYesterdayLoad({ kind: 'unavailable' })).toBe(DAILY_QUESTION_YESTERDAY_UNAVAILABLE_TEXT);
    expect(formatYesterdayLoad({ kind: 'found', answer: ANSWER })).toBe(formatYesterdayAnswer(ANSWER));
  });

  it('help: both platforms say how to see yesterday', () => {
    expect(topicHelpText('每日一題', 'line')).toContain('/每日一題 昨天　昨天的題目和答案');
    expect(topicHelpText('每日一題', 'discord')).toContain('/每日一題 哪一天:昨天　昨天的題目和答案');
    expect(basicHelpText('line')).toContain('（/每日一題 昨天 看昨天的答案）');
  });
});

describe('/每日一題 昨天 with the real question bank (no network)', () => {
  const root = path.resolve(__dirname, '..', '..');
  let bank: SimBank;
  const realBank = (): SimBank => {
    if (!bank) {
      const posts = readRecordPosts([path.join(root, 'records_cache.json')]);
      const file = readSimBankFile([path.join(root, 'sim_bank.json')]);
      if (!file || !posts) throw new Error('sim_bank.json / records_cache.json missing');
      bank = buildSimBank(file, posts);
    }
    return bank;
  };
  const noonOf = (date: string): number => {
    const [y, m, d] = date.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 4, 0, 0);
  };
  /** 那幾天都真的有貼文（自動發佈開著時 threads-state 的樣子）。 */
  const posted = (...dates: string[]): ThreadsInputs => ({
    picks: new Map(),
    liveFrom: null,
    states: new Map<string, ThreadsStateLike | null>(dates.map((d) => [d, { postId: 'p' }])),
    unread: new Set(),
  });
  const FULL_PROPOSAL = /^真人（[0-9]家・(?:梅林|派西維爾|忠臣|刺客|莫甘娜|莫德雷德|奧伯倫)）派 (?:[ABC] )?[0-9]{3,5}：\d 好 \d 壞，(?:[ox]+ 任務(?:成功|失敗)|沒有出發|出發)$/u;
  const FULL_ASSASSIN = /^梅林是 (?:[ABC] )?[0-9]家(?:；真人刺 (?:[ABC] )?[0-9]家（(?:刺中|沒刺中)）)?$/u;
  const HELD_PROPOSAL = /^真人（[0-9]家）派 (?:[ABC] )?[0-9]{3,5}，(?:[ox]+ 任務(?:成功|失敗)|沒有出發|出發)$/u;
  const HELD_NOTE = '幾好幾壞和角色明天公布（今天同一局接著打）';

  it('two weeks of days (no posts yet, as today): yesterday is the question /每日一題 showed the day before, with the full answer', async () => {
    let date = '2026-11-24';
    let seen = 0;
    const kinds = new Set<string>();
    for (let i = 0; i < 14; i++) {
      __resetDailyQuestionForTests();
      const before: DailyQuestionDeps = { now: () => noonOf(addDays(date, -1)), bank: async () => realBank(), inputs: async () => NO_INPUTS };
      const shown = await loadDailyQuestion(before);
      __resetDailyQuestionForTests();
      const days: (number | undefined)[] = [];
      const deps: DailyQuestionDeps = { now: () => noonOf(date), bank: async () => realBank(), inputs: async (_d, n) => { days.push(n); return NO_INPUTS; } };
      const load = await loadYesterdayAnswer(deps);
      expect(days).toEqual([YESTERDAY_STATE_DAYS]);
      expect(load.kind).toBe(shown.kind === 'found' ? 'found' : 'none');
      if (load.kind === 'found' && shown.kind === 'found') {
        seen += 1;
        const a = load.answer;
        // 昨天的答案講的就是昨天 /每日一題 說的那一題。
        expect(a.date).toBe(addDays(date, -1));
        expect([a.exerciseId, a.question, a.seat, a.role]).toEqual([shown.question.exerciseId, shown.question.question, shown.question.seat, shown.question.role]);
        // 沒有貼文 → 每天都是獨立的一題 → 完整公布。
        expect(a.held).toBe(false);
        const assassin = a.exerciseId.endsWith('-A');
        kinds.add(assassin ? 'assassin' : 'proposal');
        const lines = formatYesterdayAnswer(a).split('\n');
        expect(lines[0]).toBe(`📌 阿瓦隆每日一題・昨天（${dateLabel(a.date)}）的答案`);
        expect(lines[1]).toBe(a.question);
        expect(lines[2]).toMatch(/^你是 [0-9]家 (梅林|派西維爾|忠臣|刺客|莫甘娜|莫德雷德|奧伯倫)｜題號 [0-9A-Z]{5,8}-(?:A|[1-5]-[1-5])$/u);
        expect(lines[3]).toMatch(assassin ? FULL_ASSASSIN : FULL_PROPOSAL);
        expect(lines[4]).toMatch(/^三個選項：A .+｜B .+｜C .+$/u);
        expect(lines[5]).toMatch(/^角色 刺[0-9]娜[0-9]莫[0-9]奧[0-9]派[0-9]梅[0-9]（紅 [0-9] [0-9] [0-9] [0-9]）｜三(?:紅|藍死|藍活)/u);
        expect(lines[6]).toMatch(/^牌譜：https:\/\/avalon-game-platform\.web\.app\/#records=[0-9A-Za-z]+$|^（網站上還沒有這一局的牌譜頁）$/u);
        expect(lines[7]).toBe('今天的題目：/每日一題');
        expect(lines).toHaveLength(8);
        // 群裡不放貼文那一行很長的純邏輯理由，也不重複貼文的「[昨天 … 的答案]」。
        expect(lines.join('\n')).not.toMatch(/純邏輯|\[昨天 /u);
        expect(lines.join('\n')).not.toMatch(/10\s*家|undefined|null|NaN/u);
        // 整局牌譜是完整的那一頁（今天的題目的連結才有 &upto=）。
        expect(lines[6]).not.toContain('&upto=');
      }
      date = addDays(date, 1);
    }
    expect(seen).toBeGreaterThanOrEqual(10);
    expect(kinds).toEqual(new Set(['assassin', 'proposal']));
  }, 120_000);

  it('today continues yesterday\'s game (Thursday after a posted Wednesday): only what the real player proposed and the mission; next day both are revealed', () => {
    let held = 0;
    for (let week = 0; week < 8 && held < 2; week++) {
      const wed = addDays('2026-11-25', 7 * week);
      const thu = addDays(wed, 1);
      const fri = addDays(wed, 2);
      expect(weekdayOf(wed)).toBe(3);
      const a = yesterdayAnswerOf(realBank(), thu, posted(wed));
      if (!a?.held) continue;
      held += 1;
      expect(a.date).toBe(wed);
      expect(a.lines).toHaveLength(2);
      expect(a.lines[0]).toMatch(HELD_PROPOSAL);
      expect(a.lines[1]).toBe(HELD_NOTE);
      const text = formatYesterdayAnswer(a);
      // 同一局今天還在打：沒有幾好幾壞、沒有角色、沒有整局牌譜的連結。
      expect(text).not.toMatch(/\d 好 \d 壞|角色 刺|三(?:紅|藍死|藍活)|#records=|家・/u);
      // 同一天如果昨天沒有貼文，今天就是獨立的一題，昨天的答案完整公布。
      const alone = yesterdayAnswerOf(realBank(), thu, NO_INPUTS);
      expect(alone?.held).toBe(false);
      expect(alone?.exerciseId).toBe(a.exerciseId);
      expect(alone?.lines[0]).toMatch(FULL_PROPOSAL);
      // 隔天（週五）：昨天（週四）接的是週三那一局 → 兩題一起完整公布。
      const next = yesterdayAnswerOf(realBank(), fri, posted(wed, thu));
      expect(next?.held).toBe(false);
      expect(next?.date).toBe(thu);
      expect(next?.lines[0]).toMatch(new RegExp(`^前一題 ${a.exerciseId}：真人（`, 'u'));
      expect(next?.lines[0]).toMatch(/\d 好 \d 壞/u);
      expect(next?.lines[1]).toMatch(FULL_PROPOSAL);
      expect(next?.lines.some((l) => l.startsWith('角色 刺'))).toBe(true);
    }
    expect(held).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('today\'s question never shows an answer, whatever was asked the day before', async () => {
    let date = '2026-11-23';
    for (let i = 0; i < 14; i++) {
      __resetDailyQuestionForTests();
      const deps: DailyQuestionDeps = { now: () => noonOf(date), bank: async () => realBank(), inputs: async () => NO_INPUTS };
      const text = await answerDailyQuestion('line', deps);
      expect(text).not.toMatch(/真人|\d 好 \d 壞|角色 刺|梅林是|三(?:紅|藍死|藍活)/u);
      if (text.includes('#records=')) expect(text).toContain('&upto=');
      date = addDays(date, 1);
    }
  }, 120_000);

  it('a state file that could not be read (not a plain 404) for today or yesterday: no answer yet, retried after a minute', async () => {
    let now = NOON;
    let calls = 0;
    const unread = (dates: string[]): DailyQuestionDeps => ({
      now: () => now,
      bank: async () => realBank(),
      inputs: async () => { calls += 1; return { ...NO_INPUTS, unread: new Set(dates) }; },
    });
    expect(await loadYesterdayAnswer(unread(['2026-11-25']))).toEqual({ kind: 'unavailable' });
    expect(calls).toBe(1);
    now += DAILY_QUESTION_RETRY_MS + 1000;
    expect(await loadYesterdayAnswer(unread(['2026-11-24']))).toEqual({ kind: 'unavailable' });
    expect(calls).toBe(2);
    // 更早的日子讀不到不影響（只關係到「前一題」那一行）。
    now += DAILY_QUESTION_RETRY_MS + 1000;
    expect((await loadYesterdayAnswer(unread(['2026-11-22']))).kind).toBe('found');
    // 今天的題目不受影響（它本來就不附答案）。
    __resetDailyQuestionForTests();
    expect((await loadDailyQuestion(unread(['2026-11-25', '2026-11-24']))).kind).toBe('found');
  }, 60_000);

  it('today and yesterday are kept apart in memory; no bank → the yesterday retry line', async () => {
    let bankCalls = 0;
    const deps: DailyQuestionDeps = { now: () => NOON, bank: async () => { bankCalls += 1; return realBank(); }, inputs: async () => NO_INPUTS };
    const today = await answerDailyQuestionTextCommand('/每日一題', 'line', deps);
    const yesterday = await answerDailyQuestionTextCommand('/每日一題 昨天', 'line', deps);
    expect(today).toContain('📌 阿瓦隆每日一題（11/25 週三）');
    expect(yesterday).toContain('📌 阿瓦隆每日一題・昨天（11/24 週二）的答案');
    expect(bankCalls).toBe(2);
    // 十分鐘內再問，兩邊都不重讀。
    expect(await answerDailyQuestionTextCommand('/每日一題 昨天', 'line', deps)).toBe(yesterday);
    expect(await answerDailyQuestionTextCommand('/每日一題', 'line', deps)).toBe(today);
    expect(bankCalls).toBe(2);
    __resetDailyQuestionForTests();
    expect(await answerDailyQuestionTextCommand('/每日一題 昨天', 'line', { now: () => NOON, bank: async () => null })).toBe(DAILY_QUESTION_YESTERDAY_UNAVAILABLE_TEXT);
  }, 60_000);
});

describe('fetchThreadsInputs: how many days of state files, and which could not be read', () => {
  const fakeFetch = (statusOf: (url: string) => number) => {
    const urls: string[] = [];
    const impl = (async (url: string) => {
      urls.push(url);
      const status = statusOf(url);
      if (status === 0) throw new Error('offline');
      return { ok: status === 200, status, json: async () => ({}) };
    }) as unknown as typeof fetch;
    return { urls, impl };
  };
  const stateDates = (urls: string[]): string[] => urls.map((u) => /state\/(\d{4}-\d{2}-\d{2})\.json$/.exec(u)?.[1]).filter((d): d is string => !!d);

  it('default: today and the two days before; days: 4 adds one more (for yesterday\'s answer)', async () => {
    const three = fakeFetch(() => 404);
    await fetchThreadsInputs('2026-11-25', { fetchImpl: three.impl, repo: 'example/repo', localDir: '/nonexistent' });
    expect(stateDates(three.urls)).toEqual(['2026-11-25', '2026-11-24', '2026-11-23']);
    const four = fakeFetch(() => 404);
    const inputs = await fetchThreadsInputs('2026-11-25', { fetchImpl: four.impl, repo: 'example/repo', localDir: '/nonexistent', days: YESTERDAY_STATE_DAYS });
    expect(stateDates(four.urls)).toEqual(['2026-11-25', '2026-11-24', '2026-11-23', '2026-11-22']);
    expect([...inputs.states.keys()]).toEqual(['2026-11-25', '2026-11-24', '2026-11-23', '2026-11-22']);
    // 404 = 確定沒有這個檔（現在還沒開自動發佈就是這樣）：不算讀不到。
    expect([...(inputs.unread ?? [])]).toEqual([]);
  });

  it('a 5xx or a network error marks that day as unread; a 200 does not', async () => {
    const f = fakeFetch((url) => (url.includes('2026-11-25') ? 500 : url.includes('2026-11-24') ? 0 : url.includes('2026-11-23') ? 200 : 404));
    const inputs = await fetchThreadsInputs('2026-11-25', { fetchImpl: f.impl, repo: 'example/repo', localDir: '/nonexistent', days: 4 });
    expect([...(inputs.unread ?? [])].sort()).toEqual(['2026-11-24', '2026-11-25']);
    expect(inputs.states.get('2026-11-23')).toEqual({});
    expect(inputs.states.get('2026-11-25')).toBeNull();
  });
});

describe('Discord /每日一題', () => {
  it('is registered with one optional choice 哪一天 (今天／昨天), public reply, relayed to LINE from the sync channel', () => {
    const cmd = buildSlashCommands().map((b) => b.toJSON()).find((c) => c.name === COMMANDS.DAILY_QUESTION);
    expect(cmd?.name).toBe('每日一題');
    const options = (cmd?.options ?? []) as { name: string; required?: boolean; choices?: { name: string; value: string }[] }[];
    expect(options.map((o) => [o.name, o.required ?? false])).toEqual([[DAILY_QUESTION_OPTIONS.DAY, false]]);
    expect(options[0].choices?.map((c) => c.value)).toEqual(['今天', '昨天']);
    // 選項的值就是 LINE 指令後面打的字。
    expect(options[0].choices?.map((c) => dailyQuestionDayOf(c.value))).toEqual(['today', 'yesterday']);
    expect(RELAYED_DISCORD_COMMANDS.has(COMMANDS.DAILY_QUESTION)).toBe(true);
  });

  it('哪一天:昨天 asks for yesterday; a value it does not know gets the usage line (here the bank is missing → the yesterday retry line)', async () => {
    __setSimForTests({ loader: new SimBankLoader(() => null) });
    const run = async (value: string | null): Promise<unknown> => {
      const interaction = {
        commandName: COMMANDS.DAILY_QUESTION,
        options: { getString: (name: string) => (name === DAILY_QUESTION_OPTIONS.DAY ? value : null) },
        deferReply: vi.fn(async (_opts?: unknown) => {}),
        editReply: vi.fn(async (_payload: unknown) => {}),
      };
      await handleDailyQuestionCommand(interaction as never);
      expect(interaction.deferReply).toHaveBeenCalledWith();
      return interaction.editReply.mock.calls[0][0];
    };
    expect(await run('昨天')).toEqual({ content: DAILY_QUESTION_YESTERDAY_UNAVAILABLE_TEXT, allowedMentions: { parse: [] } });
    expect(await run('今天')).toEqual({ content: DAILY_QUESTION_UNAVAILABLE_TEXT, allowedMentions: { parse: [] } });
    expect(await run(null)).toEqual({ content: DAILY_QUESTION_UNAVAILABLE_TEXT, allowedMentions: { parse: [] } });
    expect(await run('前天')).toEqual({ content: DAILY_QUESTION_USAGE_HINT, allowedMentions: { parse: [] } });
  });

  it('defers, then answers in plain text with mentions off (here: the bank is missing → the retry line)', async () => {
    __setSimForTests({ loader: new SimBankLoader(() => null) });
    const interaction = {
      commandName: COMMANDS.DAILY_QUESTION,
      deferReply: vi.fn(async (_opts?: unknown) => {}),
      editReply: vi.fn(async (_payload: unknown) => {}),
    };
    await handleDailyQuestionCommand(interaction as never);
    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: DAILY_QUESTION_UNAVAILABLE_TEXT, allowedMentions: { parse: [] } });
  });
});
