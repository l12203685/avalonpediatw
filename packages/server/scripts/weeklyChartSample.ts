/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Write a sample of the Monday weekly ranking chart (invented names) to a PNG,
 * to check the layout without the real cache:
 *
 *   pnpm --filter @avalon/server exec tsx scripts/weeklyChartSample.ts [out.png]
 *
 * Default output: ./weekly_chart_sample.png. Pass --svg to also write the SVG next to it.
 */
import fs from 'fs';
import { buildWeeklyChartSvg, renderWeeklyChartPng } from '../src/bots/stats/weeklyChart';
import { sampleWeeklyChartData } from '../src/__tests__/stats/weeklyChartSample';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? 'weekly_chart_sample.png';
const data = sampleWeeklyChartData();
const started = Date.now();
const png = renderWeeklyChartPng(data);
fs.writeFileSync(out, png);
if (args.includes('--svg')) fs.writeFileSync(out.replace(/\.png$/i, '') + '.svg', buildWeeklyChartSvg(data));
console.log(`wrote ${out} (${png.length} bytes, ${Date.now() - started} ms)`);
