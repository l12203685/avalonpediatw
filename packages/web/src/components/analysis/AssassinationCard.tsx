import { motion } from 'framer-motion';
import { Loader, AlertCircle, Crosshair } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { outcomeBlocks, type OutcomeBlock } from '../../services/api';
import { useAnalysisOverview, deriveStages } from './useAnalysisOverview';
import { MetricBlocks, StatTable, OUTCOME_COLORS, type MetricBlockRow, type StatColumn } from './ui';
import { useMinCellGames } from './OutcomeBlocksTable';

/**
 * 刺殺結算卡 (docs/stats/two_stage_outcome.md)：只算三藍局 —
 * 三藍死 = 刺中、三藍活 = 沒刺中。資料用 overview.assassinationStage；
 * 舊快取沒有時以 merlinKillRate (三藍局刺中率) 推算，並標明。
 *
 * (2026-10-14 Edward：三塊結果、條件機率附 n、一頁一屏)
 *   - 卡片下面加 MetricBlocks：全部局從紅方、藍方看的 任務結果 / 刺殺結果 / 遊戲結果，
 *     刺殺那一塊的分母是三藍局 (n 跟上面的卡片一樣)，用 @avalon/shared 的 outcomeBlocks 算。
 *   - AssassinationSeatTable (刺殺分頁的「座位與刺殺」)：梅林、刺客坐在各位置時，三藍局的刺中率
 *     (三藍死 ÷ 三藍局，附三藍局數)，資料是 overview.seatPositionWinRates[].roles[].outcomes；
 *     舊快取沒有各位置的角色結果時顯示「下次每日更新後提供」。
 */
export default function AssassinationCard(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview, loading, error } = useAnalysisOverview();
  const min = useMinCellGames();

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-gray-500">
        <Loader size={14} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }
  if (error || !overview) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-red-400">
        <AlertCircle size={14} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  const stages = deriveStages(overview);
  const legacy = !overview.assassinationStage;
  const killPct = legacy && typeof overview.merlinKillRate === 'number'
    ? overview.merlinKillRate
    : stages.assassination.killPct;
  const survivePct = legacy && typeof overview.merlinKillRate === 'number'
    ? Math.round((100 - overview.merlinKillRate) * 10) / 10
    : stages.assassination.survivePct;
  const { games, merlinKilled, merlinSurvived } = stages.assassination;

  const ob = overview.outcomeBreakdown;
  const blockRows: MetricBlockRow[] = ob
    ? (['red', 'blue'] as const).map(faction => {
      const b = outcomeBlocks(ob, faction);
      return {
        key: faction,
        label: t(`analytics.ui.blocks.${faction}`),
        tone: faction,
        mission: b.mission,
        assassination: b.assassination,
        final: b.final,
      };
    })
    : [];

  return (
    <div className="space-y-3">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <div className="flex items-center gap-2 mb-1">
          <Crosshair size={16} className="text-amber-300" />
          <h3 className="text-sm font-bold text-gray-300">{t('analytics.deep.assassination.title')}</h3>
        </div>
        <p className="text-[10px] text-gray-500 mb-3">{t('analytics.deep.assassination.sub')}</p>

        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="bg-gray-800/40 rounded-lg px-3 py-2">
            <p className="text-xl font-black text-white">{games.toLocaleString()}</p>
            <p className="text-[10px] text-gray-500">{t('analytics.deep.assassination.threeBlueGames')}</p>
          </div>
          <div className="bg-gray-800/40 rounded-lg px-3 py-2">
            <p className="text-xl font-black text-amber-300">{killPct}%</p>
            <p className="text-[10px] text-gray-500">{t('analytics.deep.assassination.killRate')}</p>
            {games > 0 && (
              <p className="text-[10px] text-gray-600">{t('analytics.deep.assassination.killedCount', { count: merlinKilled })}</p>
            )}
          </div>
          <div className="bg-gray-800/40 rounded-lg px-3 py-2">
            <p className="text-xl font-black text-blue-300">{survivePct}%</p>
            <p className="text-[10px] text-gray-500">{t('analytics.deep.assassination.surviveRate')}</p>
            {games > 0 && (
              <p className="text-[10px] text-gray-600">{t('analytics.deep.assassination.survivedCount', { count: merlinSurvived })}</p>
            )}
          </div>
        </div>

        <div className="h-2 w-full rounded-full overflow-hidden flex bg-gray-800">
          <div className="h-full bg-amber-500" style={{ width: `${Math.max(0, Math.min(100, killPct))}%` }} />
          <div className="h-full bg-blue-500" style={{ width: `${Math.max(0, Math.min(100, survivePct))}%` }} />
        </div>
        <div className="flex justify-between text-[10px] text-gray-500 mt-1">
          <span className="text-amber-300">{t('analytics.deep.outcomes.threeBlueDead')}</span>
          <span className="text-blue-300">{t('analytics.deep.outcomes.threeBlueAlive')}</span>
        </div>

        <p className="text-[10px] text-gray-600 mt-2">{t('analytics.deep.assassination.rule')}</p>
        {legacy && (
          <p className="text-[10px] text-gray-600 mt-0.5">{t('analytics.deep.assassination.legacy')}</p>
        )}
      </motion.div>

      {blockRows.length > 0 && (
        <MetricBlocks
          caption={<span className="text-xs">{t('analytics.r6.tabsa.assassination.blocksCaption')}</span>}
          rows={blockRows}
          lowSample={min}
          groupLabel={t('analytics.r6.tabsa.assassination.side')}
        />
      )}
    </div>
  );
}

interface SeatKillRow {
  key: string;
  label: string;
  reference?: boolean;
  merlin: OutcomeBlock | null;
  assassin: OutcomeBlock | null;
}

/** 刺殺 › 座位與刺殺：梅林／刺客坐在各位置時，三藍局的刺中率 (附三藍局數)。 */
export function AssassinationSeatTable(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview, loading, error } = useAnalysisOverview();
  const min = useMinCellGames();
  const k = 'analytics.r6.tabsa.assassination';

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-gray-500">
        <Loader size={14} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }
  if (error || !overview) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-red-400">
        <AlertCircle size={14} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  const kill = (outcomes: Parameters<typeof outcomeBlocks>[0] | undefined): OutcomeBlock | null =>
    (outcomes ? outcomeBlocks(outcomes, 'red').assassination : null);
  const seats = [...(overview.seatPositionWinRates ?? [])].sort((a, b) => Number(a.seat) - Number(b.seat));
  const seatRows: SeatKillRow[] = seats.map(s => ({
    key: s.seat,
    label: t(`${k}.seatLabel`, { seat: s.seat }),
    merlin: kill(s.roles?.find(r => r.role === '梅林')?.outcomes),
    assassin: kill(s.roles?.find(r => r.role === '刺客')?.outcomes),
  }));
  const hasData = seatRows.some(r => r.merlin && r.merlin.n > 0);
  if (!hasData) {
    return (
      <p className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-6 text-center text-xs text-zinc-500">
        {t(`${k}.seatMissing`)}
      </p>
    );
  }
  const overall = overview.outcomeBreakdown ? outcomeBlocks(overview.outcomeBreakdown, 'red').assassination : null;
  const rows: SeatKillRow[] = overall
    ? [{ key: 'all', label: t(`${k}.allThreeBlue`), reference: true, merlin: overall, assassin: overall }, ...seatRows]
    : seatRows;

  const killColumn = (key: 'merlin' | 'assassin'): StatColumn<SeatKillRow> => ({
    key,
    label: (
      <span className="inline-flex flex-col items-end gap-0.5">
        <span className="text-[11px] font-semibold text-zinc-300">{t(`${k}.${key}Seat`)}</span>
        <span className="text-[10px] font-normal text-zinc-500">{t(`${k}.seatRule`)}</span>
      </span>
    ),
    title: t(`${k}.${key}SeatTitle`),
    align: 'right',
    format: 'pct',
    value: r => r[key]?.win,
    n: r => r[key]?.n,
    lowSample: min,
    tone: 'amber',
    bar: { color: OUTCOME_COLORS.三藍死 },
  });

  return (
    <StatTable
      caption={t(`${k}.seatCaption`)}
      columns={[
        { key: 'label', label: t(`${k}.seat`), value: r => r.label },
        killColumn('merlin'),
        killColumn('assassin'),
      ]}
      rows={rows}
      rowKey={r => r.key}
      highlightRow={r => r.reference === true}
      footnote={<>{t(`${k}.seatNote`)} {t('analytics.r6.tabsa.outcomeTable.lowSample', { min })}</>}
    />
  );
}
