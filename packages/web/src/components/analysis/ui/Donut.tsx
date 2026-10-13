import type { ReactNode } from 'react';
import { PieChart, Pie, Tooltip, type TooltipContentProps } from 'recharts';
import { useTranslation } from 'react-i18next';
import {
  OUTCOME_COLORS, OUTCOME_LABEL_KEYS, OUTCOME_ORDER,
  formatInt, formatRate, outcomeTotal,
  type OutcomeCounts, type OutcomeKey,
} from './tokens';

/**
 * Donut — 三種結果 (三紅 / 三藍死 / 三藍活) 的組成甜甜圈，顏色與 OutcomeBar 相同。
 *
 * 2026-10-14 Edward：「三種結果 & 場次排行是不是可以結合？變成大圓餅的小圓餅」——
 * 'lg' 給全體分布 (旁邊附圖例：場數與 %)，'sm' 給每位玩家／每組的小圓餅 (caption 放名字)。
 *  - 中間的字預設是總場數，可用 centerLabel / centerSub 換掉 (例：名字、勝率)。
 *  - 滑過看各段場數與 %；順序固定 三紅 → 三藍死 → 三藍活，從 12 點鐘方向順時針。
 *  - 無障礙：圖本身 aria-hidden；有圖例時圖例 (小表格) 就是文字版，沒有圖例時另附 sr-only 清單。
 *  - 0 場時畫灰色空環。
 */

export interface DonutProps {
  counts: Partial<OutcomeCounts> | null | undefined;
  size?: 'lg' | 'sm';
  /** 中間的主字 (預設總場數)。 */
  centerLabel?: ReactNode;
  /** 中間的副字 (預設 lg 顯示「場」，sm 不顯示)。 */
  centerSub?: ReactNode;
  /** 圖下方的說明 (例：玩家名字)。 */
  caption?: ReactNode;
  /** 無障礙名稱 (預設「三種結果分布」)。 */
  title?: string;
  /** 旁邊的圖例 (預設 lg 顯示、sm 不顯示)。 */
  legend?: boolean;
  className?: string;
}

interface Slice {
  key: OutcomeKey;
  label: string;
  value: number;
  pct: number | null;
  fill: string;
}

const DIMENSIONS = {
  lg: { box: 152, outer: 72, inner: 48, stroke: 2 },
  sm: { box: 64, outer: 30, inner: 19, stroke: 1 },
} as const;

const EMPTY_RING = '#3f3f46';

function safeCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** 不用 hook：recharts 把 content 當函式呼叫，文字由外層先翻好放進 slice。 */
function renderTooltip(props: TooltipContentProps, gamesLabel: (n: number) => string): ReactNode {
  if (!props.active || !props.payload || props.payload.length === 0) return null;
  const slice = props.payload[0]?.payload as Slice | undefined;
  if (!slice) return null;
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800 px-2 py-1 text-[11px] whitespace-nowrap shadow-lg">
      <span className="font-semibold" style={{ color: slice.fill }}>{slice.label}</span>
      <span className="ml-1.5 tabular-nums text-white">{formatRate(slice.pct)}</span>
      <span className="ml-1.5 tabular-nums text-gray-400">{gamesLabel(slice.value)}</span>
    </div>
  );
}

export default function Donut({
  counts,
  size = 'lg',
  centerLabel,
  centerSub,
  caption,
  title,
  legend,
  className = '',
}: DonutProps): JSX.Element {
  const { t } = useTranslation('common');
  const dim = DIMENSIONS[size];
  const total = outcomeTotal(counts);
  const gamesLabel = (n: number): string => t('analytics.ui.donut.games', { value: formatInt(n) });
  const slices: Slice[] = OUTCOME_ORDER.map(key => {
    const value = safeCount(counts?.[key]);
    return {
      key,
      label: t(OUTCOME_LABEL_KEYS[key]),
      value,
      pct: total > 0 ? (value / total) * 100 : null,
      fill: OUTCOME_COLORS[key],
    };
  });
  const drawn = total > 0 ? slices.filter(s => s.value > 0) : [];
  const showLegend = legend ?? size === 'lg';
  const name = title ?? t('analytics.ui.donut.title');
  const sub = centerSub ?? (size === 'lg' ? t('analytics.ui.donut.gamesUnit') : null);

  const chart = (
    <div className="relative shrink-0" style={{ width: dim.box, height: dim.box }} aria-hidden>
      <PieChart width={dim.box} height={dim.box} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} accessibilityLayer={false}>
        {drawn.length > 0 ? (
          <Pie
            data={drawn}
            dataKey="value"
            nameKey="label"
            innerRadius={dim.inner}
            outerRadius={dim.outer}
            startAngle={90}
            endAngle={-270}
            stroke="#09090b"
            strokeWidth={drawn.length > 1 ? dim.stroke : 0}
            isAnimationActive={size === 'lg'}
          />
        ) : (
          <Pie
            data={[{ label: 'empty', value: 1, fill: EMPTY_RING }]}
            dataKey="value"
            nameKey="label"
            innerRadius={dim.inner}
            outerRadius={dim.outer}
            stroke="none"
            isAnimationActive={false}
          />
        )}
        {drawn.length > 0 && (
          <Tooltip
            content={(p: TooltipContentProps) => renderTooltip(p, gamesLabel)}
            allowEscapeViewBox={{ x: true, y: true }}
            wrapperStyle={{ zIndex: 30, outline: 'none' }}
            isAnimationActive={false}
          />
        )}
      </PieChart>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center leading-tight">
        <span className={size === 'lg' ? 'text-xl font-black text-white tabular-nums' : 'text-[11px] font-bold text-white tabular-nums'}>
          {centerLabel ?? formatInt(total)}
        </span>
        {sub && <span className="text-[10px] text-zinc-500">{sub}</span>}
      </div>
    </div>
  );

  return (
    <figure aria-label={name} className={`min-w-0 ${size === 'lg' ? 'flex flex-wrap items-center gap-x-5 gap-y-3' : 'inline-flex flex-col items-center'} ${className}`}>
      {chart}
      {caption && (
        <figcaption className={`max-w-full truncate text-center ${size === 'lg' ? 'text-xs text-zinc-400' : 'mt-1 text-[11px] text-zinc-300'}`} style={size === 'sm' ? { maxWidth: dim.box + 24 } : undefined}>
          {caption}
        </figcaption>
      )}
      {showLegend ? (
        <table className="min-w-0 text-xs tabular-nums">
          <tbody>
            {slices.map(s => (
              <tr key={s.key}>
                <th scope="row" className="py-0.5 pr-2 text-left font-semibold whitespace-nowrap" style={{ color: s.fill }}>
                  <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-[-1px]" style={{ backgroundColor: s.fill }} aria-hidden />
                  {s.label}
                </th>
                <td className="py-0.5 pr-2 text-right font-bold text-white">{formatRate(s.pct)}</td>
                <td className="py-0.5 text-right text-zinc-500 whitespace-nowrap">{gamesLabel(s.value)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} className="pt-1 text-[10px] text-zinc-500">
                {t('analytics.ui.donut.total', { value: formatInt(total) })}
              </td>
            </tr>
          </tbody>
        </table>
      ) : (
        <ul className="sr-only">
          {slices.map(s => (
            <li key={s.key}>
              {t('analytics.ui.donut.item', { label: s.label, games: gamesLabel(s.value), pct: formatRate(s.pct) })}
            </li>
          ))}
          <li>{t('analytics.ui.donut.total', { value: formatInt(total) })}</li>
        </ul>
      )}
    </figure>
  );
}
