/**
 * 遊戲內回饋 — 離線整理（站長 2026-11-26「遊戲中的對話你也記得讀取並學習 有可能是玩家對你玩法的反饋」）。
 *
 * 私人試算表的「遊戲內回饋」分頁（server src/inGameFeedback 寫的）下載成 CSV，放在 repo 外面，然後：
 *
 *   pnpm --filter @avalon/server exec tsx scripts/inGameFeedbackReport.ts <CSV 路徑> [--no-text]
 *
 * 分頁是**一局一列**：整局被挑出的話連同前後脈絡串成一段對話（站長 2026-11-26「百科AI 的問題回饋有時候是一個整體
 * 而不是單一個決策點」）。這裡照被提到的百科AI 的角色分組（局後才知道；沒指名的歸「沒指名」），每組有幾局、
 * 幾則、出現在哪些階段，預設附每一局的整段對話（只印在你自己的終端機）；--no-text 只印數字。08:00 同步用這份把
 * 每一局整理成「整體印象 → 相關的局面／決策 → 要測的假設」（轉述、不引原文、不寫名字）放進待測清單——
 * 見 docs/ai/optimization_loop.md。
 *
 * 不寫任何檔案；CSV 在 repo 裡面就拒絕（原文不能進公開 repo）。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 表頭（跟 src/inGameFeedback/sheetWriter.ts 的 IN_GAME_FEEDBACK_HEADER 一樣；欄位用名字找，順序不重要）。 */
const COL = {
  game: '房間',
  gameNo: '第幾局',
  count: '回饋則數',
  phase: '階段',
  mentioned: '提到的百科AI',
  roles: '那個百科AI 的角色',
  kind: '類型',
  narrative: '整局對話（▶＝被挑出的那句，前後各 3 句當脈絡）',
} as const;

/** 最小的 CSV 解析（Google 試算表下載的格式：逗號、雙引號跳脫、欄位內可以換行）。 */
export function parseCsv(src: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = src.replace(/^\uFEFF/, '');
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

/** 一局。 */
export interface FeedbackRow {
  game: string;
  /** 這局被挑出幾則。 */
  count: number;
  phases: string[];
  /** 被提到的百科AI 的角色（中文，例如「梅林」）；沒有 → []。 */
  roles: string[];
  mentioned: string;
  kinds: string[];
  narrative: string;
}

/** 「3家刺客、7家梅林」→ ['刺客', '梅林']。 */
export function rolesOf(cell: string): string[] {
  return cell.split('、').map((x) => x.replace(/^\s*\d{1,2}家/u, '').trim()).filter(Boolean);
}

const list = (cell: string): string[] => cell.split('、').map((x) => x.trim()).filter(Boolean);

export function readRows(table: string[][]): FeedbackRow[] {
  const [header, ...body] = table;
  if (!header) return [];
  const idx = (name: string): number => header.findIndex((h) => h.trim() === name);
  const at = (r: string[], name: string): string => { const i = idx(name); return i >= 0 ? (r[i] ?? '').trim() : ''; };
  if (idx(COL.narrative) < 0 || idx(COL.phase) < 0) throw new Error('不是「遊戲內回饋」分頁的 CSV（找不到「階段」「整局對話」欄）');
  return body.map((r) => ({
    game: `${at(r, COL.game)}#${at(r, COL.gameNo)}`,
    count: Number(at(r, COL.count)) || 0,
    phases: list(at(r, COL.phase)),
    roles: rolesOf(at(r, COL.roles)),
    mentioned: at(r, COL.mentioned),
    kinds: list(at(r, COL.kind)),
    narrative: at(r, COL.narrative),
  }));
}

export interface FeedbackGroup {
  role: string;
  games: number;
  lines: number;
  /** 階段 → 出現在幾局。 */
  phases: Record<string, number>;
  narratives: string[];
}

/** 照被提到的百科AI 的角色分組；一局提到兩個角色就兩組都算。由局數多到少。 */
export function groupFeedback(rows: readonly FeedbackRow[]): FeedbackGroup[] {
  const map = new Map<string, FeedbackGroup>();
  for (const r of rows) {
    const noRole = r.mentioned === '' || r.mentioned.split('、').every((m) => m.trim() === '沒指名');
    const roles = r.roles.length > 0 ? [...new Set(r.roles)] : [noRole ? '沒指名' : '角色不明'];
    for (const role of roles) {
      let g = map.get(role);
      if (!g) { g = { role, games: 0, lines: 0, phases: {}, narratives: [] }; map.set(role, g); }
      g.games += 1;
      g.lines += r.count;
      for (const p of r.phases) g.phases[p] = (g.phases[p] ?? 0) + 1;
      g.narratives.push(`${r.game}（${r.kinds.join('、') || '類型不明'}）\n${r.narrative}`);
    }
  }
  return [...map.values()].sort((a, b) => b.games - a.games || b.lines - a.lines || a.role.localeCompare(b.role));
}

export function formatReport(groups: readonly FeedbackGroup[], opts: { withText: boolean }): string {
  if (groups.length === 0) return '沒有回饋。';
  const lines = [`遊戲內回饋：${groups.length} 組（一局提到兩個角色會算兩次）。每一局請整理成「整體印象 → 相關的局面／決策 → 要測的假設」。`];
  for (const g of groups) {
    const phases = Object.entries(g.phases).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join('、');
    lines.push('', `■ ${g.role}：${g.games} 局、${g.lines} 則（階段：${phases || '—'}）`);
    if (opts.withText) for (const n of g.narratives) lines.push(...n.split('\n').map((x, i) => (i === 0 ? `  ◆ ${x}` : `    ${x}`)));
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
