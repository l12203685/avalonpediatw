/**
 * 觀念卡的主控台同步（docs/CONCEPTS.md）：concepts:apply 的修改格式與驗證、concepts:export 的 JSON，以及兩支指令本身。
 * 全部在記憶體裡對真正的 concepts.json × wiki_data.json 做，不寫檔（指令只用 --dry-run 與 check）。
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { wikiSourceOf } from '../../../web/src/utils/conceptSource';
import { checkConcepts, conceptWikiOf, exportConcepts, readConceptBankFile, readWikiArticles } from '../../scripts/conceptsWiki';
import { applyConceptEdits, conceptArticleUrl, conceptEditsOf } from '../bots/threads/conceptEdits';
import { CONCEPT_SENTENCE_MAX } from '../bots/threads/concepts';

vi.setConfig({ testTimeout: 60_000 });

const serverRoot = path.resolve(__dirname, '..', '..');
const bank = readConceptBankFile();
const articles = readWikiArticles();
const wiki = conceptWikiOf(wikiSourceOf(articles));
const first = bank.concepts[0];
const card = (id: string) => {
  const c = bank.concepts.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};

describe('concepts:apply — edits', () => {
  it('accepts a bare array or { edits }', () => {
    expect(conceptEditsOf([])).toEqual([]);
    expect(conceptEditsOf({ edits: [1] })).toEqual([1]);
    expect(conceptEditsOf({ nope: [] })).toBeNull();
    expect(applyConceptEdits(bank, 'x', wiki).ok).toBe(false);
    expect(applyConceptEdits(bank, [], wiki).errors).toEqual(['no edits']);
  });

  it('rewrites a sentence, re-picks the quote and re-stamps the card', () => {
    const r = applyConceptEdits(bank, [{ cardId: first.id, 觀念: '1-1只有梅林和相認紅方有計畫可言。' }], wiki);
    expect(r.errors).toEqual([]);
    expect(r.results).toEqual([{ cardId: first.id, action: 'updated', changed: ['觀念'] }]);
    const c = r.bank.concepts[0];
    expect(c.觀念).toBe('1-1只有梅林和相認紅方有計畫可言。');
    expect(c.article.sectionHash).toBe(first.article.sectionHash); // the article did not change
    expect(Object.keys(c)).toEqual(Object.keys(first));
    expect(Object.keys(c.article)).toEqual(Object.keys(first.article));
    expect(r.bank.concepts.length).toBe(bank.concepts.length);
    expect(checkConcepts(r.bank, articles).stale).toBe(0);
    // the input bank is untouched
    expect(bank.concepts[0].觀念).toBe(first.觀念);
  });

  it('rejects the whole batch when one edit is invalid', () => {
    const r = applyConceptEdits(
      bank,
      [
        { cardId: first.id, 情境: '換一句情境。' },
        { cardId: bank.concepts[1].id, 應用: `${'長'.repeat(CONCEPT_SENTENCE_MAX)}。` },
      ],
      wiki,
    );
    expect(r.ok).toBe(false);
    expect(r.bank).toBe(bank);
    expect(r.errors.join()).toMatch(/longer than 40/);
  });

  it('validates fields, ids, sentences, tags, evidence and duplicates', () => {
    const bad = (edit: unknown): string => applyConceptEdits(bank, [edit], wiki).errors.join(' | ');
    expect(bad({ cardId: first.id, 觀點: 'x。' })).toMatch(/unknown field 觀點/);
    expect(bad({ cardId: 'Bad Id' })).toMatch(/cardId/);
    expect(bad({ cardId: 'no-such-card', 觀念: '一句。' })).toMatch(/no card/);
    expect(bad({ cardId: first.id })).toMatch(/nothing to change/);
    expect(bad({ cardId: first.id, 觀念: '沒有句號' })).toMatch(/must end with/);
    expect(bad({ cardId: first.id, 觀念: '兩句。第二句。' })).toMatch(/one sentence/);
    expect(bad({ cardId: first.id, tags: { decision: ['聊天'], round: ['1-1'] } })).toMatch(/tags.decision/);
    expect(bad({ cardId: first.id, tags: ['派隊'] })).toMatch(/tags must be an object/);
    expect(bad({ cardId: first.id, evidence: '資料證明' })).toMatch(/evidence/);
    expect(bad({ cardId: first.id, section: '沒有這節' })).toMatch(/no section/);
    expect(bad({ cardId: first.id, sourceQuote: '這句不在文章裡面' })).toMatch(/sourceQuote is not in/);
    expect(bad({ cardId: first.id, sourceQuote: '字'.repeat(61) })).toMatch(/longer than 60/);
    expect(bad({ cardId: first.id, reviewed: false })).toMatch(/reviewed must be true/);
    expect(bad({ cardId: first.id, retire: true, 觀念: '一句。' })).toMatch(/retire cannot be combined/);
    expect(applyConceptEdits(bank, [{ cardId: first.id, reviewed: true }, { cardId: first.id, reviewed: true }], wiki).errors.join()).toMatch(/more than one edit/);
  });

  it('treats values equal to the current ones as unchanged (no re-stamp)', () => {
    const r = applyConceptEdits(bank, [{ cardId: first.id, 觀念: first.觀念, tags: first.tags }], wiki);
    expect(r.results).toEqual([{ cardId: first.id, action: 'unchanged', changed: [] }]);
    expect(r.bank.concepts[0]).toEqual(first);
  });

  it('replaces tags and evidence without re-picking the quote', () => {
    const r = applyConceptEdits(bank, [{ cardId: first.id, tags: { decision: ['派隊', '投票'], round: ['1-1'] }, evidence: null }], wiki);
    expect(r.errors).toEqual([]);
    // 沒給 phase（主控台舊版的表單）：照 decision／round 補上
    expect(r.bank.concepts[0].tags).toEqual({ decision: ['派隊', '投票'], round: ['1-1'], phase: '第一局派隊' });
    expect(r.bank.concepts[0].evidence).toBeNull();
    expect(r.bank.concepts[0].article.sourceQuote).toBe(first.article.sourceQuote);
  });

  it('moves a card to another section and rebuilds its link', () => {
    const r = applyConceptEdits(bank, [{ cardId: first.id, section: '忠臣坐-1-家' }], wiki);
    expect(r.errors).toEqual([]);
    const c = r.bank.concepts[0];
    expect(c.article.section).toBe('忠臣坐-1-家');
    expect(c.article.url).toBe(conceptArticleUrl(bank.site, c.article.slug, '忠臣坐-1-家'));
    expect(c.article.sectionHash).toBe(card('w205-loyal-seat1').article.sectionHash);
    expect(c.article.sourceQuote).not.toBe(first.article.sourceQuote);
  });

  it('accepts a quote the owner picked when it is in the section', () => {
    const r = applyConceptEdits(bank, [{ cardId: 'w205-loyal-seat1', sourceQuote: '你唯一確定的好人是自己。' }], wiki);
    expect(r.errors).toEqual([]);
  });

  it('re-stamps a reviewed card after its article changed', () => {
    const edited = articles.map((a) => (a.id === first.article.slug ? { ...a, content: a.content.replace('能有策略', '能有策略（補一句）') } : a));
    expect(checkConcepts(bank, edited).needsReview.map((c) => [c.id, c.status])).toEqual([[first.id, 'changed']]);
    const r = applyConceptEdits(bank, [{ cardId: first.id, reviewed: true }], conceptWikiOf(wikiSourceOf(edited)));
    expect(r.results).toEqual([{ cardId: first.id, action: 'reviewed', changed: [] }]);
    expect(r.bank.concepts[0].article.sectionHash).not.toBe(first.article.sectionHash);
    expect(checkConcepts(r.bank, edited).stale).toBe(0);
  });

  it('retires a card and never reuses its id', () => {
    const r = applyConceptEdits(bank, [{ cardId: first.id, retire: true }], wiki);
    expect(r.results).toEqual([{ cardId: first.id, action: 'retired', changed: [] }]);
    expect(r.bank.concepts.some((c) => c.id === first.id)).toBe(false);
    expect(r.bank.retired).toEqual([...(bank.retired ?? []), first.id]);
    const again = applyConceptEdits(r.bank, [{ cardId: first.id, new: { article: { slug: 'wiki-205' }, 情境: '一。', 觀念: '二。', 應用: '三。', tags: { decision: ['派隊'], round: ['any'] } } }], wiki);
    expect(again.errors.join()).toMatch(/retired/);
    expect(applyConceptEdits(r.bank, [{ cardId: first.id, 觀念: '一句。' }], wiki).errors.join()).toMatch(/retired/);
  });

  it('creates a card with derived title and links, next to its article’s other cards', () => {
    const r = applyConceptEdits(
      bank,
      [
        {
          cardId: 'w205-new-card',
          new: {
            article: { slug: 'wiki-205', section: '忠臣坐-1-家' },
            情境: '你是1家忠臣。',
            觀念: '唯一確定的好人是自己。',
            應用: '派自己加2人。',
            tags: { decision: ['派隊'], round: ['1-1'], seats: [1] },
            evidence: '邏輯',
          },
        },
      ],
      wiki,
    );
    expect(r.errors).toEqual([]);
    expect(r.results).toEqual([{ cardId: 'w205-new-card', action: 'created', changed: [] }]);
    const i = r.bank.concepts.findIndex((c) => c.id === 'w205-new-card');
    const lastOfArticle = bank.concepts.map((c) => c.article.slug).lastIndexOf('wiki-205');
    expect(i).toBe(lastOfArticle + 1);
    const c = r.bank.concepts[i];
    expect(c.article).toMatchObject({
      slug: 'wiki-205',
      title: first.article.title,
      section: '忠臣坐-1-家',
      url: conceptArticleUrl(bank.site, 'wiki-205', '忠臣坐-1-家'),
      shareUrl: `${bank.site}/w/wiki-205/`,
    });
    expect(c.article.sectionHash).toMatch(/^[0-9a-f]{12}$/);
    expect(c.article.sourceQuote).toContain('唯一確定的好人是自己');
    expect(c.tags).toEqual({ decision: ['派隊'], round: ['1-1'], phase: '第一局派隊', seats: [1] });
    expect(checkConcepts(r.bank, articles).stale).toBe(0);
  });

  it('validates new cards', () => {
    const base = { 情境: '一。', 觀念: '二。', 應用: '三。', tags: { decision: ['派隊'], round: ['any'] } };
    const bad = (edit: unknown): string => applyConceptEdits(bank, [edit], wiki).errors.join(' | ');
    expect(bad({ cardId: first.id, new: { ...base, article: { slug: 'wiki-205' } } })).toMatch(/already exists/);
    expect(bad({ cardId: 'n-1', new: { ...base, article: { slug: 'wiki-nope' } } })).toMatch(/no article/);
    expect(bad({ cardId: 'n-1', new: { ...base, article: { slug: 'wiki-205', section: '沒有' } } })).toMatch(/no section/);
    expect(bad({ cardId: 'n-1', new: { ...base, article: { slug: 'wiki-205', url: 'http://x' } } })).toMatch(/only takes slug and section/);
    expect(bad({ cardId: 'n-1', new: { ...base, 情境: undefined, article: { slug: 'wiki-205' } } })).toMatch(/new.情境 is required/);
    expect(bad({ cardId: 'n-1', 觀念: 'x。', new: { ...base, article: { slug: 'wiki-205' } } })).toMatch(/cannot be combined/);
    expect(bad({ cardId: 'n-1', new: { ...base, id: 'n-2', article: { slug: 'wiki-205' } } })).toMatch(/new.id must equal cardId/);
  });
});

describe('concepts:export', () => {
  it('lists every card with its stale flag, the limits and the article outline', () => {
    const data = exportConcepts(bank, articles, new Date('2026-11-18T00:00:00Z'));
    expect(data).toMatchObject({
      format: 'avalon-concepts-export',
      version: 1,
      exportedAt: '2026-11-18T00:00:00.000Z',
      site: bank.site,
      summary: { total: bank.concepts.length, stale: 0, byStatus: { ok: bank.concepts.length } },
      limits: { sentenceMax: 40, quoteMax: 60, parts: ['情境', '觀念', '應用'] },
      retired: bank.retired ?? [],
    });
    expect(data.limits.phases).toEqual(['第一局派隊', '第二局派隊', '第三～五局派隊', '刺殺', '投票・湖中・出任務', '通用']);
    expect(data.limits.roleTags).toContain('莫甘娜');
    expect(data.cards[0]).toMatchObject({ ...first, stale: false, status: 'ok', reasons: [], currentHash: first.article.sectionHash, quoteFound: true });
    expect(data.articles.length).toBe(articles.length);
    expect(data.articles.find((a) => a.slug === 'wiki-205')?.sections.some((s) => s.slug === first.article.section)).toBe(true);
  });

  it('flags a card whose section changed', () => {
    const edited = articles.map((a) => (a.id === first.article.slug ? { ...a, content: a.content.replace('能有策略', '能有計畫') } : a));
    const data = exportConcepts(bank, edited);
    expect(data.summary.stale).toBe(1);
    expect(data.cards[0]).toMatchObject({ id: first.id, stale: true, status: 'quote-missing' });
  });
});

describe('concepts scripts', () => {
  const run = (...args: string[]): string =>
    execFileSync(process.execPath, [require.resolve('tsx/cli'), path.join(serverRoot, 'scripts', 'concepts.ts'), ...args], {
      cwd: serverRoot,
      encoding: 'utf8',
      env: { ...process.env, INIT_CWD: serverRoot, GITHUB_ACTIONS: '' },
    });

  it('concepts:check --json prints the report', () => {
    const report = JSON.parse(run('check', '--json'));
    expect(report).toMatchObject({ total: bank.concepts.length, stale: 0, needsReview: [] });
  });

  it('concepts:apply --dry-run validates without writing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concepts-'));
    const file = path.join(dir, 'edits.json');
    fs.writeFileSync(file, JSON.stringify({ edits: [{ cardId: first.id, reviewed: true }] }));
    const before = fs.readFileSync(path.join(serverRoot, 'src', 'bots', 'threads', 'concepts.json'), 'utf8');
    const out = JSON.parse(run('apply', file, '--dry-run', '--json'));
    expect(out).toMatchObject({ ok: true, dryRun: true, results: [{ cardId: first.id, action: 'reviewed' }], errors: [], stale: 0 });
    expect(fs.readFileSync(path.join(serverRoot, 'src', 'bots', 'threads', 'concepts.json'), 'utf8')).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
