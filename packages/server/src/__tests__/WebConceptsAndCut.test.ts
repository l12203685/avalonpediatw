/**
 * 網站的兩個新東西（packages/web；web 沒有測試執行器，在這裡測純函式）：
 *   - 百科觀念卡的公開頁（utils/concepts.ts）：#concepts／#concepts=<id>、搜尋與篩選、卡庫檔對得上網站的型別；
 *   - 牌譜「只到出題的那一刻」（utils/records.ts）：#records=<id>&upto=<n|A>&seat=<s>，藏起那一次（含）之後的派票、任務、湖、
 *     結果、刺殺、角色與名字，只留那一家自己的資訊；伺服器的小觀念連結（conceptDaily/plan.ts cutoffRecordUrl）解析得回來。
 * 虛構的牌譜與名字。
 */
import { describe, expect, it } from 'vitest';
import {
  CONCEPT_DECISIONS,
  CONCEPT_PHASES,
  CONCEPT_ROLE_TAGS,
  EMPTY_CONCEPT_FILTER,
  conceptAnchorId,
  conceptPhase,
  groupConceptsByPhase,
  conceptsHash,
  evidenceLabel,
  filterConcepts,
  parseConceptsHash,
  roundLabel,
  type ConceptBankFile,
} from '../../../web/src/utils/concepts';
import { cutLabel, cutRecordGame, cutViewer, parseRecordsHash, recordsHash, type RecordGame } from '../../../web/src/utils/records';
import { parseStatsHash } from '../../../web/src/utils/statsLinks';
import CONCEPTS_FILE from '../bots/threads/concepts.json';
import { conceptPageUrl, cutoffRecordUrl } from '../bots/conceptDaily/plan';

const BANK = CONCEPTS_FILE as unknown as ConceptBankFile;

describe('concept cards page', () => {
  it('parses #concepts links and builds them', () => {
    expect(parseConceptsHash('#concepts')).toEqual({ id: null });
    expect(parseConceptsHash('#concepts=w205-loyal-seat1')).toEqual({ id: 'w205-loyal-seat1' });
    expect(parseConceptsHash('#concepts/w205-loyal-seat1')).toEqual({ id: 'w205-loyal-seat1' });
    expect(parseConceptsHash('#concepts=<script>')).toEqual({ id: null });
    expect(parseConceptsHash('#wiki')).toBeNull();
    expect(conceptsHash('w205-loyal-seat1')).toBe('#concepts=w205-loyal-seat1');
    expect(conceptAnchorId('a-b')).toBe('concept-a-b');
    // 公開頁開在百科攻略；小觀念訊息的連結就是這個 hash。
    expect(parseStatsHash('#concepts=w205-loyal-seat1')).toEqual({ kind: 'concepts', id: 'w205-loyal-seat1' });
    const url = conceptPageUrl(BANK.site, 'w205-loyal-seat1');
    expect(parseConceptsHash(url.slice(url.indexOf('#')))).toEqual({ id: 'w205-loyal-seat1' });
  });

  it('ships the server’s card bank in the shape the page reads, every card with an anchor-safe id', () => {
    expect(BANK.concepts.length).toBeGreaterThan(40);
    for (const c of BANK.concepts) {
      expect(parseConceptsHash(conceptsHash(c.id))).toEqual({ id: c.id });
      expect(c.article.url.startsWith(`${BANK.site}/#wiki=`)).toBe(true);
      expect(c.tags.decision.every((d) => (CONCEPT_DECISIONS as readonly string[]).includes(d))).toBe(true);
      expect(evidenceLabel(c.evidence).label).toBeTruthy();
    }
  });

  it('searches the three sentences and the article, and filters by decision and round', () => {
    const all = filterConcepts(BANK.concepts, EMPTY_CONCEPT_FILTER);
    expect(all).toHaveLength(BANK.concepts.length);
    const kill = filterConcepts(BANK.concepts, { ...EMPTY_CONCEPT_FILTER, decision: '刺殺' });
    expect(kill.length).toBeGreaterThan(0);
    expect(kill.every((c) => c.tags.decision.includes('刺殺'))).toBe(true);
    const r1 = filterConcepts(BANK.concepts, { ...EMPTY_CONCEPT_FILTER, round: '1' });
    expect(r1.length).toBeGreaterThan(0);
    expect(r1.every((c) => c.tags.round.some((r) => r.startsWith('1-')))).toBe(true);
    const general = filterConcepts(BANK.concepts, { ...EMPTY_CONCEPT_FILTER, round: 'any' });
    expect(general.every((c) => c.tags.round.includes('any'))).toBe(true);
    const card = BANK.concepts[0];
    const q = card.觀念.slice(0, 6);
    expect(filterConcepts(BANK.concepts, { ...EMPTY_CONCEPT_FILTER, query: q }).map((c) => c.id)).toContain(card.id);
    expect(filterConcepts(BANK.concepts, { ...EMPTY_CONCEPT_FILTER, query: '完全不會出現的字串zzz' })).toEqual([]);
    expect(roundLabel('2-*')).toBe('第 2 局');
    expect(roundLabel('1-5')).toBe('1-5');
    expect(roundLabel('A')).toBe('刺殺');
  });

  it('groups by phase with the three 派隊 groups first, and filters by phase and role', () => {
    expect(CONCEPT_PHASES.slice(0, 3)).toEqual(['第一局派隊', '第二局派隊', '第三～五局派隊']);
    const groups = groupConceptsByPhase(BANK.concepts);
    expect(groups.map((g) => g.phase)).toEqual(CONCEPT_PHASES.filter((p) => BANK.concepts.some((c) => conceptPhase(c) === p)));
    expect(groups.reduce((n, g) => n + g.cards.length, 0)).toBe(BANK.concepts.length);
    for (const p of CONCEPT_PHASES) {
      const got = filterConcepts(BANK.concepts, { ...EMPTY_CONCEPT_FILTER, phase: p });
      expect(got.every((c) => c.tags.phase === p)).toBe(true);
    }
    for (const r of CONCEPT_ROLE_TAGS) {
      const got = filterConcepts(BANK.concepts, { ...EMPTY_CONCEPT_FILTER, role: r });
      expect(got.length, r).toBeGreaterThan(0);
      expect(got.every((c) => c.tags.role?.includes(r))).toBe(true);
    }
    // 舊的卡庫沒有 phase：當成通用
    expect(conceptPhase({ ...BANK.concepts[0], tags: { decision: ['派隊'], round: ['1-1'] } })).toBe('通用');
  });
});

// ─── 只到出題的那一刻 ──────────────────────────────────────────────────────

const GAME: RecordGame = {
  config: '936758', // 刺客 9、莫甘娜 3、莫德雷德 6、奧伯倫 7、派西 5、梅林 8
  names: 'ABCDEFGHIJ'.split('').map((c) => `玩家${c}`),
  rounds: [
    { proposals: [{ team: '147', votes: [] }, { team: '260', votes: [] }, { team: '389', votes: ['7+'] }, { team: '469', votes: [] }, { team: '568', votes: [] }], mission: 'ooo' },
    { proposals: [{ team: '5680', votes: [] }], mission: 'ooox' },
    { proposals: [{ team: '1458', votes: [] }, { team: '1450', votes: ['2+'] }], mission: 'oooo' },
    { proposals: [{ team: '15678', votes: ['5-', '39+'] }, { team: '14580', votes: [] }], mission: 'ooooo' },
  ],
  lakes: [{ after: 2, holder: '0', target: '8', claim: 'o' }, { after: 3, holder: '8', target: '4', claim: '?' }],
  assassination: '3',
  outcome: '三藍活',
  category: '線瓦',
};

describe('record cut at the decision point', () => {
  it('parses &upto= and &seat= (and builds them), ignoring a bad upto', () => {
    expect(parseRecordsHash('#records=S358&upto=4&seat=5')).toEqual({ id: 'S358', cut: { upto: 4, seat: '5' } });
    expect(parseRecordsHash('#records=1432000000000000001&upto=A&seat=0')).toEqual({ id: '1432000000000000001', cut: { upto: 'A', seat: '0' } });
    expect(parseRecordsHash('#records=S358&upto=x')).toEqual({ id: 'S358' });
    expect(parseRecordsHash('#records=S358&upto=3&seat=11')).toEqual({ id: 'S358', cut: { upto: 3 } });
    expect(parseRecordsHash('#records=S358')).toEqual({ id: 'S358' });
    expect(recordsHash('S358', { upto: 4, seat: '5' })).toBe('#records=S358&upto=4&seat=5');
    expect(parseStatsHash('#records=S358&upto=4&seat=5')).toEqual({ kind: 'records', id: 'S358' });
    // 伺服器小觀念的連結解析得回來。
    const url = cutoffRecordUrl('S358', 7, 10);
    expect(parseRecordsHash(url.slice(url.indexOf('#')))).toEqual({ id: 'S358', cut: { upto: 7, seat: '0' } });
  });

  it('hides the decision proposal and everything after it, the result, roles and names', () => {
    // 整局第 7 次派票（從 0 數）= 第 3 局第 2 次：前兩局與第 3 局第 1 次看得到，第 2 局後的湖也看得到。
    const cut = cutRecordGame(GAME, { upto: 7, seat: '4' });
    expect(cut.rounds.map((r) => [r.proposals.map((p) => p.team), r.mission])).toEqual([
      [['147', '260', '389', '469', '568'], 'ooo'],
      [['5680'], 'ooox'],
      [['1458'], ''],
    ]);
    expect(cut.lakes).toEqual([{ after: 2, holder: '0', target: '8', claim: 'o' }]);
    expect(cut.config).toBe('');
    expect(cut.assassination).toBe('');
    expect(cut.outcome).toBe('');
    expect(cut.names.every((n) => n === '')).toBe(true);
    expect(JSON.stringify(cut)).not.toContain('1450');
    expect(cutLabel(GAME, { upto: 7 })).toBe('第 3 局第 2 次派票');
  });

  it('drops the decision round entirely when the decision is its first proposal', () => {
    const cut = cutRecordGame(GAME, { upto: 5 });
    expect(cut.rounds.map((r) => r.mission)).toEqual(['ooo']);
    expect(cut.lakes).toEqual([]);
    expect(cutLabel(GAME, { upto: 0 })).toBe('第 1 局第 1 次派票');
  });

  it('keeps every quest and lake for an assassination question, still hiding the outcome and roles', () => {
    const cut = cutRecordGame(GAME, { upto: 'A', seat: '9' });
    expect(cut.rounds).toEqual(GAME.rounds);
    expect(cut.lakes).toEqual(GAME.lakes);
    expect([cut.config, cut.assassination, cut.outcome]).toEqual(['', '', '']);
    expect(cutLabel(GAME, { upto: 'A' })).toBe('刺殺');
  });

  it('shows only what the viewer’s own role knows', () => {
    expect(cutViewer(GAME.config, '9')).toEqual({ seat: '9', role: expect.objectContaining({ name: '刺客' }), knows: '紅方隊友：3、6（奧伯倫看不到）' });
    expect(cutViewer(GAME.config, '8')?.knows).toBe('看到的紅方：3、7、9（莫德雷德看不到）');
    expect(cutViewer(GAME.config, '5')?.knows).toBe('兩根拇指（梅林和莫甘娜）：3、8');
    expect(cutViewer(GAME.config, '7')).toEqual({ seat: '7', role: expect.objectContaining({ name: '奧伯倫' }), knows: null });
    expect(cutViewer(GAME.config, '1')).toEqual({ seat: '1', role: expect.objectContaining({ name: '忠臣' }), knows: null });
    expect(cutViewer(GAME.config, undefined)).toBeNull();
  });
});
