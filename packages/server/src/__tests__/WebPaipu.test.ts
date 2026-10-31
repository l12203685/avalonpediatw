/**
 * 網站「牌譜紀錄」頁籤的純函式（packages/web/src/utils/paipu.ts；web 沒有測試執行器，在這裡測），
 * 以及 #paipu 深連結與免登入頁面。虛構的貼文與名字（玩家A…）。
 */
import { describe, expect, it } from 'vitest';
import {
  approveCount,
  discordThreadUrl,
  isForcedProposal,
  lakeClaimLabel,
  matchesPaipu,
  matchingSeats,
  missionIsRed,
  outcomeOf,
  paipuHash,
  paipuText,
  parsePaipuHash,
  proposalVotes,
  roleOfSeat,
  sortedTeam,
  voteMarks,
  winnerOf,
  EMPTY_PAIPU_FILTER,
  type PaipuGame,
  type PaipuPost,
} from '../../../web/src/utils/paipu';
import { PUBLIC_STATS_STATES, parseStatsHash } from '../../../web/src/utils/statsLinks';

const NAMES = 'ABCDEFGHIJ'.split('').map((c) => `玩家${c}`);
const GAME: PaipuGame = {
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
const POST: PaipuPost = {
  id: '1432000000000000001', title: '1025一般場6', tags: ['三藍躲刺', '線瓦'],
  created: '2026-10-25T23:00:00+08:00', date: '2026-10-25', game: GAME,
};
const BROKEN: PaipuPost = {
  id: '1432000000000000002', title: '1026直播局1', tags: ['三紅', '待修正'],
  created: '2026-10-26T22:00:00+08:00', date: '2026-10-26', game: null, problem: '這一行看不懂', problemLine: 14,
};

describe('web paipu: votes', () => {
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

describe('web paipu: game facts', () => {
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
    const text = paipuText(GAME).split('\n');
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

describe('web paipu: filters', () => {
  it('by result, unreadable, date range', () => {
    const f = EMPTY_PAIPU_FILTER;
    expect(matchesPaipu(POST, { ...f, result: '三藍活' })).toBe(true);
    expect(matchesPaipu(POST, { ...f, result: '三紅' })).toBe(false);
    expect(matchesPaipu(BROKEN, { ...f, result: '三紅' })).toBe(true);
    expect(matchesPaipu(BROKEN, { ...f, result: 'unreadable' })).toBe(true);
    expect(matchesPaipu(POST, { ...f, result: 'unreadable' })).toBe(false);
    expect(matchesPaipu(POST, { ...f, from: '2026-10-25', to: '2026-10-25' })).toBe(true);
    expect(matchesPaipu(POST, { ...f, from: '2026-10-26' })).toBe(false);
    expect(matchesPaipu(POST, { ...f, to: '2026-10-24' })).toBe(false);
  });

  it('by nickname (case / width insensitive) or title', () => {
    const f = EMPTY_PAIPU_FILTER;
    expect(matchesPaipu(POST, { ...f, query: '玩家ｃ' })).toBe(true);
    expect(matchesPaipu(POST, { ...f, query: '一般場' })).toBe(true);
    expect(matchesPaipu(POST, { ...f, query: '玩家Z' })).toBe(false);
    expect(matchesPaipu(BROKEN, { ...f, query: '玩家A' })).toBe(false);
    expect(matchingSeats(POST, 'c')).toEqual(['3']);
    expect(matchingSeats(POST, '')).toEqual([]);
  });
});

describe('web paipu: #paipu links', () => {
  it('parses #paipu and #paipu=<post id>', () => {
    expect(parsePaipuHash('#paipu')).toEqual({ id: null });
    expect(parsePaipuHash('#paipu=1432000000000000001')).toEqual({ id: '1432000000000000001' });
    expect(parsePaipuHash('#paipu=abc')).toBeNull();
    expect(parsePaipuHash('#stats')).toBeNull();
    expect(paipuHash('1432000000000000001')).toBe('#paipu=1432000000000000001');
  });

  it('App opens the 牌譜紀錄 tab from those links, without a login', () => {
    expect(parseStatsHash('#paipu=1432000000000000001')).toEqual({ kind: 'paipu', id: '1432000000000000001' });
    expect(parseStatsHash('#paipu')).toEqual({ kind: 'paipu', id: null });
    expect(PUBLIC_STATS_STATES.has('paipu')).toBe(true);
  });
});
