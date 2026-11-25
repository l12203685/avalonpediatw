import { useMemo } from 'react';
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import { fmtPct, fmtTheoryPct } from '../../../services/api';
import type { AnalysisTheorySettings } from '../../../services/api';
import { Advanced, GlanceRow, MeterBar, Takeaway, formatInt, type GlanceTone } from '../ui';
import { pctText, radarGlance, type Sentence } from '../core/glance';
import { useBenchmarkSection } from '../../../stats/benchmarkRows';
import { fieldAxisValues, roleWindowSizes, type AxisKey, type PlayerRadarModel } from './radarModel';

/**
 * 玩家雷達 > 雷達圖 (2026-10-14 Edward：數字用表格、圖只留形狀有意義的)。
 *
 * 雷達圖保留：八個指標放在一起時「哪邊強、哪邊弱」的輪廓一眼看得出來，表格看不出這個形狀。
 * 算不出來的軸 (例：舊快取還沒有角色理論、從沒當紅方打到三藍) 不畫，不畫成 0%。
 * 紅方刺中率、藍方梅林存活率是刺殺結果 (只看到達三藍的局)，不是 三藍死 / 全部紅方場。
 *
 * (2026-11-25 站長：「數據分析…希望能更直觀讓看到的人一目瞭然」，第三批)
 *  - 最上面先一句話：跟全體比，這位玩家哪一項最強、哪一項最弱 (core/glance.ts radarGlance；全體＝基準組「不算散客的全體」，
 *    同一套算法、跟著篩選)。全體還沒算好時只講他自己的最高、最低。
 *  - 圖旁邊的數字表改成一項一列的長條：名字＋最強／最弱的小標、長條＋數字 (整數)、白線＝全體、小字寫全體多少與用了幾場。
 *    手機不用橫向捲。數字跟原本的表同一份 (model.axes)，角色理論／位置理論的小數在滑鼠提示與「理論勝率」小分頁。
 *  - 每一項是什麼 (白話) 收在「這八項是什麼」收合區，不再一項一個 ⓘ。
 */

/** 這一項的長條顏色：紅方的數字紅、藍方的數字藍，其他 (不分陣營) 灰。 */
const AXIS_TONE: Record<AxisKey, GlanceTone> = {
  winRate: 'plain',
  redWinRate: 'red',
  blueMerlinProtect: 'blue',
  missionWinRate: 'plain',
  roleTheory: 'plain',
  positionTheory: 'plain',
  redMerlinKillRate: 'red',
  experience: 'no',
};

const TAGS: Record<string, [string, string]> = {
  'radar.mixed': ['best', 'worst'],
  'radar.allAbove': ['lead', 'trail'],
  'radar.allBelow': ['closest', 'furthest'],
  'radar.own': ['highest', 'lowest'],
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

/** 完整的數字 (滑鼠提示用)：角色理論／位置理論一位小數，其他勝率整數 (Edward 2026-10-30)。 */
function formatAxis(key: AxisKey, v: number | null): string {
  if (v === null) return '—';
  if (key === 'experience') return v.toFixed(1);
  return key === 'roleTheory' || key === 'positionTheory' ? fmtTheoryPct(v) : fmtPct(v);
}

/** 長條旁的數字：一律整數 (經驗不是百分比)。 */
function shortAxis(key: AxisKey, v: number): string {
  return key === 'experience' ? v.toFixed(0) : pctText(v);
}

const G = 'analytics.glance.radar';

export default function RadarPanel({
  model, settings,
}: { model: PlayerRadarModel; settings: AnalysisTheorySettings }): JSX.Element {
  const { t } = useTranslation('common');
  const label = (k: AxisKey): string => t(`analytics.r6.radar.axes.${k}`);
  const { special, loyal } = roleWindowSizes(settings);
  const benchmarks = useBenchmarkSection();
  const regular = benchmarks?.groups.find(g => g.id === 'regular') ?? null;

  const chartData: ChartPoint[] = useMemo(
    () => model.axes.flatMap(a => (a.value === null
      ? []
      : [{ key: a.key, dimension: t(`analytics.r6.radar.axes.${a.key}`), value: clamp100(a.value), raw: a.value }])),
    [model.axes, t],
  );

  // 一句話與每一列的對照：同一個結果 (全體還沒算好時 field 都是 null → 只講自己的最高、最低)
  const glance = useMemo(() => {
    const field = fieldAxisValues(regular);
    return radarGlance(model.axes.map(a => ({ ...a, field: field[a.key] })), model.player.name, settings.theoryMinCellGames);
  }, [model.axes, model.player.name, regular, settings.theoryMinCellGames]);
  const rowOf = (k: AxisKey): (typeof glance.rows)[number] | undefined => glance.rows.find(r => r.key === k);
  const tags = glance.sentence ? TAGS[glance.sentence.key] : undefined;
  // 句子裡的 best／worst 是軸的鍵，換成軸名再填
  const lead = (s: Sentence | null): string | null => (s
    ? t(`analytics.glance.${s.key}`, { ...s.params, best: label(s.params.best as AxisKey), worst: label(s.params.worst as AxisKey) })
    : null);
  const hasField = glance.rows.some(r => r.field !== null);

  return (
    <div className="space-y-3">
      {glance.sentence && (
        <Takeaway>
          <p className="text-sm font-semibold text-white sm:text-[15px]" data-testid="radar-lead">{lead(glance.sentence)}</p>
        </Takeaway>
      )}
      <div className="grid items-start gap-3 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-1" role="img" aria-label={t('analytics.r6.radar.chartAria', { name: model.player.name })}>
          {chartData.length >= 3 ? (
            // 手機矮一點；桌機跟右邊的長條差不多高。
            <div className="h-64 sm:h-[340px]">
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

        <section className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3" data-testid="radar-rows">
          <h3 className="mb-2 text-xs font-bold text-zinc-200">{t(`${G}.rowsTitle`)}</h3>
          <div className="space-y-2">
            {model.axes.map((a) => {
              const row = rowOf(a.key);
              const name = label(a.key);
              const tone = AXIS_TONE[a.key];
              const tag = tags && glance.best === a.key ? t(`${G}.${tags[0]}`) : tags && glance.worst === a.key ? t(`${G}.${tags[1]}`) : undefined;
              const dotted = (
                <span className="inline-flex items-center gap-1.5">
                  {(tone === 'red' || tone === 'blue') && <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${tone === 'red' ? 'bg-red-600' : 'bg-blue-600'}`} aria-hidden />}
                  {name}
                </span>
              );
              if (!row) {
                return (
                  <GlanceRow key={a.key} label={dotted}>
                    <p className="text-xs text-zinc-500">{t('analytics.r6.radar.pending')}</p>
                  </GlanceRow>
                );
              }
              const sample = [
                row.field !== null ? t(`${G}.fieldShort`, { value: shortAxis(a.key, row.field) }) : null,
                row.n !== null ? t(`${G}.used`, { n: formatInt(row.n) }) : null,
              ].filter(Boolean).join('・');
              const aria = row.field !== null
                ? t(`${G}.rowAria`, { label: name, value: formatAxis(a.key, row.value), field: formatAxis(a.key, row.field) })
                : `${name} ${formatAxis(a.key, row.value)}`;
              return (
                <GlanceRow key={a.key} label={dotted} tag={tag} sample={sample}>
                  <MeterBar pct={clamp100(row.value)} text={shortAxis(a.key, row.value)} tone={tone} refPct={row.field} label={aria} />
                </GlanceRow>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-zinc-500">
            {hasField && benchmarks ? t(`${G}.refLine`, { n: benchmarks.maxGames }) : t(`${G}.refLineNone`)}
          </p>
        </section>
      </div>

      <Advanced title={t(`${G}.howTo`)} testId="radar-howto">
        {() => (
          <div className="space-y-1.5 px-1 text-xs leading-relaxed text-zinc-300">
            <dl className="space-y-1.5">
              {model.axes.map(a => (
                <div key={a.key} className="sm:flex sm:gap-2">
                  <dt className="shrink-0 font-semibold text-zinc-100 sm:w-28">{label(a.key)}</dt>
                  <dd className="min-w-0 text-zinc-300">{t(`${G}.def.${a.key}`, { special, loyal, games: settings.positionGames })}</dd>
                </div>
              ))}
            </dl>
            <p className="text-zinc-500">{t(`${G}.note`)}</p>
          </div>
        )}
      </Advanced>
    </div>
  );
}
