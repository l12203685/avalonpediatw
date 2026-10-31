/**
 * 給 AI／爬蟲讀的純文字版本（packages/web/src/utils/llmsTxt.ts，Edward 2026-10-31：其他百科維護者的 AI 工具讀不到網站）。
 * vite build 時由 vite.config.ts 的 llmsFilesPlugin 產生 llms.txt、llms-full.txt、wiki-md/<id>.md、sitemap.xml。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildLlmsFiles, buildNoscriptHtml, cleanWikiMarkdown, wikiMdPath } from '../../../web/src/utils/llmsTxt';
import type { LlmsArticle } from '../../../web/src/utils/llmsTxt';
import { WIKI_ARTICLES, WIKI_CATEGORIES } from '../../../web/src/data/wiki';

const SITE = 'https://example.test';
const WEB = path.resolve(__dirname, '..', '..', '..', 'web');
const jsonArticles: LlmsArticle[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'wiki_data.json'), 'utf-8'));
const allArticles: LlmsArticle[] = [...WIKI_ARTICLES, ...jsonArticles];
const files = buildLlmsFiles(allArticles, {
  siteUrl: `${SITE}/`,
  apiUrl: 'https://api.example.test',
  repoUrl: 'https://github.com/l12203685/avalonpediatw',
  categories: WIKI_CATEGORIES,
  sitePages: ['/', '/wiki'],
});

describe('buildLlmsFiles (real wiki data)', () => {
  it('every article gets its own markdown file, listed in llms.txt, llms-full.txt and sitemap.xml', () => {
    const ids = [...new Set(allArticles.map((a) => a.id))];
    expect(ids.length).toBeGreaterThan(40);
    for (const a of allArticles) {
      const md = files[wikiMdPath(a.id)];
      expect(md, a.id).toBeDefined();
      expect(md.startsWith(`# ${a.title}\n`), a.id).toBe(true);
      expect(files['llms.txt'], a.id).toContain(`](${SITE}/${wikiMdPath(a.id)})`);
      expect(files['llms-full.txt'], a.id).toContain(`\n# ${a.title}\n`);
      expect(files['sitemap.xml'], a.id).toContain(`<loc>${SITE}/${wikiMdPath(a.id)}</loc>`);
    }
    expect(Object.keys(files).filter((f) => f.startsWith('wiki-md/'))).toHaveLength(ids.length);
  });

  it('llms.txt follows the convention: H1, blockquote summary, H2 sections of links, the full-text and data links', () => {
    const txt = files['llms.txt'];
    expect(txt.split('\n')[0]).toBe('# 阿瓦隆百科 Avalon Pedia TW');
    expect(txt).toMatch(/\n> .+單頁應用/);
    for (const c of WIKI_CATEGORIES) expect(txt).toContain(`\n## ${c.name}\n`);
    expect(txt).toContain(`${SITE}/llms-full.txt`);
    expect(txt).toContain('https://api.example.test/api/analysis/wiki');
    expect(txt).toContain('docs/avalon-wiki');
    expect(txt).toContain('\n## Optional\n');
  });

  it('no front matter, [TOC], HTML or wiki: links survive; every internal link points at a generated file', () => {
    for (const [name, body] of Object.entries(files)) {
      if (!name.endsWith('.md') && !name.endsWith('.txt')) continue;
      expect(body, name).not.toMatch(/^(title|tags|最後編輯者)\s*:/m);
      expect(body, name).not.toMatch(/\[TOC\]|<font|<br\s*\/?>|<!--/i);
      expect(body, name).not.toMatch(/\]\(wiki:/);
      expect(body, name).not.toMatch(/\]\(wiki-(tag|color):/);
      expect(body, name).not.toMatch(/【(規則|建議|慣例|本站立場|百科建議|時效)】/);
      for (const m of body.matchAll(new RegExp(`\\]\\(${SITE.replace(/\./g, '\\.')}/(wiki-md/[^)\\s]+)\\)`, 'g'))) {
        expect(files[m[1]], `${name} → ${m[1]}`).toBeDefined();
      }
    }
    // the site's own article links were really rewritten (the data has plenty of them)
    expect(files['llms-full.txt'].match(new RegExp(`\\]\\(${SITE.replace(/\./g, '\\.')}/wiki-md/`, 'g'))!.length).toBeGreaterThan(50);
  });

  it('sitemap.xml is well-formed enough and lists the site pages and text files', () => {
    const xml = files['sitemap.xml'];
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    expect(xml.trim().endsWith('</urlset>')).toBe(true);
    for (const u of ['/', '/wiki', '/llms.txt', '/llms-full.txt']) expect(xml).toContain(`<loc>${SITE}${u}</loc>`);
  });
});

describe('cleanWikiMarkdown', () => {
  const knownIds = new Set(['wiki-57']);
  it('strips front matter and the repeated H1, rewrites links and images, keeps code blocks as written', () => {
    const src = [
      '---', 'title: 測試', 'tags: a', '---', '[TOC]', '# 測試', '',
      '見 [視角](wiki:wiki-57) 與 [不存在](wiki:wiki-999)。<!-- 草稿 -->',
      '![圖](/wiki-images/a.png) <font color=#ff0000>紅字</font><br>下一行',
      '- 【規則】規則書寫明 【時效】',
      '- 【建議】經驗談',
      '```', '【規則】 [x](wiki:wiki-57)', '```',
    ].join('\n');
    expect(cleanWikiMarkdown(src, { siteUrl: `${SITE}/`, knownIds }).split('\n')).toEqual([
      `見 [視角](${SITE}/wiki-md/wiki-57.md) 與 不存在。`,
      `![圖](${SITE}/wiki-images/a.png) 紅字  `,
      '下一行',
      '- 【邏輯】規則書寫明 ',
      '- 【經驗】經驗談',
      '```', '【規則】 [x](wiki:wiki-57)', '```',
    ]);
  });
});

describe('build wiring', () => {
  it('vite.config.ts runs the generator on every build and index.html has the noscript slot and alternate links', () => {
    const config = fs.readFileSync(path.join(WEB, 'vite.config.ts'), 'utf-8');
    expect(config).toMatch(/plugins:\s*\[[^\]]*llmsFilesPlugin\(\)/);
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf-8');
    expect(html).toContain('<!--llms-noscript-->');
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/llms.txt"');
    // sitemap.xml is generated now; a static copy in public/ would shadow it
    expect(fs.existsSync(path.join(WEB, 'public', 'sitemap.xml'))).toBe(false);
    expect(fs.readFileSync(path.join(WEB, 'public', 'robots.txt'), 'utf-8')).toMatch(/Allow: \/llms\.txt/);
  });

  it('the noscript fallback links the text versions and every article', () => {
    const html = buildNoscriptHtml(allArticles, { siteUrl: SITE, categories: WIKI_CATEGORIES });
    expect(html.startsWith('<noscript>')).toBe(true);
    expect(html).toContain(`href="${SITE}/llms.txt"`);
    for (const a of jsonArticles) expect(html).toContain(`href="${SITE}/${wikiMdPath(a.id)}"`);
  });
});
