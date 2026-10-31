import { useState } from 'react';
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { S_BINS, shrinkRate, type HeatCell, type OutcomeTally, type SCurveBin, type StrengthReport } from '@avalon/shared/stats';
import { OUTCOME_COLORS, InfoTip } from '../ui';
import { useMediaQuery } from '../overview/useMediaQuery';

/**
 * 強度與結果（Edward 2026-10-31：季 × 強度熱度圖「好像沒有呈現的很好」）：
 *  - 上：結果比率 vs S。依 S 把局分成 8 個等量的箱，畫選定結果的比率與 95% 信賴區間（Wilson），虛線是全部局的比率。
 *  - 下：半年 × S 區間。格子的比率先做經驗貝氏收縮（往全部局的比率拉 20 局的份量：局數少的格子幾乎等於整體），
 *    顏色只表示「比整體多／少」（多 = 這個結果的顏色、少 = 紫色，不用紅綠燈色），深淺同時看差距與局數（局數少的淡），
 *    格子裡寫收縮後的比率與局數，滑過看原始比率。
 */

type Metric = 'threeRed' | 'blueDead' | 'blueAlive';

const METRICS: { id: Metric; label: string; color: string }[] = [
  { id: 'threeRed', label: '三紅率', color: OUTCOME_COLORS.三紅 },
  { id: 'blueDead', label: '三藍被刀率', color: OUTCOME_COLORS.三藍死 },
  { id: 'blueAlive', label: '三藍躲刺率', color: OUTCOME_COLORS.三藍活 },
];

export const PRIOR_GAMES = 20;
const LESS = '#8b5cf6';

/** 收縮後跟整體的差 → 底色（多 = 結果色、少 = 紫色；差 12pp 以上最深，局數少再淡一點）。 */
export function cellStyle(shrunk: number, overall: number, n: number, color: string): { backgroundColor: string } {
  const d = shrunk - overall;
  const strength = Math.min(1, Math.abs(d) / 12) * Math.min(1, n / 30);
  const hex = d >= 0 ? color : LESS;
  const alpha = Math.round(strength * 0.85 * 255).toString(16).padStart(2, '0');
  return { backgroundColor: `${hex}${alpha}` };
}

function CurveTip({ active, payload, metric }: { active?: boolean; payload?: Array<{ payload?: SCurveBin }>; metric: Metric }): JSX.Element | null {
  const b = payload?.[0]?.payload;
  if (!active || !b) return null;
  const r = b[metric];
  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 text-xs text-zinc-200 shadow-lg">
      <div className="text-zinc-400">S {b.lo.toFixed(1)}～{b.hi.toFixed(1)}（平均 {b.mid.toFixed(1)}）· {b.n} 局</div>
      <div><b>{METRICS.find((m) => m.id === metric)?.label} {r.rate.toFixed(0)}%</b>（95% CI {r.lo.toFixed(0)}～{r.hi.toFixed(0)}%）</div>
    </div>
  );
}

export default function StrengthOutcome({ report }: { report: StrengthReport }): JSX.Element {
  const [metric, setMetric] = useState<Metric>('threeRed');
  const wide = useMediaQuery('(min-width: 640px)');
  const m = METRICS.find((x) => x.id === metric)!;
  const overall = report.overall.n ? (100 * report.overall[metric]) / report.overall.n : 0;
  const curve = report.sCurve.map((b) => ({ ...b, band: [b[metric].lo, b[metric].hi] as [number, number], rate: b[metric].rate }));
  const cells = new Map<string, HeatCell>(report.heatmap.map((c) => [`${c.period}|${c.bin}`, c]));
  const rate = (t: OutcomeTally): number => (t.n ? (100 * t[metric]) / t.n : NaN);
  return (
    <div className="space-y-3" data-testid="strength-outcome">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-zinc-500">結果</span>
        {METRICS.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-pressed={metric === x.id}
            onClick={() => setMetric(x.id)}
            data-testid={`strength-outcome-${x.id}`}
            className={`rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors ${
              metric === x.id ? 'border-blue-500 bg-blue-600 text-white' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
            }`}
          >
            {x.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-zinc-400">全部局 {overall.toFixed(0)}%（{report.overall.n} 局）</span>
      </div>

      <div>
        <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-zinc-300">
          {m.label} vs 桌上 S
          <InfoTip title="結果比率 vs 桌上 S">
            依 S 由低到高把局分成 8 箱、每箱局數差不多，點是那一箱的{m.label}，色帶是 95% 信賴區間（Wilson），虛線是全部局的{m.label}。
            色帶跟虛線重疊很多 = 這個強度範圍跟平均看不出差別。
          </InfoTip>
        </div>
        <div className="h-[200px] w-full sm:h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={curve} margin={{ top: 6, right: 12, bottom: 0, left: wide ? 0 : -14 }}>
              <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
              <XAxis dataKey="mid" type="number" domain={['dataMin - 2', 'dataMax + 2']} stroke="#71717a" fontSize={11}
                tickFormatter={(v: number) => v.toFixed(0)} label={{ value: '桌上 S', position: 'insideBottomRight', offset: -2, fill: '#71717a', fontSize: 10 }} />
              <YAxis type="number" domain={[0, (max: number): number => Math.min(100, Math.ceil((max + 5) / 10) * 10)]} stroke="#71717a" fontSize={11}
                tickFormatter={(v: number) => `${v}%`} width={wide ? 44 : 40} />
              <Tooltip content={<CurveTip metric={metric} />} cursor={{ stroke: '#71717a' }} isAnimationActive={false} />
              <ReferenceLine y={overall} stroke="#a1a1aa" strokeDasharray="4 3" />
              <Area dataKey="band" stroke="none" fill={m.color} fillOpacity={0.2} isAnimationActive={false} activeDot={false} />
              <Line dataKey="rate" stroke={m.color} strokeWidth={2} dot={{ r: 3, fill: m.color }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-zinc-300">
          半年 × S 區間的{m.label}（收縮後）
          <InfoTip title="半年 × S 區間">
            每格先往全部局的比率拉 {PRIOR_GAMES} 局的份量（經驗貝氏收縮），局數少的格子會接近整體、不會因為幾局就看起來很極端。
            顏色只表示比整體多（{m.label.replace('率', '')}的顏色）或少（紫色），越深 = 差越多而且局數越多。格子裡是收縮後的比率，小字是局數；
            滑過看原始比率。
          </InfoTip>
        </div>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full border-collapse text-[11px] tabular-nums" data-testid="strength-heatmap">
            <thead>
              <tr className="bg-zinc-950">
                <th className="sticky left-0 z-10 bg-zinc-950 px-2 py-1 text-left font-semibold text-zinc-500">S＼半年</th>
                {report.periods.map((p) => <th key={p} className="whitespace-nowrap px-1 py-1 text-center font-semibold text-zinc-400">{p}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...S_BINS].reverse().map((b) => (
                <tr key={b.id} className="border-t border-zinc-800">
                  <th className="sticky left-0 z-10 whitespace-nowrap bg-zinc-950 px-2 py-1 text-left font-semibold text-zinc-300">{b.label}</th>
                  {report.periods.map((p) => {
                    const c = cells.get(`${p}|${b.id}`);
                    if (!c || c.n === 0) return <td key={p} className="px-1 py-1 text-center text-zinc-700">·</td>;
                    const shrunk = shrinkRate(c[metric], c.n, overall / 100, PRIOR_GAMES);
                    return (
                      <td
                        key={p}
                        style={cellStyle(shrunk, overall, c.n, m.color)}
                        title={`${p}・S ${b.label}：原始 ${rate(c).toFixed(0)}%（${c[metric]}／${c.n} 局），收縮後 ${shrunk.toFixed(0)}%`}
                        className="px-1 py-0.5 text-center text-zinc-100"
                      >
                        <div className="font-semibold">{shrunk.toFixed(0)}</div>
                        <div className="text-[9px] text-zinc-300/80">n={c.n}</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
