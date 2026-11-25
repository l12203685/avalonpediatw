/**
 * /每日一題（2026-11-25，bots/dailyQuestion）：指令解析、回覆文字、讀取（快取、等太久、讀不到）、
 * Discord 斜線指令、以及用 repo 裡真的題庫跑幾天（題目跟 Threads 草稿同一套選法）。
 * 不連網：GitHub 的輸入一律用假的（空的選題、沒有存下來的草稿）。回覆裡沒有任何人的名字。
 */
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS } from '../bots/discord/config';
import { buildSlashCommands } from '../bots/discord/client';
import { RELAYED_DISCORD_COMMANDS } from '../bots/discord/replyRelay';
import {
  DAILY_QUESTION_HELP_TEXT,
  DAILY_QUESTION_LOADING_TEXT,
  DAILY_QUESTION_RETRY_MS,
  DAILY_QUESTION_TTL_MS,
  DAILY_QUESTION_UNAVAILABLE_TEXT,
  DAILY_QUESTION_USAGE,
  __resetDailyQuestionForTests,
  answerDailyQuestionTextCommand,
  dailyQuestionOf,
  dateLabel,
  formatDailyQuestion,
  formatDailyQuestionLoad,
  formatNoDailyQuestion,
  isDailyQuestionCommandText,
  loadDailyQuestion,
  parseDailyQuestionText,
  seatName,
  type DailyQuestion,
  type DailyQuestionDeps,
} from '../bots/dailyQuestion/commands';
import { handleDailyQuestionCommand } from '../bots/dailyQuestion/discordCommand';
import type { ThreadsInputs } from '../bots/conceptDaily/threadsToday';
import { basicHelpText, parseHelpCommand, topicHelpText } from '../bots/help';
import { __setSimForTests } from '../bots/simulation';
import { SimBankLoader, buildSimBank, readSimBankFile, type SimBank } from '../bots/simulation/bank';
import { normalizeExerciseId, parseSimCommand } from '../bots/simulation/commands';
import { SIM_CONFIG } from '../bots/simulation/config';
import { readRecordPosts } from '../bots/simulation/recordsIndex';
import { getFeedbackService } from '../bots/feedback/service';
import { hookQuestion } from '../bots/threads/draft';
import { addDays } from '../bots/threads/plan';

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

describe('Discord /每日一題', () => {
  it('is registered without options, public reply, relayed to LINE from the sync channel', () => {
    const cmd = buildSlashCommands().map((b) => b.toJSON()).find((c) => c.name === COMMANDS.DAILY_QUESTION);
    expect(cmd?.name).toBe('每日一題');
    expect(cmd?.options ?? []).toEqual([]);
    expect(RELAYED_DISCORD_COMMANDS.has(COMMANDS.DAILY_QUESTION)).toBe(true);
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
