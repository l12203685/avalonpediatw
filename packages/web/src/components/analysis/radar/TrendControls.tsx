import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DAY_PRESETS,
  DEFAULT_TREND_VIEW,
  GAME_PRESETS,
  TREND_VIEW_STORAGE_KEY,
  WINDOW_LIMITS,
  clampWindow,
  parseTrendView,
  type TrendView,
} from './trendSeries';

/**
 * Elo／理論走勢上方的一列控制（Edward 2026-11-10「可以切換X軸是場次 … 可以取rolling 平均 … 窗口也可以自訂要幾天/幾場」）：
 * X 軸 日期／場次、移動平均開關、視窗（日期軸用天、場次軸用場，各自記住）與常用值。兩張圖共用；每位看的人的選擇
 * 記在 localStorage（讀寫失敗就只在這次有效）。
 */

function readStored(): TrendView {
  try {
    return parseTrendView(window.localStorage.getItem(TREND_VIEW_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_TREND_VIEW };
  }
}

/** 共用的顯示設定，改了就記到 localStorage。 */
export function useTrendView(): [TrendView, (patch: Partial<TrendView>) => void] {
  const [view, setView] = useState<TrendView>(readStored);
  useEffect(() => {
    try {
      window.localStorage.setItem(TREND_VIEW_STORAGE_KEY, JSON.stringify(view));
    } catch {
      // 私密視窗或封鎖了網站資料：只在這次有效
    }
  }, [view]);
  const update = useCallback((patch: Partial<TrendView>) => setView((v) => ({ ...v, ...patch })), []);
  return [view, update];
}

const chip = (on: boolean): string =>
  `rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
    on ? 'border-blue-500 bg-blue-600 text-white' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
  }`;

export default function TrendControls({
  view, onChange, gamesAvailable,
}: { view: TrendView; onChange: (patch: Partial<TrendView>) => void; gamesAvailable: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const unitKey = view.axis === 'date' ? 'days' : 'games';
  const value = view[unitKey];
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const unit = t(view.axis === 'date' ? 'analytics.trendView.unitDays' : 'analytics.trendView.unitGames');
  const commit = (): void => {
    const v = clampWindow(draft, unitKey);
    setDraft(String(v));
    if (v !== value) onChange({ [unitKey]: v });
  };
  const presets = view.axis === 'date' ? DAY_PRESETS : GAME_PRESETS;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-400" role="group" aria-label={t('analytics.trendView.label')} data-testid="trend-controls">
      <span className="inline-flex items-center gap-1.5">
        <span>{t('analytics.trendView.axis')}</span>
        {(['date', 'games'] as const).map((a) => (
          <button
            key={a}
            type="button"
            className={chip(view.axis === a)}
            aria-pressed={view.axis === a}
            disabled={a === 'games' && !gamesAvailable}
            title={a === 'games' && !gamesAvailable ? t('analytics.trendView.gamesUnavailable') : undefined}
            onClick={() => onChange({ axis: a })}
            data-testid={`trend-axis-${a}`}
          >
            {t(a === 'date' ? 'analytics.trendView.byDate' : 'analytics.trendView.byGames')}
          </button>
        ))}
      </span>
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <label className="inline-flex cursor-pointer items-center gap-1">
          <input
            type="checkbox"
            className="accent-blue-500"
            checked={view.smooth}
            onChange={(e) => onChange({ smooth: e.target.checked })}
            data-testid="trend-smooth"
          />
          {t('analytics.trendView.smooth')}
        </label>
        <span className={`inline-flex items-center gap-1 ${view.smooth ? '' : 'opacity-50'}`}>
          <input
            type="number"
            inputMode="numeric"
            min={WINDOW_LIMITS[unitKey][0]}
            max={WINDOW_LIMITS[unitKey][1]}
            value={draft}
            disabled={!view.smooth}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
            aria-label={t('analytics.trendView.windowAria', { unit })}
            className="w-16 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-right tabular-nums text-zinc-100 disabled:cursor-not-allowed"
            data-testid="trend-window"
          />
          <span>{unit}</span>
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              className={chip(view.smooth && value === p)}
              disabled={!view.smooth}
              onClick={() => onChange({ [unitKey]: p })}
            >
              {p}
            </button>
          ))}
        </span>
      </span>
    </div>
  );
}
