/**
 * 網站「百科AI 對局」頁的純函式（packages/web/src/utils/aiGames.ts；web 沒有測試執行器，在這裡測）與 #ai-games 深連結。
 * 虛構的一局（測試玩家N、百科AI_21）。網站的型別要跟伺服器的 trace 對得上：這裡直接拿伺服器格式的 trace 餵網站函式。
 */
import { describe, expect, it } from 'vitest';
import {
  aiGamesHash, decisionWhere, parseAiGameName, parseAiGamesHash, resultText, reviewSections, seatsText,
  type AiGameTrace as WebTrace,
} from '../../../web/src/utils/aiGames';
import { PUBLIC_STATS_STATES, parseStatsHash } from '../../../web/src/utils/statsLinks';
import { AI_GAME_FORMAT, AI_GAME_VERSION, aiGameThreadName, type AiGameTrace } from '../services/aiGameTrace';

const TRACE: AiGameTrace = {
  format: AI_GAME_FORMAT, version: AI_GAME_VERSION, source: 'signage-cloud',
  room: 'Room-1460', title: '週四練習團', startedAt: '2026-11-05T13:05:00.000Z', endedAt: '2026-11-05T13:40:00.000Z', winner: 'good',
  seats: [{ seat: 3, name: '百科AI_21', role: '派西維爾', team: 'good', ai: true }, { seat: 10, name: '', role: '刺客', team: 'evil', ai: false }],
  proposals: [
    { round: 1, attempt: 1, leader: 1, team: [1, 3, 10], approve: [1, 3, 10, 6, 8, 9], reject: [2, 4, 5, 7], approved: true, forced: false },
    { round: 2, attempt: 1, leader: 2, team: [2, 3, 5, 6], approve: [2], reject: [1, 3, 4, 5, 6, 7, 8, 9, 10], approved: false, forced: false },
  ],
  missions: [{ round: 1, team: [1, 3, 10], fails: 0, result: 'success' }],
  lakes: [{ round: 2, holder: 10, target: 3, claim: null }],
  assassination: { target: 5, hit: false },
  decisions: [
    { id: 1, at: 1, round: 1, attempt: 1, kind: 'vote', seat: 3, nick: '百科AI_21', role: 'percival', team: 'good', action: '贊成', detail: { vote: true }, reason: '贊成：…', source: 'agent' },
    { id: 2, at: 2, round: 1, attempt: 1, kind: 'mission', seat: 3, nick: '百科AI_21', role: 'percival', team: 'good', action: '出成功', detail: { card: 'success' }, reason: '好人只能出成功', source: 'agent' },
    { id: 3, at: 3, round: 2, attempt: 1, kind: 'vote', seat: 3, nick: '百科AI_21', role: 'percival', team: 'good', action: '反對', detail: { vote: false }, reason: '反對：…', source: 'fallback' },
    { id: 4, at: 4, round: 2, attempt: 0, kind: 'declare', seat: 3, nick: '百科AI_21', role: 'percival', team: 'good', action: '宣告 4家 是好人', detail: {}, reason: '…', source: 'agent' },
  ],
  notes: [],
};
// 伺服器格式的 trace 直接當網站格式用（結構要相容）
const WEB: WebTrace = TRACE;

describe('#ai-games 深連結', () => {
  it('清單與打開一局；免登入頁', () => {
    expect(parseAiGamesHash('#ai-games')).toEqual({ id: null });
    expect(parseAiGamesHash('#aigames')).toEqual({ id: null });
    expect(parseAiGamesHash('#ai-games=1570000000000000001')).toEqual({ id: '1570000000000000001' });
    expect(parseAiGamesHash('#ai-games=abc')).toBeNull();
    expect(parseAiGamesHash('#records')).toBeNull();
    expect(aiGamesHash('1570000000000000001')).toBe('#ai-games=1570000000000000001');
    expect(aiGamesHash()).toBe('#ai-games');
    expect(parseStatsHash('#ai-games')).toEqual({ kind: 'aiGames', id: null });
    expect(parseStatsHash('#ai-games=1570000000000000001')).toEqual({ kind: 'aiGames', id: '1570000000000000001' });
    expect(PUBLIC_STATS_STATES.has('aiGames')).toBe(true);
  });
});

describe('清單與回顧', () => {
  it('討論串標題 → 時間與房間（伺服器組的標題讀得回來）', () => {
    expect(parseAiGameName(aiGameThreadName(TRACE))).toEqual({ when: '2026-11-05 21:05', where: '週四練習團／Room-1460' });
    expect(parseAiGameName('百科AI對局 奇怪的標題')).toEqual({ when: '', where: '奇怪的標題' });
  });

  it('依局分段：提議的公開紀錄＋百科AI 的決定；任務、湖、刺殺', () => {
    const s = reviewSections(WEB);
    expect(s.map((x) => x.title)).toEqual(['第 1 局', '第 2 局', '刺殺']);
    expect(s[0].blocks.map((b) => [b.title, b.decisions.map((d) => d.id)])).toEqual([['第 1 次提議', [1]], ['任務', [2]]]);
    expect(s[0].blocks[0].facts[0]).toBe('隊長 1家 → 1、3、0家\u3000贊成 1、3、6、8、9、0家／反對 2、4、5、7家 → 通過');
    expect(s[1].blocks.map((b) => b.title)).toEqual(['第 1 次提議', '湖']);
    expect(s[1].blocks[1].facts[0]).toBe('0家 湖 3家，沒有宣告');
    expect(s[2].blocks[0].facts[0]).toBe('刺客刺 5家，沒中');
  });

  it('篩選：只留符合的決定，沒有決定的段落不顯示', () => {
    const s = reviewSections(WEB, (d) => d.kind === 'vote', true);
    expect(s.map((x) => x.title)).toEqual(['第 1 局', '第 2 局']);
    expect(s.flatMap((x) => x.blocks.flatMap((b) => b.decisions.map((d) => d.id)))).toEqual([1, 3]);
  });

  it('結果、位置、座位文字', () => {
    expect(resultText(WEB)).toBe('藍方勝（任務 藍 1：紅 0，刺客刺 5家 沒中）');
    expect(decisionWhere(WEB.decisions[3])).toBe('第 2 局任務後');
    expect(decisionWhere(WEB.decisions[1])).toBe('第 1 局第 1 次任務');
    expect(seatsText([10, 2, 1])).toBe('1、2、0家');
  });
});
