import { useState } from 'react';
import { S_BINS, type HeatCell, type OutcomeTally, type StrengthReport } from '@avalon/shared/stats';
import { InfoTip } from '../ui';

/**
 * 季 × S 區間的熱度圖（Edward 2026-10-31）：顏色可切三紅率／三藍被刀率／三藍躲刺率／局數。比率的格子是跟「全部局」
 * 的同一比率比（高幾個百分點），不到 5 局不上色。滑過格子看局數與比率。
 */

type HeatMetric = 'threeRed' | 'blueDead' | 'blueAlive' | 'n';

const METRICS: { id: HeatMetric; label: string }[] = [
  { id: 'threeRed', label: '三紅率' },
  { id: 'blueDead', label: '三藍被刀率' },
  { id: 'blueAlive', label: '三藍躲刺率' },
  { id: 'n', label: '局數' },
];

export const MIN_HEAT_GAMES = 5;

function rate(t: OutcomeTally, m: Exclude<HeatMetric, 'n'>): number | null {
  return t.n > 0 ? (100 * t[m]) / t.n : null;
}

/** 與全部局的差（百分點）→ 底色（同座位熱度圖的色階）。 */
function deviationClass(d: number): string {
  if (d >= 8) return 'bg-emerald-500 text-white';
  if (d >= 3) return 'bg-emerald-700 text-emerald-50';
  if (d > -3) return 'bg-zinc-700 text-zinc-100';
  if (d > -8) return 'bg-rose-700 text-rose-50';
  return 'bg-rose-500 text-white';
}

function countClass(n: number, max: number): string {
  const f = max > 0 ? n / max : 0;
  if (f >= 0.66) return 'bg-blue-500 text-white';
  if (f >= 0.33) return 'bg-blue-700 text-blue-50';
  if (f > 0.1) return 'bg-blue-900 text-blue-100';
  return 'bg-zinc-800 text-zinc-300';
}

export default function StrengthHeatmap({ report }: { report: StrengthReport }): JSX.Element {
  const [metric, setMetric] = useState<HeatMetric>('threeRed');
  const cells = new Map<string, HeatCell>(report.heatmap.map((c) => [`${c.quarter}|${c.bin}`, c]));
  const overall = metric === 'n' ? null : rate(report.overall, metric);
  const maxN = Math.max(0, ...report.heatmap.map((c) => c.n));
  const bins = [...S_BINS].reverse();
  return (
    <div className="space-y-2" data-testid="strength-heatmap">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-zinc-500">顏色</span>
        {METRICS.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={metric === m.id}
            onClick={() => setMetric(m.id)}
            data-testid={`strength-heat-${m.id}`}
            className={`rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors ${
              metric === m.id ? 'border-blue-500 bg-blue-600 text-white' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
            }`}
          >
            {m.label}
          </button>
        ))}
        <InfoTip title="季 × 陣容強度">
          橫軸是季（依日期），縱軸是 S 區間。比率的格子：綠色 = 比全部局的同一比率高、紅色 = 低（±3、±8 個百分點兩段），
          格子裡的數字是比率；不到 {MIN_HEAT_GAMES} 局不上色。局數：越藍越多。
        </InfoTip>
        {overall !== null && <span className="ml-auto text-[11px] text-zinc-400">全部局 {overall.toFixed(0)}%（{report.overall.n} 局）</span>}
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full border-collapse text-[11px] tabular-nums">
          <thead>
            <tr className="bg-zinc-950">
              <th className="sticky left-0 z-10 bg-zinc-950 px-2 py-1 text-left font-semibold text-zinc-500">S＼季</th>
              {report.quarters.map((q) => (
                <th key={q} className="whitespace-nowrap px-1 py-1 text-center font-semibold text-zinc-400">{q.replace('Q', ' Q')}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bins.map((b) => (
              <tr key={b.id} className="border-t border-zinc-800">
                <th className="sticky left-0 z-10 whitespace-nowrap bg-zinc-950 px-2 py-1 text-left font-semibold text-zinc-300">{b.label}</th>
                {report.quarters.map((q) => {
                  const c = cells.get(`${q}|${b.id}`);
                  if (!c || c.n === 0) return <td key={q} className="px-1 py-1 text-center text-zinc-700">·</td>;
                  if (metric === 'n') {
                    return (
                      <td key={q} className={`px-1 py-1 text-center ${countClass(c.n, maxN)}`} title={`${q}・S ${b.label}：${c.n} 局`}>{c.n}</td>
                    );
                  }
                  const r = rate(c, metric) ?? 0;
                  const small = c.n < MIN_HEAT_GAMES;
                  return (
                    <td
                      key={q}
                      title={`${q}・S ${b.label}：${r.toFixed(0)}%（${c[metric]}／${c.n} 局）${small ? '，樣本太少不上色' : ''}`}
                      className={`px-1 py-1 text-center ${small ? 'text-zinc-500' : deviationClass(r - (overall ?? 0))}`}
                    >
                      {r.toFixed(0)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
