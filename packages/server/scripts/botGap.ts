/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 和強者的落差（分局面的結果分布）：機器人自我對打 vs 真人局 vs 強者桌。純函式在 `src/ai/benchmark/outcomeGap.ts`，
 * 規則在 `docs/ai/optimization_loop.md` 第 1F 節。
 *
 *   cd packages/server && npx tsx scripts/botGap.ts --bot DIR [--bot-prefix DT_] [--label 名稱]
 *       [--baseline DIR [--baseline-prefix P] [--baseline-label 名稱]]
 *       [--human game_db.json] [--strong-s 55] [--min-bot 30] [--min-ref 10] [--top 10]
 *       [--tol-overall 0.003] [--tol-family 0.01] [--json out.json] [--md out.md]
 *   pnpm --filter @avalon/server bot:gap -- --bot DIR ...
 *
 * --bot：`selfplay/sp.ts` 的結果目錄（或單一檔），每個 JSON {meta, cols, rows}；有 'g' 欄（detail=1）的列進全部的格，
 *        只有摘要欄的列只進 5家×0家（有 lake45 欄時再加第一湖）。--bot-prefix 只讀檔名以它開頭的檔（同一個 runId 有好幾個變體時）。
 * --baseline：同樣格式的基準（現行預設）；給了就多算關卡（候選 vs 基準的距離變化），不過時結束碼 2。
 * --human：game_db.json（預設 packages/server/game_db.json）。強者 = 桌上強度 S ≥ --strong-s（預設 55 = 偏強＋高強度）。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  addGame,
  buildGapReport,
  compareReports,
  DEFAULT_GAP_OPTIONS,
  DEFAULT_GATE_TOLERANCE,
  gameFromBotDetail,
  gameFromBotSummary,
  gameFromDb,
  newTally,
  renderMarkdown,
  totals,
  type BotDetail,
  type Counts,
  type DbGame,
  type GapGame,
  type GapOptions,
  type GapReport,
  type Tally,
} from '../src/ai/benchmark/outcomeGap';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const numArg = (name: string, d: number): number => (arg(name) !== undefined ? Number(arg(name)) : d);

interface BotLoad { tally: Tally; total: Counts; files: number; partial: number; skipped: number }

/** 一個檔一個檔讀，只留計數（10 萬局的整局紀錄約 120 MB）。 */
export function loadBot(target: string, prefix = ''): BotLoad {
  const stat = fs.statSync(target);
  const files = stat.isDirectory()
    ? fs.readdirSync(target).filter((f) => f.endsWith('.json') && f.startsWith(prefix)).sort().map((f) => path.join(target, f))
    : [target];
  const tally = newTally();
  const total: Counts = { n: 0, red3: 0, blueDead: 0, blueAlive: 0 };
  let partial = 0;
  let skipped = 0;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { cols?: string[]; rows?: unknown[][] };
    if (!Array.isArray(j.cols) || !Array.isArray(j.rows)) continue;
    const gi = j.cols.indexOf('g');
    for (const row of j.rows) {
      let g: GapGame | null = null;
      if (gi >= 0 && typeof row[gi] === 'string') g = gameFromBotDetail(JSON.parse(row[gi] as string) as BotDetail);
      else { g = gameFromBotSummary(row, j.cols); if (g) partial++; }
      if (!g) { skipped++; continue; }
      addGame(tally, g);
      total.n++;
      total[g.outcome]++;
    }
  }
  return { tally, total, files: files.length, partial, skipped };
}

export function loadHuman(file: string, strongS: number): { human: GapGame[]; strong: GapGame[] } {
  const db = JSON.parse(fs.readFileSync(file, 'utf8')) as { games: DbGame[] };
  const human = db.games.map(gameFromDb).filter((g): g is GapGame => g !== null);
  return { human, strong: human.filter((g) => g.s !== null && g.s >= strongS) };
}

function report(botDir: string, prefix: string, label: string, humanFile: string, strongS: number, opts: GapOptions): GapReport {
  const bot = loadBot(botDir, prefix);
  const { human, strong } = loadHuman(humanFile, strongS);
  const hT = newTally();
  human.forEach((g) => addGame(hT, g));
  const sT = newTally();
  strong.forEach((g) => addGame(sT, g));
  return buildGapReport(
    { bot: bot.tally, human: hT, strong: sT },
    { bot: bot.total, human: totals(human), strong: totals(strong) },
    {
      label, bot: `${path.basename(botDir)}${prefix ? `（${prefix}*）` : ''}，${bot.files} 個檔`, botPartial: bot.partial, botSkipped: bot.skipped,
      human: path.basename(humanFile), strongS, generatedAt: new Date().toISOString().slice(0, 10),
    },
    opts,
  );
}

function main(): void {
  const botDir = arg('--bot');
  if (!botDir) {
    console.error('用法：npx tsx scripts/botGap.ts --bot DIR [--baseline DIR] [--json out.json] [--md out.md]（見檔頭）');
    process.exit(1);
  }
  const humanFile = arg('--human') ?? path.resolve(__dirname, '../game_db.json');
  const strongS = numArg('--strong-s', 55);
  const opts: GapOptions = {
    minBot: numArg('--min-bot', DEFAULT_GAP_OPTIONS.minBot),
    minRef: numArg('--min-ref', DEFAULT_GAP_OPTIONS.minRef),
    top: numArg('--top', DEFAULT_GAP_OPTIONS.top),
  };
  const cand = report(botDir, arg('--bot-prefix') ?? '', arg('--label') ?? path.basename(botDir), humanFile, strongS, opts);
  const baseDir = arg('--baseline');
  let gate: { base: GapReport; result: ReturnType<typeof compareReports> } | undefined;
  if (baseDir) {
    const base = report(baseDir, arg('--baseline-prefix') ?? '', arg('--baseline-label') ?? path.basename(baseDir), humanFile, strongS, opts);
    gate = {
      base,
      result: compareReports(base, cand, {
        overall: numArg('--tol-overall', DEFAULT_GATE_TOLERANCE.overall),
        family: numArg('--tol-family', DEFAULT_GATE_TOLERANCE.family),
      }, opts.top),
    };
  }
  const f4 = (x: number): string => (Number.isFinite(x) ? x.toFixed(4) : '—');
  console.log(`機器人 ${cand.totals.bot.n} 局；真人 ${cand.totals.human.n} 局；強者（S ≥ ${strongS}）${cand.totals.strong.n} 局`);
  console.log(`總距離 D：對真人 ${f4(cand.summary.dHuman)}（雜訊底 ${f4(cand.summary.noiseHuman)}）、對強者 ${f4(cand.summary.dStrong)}（雜訊底 ${f4(cand.summary.noiseStrong)}）`);
  for (const f of cand.families) console.log(`  ${f.id.padEnd(14)} D 真人 ${f4(f.dHuman)}  強者 ${f4(f.dStrong)}${f.cross ? '（交叉）' : ''}`);
  console.log(`\n加權落差最大的 ${cand.topHuman.length} 格（對真人）：`);
  cand.topHuman.forEach((c, i) => {
    const mb = c.metrics.missionBlue;
    console.log(`  ${i + 1}. ${c.family}｜${c.cell}：n ${c.bot.n}/${c.human.n}/${c.strong.n}，任務三藍 ${(100 * mb.bot.rate).toFixed(1)} / ${(100 * mb.human.rate).toFixed(1)} / ${(100 * mb.strong.rate).toFixed(1)}%，TV ${c.tvHuman.toFixed(3)}，加權 ${c.weightedHuman.toFixed(4)}`);
  });
  if (gate) {
    console.log(`\n關卡：總距離 對真人 ${gate.result.deltaHuman >= 0 ? '+' : ''}${f4(gate.result.deltaHuman)}、對強者 ${gate.result.deltaStrong >= 0 ? '+' : ''}${f4(gate.result.deltaStrong)} → ${gate.result.pass ? '過' : `不過（${gate.result.reasons.join('；')}）`}`);
  }
  const json = arg('--json');
  if (json) fs.writeFileSync(json, JSON.stringify({ report: cand, gate: gate ? { base: gate.base.summary, baseMeta: gate.base.meta, result: gate.result } : null }, null, 1));
  const md = arg('--md');
  if (md) fs.writeFileSync(md, renderMarkdown(cand, gate));
  if (gate && !gate.result.pass) process.exitCode = 2;
}

if (require.main === module) main();
