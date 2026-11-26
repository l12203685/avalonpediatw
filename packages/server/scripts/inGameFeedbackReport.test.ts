/** 遊戲內回饋離線整理（scripts/inGameFeedbackReport.ts）。假資料。 */
import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { formatReport, groupFeedback, insideRepo, parseCsv, readRows, rolesOf } from './inGameFeedbackReport';
import { IN_GAME_FEEDBACK_HEADER } from '../src/inGameFeedback/sheetWriter';

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: Array<Array<string | number>>): string => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

const FIXTURE = csv([
  [...IN_GAME_FEEDBACK_HEADER],
  ['2026-11-26 20:01:00', 'R1', 1, '派隊投票', 2, 1, '4家', '3家百科AI', '3家刺客', '講到百科AI 的座位', '3家、7家', 3, '3家為什麼這樣派'],
  ['2026-11-26 20:05:00', 'R1', 1, '派隊投票', 3, 2, '5家', '3家百科AI', '3家刺客', '講到百科AI 的座位', '3家、7家', 3, '3家亂打, 說真的'],
  ['2026-11-26 20:20:00', 'R1', 1, '局後', '', '', '4家', '百科AI', '', '講到百科AI', '3家、7家', 3, 'AI 好強\n下次再來'],
  ['2026-11-26 21:00:00', 'R2', 1, '刺殺', 5, 1, '2家', '7家百科AI', '7家梅林', '講到百科AI 的座位', '7家', 1, '7家好神'],
]);

describe('inGameFeedbackReport', () => {
  it('parses the exported tab (quotes, commas, newlines) by column name', () => {
    const rows = readRows(parseCsv(`\uFEFF${FIXTURE}`));
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ game: 'R1#1', phase: '派隊投票', round: '3', roles: ['刺客'], text: '3家亂打, 說真的' });
    expect(rows[2].text).toBe('AI 好強\n下次再來');
    expect(rolesOf('3家刺客、0家梅林')).toEqual(['刺客', '梅林']);
  });

  it('groups by phase × role of the mentioned bot × kind', () => {
    const groups = groupFeedback(readRows(parseCsv(FIXTURE)));
    expect(groups.map((g) => [g.phase, g.role, g.kind, g.count, g.games])).toEqual([
      ['派隊投票', '刺客', '講到百科AI 的座位', 2, 1],
      ['刺殺', '梅林', '講到百科AI 的座位', 1, 1],
      ['局後', '角色不明', '講到百科AI', 1, 1],
    ]);
    const counts = formatReport(groups, { withText: false });
    expect(counts).toContain('■ 派隊投票｜刺客｜講到百科AI 的座位：2 則、1 局');
    expect(counts).not.toContain('亂打');
    expect(formatReport(groups, { withText: true })).toContain('  - 任務3：3家亂打, 說真的');
  });

  it('refuses a CSV inside the repo', () => {
    const repo = path.resolve(__dirname, '..', '..', '..');
    expect(insideRepo(path.join(repo, 'docs', 'x.csv'), repo)).toBe(true);
    expect(insideRepo('/tmp/elsewhere/x.csv', repo)).toBe(false);
  });

  it('rejects a CSV that is not the tab', () => {
    expect(() => readRows(parseCsv('a,b\n1,2'))).toThrow(/遊戲內回饋/);
  });
});
