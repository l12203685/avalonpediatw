/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 強者分面群組（Edward 2026-11-04；src/ai/infl/strongCohort.ts、docs/ai/strong_metrics.md）。
 *
 *   cd packages/server && npx tsx scripts/strongCohort.ts [--names] [--json out.json]
 *
 * 選項：
 *   --dataset PATH    每局資料集（預設 ./games_cache.json）
 *   --analysis PATH   分析快取（預設 ./analysis_cache.json；rating.players 的 Elo、場數、暫定）
 *   --pool-share X    母體 = 合格者 Elo 前 X（預設 0.2）
 *   --pool-min N      合格：生涯 ≥ N 場、非暫定（預設 50）
 *   --hi-share X      高強度局 = 桌上平均 Elo 前 X 的局（預設 0.3）
 *   --top N           每個分面列前 N（預設 5）
 *   --names           主控台印名字（只在主控台；--json 永遠不含名字）
 *   --json PATH       不含名字的摘要
 *
 * 公開 repo：預設輸出只有「分面＋名次」（紅方任務王#1 …）。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  cohortGamesFromDataset,
  computeStrongCohorts,
  facetLabel,
  intensityThreshold,
  publicSummary,
  strongPool,
  type DatasetLike,
  type FacetId,
  type RatingRow,
  type StrongCohorts,
} from '../src/ai/infl/strongCohort';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string): boolean => argv.includes(name);

export function loadStrongCohorts(opts: { dataset?: string; analysis?: string; poolShare?: number; poolMin?: number; hiShare?: number } = {}): {
  cohorts: StrongCohorts;
  dataset: DatasetLike;
} {
  const root = path.resolve(__dirname, '..');
  const dataset = JSON.parse(fs.readFileSync(opts.dataset ?? path.join(root, 'games_cache.json'), 'utf8')) as DatasetLike;
  const analysis = JSON.parse(fs.readFileSync(opts.analysis ?? path.join(root, 'analysis_cache.json'), 'utf8')) as { rating: { players: RatingRow[] } };
  const games = cohortGamesFromDataset(dataset);
  const pool = strongPool(analysis.rating.players, { topShare: opts.poolShare ?? 0.2, minGames: opts.poolMin ?? 50 });
  const threshold = intensityThreshold(games, opts.hiShare ?? 0.3);
  return { cohorts: computeStrongCohorts(games, pool, threshold), dataset };
}

const FACET_ORDER: FacetId[] = [
  'redMission', 'blueMission', 'assassinHit', 'merlinSurvival',
  'mission:merlin', 'mission:percival', 'mission:loyal', 'mission:assassin', 'mission:morgana', 'mission:mordred', 'mission:oberon',
];

function main(): void {
  const { cohorts } = loadStrongCohorts({
    dataset: arg('--dataset'),
    analysis: arg('--analysis'),
    poolShare: arg('--pool-share') !== undefined ? Number(arg('--pool-share')) : undefined,
    poolMin: arg('--pool-min') !== undefined ? Number(arg('--pool-min')) : undefined,
    hiShare: arg('--hi-share') !== undefined ? Number(arg('--hi-share')) : undefined,
  });
  const top = Number(arg('--top') ?? 5);
  const names = has('--names');
  console.log(`母體 ${cohorts.pool.length} 人；局 ${cohorts.games}（有分面資料）；高強度門檻 平均 Elo ≥ ${cohorts.threshold.toFixed(1)}、${cohorts.hiGames} 局`);
  console.log(`高強度局 任務階段平均贏率：${Object.entries(cohorts.roleAverage).map(([r, v]) => `${r} ${(100 * v).toFixed(1)}%`).join('、')}`);
  console.log(`刺中率 平均 高強度 ${(100 * cohorts.rateAverage.assassinHit.hi).toFixed(1)}% / 全部 ${(100 * cohorts.rateAverage.assassinHit.all).toFixed(1)}%；`
    + `梅林存活 高強度 ${(100 * cohorts.rateAverage.merlinSurvival.hi).toFixed(1)}% / 全部 ${(100 * cohorts.rateAverage.merlinSurvival.all).toFixed(1)}%`);
  for (const f of FACET_ORDER) {
    const list = cohorts.facets[f] ?? [];
    const rate = f === 'assassinHit' || f === 'merlinSurvival';
    console.log(`\n${facetLabel(f, 0).replace('#0', '')}（${rate ? '收縮率 / 原始率 / 樣本 / 用哪組局' : '收縮超額 / 原始超額 / 高強度樣本'}）`);
    list.slice(0, top).forEach((e, i) => {
      const v = rate
        ? `${(100 * e.value).toFixed(1)}% / ${(100 * e.raw).toFixed(1)}% / ${e.n} / ${e.basis === 'hi' ? '高強度' : '全部'}`
        : `${(100 * e.value >= 0 ? '+' : '')}${(100 * e.value).toFixed(1)}pp / ${(100 * e.raw >= 0 ? '+' : '')}${(100 * e.raw).toFixed(1)}pp / ${e.n}`;
      console.log(`  ${facetLabel(f, i + 1)}${names ? `（${e.name}）` : ''}：${v}`);
    });
  }
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify(publicSummary(cohorts, top), null, 1));
}

if (require.main === module) main();
