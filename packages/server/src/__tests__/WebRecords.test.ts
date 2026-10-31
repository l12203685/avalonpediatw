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
  RECORDS_PREF_KEYS,
  isLegacyRecordsHash,
  readRecordsPrefs,
  resultSentence,
  seatLabel,
  type RecordGame,
  type RecordPost,
} from '../../../web/src/utils/records';
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
    expect(seatLabel(GAME, '8', off)).toBe('8 號');
    expect(seatLabel(GAME, '8', { roles: false, names: true })).toBe('8 號 玩家H');
    expect(seatLabel(GAME, '8', { roles: true, names: false })).toBe('8 號（梅林）');
    expect(seatLabel(GAME, '8', both)).toBe('8 號 玩家H（梅林）');
  });

  it('the result sentence hides roles (who the assassin was, Merlin hit or not) and names when off', () => {
    expect(resultSentence(GAME, off)).toBe('藍方拿下三次任務；刺殺 3 號');
    expect(resultSentence(GAME, { roles: false, names: true })).toBe('藍方拿下三次任務；刺殺 3 號 玩家C');
    expect(resultSentence(GAME, both)).toBe('藍方拿下三次任務；刺客 9 號 玩家I 刺殺 3 號 玩家C（莫甘娜），沒刺中');
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
