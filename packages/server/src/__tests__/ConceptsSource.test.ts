/**
 * 觀念卡 ↔ 百科文章的來源追蹤（docs/CONCEPTS.md）：
 *   - wikiSectionMarkdown 取出的範圍（含子章節、遇到同級或更高級標題停、重複標題、程式碼區塊、整篇）；
 *   - sectionHash 的算法（只改空白不變，改字就變）、sourceQuote 的挑法與比對；
 *   - checkConcept 的每種狀態（含改名章節、併入別篇的建議）；
 *   - 對真正的 concepts.json × wiki_data.json 跑一次：待複查的卡只印警告（CI 的 log 與 ::warning::），不讓測試失敗。
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  CONCEPT_QUOTE_MAX as WEB_QUOTE_MAX,
  checkConcept,
  checkConceptBank,
  formatCheckReport,
  normalizeSectionMarkdown,
  pickSourceQuote,
  quoteInSection,
  sectionHashOf,
  sectionPlainText,
  stampConcept,
  wikiOutline,
  wikiSourceOf,
  type ConceptSourceCard,
} from '../../../web/src/utils/conceptSource';
import { wikiHash } from '../../../web/src/utils/wikiHash';
import { wikiSectionMarkdown } from '../../../web/src/utils/wikiSections';
import { checkConcepts, readWikiArticles, sha256Hasher } from '../../scripts/conceptsWiki';
import { conceptArticleUrl, conceptShareUrl } from '../bots/threads/conceptEdits';
import { CONCEPT_QUOTE_MAX, conceptBank, conceptProblems } from '../bots/threads/concepts';
import { wikiShareUrl } from '../../../web/src/utils/wikiHash';

const ARTICLE = [
  '---',
  'title: x',
  '---',
  '# 標題',
  '開頭一段。',
  '## 一、第一節',
  '第一節的內容：只有梅林知道誰是壞人。',
  '### 子節',
  '子節的內容。',
  '```',
  '## 這不是標題',
  '```',
  '## 二、第二節',
  '第二節。',
  '## 結論',
  '甲。',
  '## 結論',
  '乙。',
].join('\n');

const wiki = wikiSourceOf([{ id: 'wiki-x', title: '測試文章', content: ARTICLE }]);

const card = (over: Partial<ConceptSourceCard['article']> = {}): ConceptSourceCard => ({
  id: 'x-one',
  article: { slug: 'wiki-x', title: '測試文章', section: '一、第一節', ...over },
  情境: '你是忠臣。',
  觀念: '只有梅林知道誰是壞人。',
  應用: '先看自己的資訊。',
});

describe('wikiSectionMarkdown', () => {
  it('takes the heading through its sub-sections and stops at the next heading of the same level', () => {
    const md = wikiSectionMarkdown(ARTICLE, '一、第一節');
    expect(md?.split('\n')[0]).toBe('## 一、第一節');
    expect(md).toContain('### 子節');
    expect(md).toContain('## 這不是標題'); // inside fenced code
    expect(md).not.toContain('二、第二節');
  });

  it('handles repeated headings, the last section, a missing section and the whole article', () => {
    expect(wikiSectionMarkdown(ARTICLE, '結論')).toBe('## 結論\n甲。');
    expect(wikiSectionMarkdown(ARTICLE, '結論-2')).toBe('## 結論\n乙。');
    expect(wikiSectionMarkdown(ARTICLE, '沒有這節')).toBeNull();
    expect(wikiSectionMarkdown(ARTICLE)?.startsWith('# 標題')).toBe(true);
    // a level-1 section runs to the end
    expect(wikiSectionMarkdown(ARTICLE, '標題')?.endsWith('乙。')).toBe(true);
  });
});

describe('sectionHash', () => {
  it('is the first 12 hex characters of sha256 over the normalized Markdown', () => {
    expect(sectionHashOf('abc', sha256Hasher)).toBe('ba7816bf8f01');
    expect(sectionHashOf('## a\n\n\n\nb  \r\n', sha256Hasher)).toBe(sectionHashOf('## a\n\nb', sha256Hasher));
    expect(normalizeSectionMarkdown('  x \r\n\r\n\r\n y\t\n')).toBe('x\n y');
  });

  it('changes when the words change', () => {
    expect(sectionHashOf('## a\nb', sha256Hasher)).not.toBe(sectionHashOf('## a\nc', sha256Hasher));
  });
});

describe('sourceQuote', () => {
  it('strips Markdown for matching and ignores whitespace', () => {
    const md = '## 節\n- **粗體** 與 [連結](wiki:wiki-1)\n> 引用的一句。\n| a | b |\n|---|---|\n| 甲 | 乙 |';
    expect(sectionPlainText(md)).toBe('節\n粗體 與 連結\n引用的一句。\na b\n甲 乙');
    expect(quoteInSection('粗體與連結', md)).toBe(true);
    expect(quoteInSection('不在裡面', md)).toBe(false);
    expect(quoteInSection(undefined, md)).toBe(false);
  });

  it('picks the sentence closest to the card, within the length limit', () => {
    const md = wikiSectionMarkdown(ARTICLE, '一、第一節') ?? '';
    const q = pickSourceQuote(md, card());
    expect(q).toContain('只有梅林知道誰是壞人');
    expect(quoteInSection(q, md)).toBe(true);
    const long = `## 節\n${'很長的一句，'.repeat(20)}只有梅林知道誰是壞人，${'後面還有字，'.repeat(20)}。`;
    const lq = pickSourceQuote(long, card());
    expect(Array.from(lq).length).toBeLessThanOrEqual(WEB_QUOTE_MAX);
    expect(lq).toContain('只有梅林知道誰是壞人');
    expect(quoteInSection(lq, long)).toBe(true);
  });

  it('uses the same limit on both sides', () => {
    expect(WEB_QUOTE_MAX).toBe(CONCEPT_QUOTE_MAX);
  });
});

describe('checkConcept', () => {
  const stamped = stampConcept(card(), wiki, sha256Hasher);

  it('stamps a hash and a quote, and a stamped card is ok', () => {
    expect(stamped.article.sectionHash).toMatch(/^[0-9a-f]{12}$/);
    expect(stamped.article.sourceQuote).toBeTruthy();
    expect(checkConcept(stamped, wiki, sha256Hasher)).toMatchObject({ status: 'ok', stale: false, quoteFound: true, reasons: [] });
    expect(checkConcept(card(), wiki, sha256Hasher).status).toBe('unstamped');
  });

  it('keeps a quote that is still there unless asked to pick again', () => {
    const custom = { ...stamped, article: { ...stamped.article, sourceQuote: '子節的內容。' } };
    expect(stampConcept(custom, wiki, sha256Hasher).article.sourceQuote).toBe('子節的內容。');
    expect(stampConcept(custom, wiki, sha256Hasher, { repickQuote: true }).article.sourceQuote).toBe(stamped.article.sourceQuote);
  });

  it('tells an edit that keeps the quoted passage from one that removes it', () => {
    const edited = wikiSourceOf([{ id: 'wiki-x', title: '測試文章', content: ARTICLE.replace('子節的內容。', '子節改寫了。') }]);
    expect(checkConcept(stamped, edited, sha256Hasher)).toMatchObject({ status: 'changed', stale: true, quoteFound: true });
    const gone = wikiSourceOf([{ id: 'wiki-x', title: '測試文章', content: ARTICLE.replace('只有梅林知道誰是壞人', '大家都不知道') }]);
    expect(checkConcept(stamped, gone, sha256Hasher)).toMatchObject({ status: 'quote-missing', stale: true, quoteFound: false });
    const spaces = wikiSourceOf([{ id: 'wiki-x', title: '測試文章', content: ARTICLE.replace('子節的內容。', '子節的內容。   \n\n\n') }]);
    expect(checkConcept(stamped, spaces, sha256Hasher).status).toBe('ok');
  });

  it('reports a missing section, a renamed section, a missing or merged article and a new title', () => {
    expect(checkConcept(stampConcept(card(), wiki, sha256Hasher), wikiSourceOf([{ id: 'wiki-x', title: '測試文章', content: '# 別的' }]), sha256Hasher)).toMatchObject({
      status: 'section-missing',
      currentHash: null,
    });
    // wiki-32 renamed 〈先盤盤看前置位的派票〉 (data/wikiRedirects.ts WIKI_SECTION_ALIASES)
    const renamed = wikiSourceOf([{ id: 'wiki-32', title: 't', content: '## 先盤盤看前半區 1～4 家的派票\n內容。' }]);
    const old = { ...card(), article: { slug: 'wiki-32', title: 't', section: '先盤盤看前置位的派票', sectionHash: '000000000000' } };
    expect(checkConcept(old, renamed, sha256Hasher)).toMatchObject({
      status: 'section-missing',
      suggested: { slug: 'wiki-32', section: '先盤盤看前半區-1～4-家的派票' },
    });
    expect(checkConcept({ ...card(), article: { slug: 'nope', title: 't' } }, wiki, sha256Hasher).status).toBe('article-missing');
    // wiki-2 was merged into wiki-205 (WIKI_REDIRECTS)
    expect(checkConcept({ ...card(), article: { slug: 'wiki-2', title: 't' } }, wiki, sha256Hasher).suggested).toEqual({
      slug: 'wiki-205',
      section: '四、第一局開藍後：三加一還是拆車',
    });
    const retitled = wikiSourceOf([{ id: 'wiki-x', title: '新標題', content: ARTICLE }]);
    expect(checkConcept(stamped, retitled, sha256Hasher)).toMatchObject({ status: 'title-changed', stale: true });
  });

  it('summarizes a bank', () => {
    const report = checkConceptBank({ concepts: [stamped, card()] }, wiki, sha256Hasher, new Date('2026-11-18T00:00:00Z'));
    expect(report).toMatchObject({ checkedAt: '2026-11-18T00:00:00.000Z', total: 2, stale: 1, byStatus: { ok: 1, unstamped: 1 } });
    expect(report.needsReview.map((c) => c.id)).toEqual(['x-one']);
    expect(formatCheckReport(report)).toMatch(/待複查 1 張/);
  });

  it('lists every article with its sections for the console', () => {
    const [a] = wikiOutline([{ id: 'wiki-x', title: '測試文章', content: ARTICLE }]);
    expect(a.sections.map((s) => s.slug)).toEqual(['標題', '一、第一節', '子節', '二、第二節', '結論', '結論-2']);
    expect(a.sections[1]).toEqual({ slug: '一、第一節', title: '一、第一節', level: 2 });
  });
});

// ─── 真正的卡庫 ───────────────────────────────────────────────────────────

describe('concepts.json × wiki_data.json', () => {
  const bank = conceptBank();
  const articles = readWikiArticles();

  it('stamps every card with a hash and a quote that is in its section', () => {
    expect(conceptProblems(bank)).toEqual([]);
    const missing = bank.concepts.filter((c) => !c.article.sectionHash || !c.article.sourceQuote).map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it('builds the same links as the site', () => {
    for (const c of bank.concepts) {
      expect(conceptArticleUrl(bank.site, c.article.slug, c.article.section)).toBe(`${bank.site}/${wikiHash(c.article.slug, c.article.section)}`);
      expect(conceptShareUrl(bank.site, c.article.slug)).toBe(wikiShareUrl(bank.site, c.article.slug));
    }
  });

  it('reports cards whose source changed (warning only; run concepts:check for the list)', () => {
    const report = checkConcepts(bank, articles);
    expect(report.total).toBe(bank.concepts.length);
    if (report.stale > 0) {
      console.warn(formatCheckReport(report));
      if (process.env.GITHUB_ACTIONS) {
        for (const c of report.needsReview) console.warn(`::warning title=觀念卡待複查 ${c.id}::${c.slug}#${c.section ?? ''} [${c.status}] ${c.reasons.join('；')}`);
      }
    }
    // 結構性的錯（文章、章節不見）由 ThreadsConcepts.test.ts 擋；這裡只警告
    expect(report.cards.every((c) => typeof c.stale === 'boolean')).toBe(true);
  });

  it('keeps concepts.json in the format the scripts write', async () => {
    const { serializeConceptBank, CONCEPTS_PATH } = await import('../../scripts/conceptsWiki');
    const raw = fs.readFileSync(CONCEPTS_PATH, 'utf8');
    expect(serializeConceptBank(JSON.parse(raw))).toBe(raw);
    expect(path.basename(CONCEPTS_PATH)).toBe('concepts.json');
  });
});
