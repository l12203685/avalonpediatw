/**
 * 遊戲內回饋 — 離線整理（站長 2026-11-26「遊戲中的對話你也記得讀取並學習 有可能是玩家對你玩法的反饋」）。
 *
 * 私人試算表的「遊戲內回饋」分頁（server src/inGameFeedback 寫的）下載成 CSV，放在 repo 外面，然後：
 *
 *   pnpm --filter @avalon/server exec tsx scripts/inGameFeedbackReport.ts <CSV 路徑> [--no-text]
 *
 * 照情境分組印出來：階段 → 被提到的百科AI 的角色（局後才知道；沒指名的歸「沒指名」）→ 類型。每組有則數和
 * 涉及幾局，預設附原文（只印在你自己的終端機）；--no-text 只印數字。08:00 同步用這份把回饋改寫成
 * 「百科AI 改進項目」（轉述、不引原文、不寫名字）放進待測清單——見 docs/ai/optimization_loop.md。
 *
 * 不寫任何檔案；CSV 在 repo 裡面就拒絕（原文不能進公開 repo）。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 表頭（跟 src/inGameFeedback/sheetWriter.ts 的 IN_GAME_FEEDBACK_HEADER 一樣；欄位用名字找，順序不重要）。 */
const COL = {
  game: '房間',
  gameNo: '第幾局',
  phase: '階段',
  round: '任務',
  mentioned: '提到的百科AI',
  roles: '那個百科AI 的角色',
  kind: '類型',
  text: '內容',
} as const;

/** 最小的 CSV 解析（Google 試算表下載的格式：逗號、雙引號跳脫、欄位內可以換行）。 */
export function parseCsv(src: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = src.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

export interface FeedbackRow {
  game: string;
  phase: string;
  round: string;
  /** 被提到的百科AI 的角色（中文，例如「梅林」）；沒有 → []。 */
  roles: string[];
  mentioned: string;
  kind: string;
  text: string;
}

/** 「3家刺客、7家梅林」→ ['刺客', '梅林']。 */
export function rolesOf(cell: string): string[] {
  return cell.split('、').map((x) => x.replace(/^\s*\d{1,2}家/u, '').trim()).filter(Boolean);
}

export function readRows(table: string[][]): FeedbackRow[] {
  const [header, ...body] = table;
  if (!header) return [];
  const idx = (name: string): number => header.findIndex((h) => h.trim() === name);
  const at = (r: string[], name: string): string => { const i = idx(name); return i >= 0 ? (r[i] ?? '').trim() : ''; };
  if (idx(COL.text) < 0 || idx(COL.phase) < 0) throw new Error('不是「遊戲內回饋」分頁的 CSV（找不到「階段」「內容」欄）');
  return body.map((r) => ({
    game: `${at(r, COL.game)}#${at(r, COL.gameNo)}`,
    phase: at(r, COL.phase) || '（不明）',
    round: at(r, COL.round),
    roles: rolesOf(at(r, COL.roles)),
    mentioned: at(r, COL.mentioned),
    kind: at(r, COL.kind) || '（不明）',
    text: at(r, COL.text),
  }));
}

export interface FeedbackGroup {
  phase: string;
  role: string;
  kind: string;
  count: number;
  games: number;
  texts: string[];
}

/** 階段 × 角色 × 類型；一則提到兩個角色就兩組都算。由多到少。 */
export function groupFeedback(rows: readonly FeedbackRow[]): FeedbackGroup[] {
  const map = new Map<string, FeedbackGroup & { gameSet: Set<string> }>();
  for (const r of rows) {
    const roles = r.roles.length > 0 ? r.roles : [r.mentioned === '沒指名' || !r.mentioned ? '沒指名' : '角色不明'];
    for (const role of roles) {
      const key = `${r.phase}|${role}|${r.kind}`;
      let g = map.get(key);
      if (!g) { g = { phase: r.phase, role, kind: r.kind, count: 0, games: 0, texts: [], gameSet: new Set() }; map.set(key, g); }
      g.count += 1;
      g.gameSet.add(r.game);
      g.texts.push(r.round ? `任務${r.round}：${r.text}` : r.text);
    }
  }
  return [...map.values()]
    .map(({ gameSet, ...g }) => ({ ...g, games: gameSet.size }))
    .sort((a, b) => b.count - a.count || a.phase.localeCompare(b.phase) || a.role.localeCompare(b.role));
}

export function formatReport(groups: readonly FeedbackGroup[], opts: { withText: boolean }): string {
  if (groups.length === 0) return '沒有回饋。';
  const total = groups.reduce((s, g) => s + g.count, 0);
  const lines = [`遊戲內回饋：${groups.length} 組（一則提到兩個角色會算兩次，合計 ${total}）`];
  for (const g of groups) {
    lines.push('', `■ ${g.phase}｜${g.role}｜${g.kind}：${g.count} 則、${g.games} 局`);
    if (opts.withText) for (const t of g.texts) lines.push(`  - ${t}`);
  }
  return lines.join('\n');
}

/** CSV 在 repo 裡面？（原文不能進公開 repo） */
export function insideRepo(file: string, repoRoot: string): boolean {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('用法：tsx scripts/inGameFeedbackReport.ts <「遊戲內回饋」分頁的 CSV（放在 repo 外面）> [--no-text]');
    process.exit(2);
  }
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  if (insideRepo(file, repoRoot)) {
    console.error('CSV 在 repo 裡面：請放到 repo 外面（裡面有玩家原文，不能進公開 repo）。');
    process.exit(2);
  }
  const rows = readRows(parseCsv(fs.readFileSync(file, 'utf8')));
  console.log(formatReport(groupFeedback(rows), { withText: !args.includes('--no-text') }));
}

if (require.main === module) main();
