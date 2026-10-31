/**
 * 陣容強度的網站純函式（Edward 2026-10-31）：組成比較的分組與數字格式（web components/analysis/strength/compareFormat）、
 * 角色條件的畫面狀態（web utils/lineupFilter）、牌譜紀錄的角色強度與角色篩選（web utils/records）。虛構的名字。
 */
import { describe, expect, it } from 'vitest';
import { GROUPING_OPTIONS, buildGrouping, formatDelta, formatMetric } from '../../../web/src/components/analysis/strength/compareFormat';
import {
  DEFAULT_LINEUP_FILTER, ROLE_CONDITIONS, lineupCondition, lineupFilterActive, lineupStateFromCondition, sanitizeLineupState,
} from '../../../web/src/utils/lineupFilter';
import { EMPTY_RECORDS_FILTER, matchesRecords, postRoleStrength, postSeats, type RecordPost } from '../../../web/src/utils/records';

const NAMES = 'ABCDEFGHIJ'.split('').map((c) => `玩家${c}`);
const POST: RecordPost = {
  id: '1432000000000000009', title: '1025一般場9', tags: ['三紅'], created: '2026-10-25T23:00:00+08:00', date: '2026-10-25',
  game: {
    config: '123456', names: NAMES, rounds: [{ proposals: [{ team: '157', votes: [] }], mission: 'oox' }], lakes: [],
    assassination: '', outcome: '三紅', category: '線瓦',
  },
  // 紅方 1–4：80 75 72 71；派 5：90；梅 6：85；忠臣 7–0：60 55 52 50
  lineup: { pool: 40, s: 69, prs: [80, 75, 72, 71, 90, 85, 60, 55, 52, 50], prov: '' },
};

describe('組成比較：分組與格式', () => {
  it('groupings carry their parameters only where needed', () => {
    expect(buildGrouping('count', 65, 7, 30)).toEqual({ kind: 'count', pr: 65, count: 7 });
    expect(buildGrouping('weakLoyal', 65, 7, 25)).toEqual({ kind: 'weakLoyal', pr: 25 });
    expect(buildGrouping('gap', 65, 7, 25)).toEqual({ kind: 'gap' });
    expect(GROUPING_OPTIONS.map((o) => o.kind)).toEqual(['tier', 'count', 'merlin', 'percival', 'merlinVsAssassin', 'gap', 'weakRed', 'weakLoyal']);
  });

  it('rates as whole percents (one decimal under 10), averages one decimal, deltas vs 全部', () => {
    expect([formatMetric(44.44, 'rate'), formatMetric(2.46, 'rate'), formatMetric(13.04, 'avg'), formatMetric(null, 'rate')])
      .toEqual(['44%', '2.5%', '13.0', '—']);
    expect(formatDelta(49, 44, 'rate')).toEqual({ text: '+5', tone: 'up' });
    expect(formatDelta(42, 44, 'rate')).toEqual({ text: '−2', tone: 'flat' });
    expect(formatDelta(44.2, 44, 'rate')).toEqual({ text: '±0', tone: 'flat' });
    expect(formatDelta(9.3, 13.0, 'avg')).toEqual({ text: '−3.7', tone: 'down' });
    expect(formatDelta(null, 1, 'avg')).toBeNull();
  });
});

describe('角色條件的畫面狀態', () => {
  it('only switched-on role conditions go into the condition; 且／或 needs two', () => {
    const merlin = { ...DEFAULT_LINEUP_FILTER, roleOn: { ...DEFAULT_LINEUP_FILTER.roleOn, merlinPrMin: true }, combine: 'or' as const };
    expect(lineupCondition(merlin)).toEqual({ merlinPrMin: 70 });
    expect(lineupFilterActive(merlin)).toBe(true);
    const two = { ...merlin, sOn: true, roleOn: { ...merlin.roleOn, gapMin: true }, roleValue: { ...merlin.roleValue, gapMin: -15 } };
    expect(lineupCondition(two)).toEqual({ sMin: 65, merlinPrMin: 70, gapMin: -15, combine: 'or' });
    expect(lineupStateFromCondition(lineupCondition(two))).toEqual(two);
    expect(ROLE_CONDITIONS.map((r) => r.key)).toEqual(['merlinPrMin', 'percivalPrMin', 'redMinPrMin', 'loyalMinPrMin', 'gapMin']);
  });

  it('stored values are clamped (gap −100–100, PR 0–100)', () => {
    const s = sanitizeLineupState({ roleOn: { gapMin: true, merlinPrMin: 'yes' }, roleValue: { gapMin: -300, percivalPrMin: 150 } });
    expect(s.roleOn).toEqual({ ...DEFAULT_LINEUP_FILTER.roleOn, gapMin: true });
    expect(s.roleValue.gapMin).toBe(-100);
    expect(s.roleValue.percivalPrMin).toBe(100);
    expect(sanitizeLineupState(undefined)).toEqual(DEFAULT_LINEUP_FILTER);
  });
});

describe('牌譜紀錄：角色強度與角色篩選', () => {
  const role = (patch: Partial<Record<(typeof ROLE_CONDITIONS)[number]['key'], number>>) => ({
    ...EMPTY_RECORDS_FILTER,
    lineup: {
      ...DEFAULT_LINEUP_FILTER,
      roleOn: { ...DEFAULT_LINEUP_FILTER.roleOn, ...Object.fromEntries(Object.keys(patch).map((k) => [k, true])) },
      roleValue: { ...DEFAULT_LINEUP_FILTER.roleValue, ...patch },
    },
  });

  it('roles from the 配置, unnamed seats unknown', () => {
    expect(postSeats(POST)?.roles.slice(0, 7)).toEqual(['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林', '忠臣']);
    const st = postRoleStrength(POST);
    expect(st?.pr.red).toEqual({ mean: 74.5, max: 80, min: 71 });
    expect([st?.pr.merlin, st?.pr.percival]).toEqual([85, 90]);
    const unnamed: RecordPost = { ...POST, game: { ...POST.game!, names: [...NAMES.slice(0, 9), ''] } };
    expect(postRoleStrength(unnamed)?.pr.loyal).toBeNull();
    expect(postRoleStrength({ ...POST, lineup: undefined })).toBeNull();
  });

  it('filters by Merlin / Percival PR, weakest red, red − blue gap', () => {
    expect(matchesRecords(POST, role({ merlinPrMin: 80 }))).toBe(true);
    expect(matchesRecords(POST, role({ merlinPrMin: 90 }))).toBe(false);
    expect(matchesRecords(POST, role({ percivalPrMin: 90, redMinPrMin: 70 }))).toBe(true);
    expect(matchesRecords(POST, role({ gapMin: 9 }))).toBe(true);
    expect(matchesRecords(POST, role({ gapMin: 10 }))).toBe(false);
    expect(matchesRecords({ ...POST, game: { ...POST.game!, names: [...NAMES.slice(0, 9), ''] } }, role({ loyalMinPrMin: 0 }))).toBe(false);
  });
});
