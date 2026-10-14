import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { theorySettings, outcomeBlocks } from '../../services/api';
import { useAnalysisOverview } from './useAnalysisOverview';
import {
  PLAYER_SEAT_KEYS, playerSeatGameBlocks, playerSeatGames, playerSeatRate, seatFactionCounts, seatNumber,
  useAnalysisPlayerRows, useIsWide, type PlayerWithSeatStats, type SeatMode,
} from './seatRoleBlocks';
import { SectionTabs, StatTable, formatRate, type SectionTabItem, type StatColumn } from './ui';

/** 30 場以上的玩家才列 (同舊版)；最多 25 位 (快取 players 依場數排序)。 */
const MIN_PLAYER_GAMES = 30;
const MAX_ROWS = 25;

function colorForDeviation(deviation: number): string {
  if (deviation >= 8)  return 'bg-green-600/80 text-green-100';
  if (deviation >= 3)  return 'bg-green-700/60 text-green-200';
  if (deviation >= -3) return 'bg-gray-600/60 text-gray-200';
  if (deviation >= -8) return 'bg-red-700/60 text-red-200';
  return 'bg-red-600/80 text-red-100';
}

/**
 * 玩家 × 位置 — Edward 2026-04-26 + 2026-04-27；(2026-10-14 Edward：「用條件機率」「每個數字附 n」「一頁一屏」)
 *
 * 每格 = 這位玩家坐這個位置時「自己陣營」的任務結果勝率 (三紅＝紅勝、三藍＝藍勝；快取 seatWinRates /
 * seatRedWinRates / seatBlueWinRates) + n (players[].roleSeatStats 加總)，可切 全部 / 當紅方 / 當藍方。
 * 顏色 = 與全體在這個位置 (同一陣營) 的任務結果勝率的差；n 不到補值門檻 (theoryMinCellGames，讀快取)
 * 不上色並變淡。舊版把 n = 0 和 0% 混在一起 (都顯示「-」)，現在有 n 就分得開。
 *
 * 刺殺結果與遊戲結果要分陣營的三藍死／三藍活局數，玩家 × 位置的快取沒有 (seatOutcomes 紅藍混在一起)，
 * 所以表格只放任務結果；滑鼠移到格子上另列「坐這裡的全部對局」的條件比率 (seatOutcomes：
 * 三紅率 n = 全部、三藍局刺中率 n = 三藍局)，取代舊版的三種結果占全部對局的比例。
 * 表格在自己的容器裡上下／左右捲，整頁不拉長。
 */
export default function SeatHeatmap(): JSX.Element {
  const { t } = useTranslation('common');
  const { players, loading, error } = useAnalysisPlayerRows();
  const { overview } = useAnalysisOverview();
  // 表格在自己的容器裡捲：桌機留給頁面外框後約 19rem，手機頁面可到 1.5 屏，給 60vh。
  const wide = useIsWide();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.seat.loading')}
      </div>
    );
  }

  const rows = (players ?? []).filter(p => p.totalGames >= MIN_PLAYER_GAMES).slice(0, MAX_ROWS);
  if (error || rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || t('analytics.deep.seat.noData')}
      </div>
    );
  }

  const minCell = theorySettings(overview?.theoryConfig).theoryMinCellGames;
  const factionSeats = seatFactionCounts(overview);
  /** 全體在這個位置的任務結果勝率 (players[] 的座位鍵)；算不出來時 null = 不上色。 */
  const reference = (seat: string, mode: SeatMode): number | null => {
    const label = seatNumber(seat);
    if (mode === 'all') {
      const v = overview?.seatPositionWinRates?.find(s => String(s.seat) === label)?.overallWinRate;
      return typeof v === 'number' ? v : null;
    }
    const counts = factionSeats?.find(s => s.seat === label)?.[mode];
    return counts ? outcomeBlocks(counts, mode).mission.win : null;
  };

  const modeItems: SectionTabItem<SeatMode>[] = [
    { id: 'all', label: t('analytics.r6.tabsb.heatmap.modeAll') },
    { id: 'red', label: t('analytics.r6.tabsb.heatmap.modeRed') },
    { id: 'blue', label: t('analytics.r6.tabsb.heatmap.modeBlue') },
  ];

  const modeGames = (p: PlayerWithSeatStats, mode: SeatMode): number | null => {
    const v = mode === 'red' ? p.rawRedGames : mode === 'blue' ? p.rawBlueGames : p.totalGames;
    return typeof v === 'number' ? v : null;
  };

  const renderTable = (mode: SeatMode): JSX.Element => {
    const seatColumn = (seat: string): StatColumn<PlayerWithSeatStats> => {
      const ref = reference(seat, mode);
      const seatLabel = t('analytics.r6.tabsb.seats.seatLabel', { n: seatNumber(seat) });
      return {
        key: `seat-${seat}`,
        label: seatLabel,
        align: 'right',
        value: (p): number | null => {
          const n = playerSeatGames(p, seat, mode);
          // 有 n：0 場顯示「—」；沒有 n (舊快取)：比率 0 當作沒打過 (舊版行為)。
          if (n === 0) return null;
          const rate = playerSeatRate(p, seat, mode);
          return n === null && rate === 0 ? null : rate;
        },
        n: (p): number | null => {
          const n = playerSeatGames(p, seat, mode);
          return n === 0 ? null : n;
        },
        lowSample: minCell > 0 ? minCell : undefined,
        format: (v, p): JSX.Element => {
          if (typeof v !== 'number') return <span className="text-zinc-600">—</span>;
          const n = playerSeatGames(p, seat, mode);
          const thin = n !== null && minCell > 0 && n < minCell;
          const colour = ref !== null && !thin ? colorForDeviation(v - ref) : 'bg-zinc-800/60 text-zinc-300';
          const games = playerSeatGameBlocks(p, seat, 'red');
          const parts = [
            t('analytics.r6.tabsb.heatmap.cellTitle', {
              name: p.name, seat: seatLabel, mode: t(`analytics.r6.tabsb.heatmap.mode${mode === 'all' ? 'All' : mode === 'red' ? 'Red' : 'Blue'}`),
              rate: formatRate(v), n: n ?? '—', ref: formatRate(ref),
            }),
          ];
          if (games && games.mission.n > 0) {
            parts.push(t('analytics.r6.tabsb.heatmap.cellGames', {
              threeRed: formatRate(games.mission.win), n: games.mission.n,
              kill: formatRate(games.assassination.win), nBlue: games.assassination.n,
            }));
          }
          return (
            <span title={parts.join('\n')} className={`inline-block min-w-[2.6rem] rounded px-1 text-center font-bold ${colour}`}>
              {v.toFixed(1)}
            </span>
          );
        },
      };
    };

    const columns: StatColumn<PlayerWithSeatStats>[] = [
      { key: 'name', label: t('analytics.deep.seat.playerCol') },
      {
        key: 'games',
        label: t('analytics.r6.tabsb.heatmap.gamesCol'),
        format: 'int',
        value: p => modeGames(p, mode),
        className: 'text-zinc-500',
      },
      ...PLAYER_SEAT_KEYS.map(seatColumn),
    ];

    return (
      <StatTable
        columns={columns}
        rows={rows}
        rowKey={p => p.name}
        maxHeight={wide ? 'min(19rem, 52vh)' : '60vh'}
        footnote={
          <>
            {t('analytics.r6.tabsb.heatmap.note', { min: MIN_PLAYER_GAMES, max: MAX_ROWS })}
            {minCell > 0 && <> {t('analytics.ui.blocks.lowSampleNote', { min: minCell })}</>}
            {' '}{t('analytics.r6.tabsb.heatmap.noteBlocks')}
          </>
        }
      />
    );
  };

  return (
    <SectionTabs
      items={modeItems}
      persistKey="analysis.position.heatmapMode"
      ariaLabel={t('analytics.r6.tabsb.heatmap.modeLabel')}
    >
      {renderTable}
    </SectionTabs>
  );
}

