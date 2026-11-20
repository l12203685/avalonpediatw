/**
 * 網站「牌譜紀錄」頁籤的純函式（packages/web/src/utils/records.ts；web 沒有測試執行器，在這裡測），
 * 以及 #records 深連結與免登入頁面。虛構的貼文與名字（玩家A…）。
 */
import { describe, expect, it } from 'vitest';
import {
  approveCount,
  discordThreadUrl,
  isForcedProposal,
  lakeClaimLabel,
  matchesRecords,
  matchingSeats,
  missionIsRed,
  outcomeOf,
  recordsHash,
  recordsText,
  parseRecordsHash,
  proposalVotes,
  roleOfSeat,
  sortedTeam,
  voteMarks,
  winnerOf,
  EMPTY_RECORDS_FILTER,
  deriveLeaders,
  lakeLine,
  proposalLine,
  recordLineParts,
  isMissionTextLine,
  RECORDS_PREF_KEYS,
  isLegacyRecordsHash,
  readRecordsPrefs,
  resultSentence,
  seatLabel,
  type RecordGame,
  type RecordPost,
  RECORDS_FILTER_KEY,
  RECORD_MISTAKE_TAGS,
  mistakeDetails,
  mistakeTags,
  parseRecordsFilter,
  postLineup,
  recordsFilterActive,
  isDiscordPost,
  kindLabel,
  sourceLabel,
  findRecordPost,
  normaliseRecordsId,
} from '../../../web/src/utils/records';
import {
  DEFAULT_LINEUP_FILTER,
  lineupCondition,
  lineupStateFromCondition,
  lineupTier,
  sanitizeLineupState,
} from '../../../web/src/utils/lineupFilter';
import { PUBLIC_STATS_STATES, parseStatsHash } from '../../../web/src/utils/statsLinks';

const NAMES = 'ABCDEFGHIJ'.split('').map((c) => `玩家${c}`);
const GAME: RecordGame = {
  config: '936758',
  names: NAMES,
  rounds: [
    { proposals: [{ team: '147', votes: [] }, { team: '260', votes: [] }, { team: '389', votes: ['7+'] },
      { team: '469', votes: [] }, { team: '568', votes: [] }], mission: 'ooo' },
    { proposals: [{ team: '5680', votes: [] }], mission: 'ooox' },
    { proposals: [{ team: '1458', votes: [] }], mission: 'oooo' },
    { proposals: [{ team: '15678', votes: ['5-', '39+'] }, { team: '14580', votes: [] }], mission: 'ooooo' },
  ],
  lakes: [{ after: 2, holder: '0', target: '8', claim: 'o' }, { after: 3, holder: '8', target: '4', claim: '?' }],
  assassination: '3',
  outcome: '三藍活',
  category: '線瓦',
};
const POST: RecordPost = {
  id: '1432000000000000001', title: '1025一般場6', tags: ['三藍躲刺', '線瓦'],
  created: '2026-10-25T23:00:00+08:00', date: '2026-10-25', game: GAME,
};
const BROKEN: RecordPost = {
  id: '1432000000000000002', title: '1026直播局1', tags: ['三紅', '待修正'],
  created: '2026-10-26T22:00:00+08:00', date: '2026-10-26', game: null, problem: '這一行看不懂', problemLine: 14,
};

describe('web records: votes', () => {
  it('reads sign-last marks: 57- = those seats reject, 6+ = approve', () => {
    expect([...voteMarks(['57-6+'])]).toEqual([['5', 'reject'], ['7', 'reject'], ['6', 'approve']]);
  });

  it('team approves and the rest reject unless marked', () => {
    const votes = proposalVotes(GAME.rounds[3].proposals[0], 0)!;
    expect(votes['1']).toBe('approve');
    expect(votes['5']).toBe('reject'); // 內黑
    expect(votes['3']).toBe('approve'); // 外白
    expect(votes['9']).toBe('approve');
    expect(votes['2']).toBe('reject');
    expect(approveCount(GAME.rounds[3].proposals[0], 0)).toBe(6);
  });

  it('a 5th proposal without marks is the forced one (no votes)', () => {
    const fifth = GAME.rounds[0].proposals[4];
    expect(isForcedProposal(4, fifth)).toBe(true);
    expect(proposalVotes(fifth, 4)).toBeNull();
    expect(approveCount(fifth, 4)).toBeNull();
    expect(isForcedProposal(4, { team: '568', votes: ['1+'] })).toBe(false);
  });
});

describe('web records: game facts', () => {
  it('roles by seat from the 6-digit 配置', () => {
    expect(roleOfSeat('936758', '9').name).toBe('刺客');
    expect(roleOfSeat('936758', '8')).toMatchObject({ name: '梅林', red: false });
    expect(roleOfSeat('936758', '7')).toMatchObject({ short: '奧', red: true });
    expect(roleOfSeat('936758', '1').name).toBe('忠臣');
  });

  it('the 4th mission needs two fails', () => {
    expect(missionIsRed('ooox', 1)).toBe(true);
    expect(missionIsRed('oooox', 3)).toBe(false);
    expect(missionIsRed('oooxx', 3)).toBe(true);
  });

  it('result from the game, else from exactly one result tag', () => {
    expect(outcomeOf(POST)).toBe('三藍活');
    expect(outcomeOf(BROKEN)).toBe('三紅');
    expect(outcomeOf({ ...BROKEN, tags: ['三紅', '三藍被刀'] })).toBeNull();
    expect(winnerOf('三藍死')).toBe('red');
    expect(winnerOf('三藍活')).toBe('blue');
  });

  it('lake claims: ? is shown as 未記錄', () => {
    expect(lakeClaimLabel('?')).toBe('未記錄');
    expect(lakeClaimLabel('o')).toBe('宣告藍');
    expect(lakeClaimLabel('x')).toBe('宣告紅');
    expect(lakeClaimLabel('')).toBe('沒寫宣告');
  });

  it('sorts teams 1..9 then 0', () => {
    expect(sortedTeam('0851')).toBe('1580');
  });

  it('rebuilds the DC text format', () => {
    const text = recordsText(GAME).split('\n');
    expect(text.slice(0, 6)).toEqual(['147', '260', '389 7+', '469', '568', 'ooo']);
    expect(text).toContain('0>8 o');
    expect(text).toContain('8>4 ?');
    expect(text).toContain('15678 5- 39+');
    expect(text.slice(-12)).toEqual(['936758', '刺客刺殺:3', ...NAMES.map((n, i) => `${i === 9 ? 0 : i + 1}.${n}`)]);
  });

  it('links the Discord thread', () => {
    expect(discordThreadUrl(POST.id)).toBe('https://discord.com/channels/1132682489840812113/1432000000000000001');
  });
});

describe('web records: filters', () => {
  it('by result, unreadable, date range', () => {
    const f = EMPTY_RECORDS_FILTER;
    expect(matchesRecords(POST, { ...f, result: '三藍活' })).toBe(true);
    expect(matchesRecords(POST, { ...f, result: '三紅' })).toBe(false);
    expect(matchesRecords(BROKEN, { ...f, result: '三紅' })).toBe(true);
    expect(matchesRecords(BROKEN, { ...f, result: 'unreadable' })).toBe(true);
    expect(matchesRecords(POST, { ...f, result: 'unreadable' })).toBe(false);
    expect(matchesRecords(POST, { ...f, from: '2026-10-25', to: '2026-10-25' })).toBe(true);
    expect(matchesRecords(POST, { ...f, from: '2026-10-26' })).toBe(false);
    expect(matchesRecords(POST, { ...f, to: '2026-10-24' })).toBe(false);
  });

  it('站長 2026-11-20: a dc+sheet post is found by the sheet date, not its Discord date', () => {
    const f = EMPTY_RECORDS_FILTER;
    // discord_records_export / records_merge put the sheet's date in `date` and keep the post's own in postDate
    const merged: RecordPost = { ...POST, src: 'dc+sheet', date: '2026-10-20', postDate: '2026-10-25' };
    expect(matchesRecords(merged, { ...f, from: '2026-10-20', to: '2026-10-20' })).toBe(true);
    expect(matchesRecords(merged, { ...f, from: '2026-10-25', to: '2026-10-25' })).toBe(false);
  });

  it('Edward 2026-11-20: by config code (prefix) or game id / aka', () => {
    const f = EMPTY_RECORDS_FILTER;
    const cfg = GAME.config;
    expect(matchesRecords(POST, { ...f, query: cfg })).toBe(true);
    expect(matchesRecords(POST, { ...f, query: cfg.slice(0, 4) })).toBe(true);
    expect(matchesRecords(POST, { ...f, query: cfg.split('').reverse().join('') === cfg ? '000000' : cfg.split('').reverse().join('') })).toBe(false);
    expect(matchesRecords(POST, { ...f, query: POST.id })).toBe(true);
    expect(matchesRecords({ ...POST, aka: ['S1236'] }, { ...f, query: 's1236' })).toBe(true);
    expect(matchesRecords(POST, { ...f, query: 'S9999' })).toBe(false);
  });

  it('by nickname (case / width insensitive) or title', () => {
    const f = EMPTY_RECORDS_FILTER;
    expect(matchesRecords(POST, { ...f, query: '玩家ｃ' })).toBe(true);
    expect(matchesRecords(POST, { ...f, query: '一般場' })).toBe(true);
    expect(matchesRecords(POST, { ...f, query: '玩家Z' })).toBe(false);
    expect(matchesRecords(BROKEN, { ...f, query: '玩家A' })).toBe(false);
    expect(matchingSeats(POST, 'c')).toEqual(['3']);
    expect(matchingSeats(POST, '')).toEqual([]);
  });
});

describe('web records: #records links', () => {
  it('parses #records and #records=<post id>', () => {
    expect(parseRecordsHash('#records')).toEqual({ id: null });
    expect(parseRecordsHash('#records=1432000000000000001')).toEqual({ id: '1432000000000000001' });
    expect(parseRecordsHash('#records=abc')).toBeNull();
    expect(parseRecordsHash('#stats')).toBeNull();
    expect(recordsHash('1432000000000000001')).toBe('#records=1432000000000000001');
  });

  it('App opens the 牌譜紀錄 tab from those links, without a login', () => {
    expect(parseStatsHash('#records=1432000000000000001')).toEqual({ kind: 'records', id: '1432000000000000001' });
    expect(parseStatsHash('#records')).toEqual({ kind: 'records', id: null });
    expect(PUBLIC_STATS_STATES.has('records')).toBe(true);
  });
});

describe('web records: 顯示角色／顯示名稱', () => {
  const off = { roles: false, names: false };
  const both = { roles: true, names: true };

  it('both default off, only "1" turns one on, a throwing storage reads as off', () => {
    expect(readRecordsPrefs(() => null)).toEqual(off);
    expect(readRecordsPrefs((k) => (k === RECORDS_PREF_KEYS.names ? '1' : '0'))).toEqual({ roles: false, names: true });
    expect(readRecordsPrefs(() => { throw new Error('blocked'); })).toEqual(off);
  });

  it('seat labels show only what is switched on', () => {
    expect(seatLabel(GAME, '8', off)).toBe('8 家');
    expect(seatLabel(GAME, '8', { roles: false, names: true })).toBe('8 家 玩家H');
    expect(seatLabel(GAME, '8', { roles: true, names: false })).toBe('8 家（梅林）');
    expect(seatLabel(GAME, '8', both)).toBe('8 家 玩家H（梅林）');
  });

  it('the result sentence hides roles (who the assassin was, Merlin hit or not) and names when off', () => {
    expect(resultSentence(GAME, off)).toBe('藍方拿下三次任務；刺殺 3 家');
    expect(resultSentence(GAME, { roles: false, names: true })).toBe('藍方拿下三次任務；刺殺 3 家 玩家C');
    expect(resultSentence(GAME, both)).toBe('藍方拿下三次任務；刺客 9 家 玩家I 刺殺 3 家 玩家C（莫甘娜），沒刺中');
    const dead = { ...GAME, outcome: '三藍死' as const, assassination: '8' };
    expect(resultSentence(dead, off)).not.toMatch(/梅林|刺客/);
    expect(resultSentence(dead, both)).toContain('刺中梅林');
    expect(resultSentence({ ...GAME, outcome: '三紅' as const }, off)).toBe('紅方拿下三次任務');
  });
});

describe('web records: old #paipu links', () => {
  it('still open the tab and are recognised for the redirect', () => {
    expect(parseRecordsHash('#paipu=1432000000000000001')).toEqual({ id: '1432000000000000001' });
    expect(parseStatsHash('#paipu')).toEqual({ kind: 'records', id: null });
    expect(isLegacyRecordsHash('#paipu=1432000000000000001')).toBe(true);
    expect(isLegacyRecordsHash('#records=1432000000000000001')).toBe(false);
  });
});

describe('web records: 文字紀錄 column and leaders', () => {
  it('each row\'s DC text: team then marks, and the lake line', () => {
    expect(proposalLine({ team: '2468', votes: ['48-5+'] }, 0)).toBe('2468 48- 5+');
    expect(proposalLine({ team: '2579', votes: ['1+', '7-'] }, 1)).toBe('2579 7- 1+'); // 內黑在前
    expect(proposalLine({ team: '1345', votes: ['26780+'] }, 0)).toBe('1345 26780+');
    expect(proposalLine({ team: '14670', votes: ['358+', '167-'] }, 2)).toBe('14670 167- 358+');
    expect(proposalLine({ team: '15678', votes: ['5-', '39+'] }, 0)).toBe('15678 5- 39+');
    expect(proposalLine({ team: '147', votes: [] }, 0)).toBe('147');
    expect(proposalLine({ team: '568', votes: [] }, 4)).toBe('568'); // 強制局只有隊伍
    expect(lakeLine({ after: 2, holder: '0', target: '3', claim: 'x' })).toBe('0>3 x');
    expect(lakeLine({ after: 2, holder: '0', target: '3', claim: '' })).toBe('0>3');
  });

  it('derives the leaders when the rotation (1→…→9→0→1, across rounds) clearly fits', () => {
    // leaders 8,9,0,1 | 2,3,4 …: every team holds its leader
    const game: RecordGame = {
      ...GAME,
      rounds: [
        { proposals: [{ team: '378', votes: [] }, { team: '139', votes: [] }, { team: '240', votes: [] }, { team: '146', votes: [] }], mission: 'ooo' },
        { proposals: [{ team: '1256', votes: [] }, { team: '3567', votes: [] }, { team: '1346', votes: [] }], mission: 'ooox' },
        { proposals: [{ team: '1568', votes: [] }, { team: '2569', votes: [] }], mission: 'oooo' },
        { proposals: [{ team: '12470', votes: [] }], mission: 'oooxx' },
      ],
    };
    expect(deriveLeaders(game)).toEqual([['8', '9', '0', '1'], ['2', '3', '4'], ['5', '6'], ['7']]);
  });

  it('gives up (null) when no starting seat clearly fits', () => {
    expect(deriveLeaders({ ...GAME, rounds: [{ proposals: [{ team: '123', votes: [] }, { team: '123', votes: [] }], mission: 'ooo' }] })).toBeNull();
    expect(deriveLeaders({ ...GAME, rounds: [] })).toBeNull();
  });
});

describe('web records: 陣容強度與失誤標籤', () => {
  const SCORED: RecordPost = {
    ...POST,
    lineup: { pool: 33, s: 67.5, prs: [80, 75, 72, 71, 70, 66, 64, 60, 52, 50], prov: '0' },
    mistakes: [['嚴重失誤', 0, ''], ['藍方贊成已證有紅的隊', 2, '560'], ['已證有紅的隊出任務', 2, '1570'], ['藍方贊成已證有紅的隊', 3, '7']],
  };
  const f = EMPTY_RECORDS_FILTER;
  const on = (patch: Partial<typeof DEFAULT_LINEUP_FILTER>) => ({ ...f, lineup: { ...DEFAULT_LINEUP_FILTER, ...patch } });

  it('the post lineup: provisional seats from the prov string; no lineup or no game = unscored', () => {
    expect(postLineup(SCORED)?.prov).toEqual([...Array(9).fill(false), true]);
    expect(postLineup(POST)).toBeNull();
    expect(postLineup({ ...BROKEN, lineup: SCORED.lineup })).toBeNull();
  });

  it('S, PR X with at least Y (provisional seats do not count), and / or, unscored', () => {
    expect(matchesRecords(SCORED, on({ sOn: true, sMin: 65 }))).toBe(true);
    expect(matchesRecords(SCORED, on({ sOn: true, sMin: 70 }))).toBe(false);
    expect(matchesRecords(SCORED, on({ countOn: true, strongPr: 70, strongCount: 5 }))).toBe(true);
    expect(matchesRecords(SCORED, on({ countOn: true, strongPr: 50, strongCount: 10 }))).toBe(false); // seat 0 is provisional
    expect(matchesRecords(SCORED, on({ sOn: true, sMin: 70, countOn: true, strongPr: 70, strongCount: 5 }))).toBe(false);
    expect(matchesRecords(SCORED, on({ sOn: true, sMin: 70, countOn: true, strongPr: 70, strongCount: 5, combine: 'or' }))).toBe(true);
    expect(matchesRecords(POST, on({ sOn: true, sMin: 0 }))).toBe(false);
    expect(matchesRecords(POST, on({ sOn: true, sMin: 0, includeUnscored: true }))).toBe(true);
    expect(matchesRecords(POST, on({ includeUnscored: true }))).toBe(true); // no condition on: no filter
    expect(recordsFilterActive(on({ includeUnscored: true }))).toBe(false);
    expect(recordsFilterActive(on({ countOn: true }))).toBe(true);
  });

  it('mistake tags: any of the chosen tags, details with round and seats only', () => {
    expect(mistakeTags(SCORED)).toEqual(['嚴重失誤', '已證有紅的隊出任務', '藍方贊成已證有紅的隊']);
    expect(mistakeDetails(SCORED, '藍方贊成已證有紅的隊')).toEqual(['第 2 輪：5、6、0 家', '第 3 輪：7 家']);
    expect(mistakeDetails(SCORED, '嚴重失誤')).toEqual([]);
    expect(matchesRecords(SCORED, { ...f, mistakes: ['嚴重失誤'] })).toBe(true);
    expect(matchesRecords(SCORED, { ...f, mistakes: ['紅方賽點未出失敗（待查）', '已證有紅的隊出任務'] })).toBe(true);
    expect(matchesRecords(SCORED, { ...f, mistakes: ['紅方賽點未出失敗（待查）'] })).toBe(false);
    expect(matchesRecords(POST, { ...f, mistakes: ['嚴重失誤'] })).toBe(false);
    expect(RECORD_MISTAKE_TAGS.filter((m) => m.serious).map((m) => m.tag)).toEqual(['嚴重失誤', '已證有紅的隊出任務', '藍方隊長派已證有紅的隊']);
  });

  it('the remembered filter: unknown or malformed values fall back to the defaults', () => {
    const saved = JSON.stringify({ ...on({ sOn: true, sMin: 62, combine: 'or' }), result: '三紅', mistakes: ['嚴重失誤', '亂寫'] });
    const back = parseRecordsFilter(saved);
    expect(back.lineup).toEqual({ ...DEFAULT_LINEUP_FILTER, sOn: true, sMin: 62, combine: 'or' });
    expect(back.result).toBe('三紅');
    expect(back.mistakes).toEqual(['嚴重失誤']);
    expect(parseRecordsFilter(null)).toEqual(EMPTY_RECORDS_FILTER);
    expect(parseRecordsFilter('{not json')).toEqual(EMPTY_RECORDS_FILTER);
    expect(parseRecordsFilter(JSON.stringify({ result: 'x', from: '2026/10/01', lineup: { sMin: 300, strongCount: 0, strongPr: '75' } })))
      .toEqual({ ...EMPTY_RECORDS_FILTER, lineup: { ...DEFAULT_LINEUP_FILTER, sMin: 100, strongCount: 1, strongPr: 75 } });
    expect(RECORDS_FILTER_KEY).toBe('avalon.records.filter');
  });

  it('screen state <-> condition (the stats filter clause): only switched-on parts, defaults when off', () => {
    expect(lineupCondition(DEFAULT_LINEUP_FILTER)).toEqual({});
    const both = { ...DEFAULT_LINEUP_FILTER, sOn: true, countOn: true, combine: 'or' as const, includeUnscored: true };
    expect(lineupCondition(both)).toEqual({ sMin: 65, strongPr: 70, strongCount: 6, combine: 'or', includeUnscored: true });
    expect(lineupCondition({ ...both, countOn: false })).toEqual({ sMin: 65, includeUnscored: true });
    expect(lineupStateFromCondition(lineupCondition(both))).toEqual(both);
    expect(lineupStateFromCondition(undefined)).toEqual(DEFAULT_LINEUP_FILTER);
    expect(sanitizeLineupState({ sOn: 'yes', sMin: -5 })).toEqual({ ...DEFAULT_LINEUP_FILTER, sMin: 0 });
    expect([lineupTier(65), lineupTier(55), lineupTier(54.9)]).toEqual(['high', 'strong', 'normal']);
  });
});

describe('web records: one database (DC + 試算表 牌譜 + 模擬瓦, Edward 2026-11-16)', () => {
  const SHEET: RecordPost = { ...POST, id: 'S102', title: '試算表牌譜 #102', tags: ['線瓦'], created: '', src: 'sheet' };
  const SIM_GAME: RecordGame = {
    ...GAME,
    rounds: [GAME.rounds[0], { proposals: [{ team: '1357', votes: [] }], mission: '' }],
    lakes: [],
    assassination: '',
    outcome: '',
    category: '',
  };
  const SIM: RecordPost = {
    id: 'M7', title: '試算表模擬 #7', tags: ['模擬'], created: '', date: '', game: SIM_GAME, src: 'sheet', sim: true,
  };

  it('模擬 is only a simulation: never in the default (實戰) list, only under 模擬 or 全部', () => {
    const f = EMPTY_RECORDS_FILTER;
    expect(f.kind).toBe('real');
    expect(matchesRecords(SIM, f)).toBe(false);
    expect(matchesRecords(POST, f)).toBe(true);
    expect(matchesRecords(SHEET, f)).toBe(true);
    expect(matchesRecords(SIM, { ...f, kind: 'sim' })).toBe(true);
    expect(matchesRecords(POST, { ...f, kind: 'sim' })).toBe(false);
    expect(matchesRecords(SIM, { ...f, kind: 'all' })).toBe(true);
    expect(recordsFilterActive({ ...f, kind: 'sim' })).toBe(false);  // a tab, not a filter
    expect(parseRecordsFilter(JSON.stringify({ kind: 'sim' })).kind).toBe('sim');
    expect(parseRecordsFilter(JSON.stringify({ kind: 'bogus' })).kind).toBe('real');
    expect(parseRecordsFilter(null).kind).toBe('real');
  });

  it('source and type labels; only Discord posts have a thread', () => {
    expect(sourceLabel(POST)).toBe('DC');
    expect(sourceLabel({ ...POST, src: 'dc+sheet' })).toBe('DC＋試算表');
    expect(sourceLabel(SHEET)).toBe('試算表');
    expect([kindLabel(POST), kindLabel(SIM)]).toEqual(['實戰', '模擬']);
    expect(isDiscordPost(POST)).toBe(true);
    expect([isDiscordPost(SHEET), isDiscordPost(SIM)]).toEqual([false, false]);
  });

  it('#records=S…／M… open sheet games', () => {
    expect(parseRecordsHash('#records=S102')).toEqual({ id: 'S102' });
    expect(parseRecordsHash('#records=m7')).toEqual({ id: 'M7' });
    expect(parseRecordsHash('#records=X7')).toBeNull();
    expect(parseStatsHash('#records=S102')).toEqual({ kind: 'records', id: 'S102' });
  });

  it('#records=<另一個來源的局號> 打開合併後的那一篇（站長 2026-11-19：S1629／S1951 打不開）', () => {
    // 同一局在試算表與 DC 都有時清單只留 DC 那一篇；伺服器把試算表 S…、Discord匯入 D… 寫進 aka
    const merged: RecordPost = { ...POST, id: '1297000000000000001', src: 'dc+sheet', aka: ['S1629', 'Dcc028a2b63'] };
    const posts = [SHEET, merged, SIM];
    expect(findRecordPost(posts, 'S1629')).toBe(merged);
    expect(findRecordPost(posts, 'Dcc028a2b63')).toBe(merged);
    expect(findRecordPost(posts, '1297000000000000001')).toBe(merged); // 正式局號照舊
    expect(findRecordPost(posts, SHEET.id)).toBe(SHEET);
    expect(findRecordPost(posts, 'S9999')).toBeUndefined();
    // 局號本身就是一篇時優先（另一篇的 aka 剛好也寫了它也不會搶走）
    expect(findRecordPost([{ ...merged, aka: [SHEET.id] }, SHEET], SHEET.id)).toBe(SHEET);

    // 網址：S／M／D／P 都認，大小寫不拘；&upto=&seat= 照留
    expect(parseRecordsHash('#records=s1629')).toEqual({ id: 'S1629' });
    expect(parseRecordsHash('#records=DCC028A2B63')).toEqual({ id: 'Dcc028a2b63' });
    expect(parseRecordsHash('#records=P5b75aa4683d07b001499d7e9')).toEqual({ id: 'P5b75aa4683d07b001499d7e9' });
    expect(parseRecordsHash('#records=S1629&upto=4&seat=0')).toEqual({ id: 'S1629', cut: { upto: 4, seat: '0' } });
    expect(parseRecordsHash('#records=Dcc028a2b63&upto=A')).toEqual({ id: 'Dcc028a2b63', cut: { upto: 'A' } });
    expect(parseStatsHash('#records=Dcc028a2b63')).toEqual({ kind: 'records', id: 'Dcc028a2b63' });
    expect(findRecordPost(posts, parseRecordsHash('#records=S1629&upto=4&seat=5')!.id!)).toBe(merged);
    // 換成正式局號的網址：cut 照留
    expect(recordsHash(merged.id, { upto: 4, seat: '5' })).toBe('#records=1297000000000000001&upto=4&seat=5');

    // 看不懂的不收
    expect(normaliseRecordsId('D12345')).toBeNull(); // D 要 10 碼
    expect(normaliseRecordsId('Dxyz0000000')).toBeNull();
    expect(normaliseRecordsId('12345')).toBeNull();
    expect(parseRecordsHash('#records=D12345')).toBeNull();
    expect(parseRecordsHash('#records=abc')).toBeNull();
  });

  it('an unfinished 模擬: no result, no empty mission line', () => {
    expect(outcomeOf(SIM)).toBeNull();
    expect(resultSentence(SIM_GAME, { roles: true, names: true })).toBe('模擬：打完 1 輪任務，還沒分出勝負');
    const text = recordsText(SIM_GAME).split('\n');
    expect(text.slice(0, 7)).toEqual(['147', '260', '389 7+', '469', '568', 'ooo', '1357']);
    expect(text[7]).toBe('936758');
  });
});

describe('文字牌譜上色（站長 2026-11-17：異常票變色）', () => {
  it('隊伍白、值得注意的票綠、任務紅藍、湖青色＋宣告', () => {
    expect(recordLineParts('4789 8- 36+')).toEqual([
      { text: '4789', kind: 'team' },
      { text: ' 8-', kind: 'mark' },
      { text: ' 36+', kind: 'mark' },
    ]);
    expect(recordLineParts('1590')).toEqual([{ text: '1590', kind: 'plain' }]);
    expect(recordLineParts('ooox', 1)).toEqual([{ text: 'ooox', kind: 'missionRed' }]);
    expect(recordLineParts('ooxoo', 3)).toEqual([{ text: 'ooxoo', kind: 'missionBlue' }]); // 第 4 輪要兩張失敗
    expect(recordLineParts('ooo')).toEqual([{ text: 'ooo', kind: 'missionBlue' }]);
    expect(recordLineParts('0>9 x')).toEqual([{ text: '0>9', kind: 'lake' }, { text: ' x', kind: 'claimEvil' }]);
    expect(recordLineParts('9>3 o')).toEqual([{ text: '9>3', kind: 'lake' }, { text: ' o', kind: 'claimGood' }]);
    expect(recordLineParts('刺客刺殺:5')).toEqual([{ text: '刺客刺殺:5', kind: 'plain' }]);
    expect(isMissionTextLine('oox')).toBe(true);
    expect(isMissionTextLine('1590')).toBe(false);
  });
});
