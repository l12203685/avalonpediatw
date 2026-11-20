/**
 * 產生網站「百科AI 優化歷程」頁（#ai-history）的資料：packages/web/src/data/aiHistory.json。
 *
 *   npx tsx scripts/build_ai_history.ts          # 寫檔
 *   npx tsx scripts/build_ai_history.ts --check  # 只檢查（資料和現有檔不同、或有錯就結束碼 1）
 *
 * 來源：
 *   - docs/ai/ai_history.curated.json：手寫的里程碑（每次採用新預設加一列）、首頁數字、走勢圖的點。
 *   - docs/ai/optimization_loop.md 第 4 節「回合紀錄」表：解析回合數、有採用／沒採用的回合，並核對每個里程碑的回合在表上是「採用」。
 * 表上有採用、curated 沒有里程碑的回合只警告（有些回合採用的是已被取代或只動門檻的小改）。
 */
import fs from 'fs';
import path from 'path';
import {
  parseRoundTable, roundStats, roundOrder, sortMilestones,
  type AiHistoryData, type AiMilestone,
} from '../packages/web/src/utils/aiHistory';

type Curated = Pick<AiHistoryData, 'headline' | 'series' | 'milestones'>;

export function buildAiHistory(loopMd: string, curated: Curated, generatedAt: string): { data: AiHistoryData; errors: string[]; warnings: string[] } {
  const rows = parseRoundTable(loopMd);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (rows.length === 0) errors.push('optimization_loop.md 找不到「## 4. 回合紀錄」表');
  const adopted = new Set(rows.filter((r) => r.adopted).map((r) => r.round));
  const ids = new Set<string>();
  for (const m of curated.milestones as AiMilestone[]) {
    if (ids.has(m.id)) errors.push(`里程碑 id 重複：${m.id}`);
    ids.add(m.id);
    if (!adopted.has(m.round)) errors.push(`${m.id}：第 ${m.round} 回合在回合紀錄表上不是「採用」`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date)) errors.push(`${m.id}：日期格式 ${m.date}`);
    if (!m.roles.includes(m.primary) && !['blue', 'red'].includes(m.primary)) errors.push(`${m.id}：primary ${m.primary} 不在 roles 裡`);
  }
  const covered = new Set(curated.milestones.map((m) => m.round));
  for (const r of [...adopted].sort((a, b) => roundOrder(a) - roundOrder(b))) {
    if (!covered.has(r)) warnings.push(`第 ${r} 回合表上有採用，但 curated 沒有里程碑`);
  }
  const data: AiHistoryData = {
    version: 1,
    generatedAt,
    source: 'docs/ai/optimization_loop.md 第 4 節＋docs/ai/ai_history.curated.json（scripts/build_ai_history.ts）',
    stats: roundStats(rows),
    headline: curated.headline,
    series: curated.series,
    milestones: sortMilestones(curated.milestones),
  };
  return { data, errors, warnings };
}

function main(): void {
  const ROOT = path.resolve(__dirname, '..');
  const LOOP_MD = path.join(ROOT, 'docs/ai/optimization_loop.md');
  const CURATED = path.join(ROOT, 'docs/ai/ai_history.curated.json');
  const OUT = path.join(ROOT, 'packages/web/src/data/aiHistory.json');
  const check = process.argv.includes('--check');
  const curated = JSON.parse(fs.readFileSync(CURATED, 'utf8')) as Curated;
  const loopMd = fs.readFileSync(LOOP_MD, 'utf8');
  const prev = fs.existsSync(OUT) ? (JSON.parse(fs.readFileSync(OUT, 'utf8')) as AiHistoryData) : null;
  // 內容沒變時沿用舊的 generatedAt，--check 才比得出「資料有沒有過期」
  const draft = buildAiHistory(loopMd, curated, prev?.generatedAt ?? new Date().toISOString().slice(0, 10));
  const same = prev !== null && JSON.stringify({ ...prev, generatedAt: '' }) === JSON.stringify({ ...draft.data, generatedAt: '' });
  const { data, errors, warnings } = same ? draft : buildAiHistory(loopMd, curated, new Date().toISOString().slice(0, 10));
  for (const w of warnings) console.warn(`警告：${w}`);
  for (const e of errors) console.error(`錯誤：${e}`);
  if (errors.length > 0) process.exit(1);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (check) {
    if (!same) {
      console.error('aiHistory.json 過期：跑 npx tsx scripts/build_ai_history.ts');
      process.exit(1);
    }
    console.log(`aiHistory.json 是最新的（${data.milestones.length} 個里程碑；${data.stats.rounds} 回合，${data.stats.adoptedRounds} 回合有採用）`);
    return;
  }
  fs.writeFileSync(OUT, text);
  console.log(`寫入 ${path.relative(ROOT, OUT)}：${data.milestones.length} 個里程碑；${data.stats.rounds} 回合，${data.stats.adoptedRounds} 回合有採用、${data.stats.notAdoptedRounds} 回合沒有`);
}

// 被測試 import 時不執行（只用 buildAiHistory）
if (typeof require !== 'undefined' && require.main === module) main();
