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

const NARRATIVE_1 = ['【第1局任務2・派隊投票】', '　 2家：嗯', '▶ 4家：3家為什麼這樣派（提到 3家百科AI・講到百科AI 的座位）', '　 5家：3家亂打, 說真的'].join('\n');
const FIXTURE = csv([
  [...IN_GAME_FEEDBACK_HEADER],
  ['2026-11-26 20:01:00', 'R1', 1, '3家、7家', 2, '派隊投票、局後', '3家百科AI、百科AI', '3家刺客', '講到百科AI 的座位、講到百科AI', NARRATIVE_1],
  ['2026-11-26 21:00:00', 'R2', 1, '7家', 1, '刺殺', '7家百科AI', '7家梅林', '講到百科AI 的座位', '【第1局任務5・刺殺】\n▶ 2家：7家好神（提到 7家百科AI・講到百科AI 的座位）'],
  ['2026-11-26 22:00:00', 'R3', 2, '3家', 1, '局後', '沒指名', '', '評價玩法', '【第2局・局後】\n▶ 6家：好強（提到 沒指名・評價玩法）'],
  ['2026-11-26 23:00:00', 'R4', 1, '3家', 1, '出任務', '3家百科AI', '3家刺客', '講到百科AI 的座位', '【第1局任務1・出任務】\n▶ 1家：3家怪怪的'],
]);

describe('inGameFeedbackReport', () => {
  it('parses the exported tab (one row per game; quotes, commas, newlines) by column name', () => {
    const rows = readRows(parseCsv(`\uFEFF${FIXTURE}`));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ game: 'R1#1', count: 2, phases: ['派隊投票', '局後'], roles: ['刺客'], narrative: NARRATIVE_1 });
    expect(rolesOf('3家刺客、0家梅林')).toEqual(['刺客', '梅林']);
  });

  it('groups whole games by the role of the mentioned bot, with the conversation', () => {
    const groups = groupFeedback(readRows(parseCsv(FIXTURE)));
    expect(groups.map((g) => [g.role, g.games, g.lines])).toEqual([
      ['刺客', 2, 3],
      ['梅林', 1, 1],
      ['沒指名', 1, 1],
    ]);
    const counts = formatReport(groups, { withText: false });
    expect(counts).toContain('■ 刺客：2 局、3 則（階段：派隊投票 1、局後 1、出任務 1）');
    expect(counts).toContain('整體印象 → 相關的局面／決策 → 要測的假設');
    expect(counts).not.toContain('亂打');
    const full = formatReport(groups, { withText: true });
    expect(full).toContain('  ◆ R1#1（講到百科AI 的座位、講到百科AI）');
    expect(full).toContain('    　 5家：3家亂打, 說真的');
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
