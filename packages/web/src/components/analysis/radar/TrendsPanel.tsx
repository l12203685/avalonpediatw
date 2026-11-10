import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AnalysisApiError,
  fetchPlayerTheoryTrend,
  getErrorMessage,
  isAnalysisNotGenerated,
  isAnalysisRouteMissing,
  type PlayerTheoryTrendData,
} from '../../../services/api';
import EloPanel from './EloPanel';
import TheoryTrendPanel, { type TheoryTrendState } from './TheoryTrendPanel';
import TrendControls, { useTrendView } from './TrendControls';
import { trendWindow } from './trendSeries';

/**
 * 玩家雷達 >「Elo／理論走勢」小分頁：上方一列共用的顯示設定（X 軸 日期／場次、移動平均與視窗，TrendControls），
 * 下面 Elo 走勢與理論勝率走勢（寬螢幕並排、手機上下）。理論走勢在這裡拿（/theory-trend/:name），每場的 Elo 也在裡面，
 * 所以場次軸的 Elo 用它；日期軸的 Elo 仍是 EloPanel 自己拿的 /rating/:name。
 * 舊快取沒有每場的點（theoryTrend 第 1 版）時，場次鈕停用，記住的「場次」先照日期畫。
 */
export default function TrendsPanel({ name }: { name: string }): JSX.Element {
  const { t } = useTranslation('common');
  const [view, setView] = useTrendView();
  const [trend, setTrend] = useState<TheoryTrendState>({ status: 'loading', data: null });

  useEffect(() => {
    if (!name) return;
    let stale = false;
    setTrend((s) => ({ status: 'loading', data: s.data }));
    fetchPlayerTheoryTrend(name)
      .then((d: PlayerTheoryTrendData) => { if (!stale) setTrend({ status: 'ok', data: d }); })
      .catch((err) => {
        if (stale) return;
        if (err instanceof AnalysisApiError && err.status === 404 && /not found/i.test(err.serverError ?? '')) setTrend({ status: 'notFound', data: null });
        else if (isAnalysisNotGenerated(err) || isAnalysisRouteMissing(err)) setTrend({ status: 'notGenerated', data: null });
        else setTrend({ status: 'error', data: null, error: getErrorMessage(err) });
      });
    return (): void => { stale = true; };
  }, [name]);

  const games = trend.data?.games ?? null;
  const gamesAvailable = Boolean(games && games.days.length);
  const effective = view.axis === 'games' && !gamesAvailable ? { ...view, axis: 'date' as const } : view;
  const unit = t(effective.axis === 'date' ? 'analytics.trendView.unitDays' : 'analytics.trendView.unitGames');
  return (
    <div className="space-y-2" data-testid="trends-panel">
      <TrendControls view={view} onChange={setView} gamesAvailable={gamesAvailable} />
      <div className="grid gap-4 lg:grid-cols-2">
        <EloPanel name={name} view={effective} perGame={games} />
        <TheoryTrendPanel trend={trend} view={effective} />
      </div>
      {(effective.smooth || effective.axis === 'games') && (
        <p className="text-[11px] text-zinc-500">
          {effective.axis === 'games' && t('analytics.trendView.noteGames')}
          {effective.axis === 'games' && effective.smooth && ' '}
          {effective.smooth && t('analytics.trendView.note', { window: trendWindow(effective), unit })}
        </p>
      )}
    </div>
  );
}
