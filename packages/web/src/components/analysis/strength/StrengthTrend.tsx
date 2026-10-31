import { useMemo, useState } from 'react';
import {
  CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';
import { rollingMedian, type StrengthPoint, type StrengthReport } from '@avalon/shared/stats';
import { OUTCOME_COLORS, OUTCOME_ORDER, InfoTip, type OutcomeKey } from '../ui';
import { useMediaQuery } from '../overview/useMediaQuery';

/**
 * 陣容強度的時間散點（Edward 2026-10-31）：x = 日期、每局一點，y 可切 S／桌上賽前 Elo 平均／中位／最低／最高，
 * 顏色 = 結果，灰線 = 前後各 30 局的中位數。滑過看日期、局號、結果、S 與 Elo 範圍。
 */

type YKey = 's' | 'eloMean' | 'eloMedian' | 'eloMin' | 'eloMax';

const Y_OPTIONS: { id: YKey; label: string; help: string }[] = [
  { id: 's', label: 'S', help: '桌上 10 人開打前 PR 的平均（0–100）' },
  { id: 'eloMean', label: 'Elo 平均', help: '桌上 10 人開打前 Elo 的平均' },
  { id: 'eloMedian', label: 'Elo 中位', help: '桌上 10 人開打前 Elo 的中位數' },
  { id: 'eloMin', label: 'Elo 最低', help: '桌上開打前 Elo 最低的那位' },
  { id: 'eloMax', label: 'Elo 最高', help: '桌上開打前 Elo 最高的那位' },
];

const OUTCOME_TEXT: Record<OutcomeKey, string> = { 三紅: '三紅', 三藍死: '三藍被刀', 三藍活: '三藍躲刺' };

interface Dot {
  t: number;
  y: number;
  p: StrengthPoint;
}

function yOf(p: StrengthPoint, key: YKey): number | null {
  if (key === 's') return p.s;
  if (!p.elo) return null;
  return key === 'eloMean' ? p.elo.mean : key === 'eloMedian' ? p.elo.median : key === 'eloMin' ? p.elo.min : p.elo.max;
}

const dateMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const fmtDate = (t: number): string => new Date(t).toISOString().slice(0, 7);

/** 橫軸刻度：每年 1 月與 7 月（手機只放 1 月）。 */
function dateTicks(lo: number, hi: number, halfYears: boolean): number[] {
  const out: number[] = [];
  const start = new Date(lo).getUTCFullYear();
  const end = new Date(hi).getUTCFullYear();
  for (let y = start; y <= end; y++) {
    for (const m of halfYears ? [0, 6] : [0]) {
      const t = Date.UTC(y, m, 1);
      if (t >= lo && t <= hi) out.push(t);
    }
  }
  return out;
}

function DotTip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: Dot }> }): JSX.Element | null {
  const dot = payload?.[0]?.payload;
  if (!active || !dot?.p) return null;
  const p = dot.p;
  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 text-xs text-zinc-200 shadow-lg">
      <div className="font-mono text-zinc-400">{p.date} · #{p.id}</div>
      <div style={{ color: OUTCOME_COLORS[p.outcome as OutcomeKey] }} className="font-semibold">{OUTCOME_TEXT[p.outcome as OutcomeKey] ?? p.outcome}</div>
      <div>S {p.s.toFixed(1)}</div>
      {p.elo && <div>Elo {p.elo.min.toFixed(0)}–{p.elo.max.toFixed(0)}（中位 {p.elo.median.toFixed(0)}、平均 {p.elo.mean.toFixed(1)}）</div>}
    </div>
  );
}

export default function StrengthTrend({ report }: { report: StrengthReport }): JSX.Element {
  const [yKey, setYKey] = useState<YKey>('s');
  const wide = useMediaQuery('(min-width: 640px)');
  const hasElo = report.points.some((p) => p.elo);
  const { byOutcome, line, domain, xDomain } = useMemo(() => {
    const dots: Dot[] = [];
    for (const p of report.points) {
      const y = yOf(p, yKey);
      if (y !== null) dots.push({ t: dateMs(p.date), y, p });
    }
    const med = rollingMedian(dots.map((d) => d.y), 30);
    const ys = dots.map((d) => d.y);
    const lo = ys.length ? Math.min(...ys) : 0;
    const hi = ys.length ? Math.max(...ys) : 100;
    const pad = (hi - lo) * 0.04 || 1;
    return {
      byOutcome: OUTCOME_ORDER.map((o) => ({ o, data: dots.filter((d) => d.p.outcome === o) })),
      line: dots.map((d, i) => ({ t: d.t, y: med[i] })),
      domain: yKey === 's' ? [0, 100] : [Math.floor(lo - pad), Math.ceil(hi + pad)],
      xDomain: dots.length ? [dots[0].t, dots[dots.length - 1].t] : [0, 1],
    };
  }, [report.points, yKey]);

  return (
    <div className="space-y-2" data-testid="strength-trend">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-zinc-500">縱軸</span>
        {Y_OPTIONS.map((o) => {
          const disabled = o.id !== 's' && !hasElo;
          return (
            <button
              key={o.id}
              type="button"
              title={disabled ? '這份資料還沒有座位的賽前 Elo（下次每日更新後就有）' : o.help}
              disabled={disabled}
              aria-pressed={yKey === o.id}
              onClick={() => setYKey(o.id)}
              data-testid={`strength-y-${o.id}`}
              className={`rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
                yKey === o.id ? 'border-blue-500 bg-blue-600 text-white' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
              }`}
            >
              {o.label}
            </button>
          );
        })}
        <InfoTip title="陣容強度走勢">
          每一點是一局：橫軸是日期，縱軸是開打前的陣容強度（S = 桌上 10 人在「生涯已 ≥30 場」玩家池裡 PR 的平均；或桌上 Elo）。
          顏色是結果，灰線是前後各 30 局的中位數。暫定玩家（不到 30 場）PR 最高算 50。
        </InfoTip>
        <span className="ml-auto flex flex-wrap gap-2 text-[11px] text-zinc-400">
          {OUTCOME_ORDER.map((o) => (
            <span key={o} className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: OUTCOME_COLORS[o] }} />{OUTCOME_TEXT[o]}
            </span>
          ))}
          <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-zinc-300" />滾動中位數</span>
        </span>
      </div>
      <div className="h-[260px] w-full sm:h-[380px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 6, right: 8, bottom: 0, left: wide || yKey !== 's' ? 0 : -18 }}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis
              dataKey="t" type="number" domain={xDomain} ticks={dateTicks(xDomain[0], xDomain[1], wide)} tickFormatter={fmtDate}
              stroke="#71717a" fontSize={11}
            />
            <YAxis dataKey="y" type="number" domain={domain} stroke="#71717a" fontSize={11} width={wide ? 44 : 40} />
            <ZAxis type="number" range={wide ? [12, 12] : [4, 4]} />
            <Tooltip content={<DotTip />} cursor={{ stroke: '#52525b' }} isAnimationActive={false} />
            {byOutcome.map(({ o, data }) => (
              <Scatter key={o} name={OUTCOME_TEXT[o]} data={data} fill={OUTCOME_COLORS[o]} fillOpacity={0.55} isAnimationActive={false} shape="circle" />
            ))}
            <Scatter
              data={line} line={{ stroke: '#e4e4e7', strokeWidth: 2 }} shape={() => <g />} isAnimationActive={false}
              legendType="none" tooltipType="none"
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-zinc-500">{report.points.length} 局有陣容強度（篩選後共 {report.games} 局）</p>
    </div>
  );
}
