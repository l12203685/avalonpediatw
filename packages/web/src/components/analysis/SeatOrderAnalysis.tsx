import { useState, useEffect } from 'react';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisSeatOrder, getErrorMessage, outcomeBlocks, theorySettings } from '../../services/api';
import type { OutcomeBlocks, SeatOrderData, SeatOrderPermutation } from '../../services/api';
import { useAnalysisOverview } from './useAnalysisOverview';
import { blockValues, useIsWide } from './seatRoleBlocks';
import { MetricBlocks, StatTable, formatRate, type MetricBlockRow, type StatColumn } from './ui';

/**
 * 派/梅/娜順序分析 — Edward 2026-04-26 spec；(2026-10-14 Edward：「用條件機率」「能用表格就不用圖」「一頁一屏」)
 *
 * 六種順序各一列，三塊結果 (紅方視角，藍方 = 100% − 同一格，n 相同)：
 *   任務結果 = 三紅 / 該順序全部局；刺殺結果 = 三藍死 / 該順序打到三藍的局 (刺中率)；
 *   遊戲結果 = (三紅 + 三藍死) / 全部局。比率由 @avalon/shared 的 outcomeBlocks 算。
 * 舊版的「梅林擊殺率」(快取 merlinKillRate) 其實是 三藍死 / 全部局 (含三紅局)，不是刺中率，不再顯示；
 * 每種順序一張三種結果占比的卡片 + 堆疊長條圖也拿掉 (同樣的數字，表格一眼比完六種)。
 * 穿插表 (快取有 穿插紅勝率 時) 只有任務結果的紅勝率 (快取 red_win = 三紅)，附各自的 n；
 * 結論改成依資料算出來的一行 (舊版寫死「~41%」「~48%」)。
 */
type Perm = SeatOrderPermutation;

function counts(p: Perm): { 三紅: number; 三藍死: number; 三藍活: number } {
  return { 三紅: p['三紅'], 三藍死: p['三藍梅死'], 三藍活: p['三藍梅活'] };
}

function extremes(perms: readonly Perm[], pick: (b: OutcomeBlocks) => number | null): { low: Perm; high: Perm; lowV: number; highV: number } | null {
  let low: Perm | null = null; let high: Perm | null = null;
  let lowV = Infinity; let highV = -Infinity;
  for (const p of perms) {
    const v = pick(outcomeBlocks(counts(p), 'red'));
    if (typeof v !== 'number') continue;
    if (v < lowV) { lowV = v; low = p; }
    if (v > highV) { highV = v; high = p; }
  }
  return low && high ? { low, high, lowV, highV } : null;
}

export default function SeatOrderAnalysis(): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<SeatOrderData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { overview } = useAnalysisOverview();
  const minCell = theorySettings(overview?.theoryConfig).theoryMinCellGames;
  const wide = useIsWide();

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        const d = await fetchAnalysisSeatOrder();
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
      <div className="flex items-center justify-center py-12 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.seatOrder.loading')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-12 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  if (data.permutations.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        {t('analytics.deep.seatOrder.noData')}
      </div>
    );
  }

  const perms = data.permutations;
  const total = perms.reduce(
    (acc, p) => {
      const c = counts(p);
      return { 三紅: acc.三紅 + c.三紅, 三藍死: acc.三藍死 + c.三藍死, 三藍活: acc.三藍活 + c.三藍活 };
    },
    { 三紅: 0, 三藍死: 0, 三藍活: 0 },
  );
  const lowSample = minCell > 0 ? minCell : undefined;
  const rows: MetricBlockRow[] = [
    ...perms.map(p => ({ key: p.order, label: p.order, tone: 'red' as const, ...blockValues(outcomeBlocks(counts(p), 'red')) })),
    { key: 'all', label: t('analytics.r6.tabsb.order.all'), ...blockValues(outcomeBlocks(total, 'red')) },
  ];

  // The raw-牌譜 rebuild (61b7398) carries no interleave red-win split, so the
  // interleave table only renders when the cache actually has it.
  const hasInterleave = perms.some(p => p['穿插紅勝率'] !== undefined);
  const interleaveColumns: StatColumn<Perm>[] = [
    { key: 'order', label: t('analytics.deep.seatOrder.permCol') },
    { key: '穿插率', label: t('analytics.deep.seatOrder.interleaveRateCol'), format: 'pct', n: 'total', lowSample },
    {
      key: '穿插紅勝率', label: t('analytics.r6.tabsb.order.interleaveRed'), format: 'pct', tone: 'red',
      n: p => p['穿插任務'], lowSample,
    },
    {
      key: '無穿插紅勝率', label: t('analytics.r6.tabsb.order.noInterleaveRed'), format: 'pct', tone: 'red',
      n: p => p.total - p['穿插任務'], lowSample,
    },
    { key: 'redWinRate', label: t('analytics.r6.tabsb.order.overallRed'), format: 'pct', tone: 'red', n: 'total', emphasis: true },
  ];

  const killRange = extremes(perms, b => b.assassination.win);
  const missionRange = extremes(perms, b => b.mission.win);

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-zinc-500">
        {t('analytics.r6.tabsb.order.sub', { games: data.totalGames })}
      </p>
      <div className={`grid grid-cols-1 gap-3 ${hasInterleave ? 'lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]' : ''}`}>
        <MetricBlocks
          rows={rows}
          caption={t('analytics.r6.tabsb.order.blocksTitle')}
          groupLabel={t('analytics.deep.seatOrder.permCol')}
          showRules={wide}
          lowSample={lowSample}
          footnote={t('analytics.r6.tabsb.order.blocksNote')}
        />
        {hasInterleave && (
          <StatTable
            caption={t('analytics.deep.seatOrder.interleaveTitle')}
            columns={interleaveColumns}
            rows={perms}
            rowKey={p => p.order}
            footnote={
              <>
                {t('analytics.deep.seatOrder.interleaveSub')}{' '}
                {t('analytics.r6.tabsb.order.interleaveNote')}
              </>
            }
          />
        )}
      </div>
      {killRange && missionRange && (
        <p className="text-xs text-zinc-300">
          {t('analytics.r6.tabsb.order.summary', {
            killLow: killRange.low.order, killLowV: formatRate(killRange.lowV), killLowN: outcomeBlocks(counts(killRange.low), 'red').assassination.n,
            killHigh: killRange.high.order, killHighV: formatRate(killRange.highV), killHighN: outcomeBlocks(counts(killRange.high), 'red').assassination.n,
            redLow: missionRange.low.order, redLowV: formatRate(missionRange.lowV), redLowN: missionRange.low.total,
            redHigh: missionRange.high.order, redHighV: formatRate(missionRange.highV), redHighN: missionRange.high.total,
          })}
        </p>
      )}
    </div>
  );
}
