/**
 * OutcomeBar — three-outcome breakdown display.
 *
 * Edward 2026-04-26 spec: every percentage in 深度分析 must be expanded into the
 * three mutually-exclusive game outcomes (三紅 / 三藍死 / 三藍活), in fixed display
 * order matching the rank baseline:
 *   1. 三紅           (red wins by 3 failed missions)
 *   2. 三藍死         (blue wins 3 missions but Merlin assassinated)
 *   3. 三藍活         (blue wins 3 missions and Merlin survives)
 *
 * Three render modes are supported so the component drops into both card-style
 * stat blocks and table cells.
 */
import { useTranslation } from 'react-i18next';
import type { OutcomeBreakdown } from '../../services/api';

const RED   = '#ef4444';
const BLUE_DEAD  = '#f59e0b';
const BLUE_ALIVE = '#3b82f6';

export interface OutcomeBarProps {
  outcomes: OutcomeBreakdown;
  /** Render style. */
  variant?: 'inline' | 'stacked' | 'rows';
  /** Card title shown above the breakdown (rows variant). */
  title?: string;
  /** Show 場 number row beneath the percentages. */
  showRawCounts?: boolean;
  /** Compact text (fewer characters). */
  compact?: boolean;
}

/**
 * Inline variant: three small pills `三紅 52% · 三藍死 21% · 三藍活 27%`.
 * Suitable inside table cells or tight tooltips.
 */
function InlineOutcomes({ outcomes, compact }: { outcomes: OutcomeBreakdown; compact: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const labels = compact
    ? {
        red:   t('analytics.deep.outcomes.threeRed'),
        dead:  t('analytics.deep.outcomes.threeBlueDead'),
        alive: t('analytics.deep.outcomes.threeBlueAlive'),
      }
    : {
        red:   t('analytics.deep.outcomes.threeRed'),
        dead:  t('analytics.deep.outcomes.threeBlueDead'),
        alive: t('analytics.deep.outcomes.threeBlueAlive'),
      };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
      <span style={{ color: RED }}>{labels.red} {outcomes.threeRedPct}%</span>
      <span className="text-gray-600">·</span>
      <span style={{ color: BLUE_DEAD }}>{labels.dead} {outcomes.threeBlueDeadPct}%</span>
      <span className="text-gray-600">·</span>
      <span style={{ color: BLUE_ALIVE }}>{labels.alive} {outcomes.threeBlueAlivePct}%</span>
    </div>
  );
}

/**
 * Stacked variant: a single horizontal bar split into three coloured segments.
 * Width-proportional to the percentages. Tooltip on hover shows raw count.
 */
function StackedOutcomes({ outcomes }: { outcomes: OutcomeBreakdown }): JSX.Element {
  const { t } = useTranslation('common');
  const segs = [
    { color: RED,        pct: outcomes.threeRedPct,        n: outcomes.threeRed,        label: t('analytics.deep.outcomes.threeRed') },
    { color: BLUE_DEAD,  pct: outcomes.threeBlueDeadPct,   n: outcomes.threeBlueDead,   label: t('analytics.deep.outcomes.threeBlueDead') },
    { color: BLUE_ALIVE, pct: outcomes.threeBlueAlivePct,  n: outcomes.threeBlueAlive,  label: t('analytics.deep.outcomes.threeBlueAlive') },
  ];
  return (
    <div className="space-y-1">
      <div className="flex h-3 w-full overflow-hidden rounded bg-zinc-800">
        {segs.map(s => (
          <div
            key={s.label}
            title={`${s.label} ${s.pct}% (${s.n} 場)`}
            style={{ width: `${s.pct}%`, backgroundColor: s.color }}
            className="transition-all"
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px]">
        <span style={{ color: RED }}>{segs[0].label} {segs[0].pct}%</span>
        <span style={{ color: BLUE_DEAD }}>{segs[1].label} {segs[1].pct}%</span>
        <span style={{ color: BLUE_ALIVE }}>{segs[2].label} {segs[2].pct}%</span>
      </div>
    </div>
  );
}

/**
 * Rows variant: three labelled rows with raw count for each outcome.
 * Used inside cards where vertical space is available.
 */
function RowsOutcomes({ outcomes, title, showRawCounts }: {
  outcomes: OutcomeBreakdown; title?: string; showRawCounts: boolean;
}): JSX.Element {
  const { t } = useTranslation('common');
  const rows = [
    { color: RED,        pct: outcomes.threeRedPct,       n: outcomes.threeRed,       label: t('analytics.deep.outcomes.threeRed') },
    { color: BLUE_DEAD,  pct: outcomes.threeBlueDeadPct,  n: outcomes.threeBlueDead,  label: t('analytics.deep.outcomes.threeBlueDead') },
    { color: BLUE_ALIVE, pct: outcomes.threeBlueAlivePct, n: outcomes.threeBlueAlive, label: t('analytics.deep.outcomes.threeBlueAlive') },
  ];
  return (
    <div className="space-y-1">
      {title && <p className="text-[10px] text-gray-500 mb-1">{title}</p>}
      {rows.map(r => (
        <div key={r.label} className="flex items-center justify-between text-xs">
          <span style={{ color: r.color }} className="font-semibold">{r.label}</span>
          <span className="text-white font-bold">
            {r.pct}%
            {showRawCounts && <span className="text-gray-500 ml-1">({r.n})</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function OutcomeBar({
  outcomes,
  variant = 'rows',
  title,
  showRawCounts = false,
  compact = false,
}: OutcomeBarProps): JSX.Element {
  if (variant === 'inline')  return <InlineOutcomes  outcomes={outcomes} compact={compact} />;
  if (variant === 'stacked') return <StackedOutcomes outcomes={outcomes} />;
  return <RowsOutcomes outcomes={outcomes} title={title} showRawCounts={showRawCounts} />;
}
