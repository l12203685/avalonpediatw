import { useMemo, useState } from 'react';
import {
  Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { riverSeries, type RiverPoint, type StrengthReport } from '@avalon/shared/stats';
import { OUTCOME_COLORS, InfoTip } from '../ui';
import { useMediaQuery } from '../overview/useMediaQuery';

/**
 * 陣容強度走勢的河流圖（Edward 2026-10-31：「ELO 最低／最高／中位／平均可以同時呈現在圖上吧？變成有點像河流區間那樣」）。
 * 每一點 = 依日期排好的局，前後各 30 局的視窗裡「桌上分布」各項的中位數：
 *  - 淺色帶：桌上最低 ～ 最高（典型的一桌從最弱到最強）；
 *  - 深色帶：桌上第 1 ～ 第 3 四分位（中間一半的座位）；
 *  - 白線：桌上中位數；黃虛線：桌上平均（PR 版的平均就是 S）。
 * 下方細條：同一個視窗裡三種結果的比例。可切 Elo（賽前 Elo）／PR（時點 PR，S 版）。
 */

type Mode = 'elo' | 'pr';

const fmtDate = (t: number): string => new Date(t).toISOString().slice(0, 7);

function dateTicks(lo: number, hi: number, halfYears: boolean): number[] {
  const out: number[] = [];
  for (let y = new Date(lo).getUTCFullYear(); y <= new Date(hi).getUTCFullYear(); y++) {
    for (const m of halfYears ? [0, 6] : [0]) {
      const t = Date.UTC(y, m, 1);
      if (t >= lo && t <= hi) out.push(t);
    }
  }
  return out;
}

interface Datum extends RiverPoint {
  outer: [number, number];
  inner: [number, number];
}

function RiverTip({ active, payload, mode }: { active?: boolean; payload?: Array<{ payload?: Datum }>; mode: Mode }): JSX.Element | null {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  const f = (v: number): string => (mode === 'elo' ? v.toFixed(0) : v.toFixed(0));
  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 text-xs text-zinc-200 shadow-lg">
      <div className="font-mono text-zinc-400">{d.date} 前後 · {d.n} 局</div>
      <div>{mode === 'elo' ? '桌上 Elo' : '桌上 PR'}：最高 {f(d.max)}、Q3 {f(d.q3)}、<b>中位 {f(d.median)}</b>、平均 {mode === 'elo' ? d.mean.toFixed(1) : d.mean.toFixed(1)}、Q1 {f(d.q1)}、最低 {f(d.min)}</div>
      <div>S（中位數）{d.s.toFixed(1)}</div>
      <div className="text-zinc-400">
        <span style={{ color: OUTCOME_COLORS.三紅 }}>三紅 {d.threeRed.toFixed(0)}%</span>{' · '}
        <span style={{ color: OUTCOME_COLORS.三藍死 }}>被刀 {d.blueDead.toFixed(0)}%</span>{' · '}
        <span style={{ color: OUTCOME_COLORS.三藍活 }}>躲刺 {d.blueAlive.toFixed(0)}%</span>
      </div>
    </div>
  );
}

export default function StrengthTrend({ report }: { report: StrengthReport }): JSX.Element {
  const hasElo = report.points.some((p) => p.elo);
  const [mode, setMode] = useState<Mode>(hasElo ? 'elo' : 'pr');
  const wide = useMediaQuery('(min-width: 640px)');
  const data: Datum[] = useMemo(
    () => riverSeries(report.points, mode, 30, wide ? 240 : 120).map((p) => ({ ...p, outer: [p.min, p.max], inner: [p.q1, p.q3] })),
    [report.points, mode, wide],
  );
  const xDomain: [number, number] = data.length ? [data[0].t, data[data.length - 1].t] : [0, 1];
  const ticks = dateTicks(xDomain[0], xDomain[1], wide);
  const yDomain: [number, number] = mode === 'pr'
    ? [0, 100]
    : data.length ? [Math.floor(Math.min(...data.map((d) => d.min)) - 2), Math.ceil(Math.max(...data.map((d) => d.max)) + 2)] : [1450, 1550];
  const margin = { top: 6, right: 8, bottom: 0, left: wide ? 0 : -6 };
  return (
    <div className="space-y-1" data-testid="strength-trend">
      <div className="flex flex-wrap items-center gap-1.5">
        {(['elo', 'pr'] as const).map((m) => (
          <button
            key={m}
            type="button"
            disabled={m === 'elo' && !hasElo}
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            data-testid={`strength-river-${m}`}
            className={`rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
              mode === m ? 'border-blue-500 bg-blue-600 text-white' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
            }`}
          >
            {m === 'elo' ? '賽前 Elo' : 'PR（S）'}
          </button>
        ))}
        <InfoTip title="陣容強度的河流圖">
          橫軸是日期。每一點取前後各 30 局：淺色帶是桌上最低到最高、深色帶是桌上中間一半的座位（第 1 到第 3 四分位）、白線是桌上
          中位數、黃虛線是桌上平均（PR 版的平均就是 S），都是這 61 局的中位數，所以是「那段時間典型的一桌」。下面的細條是同一段時間
          三種結果的比例。PR 是開打前在「生涯已 ≥30 場」玩家池裡的百分等級，暫定玩家最高算 50。
        </InfoTip>
        <span className="ml-auto flex flex-wrap gap-2 text-[11px] text-zinc-400">
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-3 rounded-sm bg-blue-400/20" />最低～最高</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-3 rounded-sm bg-blue-400/50" />Q1～Q3</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-zinc-100" />中位</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3 border-t border-dashed border-amber-300" />平均</span>
        </span>
      </div>
      <div className="h-[240px] w-full sm:h-[340px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={margin} syncId="strength-river">
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis dataKey="t" type="number" domain={xDomain} ticks={ticks} tickFormatter={fmtDate} stroke="#71717a" fontSize={11} />
            <YAxis type="number" domain={yDomain} stroke="#71717a" fontSize={11} width={wide ? 44 : 40} allowDataOverflow />
            <Tooltip content={<RiverTip mode={mode} />} cursor={{ stroke: '#71717a' }} isAnimationActive={false} />
            <Area dataKey="outer" stroke="none" fill="#93c5fd" fillOpacity={0.2} isAnimationActive={false} activeDot={false} />
            <Area dataKey="inner" stroke="none" fill="#60a5fa" fillOpacity={0.42} isAnimationActive={false} activeDot={false} />
            <Line dataKey="median" stroke="#f4f4f5" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="mean" stroke="#fcd34d" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="h-[56px] w-full" aria-label="同一段時間三種結果的比例">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ ...margin, top: 0 }} syncId="strength-river">
            <XAxis dataKey="t" type="number" domain={xDomain} hide />
            <YAxis type="number" domain={[0, 100]} hide width={wide ? 44 : 40} />
            <Tooltip content={() => null} cursor={{ stroke: '#71717a' }} />
            <Area dataKey="threeRed" stackId="o" stroke="none" fill={OUTCOME_COLORS.三紅} fillOpacity={0.75} isAnimationActive={false} />
            <Area dataKey="blueDead" stackId="o" stroke="none" fill={OUTCOME_COLORS.三藍死} fillOpacity={0.75} isAnimationActive={false} />
            <Area dataKey="blueAlive" stackId="o" stroke="none" fill={OUTCOME_COLORS.三藍活} fillOpacity={0.75} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="flex flex-wrap gap-x-3 text-[11px] text-zinc-500">
        <span>細條：<span style={{ color: OUTCOME_COLORS.三紅 }}>三紅</span>／<span style={{ color: OUTCOME_COLORS.三藍死 }}>三藍被刀</span>／<span style={{ color: OUTCOME_COLORS.三藍活 }}>三藍躲刺</span> 的比例（前後各 30 局）</span>
        <span>{report.points.length} 局有陣容強度（篩選後共 {report.games} 局）</span>
      </p>
    </div>
  );
}
