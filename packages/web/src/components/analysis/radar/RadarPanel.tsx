import { useMemo } from 'react';
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import { fmtPct, fmtTheoryPct } from '../../../services/api';
import type { AnalysisTheorySettings } from '../../../services/api';
import { InfoTip, StatTable, type StatColumn, type Tone } from '../ui';
import { roleWindowSizes, type AxisKey, type AxisRow, type PlayerRadarModel } from './radarModel';

/**
 * 玩家雷達 > 雷達圖 (2026-10-14 Edward：數字用表格、圖只留形狀有意義的)。
 *
 * 雷達圖保留：八個指標放在一起時「哪邊強、哪邊弱」的輪廓一眼看得出來，表格看不出這個形狀；
 * 每條軸的數字、n (分母) 與定義放在旁邊的表裡。算不出來的軸 (例：舊快取還沒有角色理論、
 * 從沒當紅方打到三藍) 不畫，不畫成 0%；表格那一列顯示「—」。
 * 紅方刺中率、藍方梅林存活率是刺殺結果 (只看到達三藍的局)，不是 三藍死 / 全部紅方場。
 * (2026-10-30 Edward：說明太冗長) 原本表格最右邊的「定義」欄改成軸名旁的 ⓘ，表格註腳也收進 ⓘ；完整版在說明頁。
 */

const AXIS_TONE: Partial<Record<AxisKey, Tone>> = {
  redWinRate: 'red',
  redMerlinKillRate: 'red',
  blueMerlinProtect: 'blue',
};

interface ChartPoint {
  key: AxisKey;
  dimension: string;
  /** 畫在圖上的 0–100 值。 */
  value: number;
  raw: number;
}

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

interface AxisTickProps {
  x?: number | string;
  y?: number | string;
  textAnchor?: 'start' | 'middle' | 'end' | 'inherit';
  /** recharts 依軸的方向給：上方的軸 'end' (字在點的上面)、下方 'start'、左右 'middle'。 */
  verticalAnchor?: 'start' | 'middle' | 'end';
  payload?: { value?: unknown };
}

const TICK_LINE_EM = 1.1;

/**
 * 軸名：有空白的長名字 (英文，例 Blue Merlin survival) 拆兩行，手機上才不會被圖的邊切掉；
 * 中文軸名不拆。垂直對齊照 recharts 預設的 verticalAnchor。
 */
function AxisTick({ x = 0, y = 0, textAnchor = 'middle', verticalAnchor = 'middle', payload }: AxisTickProps): JSX.Element {
  const text = String(payload?.value ?? '');
  const cut = text.length > 12 ? text.lastIndexOf(' ', Math.ceil(text.length / 2) + 2) : -1;
  const lines = cut > 0 ? [text.slice(0, cut), text.slice(cut + 1)] : [text];
  const extra = (lines.length - 1) * TICK_LINE_EM;
  const firstDy = verticalAnchor === 'start' ? 0.71 : verticalAnchor === 'end' ? -extra : 0.355 - extra / 2;
  return (
    <text x={x} y={y} textAnchor={textAnchor} fontSize={10} fill="#d4d4d8">
      {lines.map((line, i) => (
        <tspan key={i} x={x} dy={`${i === 0 ? firstDy : TICK_LINE_EM}em`}>{line}</tspan>
      ))}
    </text>
  );
}

function formatAxis(key: AxisKey, v: number | null): string {
  if (v === null) return '—';
  if (key === 'experience') return v.toFixed(1);
  // 角色理論／位置理論一位小數，其他勝率整數 (Edward 2026-10-30)。
  return key === 'roleTheory' || key === 'positionTheory' ? fmtTheoryPct(v) : fmtPct(v);
}

export default function RadarPanel({
  model, settings,
}: { model: PlayerRadarModel; settings: AnalysisTheorySettings }): JSX.Element {
  const { t } = useTranslation('common');
  const label = (k: AxisKey): string => t(`analytics.r6.radar.axes.${k}`);
  const { special, loyal } = roleWindowSizes(settings);

  const chartData: ChartPoint[] = useMemo(
    () => model.axes.flatMap(a => (a.value === null
      ? []
      : [{ key: a.key, dimension: t(`analytics.r6.radar.axes.${a.key}`), value: clamp100(a.value), raw: a.value }])),
    [model.axes, t],
  );

  const definition = (k: AxisKey): string => t(`analytics.r6.radar.axisDef.${k}`, {
    special, loyal, games: settings.positionGames,
  });

  const columns: StatColumn<AxisRow>[] = [
    {
      key: 'label',
      label: t('analytics.r6.radar.colAxis'),
      value: row => label(row.key),
      tone: row => AXIS_TONE[row.key],
      format: (_v, row) => (
        <span className="inline-flex items-center gap-0.5">
          {label(row.key)}
          <InfoTip title={label(row.key)} testId={`radar-axis-info-${row.key}`}><p>{definition(row.key)}</p></InfoTip>
        </span>
      ),
    },
    {
      key: 'value',
      label: t('analytics.r6.radar.colValue'),
      align: 'right',
      format: (_v, row) => (row.value === null
        ? <span className="font-normal text-zinc-500">{t('analytics.r6.radar.pending')}</span>
        : formatAxis(row.key, row.value)),
      n: row => (row.value === null ? null : row.n),
      tone: row => AXIS_TONE[row.key],
      emphasis: true,
    },
  ];

  return (
    <div className="grid items-start gap-3 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-1" role="img" aria-label={t('analytics.r6.radar.chartAria', { name: model.player.name })}>
        {chartData.length >= 3 ? (
          // 手機矮一點，桌機 292 px 剛好和右邊的表等高。
          <div className="h-64 sm:h-[292px]">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={chartData} outerRadius="66%" margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                <PolarGrid stroke="#3f3f46" />
                <PolarAngleAxis dataKey="dimension" tick={<AxisTick />} />
                <PolarRadiusAxis
                  angle={67.5}
                  domain={[0, 100]}
                  tickCount={5}
                  tick={{ fontSize: 8, fill: '#71717a' }}
                  axisLine={false}
                />
                <Radar name={model.player.name} dataKey="value" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} />
                <Tooltip
                  formatter={(_val: unknown, _name, item) => {
                    const p = item.payload as ChartPoint;
                    return [formatAxis(p.key, p.raw), p.dimension];
                  }}
                  contentStyle={{ backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: '8px', fontSize: 12 }}
                  itemStyle={{ color: '#d4d4d8' }}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="px-3 py-10 text-center text-xs text-zinc-500">{t('analytics.r6.radar.tooFewAxes')}</p>
        )}
      </div>
      <StatTable
        columns={columns}
        rows={model.axes}
        rowKey={row => row.key}
        footnote={t('analytics.r6.radar.radarNote')}
      />
    </div>
  );
}
