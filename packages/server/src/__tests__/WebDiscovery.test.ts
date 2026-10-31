/**
 * 自動發現的網站文字與清單（web components/analysis/discovery/discoveryText）：一句話、差距與信賴區間、可套用的篩選、
 * 清單的篩選與排序。合成的發現物件。
 */
import { describe, expect, it } from 'vitest';
import { DISCOVERY_DIMENSIONS, DISCOVERY_METRICS, type DiscoveryFinding } from '@avalon/shared/stats';
import {
  EMPTY_DISCOVERY_QUERY, findingClause, findingNotes, findingSentence, formatCi, formatDiff, queryFindings, topForPage,
} from '../../../web/src/components/analysis/discovery/discoveryText';
import { buildGrouping } from '../../../web/src/components/analysis/strength/compareFormat';

const dim = (unit: string, id: string) => DISCOVERY_DIMENSIONS.find((d) => d.unit === unit && d.id === id)!;
const met = (unit: string, id: string) => DISCOVERY_METRICS.find((m) => m.unit === unit && m.id === id)!;

function finding(over: Partial<DiscoveryFinding>): DiscoveryFinding {
  return {
    id: 'x', unit: 'game', dimension: dim('game', 'merlin'), metric: met('game', 'hit'),
    a: { label: '前 1/3（≥ 62）', value: 38.6, n: 251, units: 458 }, b: { label: '後 1/3（< 24）', value: 47.2, n: 300, units: 540 },
    diff: -8.6, lo: -16.8, hi: -0.4, p: 0.001, q: 0.02, effect: -0.17, ...over,
  };
}

describe('discovery text', () => {
  it('one plain sentence, the difference and its CI', () => {
    const f = finding({});
    expect(findingSentence(f)).toBe('梅林 PR 前 1/3（≥ 62）時，刺中率 39%；後 1/3（< 24）時 47%');
    expect(formatDiff(-8.6, 'rate')).toBe('−9pp');
    expect(formatDiff(0.25, 'avg')).toBe('+0.25');
    expect(formatCi(f)).toBe('95% CI −17～−0pp');
    const cat = finding({ dimension: dim('game', 'category'), a: { label: '面瓦', value: 3.03, n: 269, units: 269 }, metric: met('game', 'outerWhiteRed') });
    expect(findingSentence(cat)).toBe('分類是「面瓦」時，紅方外白／局 3.03；其他情況時 25.00'.replace('25.00', '47.20'));
  });

  it('notes: strongly correlated with S, and the difference within S tiers', () => {
    expect(findingNotes(finding({ corrWithS: 0.83, withinS: -5.2 }))).toEqual([
      '這個維度跟桌上 S 高度相關（r = 0.83）', '在 S 三分層裡各自比，平均差 −5pp']);
    expect(findingNotes(finding({ corrWithS: 0.2 }))).toEqual([]);
  });

  it('filters that can be applied: 分類, 年份, 梅林座位', () => {
    expect(findingClause(finding({ dimension: dim('game', 'category'), a: { label: '面瓦', value: 1, n: 1, units: 1 } }))).toEqual({ kind: 'category', in: ['面瓦'] });
    expect(findingClause(finding({ dimension: dim('game', 'year'), a: { label: '2024', value: 1, n: 1, units: 1 } }))).toEqual({ kind: 'date', from: '2024-01-01', to: '2024-12-31' });
    expect(findingClause(finding({ dimension: dim('game', 'merlinSeat'), a: { label: '10 號', value: 1, n: 1, units: 1 } }))).toEqual({ kind: 'roleSeat', role: '梅林', seats: [10] });
    expect(findingClause(finding({}))).toBeNull();
  });

  it('list: page, unit, text, structural toggle, sort', () => {
    const lake = finding({ id: 'l', unit: 'lake', dimension: dim('lake', 'holderRole'), metric: met('lake', 'targetRed'), effect: 0.26, q: 0.01, a: { label: '莫甘娜', value: 40, n: 378, units: 378 } });
    const seq = finding({ id: 's', unit: 'proposal', dimension: dim('proposal', 'sequence'), metric: met('proposal', 'passed'), effect: 1.2 });
    const all = [finding({}), lake, seq];
    expect(queryFindings(all, EMPTY_DISCOVERY_QUERY).map((f) => f.id)).toEqual(['l', 'x']);
    expect(queryFindings(all, { ...EMPTY_DISCOVERY_QUERY, structural: true }).map((f) => f.id)).toEqual(['s', 'l', 'x']);
    expect(queryFindings(all, { ...EMPTY_DISCOVERY_QUERY, page: 'lake' }).map((f) => f.id)).toEqual(['l']);
    expect(queryFindings(all, { ...EMPTY_DISCOVERY_QUERY, text: '刺中' }).map((f) => f.id)).toEqual(['x']);
    expect(queryFindings(all, { ...EMPTY_DISCOVERY_QUERY, sort: 'q' }).map((f) => f.id)).toEqual(['l', 'x']);
    expect(topForPage(all, 'assassination', 3).map((f) => f.id)).toEqual(['x']);
    expect(buildGrouping('tertile', 70, 6, 30, 'redMin')).toEqual({ kind: 'tertile', dim: 'redMin' });
  });
});
