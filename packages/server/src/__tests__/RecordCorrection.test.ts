/**
 * 牌譜更正 /更正（2026-11-17）：解析、查詢（牌譜文字、1家…0家、問題、網站連結）、不存在的局號、送出（跟 /回報 同一條路，
 * 類型 correction）、頻率限制、LINE 重送、說明、Discord 斜線指令註冊、LINE 鏡像群不同步。
 * 牌譜總庫與網站牌譜清單都用編的小檔案（AVALON_GAME_DB／AVALON_RECORDS_CACHE），暱稱是編的。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Client } from '@line/bot-sdk';
import type { Request, Response } from 'express';
import {
  CORRECTION_RATE_LIMITED_TEXT,
  CORRECTION_RECEIVED_TEXT,
  LOOKUP_LIMITS,
  __resetCorrectionLimitsForTests,
  answerCorrection,
  answerCorrectionTextCommand,
  correctionContentMax,
  correctionMessage,
  correctionTooLongText,
  formatRecordReply,
  parseCorrectionText,
  recordLines,
} from '../bots/recordCorrection/commands';
import { discordNameOf } from '../bots/recordCorrection/discordCommand';
import { __resetRecordLookupForTests, ENV_GAME_DB, lookupRecord, normaliseRecordId } from '../services/recordLookup';
import { ENV_RECORDS_CACHE } from '../services/recordsList';
import { FEEDBACK_KINDS, __resetSubmitLimitsForTests, __resetSyncLinePushesForTests } from '../services/communityReports';
import { parseReportMessage } from '../services/communityReportsList';
import { SUBMIT_REDELIVERY_TEXT, isCommunityCommandText } from '../bots/reports/commands';
import { basicHelpText, helpTopicOf, topicHelpText, HELP_TOPICS } from '../bots/help';
import { buildSlashCommands } from '../bots/discord/client';
import { COMMANDS } from '../bots/discord/config';
import { RELAYED_DISCORD_COMMANDS } from '../bots/discord/replyRelay';
import { ChatMirror, DiscordAdapter, DiscordChannelAdapter, __resetChatMirrorForTests, initializeChatMirror } from '../bots/ChatMirror';
import { LineReplyQueue } from '../bots/line/replyQueue';
import { LineBotClient } from '../bots/line/client';
import { LINE_CONFIG } from '../bots/line/config';

const NAMES = ['甲一', '乙二', '丙三', '丁四', '戊五', '己六', '庚七', '辛八', '壬九', '癸十'];

const GAME_DB = {
  format: 'avalon-game-db',
  version: 1,
  games: [
    {
      id: 'S0001', kind: 'real', date: '2026-01-02', venue: '線瓦', status: 'warn',
      sources: [{ src: 'sheet', id: 'S0001' }, { src: 'dc_import', id: 'Dabc123' }],
      game: {
        config: '314680',
        rounds: [
          { proposals: [{ team: '169', votes: [] }, { team: '247', votes: ['7-', '1+'] }], mission: 'ooo' },
          { proposals: [{ team: '2568', votes: [] }, { team: '2580', votes: ['3+'] }], mission: 'ooxo' },
        ],
        lakes: [{ after: 2, holder: '0', target: '5', claim: 'x' }],
        assassination: '',
        outcome: '',
      },
      problem: '',
      checks: [
        { rule: 'VOTE_RESULT', level: 'warn', msg: '第 2 局第 2 次提議的贊成票不夠' },
        { rule: 'INFERRED_VOTES', level: 'info', msg: '推定全部投白' },
        { rule: 'FAILS_GT_RED', level: 'error', msg: '失敗張數比隊上的紅方多' },
      ],
    },
    {
      id: 'M0002', kind: 'sim', date: '2025-05-05', venue: '', status: 'ok', sources: [{ src: 'sim_sheet', id: 'M0002' }],
      game: { config: '641923', rounds: [{ proposals: [{ team: '158', votes: [] }], mission: 'oox' }], lakes: [], assassination: '', outcome: '' },
      checks: [],
    },
    {
      // 同一局在論壇貼了兩次：總庫留第一篇，第二篇是來源 id（真實例子的形狀：DUP_SAME_SOURCE）。
      id: '1600000000000000010', kind: 'real', date: '2026-02-03', venue: '線瓦', status: 'warn',
      sources: [{ src: 'sheet', id: 'S0010' }, { src: 'discord', id: '1600000000000000010' }, { src: 'discord', id: '1600000000000000011' }],
      game: { config: '123456', rounds: [{ proposals: [{ team: '789', votes: [] }], mission: 'ooo' }], lakes: [], assassination: '', outcome: '' },
      problem: '',
      checks: [{ rule: 'DUP_SAME_SOURCE', level: 'warn', msg: '同一個來源登錄了兩次' }],
    },
    {
      id: '1500000000000000001', kind: 'real', date: '2026-11-01', venue: '線瓦', status: 'unreadable',
      sources: [{ src: 'discord', id: '1500000000000000001' }], game: null, problem: '起始訊息不是牌譜', checks: [],
    },
  ],
};

const RECORDS = {
  format: 'avalon-records',
  version: 1,
  guildId: '1132682489840812113',
  posts: [
    { id: 'S0001', title: '試算表牌譜 #1', tags: ['線瓦'], date: '2026-01-02', game: { config: '314680', names: NAMES, rounds: [], lakes: [], assassination: '', outcome: '', category: '線瓦' }, problem: '' },
    { id: '1600000000000000011', title: '重複貼文', tags: ['線瓦'], date: '2026-02-03', game: { config: '123456', names: NAMES, rounds: [], lakes: [], assassination: '', outcome: '', category: '線瓦' }, problem: '' },
    { id: '1500000000000000001', title: '待檢視', tags: ['線瓦'], date: '2026-11-01', game: null, problem: '起始訊息不是牌譜' },
  ],
};

let dir = '';
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-correction-'));
  fs.writeFileSync(path.join(dir, 'game_db.json'), JSON.stringify(GAME_DB));
  fs.writeFileSync(path.join(dir, 'records_cache.json'), JSON.stringify(RECORDS));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv(ENV_GAME_DB, path.join(dir, 'game_db.json'));
  vi.stubEnv(ENV_RECORDS_CACHE, path.join(dir, 'records_cache.json'));
  __resetRecordLookupForTests();
  __resetCorrectionLimitsForTests();
  __resetSubmitLimitsForTests();
  __resetSyncLinePushesForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  __resetRecordLookupForTests();
});

/** 假的 DC：POST 訊息回 id；記下每一次呼叫。 */
function fakeDc(status = 200) {
  const posts: { url: string; body: { content: string } }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') posts.push({ url, body: JSON.parse(init.body as string) });
    return { ok: status >= 200 && status < 300, status, json: async () => ({ id: `90000000000000000${posts.length}` }) };
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, posts };
}
function fakeMirror() {
  const queued: string[] = [];
  return {
    queued,
    mirror: () => ({
      enqueueLineReplyText: (t: string) => { queued.push(t); return true; },
      runOnDiscordSendChain: <T>(post: () => Promise<T>) => post(),
    }),
  };
}
const ENV = { DISCORD_BOT_TOKEN: 't', LOBBY_MIRROR_DISCORD_CHANNEL_ID: '1132901301802504242', LOBBY_MIRROR_LINE_GROUP_ID: 'Cgroup' };

describe('parseCorrectionText', () => {
  it('reads the id and the (multi-line) content; aliases and full-width slash', () => {
    expect(parseCorrectionText('/更正 S1794')).toEqual({ id: 'S1794', content: '' });
    expect(parseCorrectionText('／更正　S1794　第一局是 158')).toEqual({ id: 'S1794', content: '第一局是 158' });
    expect(parseCorrectionText('/牌譜更正 M536\n158\n290 3+\nooo')).toEqual({ id: 'M536', content: '158\n290 3+\nooo' });
    expect(parseCorrectionText('/更正')).toEqual({ id: '', content: '' });
  });

  it('is not a command when the word goes on, or without the slash', () => {
    expect(parseCorrectionText('/更正的地方')).toBeNull();
    expect(parseCorrectionText('更正 S1794')).toBeNull();
    expect(parseCorrectionText('/回報 x')).toBeNull();
  });

  it('counts as a community command (not mirrored, not counted as /意見 topics, not exported)', () => {
    expect(isCommunityCommandText('/更正 S1794 第一局是 158')).toBe(true);
    expect(isCommunityCommandText('/更正 S1794')).toBe(true);
  });

  it('normalises ids: lower case, #, full-width, the site link', () => {
    expect(normaliseRecordId('s1794')).toBe('S1794');
    expect(normaliseRecordId('#S1794')).toBe('S1794');
    expect(normaliseRecordId('Ｍ５３６')).toBe('M536');
    expect(normaliseRecordId('https://avalon-game-platform.web.app/#records=S1794')).toBe('S1794');
    expect(normaliseRecordId('<script>')).toBe('');
    expect(normaliseRecordId('https://avalon-game-platform.web.app/#records=%')).toBe('');
    expect(normaliseRecordId('#records=%E0%A4%A')).toBe('');
  });

  it('a malformed escape in the site link is an unknown id (the normal reply, never a throw)', async () => {
    const raw = 'https://avalon-game-platform.web.app/#records=%';
    expect(lookupRecord(raw)).toBeNull();
    const text = await answerCorrectionTextCommand(`/更正 ${raw}`, { platform: 'line' });
    expect(text).toMatch(/^找不到局號「/);
    expect(await answerCorrection({ id: raw, content: '第一局是 158' }, { platform: 'discord' })).toMatch(/^找不到局號「/);
  });
});

describe('lookup', () => {
  it('/更正 S0001 → header, DC record text, seat line 1家…0家 with names, error/warn problems (not info), site link, usage hint', async () => {
    const text = await answerCorrection({ id: 's0001', content: '' }, { platform: 'line' });
    expect(text.split('\n')).toEqual([
      '【S0001】實戰・線瓦・2026-01-02',
      '169',
      '247 7- 1+',
      'ooo',
      '2568',
      '2580 3+',
      'ooxo',
      '0>5 x',
      '314680',
      '刺客刺殺:',
      '1家 甲一｜2家 乙二｜3家 丙三｜4家 丁四｜5家 戊五｜6家 己六｜7家 庚七｜8家 辛八｜9家 壬九｜0家 癸十',
      '問題：',
      '・第 2 局第 2 次提議的贊成票不夠',
      '・失敗張數比隊上的紅方多',
      '網站牌譜：https://avalon-game-platform.web.app/#records=S0001',
      '要更正：/更正 S0001 正確的內容（可以多行，例：第一局是 158）',
    ]);
    expect(text).not.toContain('推定全部投白');
  });

  it('a record only in the game DB: roles in the seat line, no site link, no problems found', async () => {
    const text = await answerCorrection({ id: 'M0002', content: '' }, { platform: 'line' });
    expect(text).toContain('【M0002】模擬・2025-05-05');
    expect(text).toContain('1家 莫德雷德｜2家 派西維爾｜3家 梅林｜4家 莫甘娜｜5家 忠臣｜6家 刺客｜7家 忠臣｜8家 忠臣｜9家 奧伯倫｜0家 忠臣');
    expect(text).toContain('問題：檢查沒有找到問題');
    expect(text).toContain('網站牌譜：（網站上沒有這一局）');
  });

  it('an unreadable Discord post: no record text, its problem once, the link', async () => {
    const text = await answerCorrection({ id: '1500000000000000001', content: '' }, { platform: 'line' });
    expect(text).toContain('（這局的牌譜讀不懂');
    expect(text.split('起始訊息不是牌譜')).toHaveLength(2); // the DB and the site say the same thing: listed once
    expect(text).toContain('#records=1500000000000000001');
  });

  it('a source id that is also a site post answers the canonical DB record (its checks), with the site post\'s names and link', async () => {
    const r = lookupRecord('1600000000000000011');
    expect(r?.id).toBe('1600000000000000010');
    expect(r?.problems).toEqual(['同一個來源登錄了兩次']);
    expect(r?.names?.[0]).toBe('甲一');
    const text = await answerCorrection({ id: '1600000000000000011', content: '' }, { platform: 'line' });
    expect(text).toContain('【1600000000000000010】');
    expect(text).toContain('・同一個來源登錄了兩次');
    expect(text).not.toContain('檢查沒有找到問題');
    expect(text).toContain('網站牌譜：https://avalon-game-platform.web.app/#records=1600000000000000011');
    expect(lookupRecord('S0010')?.id).toBe('1600000000000000010');
  });

  it('a source id resolves to the record', () => {
    expect(lookupRecord('Dabc123')?.id).toBe('S0001');
  });

  it('Discord: the record in a code block, names escaped, the hint uses the slash options, under 2000 characters', () => {
    const r = lookupRecord('S0001');
    if (!r) throw new Error('missing');
    const text = formatRecordReply({ ...r, names: NAMES.map((n, i) => (i === 0 ? 'a_b*c' : n)) }, 'discord');
    expect(text).toContain('```\n169\n247 7- 1+');
    expect(text).toContain('1家 a\\_b\\*c');
    expect(text).toContain('/更正 局號:S0001 內容:');
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('forced proposals (5th, no marks) show the team only', () => {
    const lines = recordLines({ config: '123456', rounds: [{ proposals: Array.from({ length: 5 }, () => ({ team: '123', votes: [] })), mission: 'ooo' }], lakes: [], assassination: '7', outcome: '三藍活' });
    expect(lines).toEqual(['123', '123', '123', '123', '123', 'ooo', '123456', '刺客刺殺:7']);
  });
});

describe('unknown id, usage, rate limit', () => {
  it('unknown id → short error, nothing submitted', async () => {
    const d = fakeDc();
    expect(await answerCorrection({ id: 'X999', content: '第一局是 158' }, { platform: 'line', deps: { env: ENV, fetchImpl: d.fetchImpl, mirror: fakeMirror().mirror } }))
      .toBe('找不到局號「X999」。局號在網站牌譜頁的網址 #records= 後面，例如 S1794、M536，或 DC 貼文 id。');
    expect(d.posts).toEqual([]);
  });

  it('no id → usage', async () => {
    expect(await answerCorrectionTextCommand('/更正', { platform: 'line' })).toMatch(/^用法：\/更正 局號 \[更正內容\]/);
    expect(await answerCorrectionTextCommand('/回報 x', { platform: 'line' })).toBeNull();
  });

  it('lookups are rate limited per user', async () => {
    const ctx = { platform: 'line' as const, userId: 'U1', now: () => 1_000 };
    for (let i = 0; i < LOOKUP_LIMITS.perUser; i++) expect(await answerCorrection({ id: 'S0001', content: '' }, ctx)).toContain('【S0001】');
    expect(await answerCorrection({ id: 'S0001', content: '' }, ctx)).toBe(CORRECTION_RATE_LIMITED_TEXT);
    expect(await answerCorrection({ id: 'S0001', content: '' }, { ...ctx, userId: 'U2' })).toContain('【S0001】');
  });
});

describe('submitting a correction (the /回報 path, kind correction)', () => {
  it('posts 【百科回報・牌譜更正】 with [更正] 局號, the content and the submitter to DC, then LINE; replies 收到', async () => {
    const d = fakeDc();
    const m = fakeMirror();
    const name = vi.fn(async () => '送出者');
    const text = await answerCorrectionTextCommand('/更正 s0001 第一局是 158\n第二局 2580 沒有 3+', {
      platform: 'line', userId: 'U1', submitterName: name, deps: { env: ENV, fetchImpl: d.fetchImpl, mirror: m.mirror },
    });
    expect(text).toMatch(new RegExp(`^${CORRECTION_RECEIVED_TEXT}（S0001）（編號 #R[0-9A-Z]{8}）$`));
    expect(name).toHaveBeenCalledTimes(1);
    expect(d.posts).toHaveLength(1);
    const dc = d.posts[0].body.content;
    expect(dc).toMatch(/^【百科回報・牌譜更正】#R[0-9A-Z]{8} \\\[更正\\\] S0001\n第一局是 158\n/);
    expect(dc).toContain('（來自LINE・送出者）');
    // The daily job reads it back as kind correction with the plain text.
    const parsed = parseReportMessage(dc);
    expect(parsed?.kind).toBe('correction');
    expect(parsed?.text).toContain('[更正] S0001\n第一局是 158\n第二局 2580 沒有 3+');
    expect(m.queued).toHaveLength(1);
    expect(m.queued[0]).toMatch(/^【百科回報・牌譜更正】#R[0-9A-Z]{8} \[更正\] S0001\n/);
  });

  it('a lookup never posts anything; a redelivered correction is not sent twice', async () => {
    const d = fakeDc();
    const deps = { env: ENV, fetchImpl: d.fetchImpl, mirror: fakeMirror().mirror };
    await answerCorrection({ id: 'S0001', content: '' }, { platform: 'line', deps });
    expect(await answerCorrection({ id: 'S0001', content: '第一局是 158' }, { platform: 'line', redelivery: true, deps })).toBe(SUBMIT_REDELIVERY_TEXT);
    expect(d.posts).toEqual([]);
  });

  it('DC down → the /回報 unavailable text; a failing name lookup still submits without a name', async () => {
    expect(await answerCorrection({ id: 'S0001', content: 'x' }, { platform: 'discord', deps: { env: ENV, fetchImpl: fakeDc(500).fetchImpl, mirror: fakeMirror().mirror } }))
      .toContain('送不出去');
    const d = fakeDc();
    await answerCorrection({ id: 'S0001', content: 'x' }, {
      platform: 'discord', submitterName: async () => { throw new Error('profile'); }, deps: { env: ENV, fetchImpl: d.fetchImpl, mirror: fakeMirror().mirror },
    });
    expect(d.posts[0].body.content).toMatch(/（來自DC）$/);
  });

  it('content up to the limit (1000 minus the 「[更正] 局號」 line) is sent whole; one more character is refused, never truncated', async () => {
    const max = correctionContentMax('S0001');
    expect(max).toBe(1000 - '[更正] S0001\n'.length);
    const d = fakeDc();
    const m = fakeMirror();
    const deps = { env: ENV, fetchImpl: d.fetchImpl, mirror: m.mirror };
    const exact = '長'.repeat(max - 1) + '尾';
    expect(await answerCorrection({ id: 'S0001', content: exact }, { platform: 'line', submitterName: async () => '送出者', deps })).toContain(CORRECTION_RECEIVED_TEXT);
    expect(d.posts).toHaveLength(1);
    expect(parseReportMessage(d.posts[0].body.content)?.text).toBe(`[更正] S0001\n${exact}`); // nothing cut
    expect(m.queued[0]).toContain(`${exact}\n（來自LINE・送出者）`);

    const tooLong = `${exact}多`;
    expect(await answerCorrection({ id: 'S0001', content: tooLong }, { platform: 'line', deps }))
      .toBe(`更正內容太長（${max + 1} 字），這一局最多 ${max} 字。請縮短，或分成幾次送（每次寫明是哪一局的哪裡）。`);
    expect(correctionTooLongText('S0001', max + 1)).toContain(`最多 ${max} 字`);
    expect(d.posts).toHaveLength(1); // the refused one was not posted
    expect(correctionMessage('S0001', tooLong).length).toBe(1001); // the message itself is never sliced
  });

  it('content that fits the count but not one Discord post once its markdown is escaped is refused too', async () => {
    const d = fakeDc();
    const content = '\\'.repeat(correctionContentMax('S0001')); // every \\ doubles in the DC post
    expect(await answerCorrection({ id: 'S0001', content }, { platform: 'discord', deps: { env: ENV, fetchImpl: d.fetchImpl, mirror: fakeMirror().mirror } }))
      .toMatch(/^更正內容太長/);
    expect(d.posts).toEqual([]);
  });

  it('the website form still does not accept correction', () => {
    expect(FEEDBACK_KINDS).not.toContain('correction');
  });

  it('Discord submitter name: server nickname > global name > username', () => {
    expect(discordNameOf({ member: { displayName: '暱稱' }, user: { globalName: 'G', username: 'u' } } as never)).toBe('暱稱');
    expect(discordNameOf({ member: null, user: { globalName: 'G', username: 'u' } } as never)).toBe('G');
    expect(discordNameOf({ member: null, user: { globalName: null, username: 'u' } } as never)).toBe('u');
  });
});

describe('deploy: the runtime image carries both data files', () => {
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  it('the production Dockerfile copies game_db.json and the records cache into the runtime stage', () => {
    const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf-8');
    const runtime = docker.slice(docker.lastIndexOf('\nFROM '));
    expect(runtime).toContain('COPY --from=builder /app/packages/server/game_db.json ./packages/server/game_db.json');
    expect(runtime).toMatch(/COPY --from=builder \/app\/packages\/server\/\[agr\]\*_cache\.json/); // records_cache.json
  });

  it('Render (Dockerfile.server) copies the whole context, and .dockerignore keeps both files', () => {
    expect(fs.readFileSync(path.join(root, 'render.yaml'), 'utf-8')).toMatch(/dockerfilePath: \.\/Dockerfile\.server/);
    expect(fs.readFileSync(path.join(root, 'Dockerfile.server'), 'utf-8')).toMatch(/^COPY \. \.$/m);
    const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf-8').split('\n').map((l) => l.trim());
    for (const f of ['packages/server/game_db.json', 'packages/server/records_cache.json', '*.json', 'packages/server/*.json']) expect(ignore).not.toContain(f);
    expect(fs.existsSync(path.join(root, 'packages', 'server', 'game_db.json'))).toBe(true);
  });

  it('a missing game_db.json logs a warning (not silent) and lookups still use the records cache', async () => {
    vi.stubEnv(ENV_GAME_DB, path.join(dir, 'missing.json'));
    __resetRecordLookupForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(lookupRecord('S0001')?.names?.[0]).toBe('甲一');
      expect(lookupRecord('M0002')).toBeNull(); // DB-only record
      expect(warn.mock.calls.flat().join('\n')).toContain('找不到 game_db.json');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('help and Discord registration', () => {
  it('/help 更正 is a topic; the basic help mentions /更正', () => {
    expect(HELP_TOPICS).toContain('更正');
    expect(helpTopicOf('牌譜更正')).toBe('更正');
    expect(topicHelpText('更正', 'line')).toMatch(/^✏️ \/更正 局號 \[更正內容\]/);
    expect(topicHelpText('更正', 'discord')).toContain('/更正 局號 [內容]');
    expect(basicHelpText('line')).toContain('/更正 局號 [更正內容]');
  });

  it('/更正 is registered with a required 局號 and an optional 內容; its reply is never relayed to LINE', () => {
    const cmd = buildSlashCommands().map((c) => c.toJSON()).find((c) => c.name === COMMANDS.CORRECTION);
    expect(cmd).toBeDefined();
    const options = (cmd?.options ?? []) as { name: string; required?: boolean }[];
    expect(options.map((o) => [o.name, Boolean(o.required)])).toEqual([['局號', true], ['內容', false]]);
    expect(RELAYED_DISCORD_COMMANDS.has(COMMANDS.CORRECTION)).toBe(false);
  });
});

describe('LINE mirror group', () => {
  const GROUP = 'Cmirror-group';
  const SECRET = 'test-channel-secret';

  function harness(): { bot: LineBotClient; mirror: ChatMirror; replies: string[][]; discordSent: string[]; profiles: string[] } {
    const replies: string[][] = [];
    const discordSent: string[] = [];
    const profiles: string[] = [];
    const client = {
      replyMessage: async (_t: string, messages: { text: string }[]) => { replies.push(messages.map((m) => m.text)); return {}; },
      pushMessage: async () => { throw new Error('push must never be used'); },
      getGroupMemberProfile: async (_g: string, userId: string) => { profiles.push(userId); return { displayName: `LineUser-${userId}` }; },
    } as unknown as Client;
    const discord: DiscordAdapter = {
      fetchChannel: async (): Promise<DiscordChannelAdapter | null> => ({ send: async (content: string) => { discordSent.push(content); return {}; } }),
    };
    const mirror = initializeChatMirror({ lineGroupId: GROUP, discordChannelId: 'D1', discord, lineReplyQueue: new LineReplyQueue(), logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } });
    const bot = new LineBotClient({ channelSecret: SECRET, channelAccessToken: 'tok', client });
    return { bot, mirror, replies, discordSent, profiles };
  }

  async function deliver(bot: LineBotClient, text: string, id: string): Promise<void> {
    const raw = JSON.stringify({ destination: 'U', events: [{ type: 'message', replyToken: `rt-${id}`, source: { type: 'group', groupId: GROUP, userId: 'U1' }, message: { type: 'text', id, text, quoteToken: `q-${id}` } }] });
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
    const req = { get: (h: string) => (h === 'X-Line-Signature' ? sig : undefined), body: JSON.parse(raw), rawBody: Buffer.from(raw) } as unknown as Request;
    const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; } } as unknown as Response;
    await bot.handleWebhook(req, res);
  }

  beforeEach(() => {
    __resetChatMirrorForTests();
    vi.stubEnv('LOBBY_MIRROR_LINE_GROUP_ID', GROUP);
    LINE_CONFIG.statsCommandsEnabled = true;
  });

  it('/更正 局號 answers in the group; neither the command nor the answer goes to Discord; no profile lookup for a lookup', async () => {
    const h = harness();
    await deliver(h.bot, '/更正 S0001', 'm1');
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0][0]).toContain('【S0001】實戰・線瓦・2026-01-02');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.discordSent).toEqual([]);
    expect(h.profiles).toEqual([]);
  });
});
