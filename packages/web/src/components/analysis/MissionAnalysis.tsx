import { useState, useEffect } from 'react';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisMissions, getErrorMessage } from '../../services/api';
import type { MissionAnalysisData } from '../../services/api';
import { SectionTabs, StatTable, OUTCOME_COLORS, type StatColumn } from './ui';
import OutcomeBlocksTable, { useMinCellGames, type OutcomeGroup } from './OutcomeBlocksTable';
import { useAnalysisOverview } from './useAnalysisOverview';

/**
 * 任務分析 — Edward 2026-04-26 spec
 *
 * The mission pass-rate chart stays as-is (it's about missions, not game
 * outcomes). The "任務結果與最終勝負關聯" table now expands the final result
 * into three outcomes (三紅 / 三藍死 / 三藍活) instead of collapsing the blue
 * win into a single bar.
 *
 * (2026-10-14 Edward：一頁一屏、能用表格就不用圖、比率要用條件機率並附 n)
 *   - 兩張長條圖 (通過率、失敗票分布) 合成一張數字表：每輪 n = 打到這一輪的局數、通過率、
 *     1 張／2+ 張失敗的比例。五個數字的高低一眼就看得出來，長條圖沒有多說什麼。
 *   - 「任務結果 → 結局」從八組堆疊長條改成 OutcomeBlocksTable：第 k 輪通過／失敗的局裡
 *     任務結果 (三紅率)、刺殺結果 (三藍死 ÷ 三藍局，附三藍局數)、遊戲結果 (紅方最終勝)，
 *     最上面一列是全部局當對照。舊的「三藍死 %」除以全部局，不是刺殺成功率。
 *   - 兩張表用 SectionTabs 分成兩頁，桌機一頁一屏。
 *   - 「通過」沿用快取口徑：該輪 0 張失敗票 (generate_cache.py compute_missions)；表下註明。
 */

type MissionView = 'pass' | 'outcome';

interface PassRow {
  round: number;
  n: number;
  passRate: number | null;
  oneFail: number | null;
  twoFail: number | null;
}

export default function MissionAnalysis(): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<MissionAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { overview } = useAnalysisOverview();
  const min = useMinCellGames();
  const k = 'analytics.r6.tabsa.missions';

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        const d = await fetchAnalysisMissions();
        if (!cancelled) setData(d);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return (): void => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.mission.loading')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  const share = (part: number, total: number): number | null => (total > 0 ? (part / total) * 100 : null);
  const passRows: PassRow[] = (data.missionPassRates ?? []).map(m => {
    const dist = (data.missionOutcomeByRound ?? []).find(o => o.round === m.round);
    return {
      round: m.round,
      n: m.totalGames,
      passRate: m.passRate,
      oneFail: dist ? share(dist.oneFail, dist.total) : null,
      twoFail: dist ? share(dist.twoFail, dist.total) : null,
    };
  });

  const passColumns: StatColumn<PassRow>[] = [
    { key: 'round', label: t(`${k}.round`), value: r => t('analytics.deep.mission.missionLabel', { round: r.round }) },
    { key: 'n', label: t(`${k}.reached`), title: t(`${k}.reachedTitle`), format: 'int', className: 'text-zinc-400' },
    {
      key: 'passRate', label: t(`${k}.passRate`), title: t(`${k}.passRateTitle`), format: 'pct', emphasis: true,
      bar: { color: '#22c55e' }, lowSample: min, n: r => (r.n < min ? r.n : null),
    },
    { key: 'oneFail', label: t('analytics.deep.mission.fail1'), format: 'pct', bar: { color: OUTCOME_COLORS.三藍死 } },
    { key: 'twoFail', label: t('analytics.deep.mission.fail2'), format: 'pct', bar: { color: OUTCOME_COLORS.三紅 } },
  ];

  const corr = (data.missionOutcomeCorrelation ?? []).filter(c => c.round <= 4);
  const groups: OutcomeGroup[] = [];
  if (overview?.outcomeBreakdown) {
    groups.push({ key: 'all', label: t('analytics.r6.tabsa.outcomeTable.all'), counts: overview.outcomeBreakdown, reference: true });
  }
  for (const c of corr) {
    groups.push(
      { key: `p${c.round}`, label: t(`${k}.passed`, { round: c.round }), counts: c.passedOutcomes, tone: 'blue' },
      { key: `f${c.round}`, label: t(`${k}.failed`, { round: c.round }), counts: c.failedOutcomes, tone: 'red' },
    );
  }

  const items = [
    { id: 'pass' as MissionView, label: t(`${k}.tabs.pass`) },
    { id: 'outcome' as MissionView, label: t(`${k}.tabs.outcome`) },
  ];

  return (
    <SectionTabs items={items} persistKey="analysis.missions" ariaLabel={t('analytics.analysis.tabs.missions')}>
      {(view) => (view === 'pass' ? (
        <StatTable
          caption={t(`${k}.passCaption`)}
          columns={passColumns}
          rows={passRows}
          rowKey={r => String(r.round)}
          footnote={t(`${k}.passNote`)}
        />
      ) : corr.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-6 text-center text-xs text-zinc-500">
          {t(`${k}.noCorrelation`)}
        </p>
      ) : (
        <OutcomeBlocksTable
          caption={t(`${k}.outcomeCaption`)}
          rows={groups}
          groupLabel={t(`${k}.group`)}
          footnote={t(`${k}.outcomeNote`)}
        />
      ))}
    </SectionTabs>
  );
}
