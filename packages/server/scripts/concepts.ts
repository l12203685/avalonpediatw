/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 觀念卡 ↔ 百科文章（docs/CONCEPTS.md）：
 *
 *   pnpm --filter @avalon/server concepts:check                 # 哪些卡的章節改了、不見了（人看的報告；預設 exit 0）
 *     --json                 印 JSON（ConceptCheckReport：checkedAt、total、stale、byStatus、needsReview、cards）
 *     --out <檔>             JSON 另外寫進檔案
 *     --github               在 GitHub Actions 印 ::warning:: 並寫進 job summary
 *     --strict               有待複查的卡就 exit 1
 *   pnpm --filter @avalon/server concepts:export [--out <檔>]   # 主控台讀的 JSON（卡片＋stale＋原因＋章節目錄）
 *   pnpm --filter @avalon/server concepts:apply <edits.json> [--dry-run] [--json]
 *                                                               # 套用主控台的修改（全部通過才寫回 concepts.json）
 *   pnpm --filter @avalon/server concepts:stamp --missing | <id>...
 *                                                               # 蓋章：重算 sectionHash／sourceQuote（確認過的卡）
 *
 * 相對路徑以下指令時的資料夾為準（pnpm 的 INIT_CWD）。
 */

import fs from 'fs';
import path from 'path';
import { formatCheckReport, wikiSourceOf } from '../../web/src/utils/conceptSource';
import { applyConceptEdits } from '../src/bots/threads/conceptEdits';
import {
  CONCEPTS_PATH,
  checkConcepts,
  conceptWikiOf,
  exportConcepts,
  readConceptBankFile,
  readWikiArticles,
  serializeConceptBank,
} from './conceptsWiki';

const [cmd, ...argv] = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--out'].includes(argv[i - 1])));
const userPath = (p: string): string => path.resolve(process.env.INIT_CWD || process.cwd(), p);

function writeOut(file: string | undefined, json: unknown): void {
  if (!file) return;
  const out = userPath(file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
  console.error(`wrote ${out}`);
}

function main(): number {
  const articles = readWikiArticles();
  const bank = readConceptBankFile();

  if (cmd === 'check') {
    const report = checkConcepts(bank, articles);
    writeOut(arg('--out'), report);
    if (flag('--json')) console.log(JSON.stringify(report, null, 2));
    else console.log(formatCheckReport(report));
    if (flag('--github') && process.env.GITHUB_ACTIONS) {
      for (const c of report.needsReview) {
        console.log(`::warning title=觀念卡待複查 ${c.id}::${c.slug}${c.section ? `#${c.section}` : ''} [${c.status}] ${c.reasons.join('；')}`);
      }
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 觀念卡來源檢查\n\n${formatCheckReport(report)}\n\n`);
      }
    }
    return flag('--strict') && report.stale > 0 ? 1 : 0;
  }

  if (cmd === 'export') {
    const data = exportConcepts(bank, articles);
    if (arg('--out')) writeOut(arg('--out'), data);
    else console.log(JSON.stringify(data, null, 2));
    return 0;
  }

  if (cmd === 'apply') {
    const file = positional[0];
    if (!file) {
      console.error('usage: concepts:apply <edits.json> [--dry-run] [--json]');
      return 2;
    }
    const input: unknown = JSON.parse(fs.readFileSync(userPath(file), 'utf8'));
    const result = applyConceptEdits(bank, input, conceptWikiOf(wikiSourceOf(articles)));
    const summary = {
      ok: result.ok,
      dryRun: flag('--dry-run'),
      results: result.results,
      errors: result.errors,
      stale: result.ok ? checkConcepts(result.bank, articles).stale : null,
    };
    if (result.ok && !flag('--dry-run')) fs.writeFileSync(CONCEPTS_PATH, serializeConceptBank(result.bank));
    if (flag('--json')) console.log(JSON.stringify(summary, null, 2));
    else if (result.ok) {
      for (const r of result.results) console.log(`${r.action.padEnd(9)} ${r.cardId}${r.changed.length ? `（${r.changed.join('、')}）` : ''}`);
      console.log(`${flag('--dry-run') ? '（試跑，沒有寫入）' : `寫入 ${path.relative(process.cwd(), CONCEPTS_PATH)}`}；待複查 ${summary.stale} 張`);
    } else {
      console.error(`沒有寫入，${result.errors.length} 個問題：`);
      for (const e of result.errors) console.error(`- ${e}`);
    }
    return result.ok ? 0 : 1;
  }

  if (cmd === 'stamp') {
    const report = checkConcepts(bank, articles);
    const ids = flag('--missing') ? report.cards.filter((c) => c.status === 'unstamped').map((c) => c.id) : positional;
    if (!ids.length) {
      console.error(flag('--missing') ? 'nothing to stamp' : 'usage: concepts:stamp --missing | <id>...');
      return flag('--missing') ? 0 : 2;
    }
    const result = applyConceptEdits(bank, { edits: ids.map((cardId) => ({ cardId, reviewed: true })) }, conceptWikiOf(wikiSourceOf(articles)));
    if (!result.ok) {
      for (const e of result.errors) console.error(`- ${e}`);
      return 1;
    }
    fs.writeFileSync(CONCEPTS_PATH, serializeConceptBank(result.bank));
    console.log(`蓋章 ${ids.length} 張；待複查 ${checkConcepts(result.bank, articles).stale} 張`);
    return 0;
  }

  console.error('usage: concepts.ts check|export|apply|stamp (see the header of scripts/concepts.ts)');
  return 2;
}

process.exitCode = main();
