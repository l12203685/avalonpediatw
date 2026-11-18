/**
 * 觀念卡腳本共用（docs/CONCEPTS.md）：讀 wiki_data.json 與 concepts.json、sha256 雜湊、把 web 的來源追蹤
 * （web/src/utils/conceptSource.ts）接成伺服器 conceptEdits.ts 要的 ConceptWiki。伺服器 src 不 import web，
 * 所以這段膠水放在 scripts（測試也用它）。
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  checkConceptBank,
  conceptSectionMarkdown,
  quoteInSection,
  stampConcept,
  wikiOutline,
  wikiSourceOf,
  type ConceptCheckReport,
  type SectionHasher,
  type WikiSource,
  type WikiSourceArticle,
} from '../../web/src/utils/conceptSource';
import { hasWikiSection } from '../../web/src/utils/wikiSections';
import { buildConceptExport, type ConceptExport, type ConceptWiki } from '../src/bots/threads/conceptEdits';
import { loadConceptBank, type ConceptBank } from '../src/bots/threads/concepts';

const serverRoot = path.resolve(__dirname, '..');
export const WIKI_DATA_PATH = path.join(serverRoot, 'wiki_data.json');
export const CONCEPTS_PATH = path.join(serverRoot, 'src', 'bots', 'threads', 'concepts.json');

/** sha256 的前 12 個十六進位字。 */
export const sha256Hasher: SectionHasher = (normalized) => createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);

export function readWikiArticles(file: string = WIKI_DATA_PATH): WikiSourceArticle[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as WikiSourceArticle[];
}

export function readConceptBankFile(file: string = CONCEPTS_PATH): ConceptBank {
  return loadConceptBank(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** 跟原檔一樣：兩格縮排、只有字串／數字的陣列寫在同一行（["1-1", "1-2"]）、檔尾換行。 */
export function serializeConceptBank(bank: ConceptBank): string {
  const fmt = (v: unknown, indent: string): string => {
    if (Array.isArray(v)) {
      if (v.every((x) => x === null || typeof x !== 'object')) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      const inner = `${indent}  `;
      return v.length ? `[\n${v.map((x) => inner + fmt(x, inner)).join(',\n')}\n${indent}]` : '[]';
    }
    if (v !== null && typeof v === 'object') {
      const inner = `${indent}  `;
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      return entries.length ? `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${fmt(x, inner)}`).join(',\n')}\n${indent}}` : '{}';
    }
    return JSON.stringify(v);
  };
  return `${fmt(bank, '')}\n`;
}

export function conceptWikiOf(source: WikiSource): ConceptWiki {
  return {
    title: (slug) => source.get(slug)?.title,
    hasSection: (slug, section): boolean => {
      const a = source.get(slug);
      return !!a && hasWikiSection(a.content, section);
    },
    quoteInSection: (card, quote): boolean => {
      const md = conceptSectionMarkdown(card, source);
      return md !== null && quoteInSection(quote, md);
    },
    stamp: (card, opts) => stampConcept(card, source, sha256Hasher, opts),
  };
}

export function checkConcepts(bank: ConceptBank, articles: readonly WikiSourceArticle[], now?: Date): ConceptCheckReport {
  return checkConceptBank(bank, wikiSourceOf(articles), sha256Hasher, now);
}

export function exportConcepts(bank: ConceptBank, articles: readonly WikiSourceArticle[], now: Date = new Date()): ConceptExport {
  const report = checkConcepts(bank, articles, now);
  return buildConceptExport(bank, report.cards, wikiOutline(articles), now);
}
