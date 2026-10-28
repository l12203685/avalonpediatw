import { useState, useEffect } from 'react';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisChemistry, getErrorMessage, outcomeBlocks, theorySettings } from '../../services/api';
import type { ChemistryData, ChemistryMatrix as ChemistryMatrixType } from '../../services/api';
import { isThinPairCell } from '../../utils/analysisDisplay';
import { useAnalysisOverview } from './useAnalysisOverview';
import { pairOutcomeCounts } from './seatRoleBlocks';
import { SectionTabs, Term, formatRate, useSectionTab, type MetricBlockKey, type SectionTabItem, type StatTermKey } from './ui';
import NotFilteredNote from './filter/NotFilteredNote';

type MatrixKey = 'coWin' | 'coLose' | 'winCorr' | 'coWinMinusLose' | 'outcomePair';

const MATRIX_KEYS: MatrixKey[] = ['coWin', 'coLose', 'winCorr', 'coWinMinusLose', 'outcomePair'];

/** 矩陣名稱的名詞說明 (Term)；三結果配對沒有。 */
const MATRIX_TERM: Partial<Record<MatrixKey, StatTermKey>> = {
  coWin: 'coWin', coLose: 'coWin', winCorr: 'winCorr', coWinMinusLose: 'coWinMinusLose',
};
const BLOCKS: readonly MetricBlockKey[] = ['mission', 'assassination', 'final'];

/** 三結果配對：與全體同一塊的差 (百分點)，正 = 紅方較好。 */
function colorForPairDeviation(deviation: number): string {
  if (deviation >= 10)  return 'bg-red-500/70 text-red-100';
  if (deviation >= 5)   return 'bg-red-700/50 text-red-200';
  if (deviation > -5)   return 'bg-gray-700/40 text-gray-300';
  if (deviation > -10)  return 'bg-blue-700/50 text-blue-200';
  return 'bg-blue-500/70 text-blue-100';
}

/** 三結果配對：共同場次太少的格子 (isThinPairCell) 不上紅藍色，灰字虛線框。 */
// 不用 opacity：會連滑鼠提示一起變淡。
const THIN_PAIR_CELL = 'bg-gray-900/30 text-gray-500 border border-dashed border-gray-700';

function cellColor(value: number, key: MatrixKey): string {
  if (isNaN(value)) return 'bg-gray-900/30 text-gray-700';

  // 同隊贏 / 同隊輸 are game counts, not rates: no scale.
  if (key === 'coWin' || key === 'coLose') return 'bg-gray-800/40 text-gray-300';

  // 我贏時他也贏 = 同隊贏 ÷ 我的勝場 (0–100, never negative): mostly how often the two play on one team.
  if (key === 'winCorr') {
    if (value >= 30) return 'bg-green-500/70 text-green-100';
    if (value >= 20) return 'bg-green-700/50 text-green-200';
    if (value >= 10) return 'bg-gray-700/40 text-gray-300';
    return 'bg-gray-900/30 text-gray-500';
  }

  if (key === 'coWinMinusLose') {
    if (value >= 15)  return 'bg-green-500/70 text-green-100';
    if (value >= 5)   return 'bg-green-700/50 text-green-200';
    if (value >= -5)  return 'bg-gray-700/40 text-gray-300';
    if (value >= -15) return 'bg-red-700/50 text-red-200';
    return 'bg-red-500/70 text-red-100';
  }

  if (value >= 60) return 'bg-blue-500/70 text-blue-100';
  if (value >= 50) return 'bg-blue-700/50 text-blue-200';
  if (value >= 40) return 'bg-gray-700/40 text-gray-300';
  if (value >= 30) return 'bg-purple-700/50 text-purple-200';
  return 'bg-purple-500/70 text-purple-100';
}

/**
 * 默契矩陣 — Edward 2026-04-26 + 2026-04-27
 *
 * The original 4 matrices (coWin / coLose / winCorr / coWinMinusLose) stay
 * unchanged. Edward 2026-04-27: a 5th matrix ``outcomePair`` from each pair's
 * co-played games. Hidden when the cache predates the field.
 *
 * (2026-10-14 Edward：「用條件機率」「每個數字附 n」「一頁一屏」)
 *  - 三結果配對不再顯示「三紅占全部共同場次」：改成三塊結果 (紅方視角，藍方 = 100% − 同一格)，
 *    用小分頁切 任務結果 (三紅 / 共同場次) / 刺殺結果 (三藍死 / 共同的三藍局 = 刺中率) /
 *    遊戲結果 ((三紅 + 三藍死) / 共同場次)。局數由快取的 % 與共同場數還原 (pairOutcomeCounts，
 *    兩份快取每格都精確)，比率由 @avalon/shared 的 outcomeBlocks 算；顏色 = 與全體同一塊的差。
 *    這一塊的 n 不到補值門檻 (theoryMinCellGames，讀快取) 的格子不上色、虛線框 —— 刺殺的 n 比共同場次少。
 *  - 矩陣切換改用 SectionTabs (三塊切換放同一列)，說明縮成一行，矩陣在自己的容器裡上下／左右捲 (表頭與名字固定)，
 *    整頁不拉長；滑鼠提示改用 title (不會被捲動容器切掉)。
 */
export default function ChemistryMatrixPanel(): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<ChemistryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { overview } = useAnalysisOverview();
  const minPairGames = theorySettings(overview?.theoryConfig).theoryMinCellGames;

  // outcomePair only when counted from the game log (`source: 'games'`); older caches held the
  // overall split in every cell (45.5 % everywhere; 2026-10-13 players' report).
  const hasMatrix = (k: MatrixKey): boolean =>
    !!data && (k === 'outcomePair' ? data.outcomePair?.source === 'games' : Boolean(data[k]));
  const matrixItems: SectionTabItem<MatrixKey>[] = MATRIX_KEYS.filter(hasMatrix).map(k => ({
    id: k,
    label: t(`analytics.deep.chemistry.matrices.${k}`),
  }));
  const blockItems: SectionTabItem<MetricBlockKey>[] = BLOCKS.map(b => ({ id: b, label: t(`analytics.ui.blocks.${b}`) }));
  // 兩排小分頁 (矩陣、三結果配對的哪一塊) 放同一列，記住上次選的。
  const [matrixKey, setMatrixKey] = useSectionTab(matrixItems, {
    defaultValue: 'coWinMinusLose', persistKey: 'analysis.roles.chemistryMatrix',
  });
  const [block = 'mission', setBlock] = useSectionTab(blockItems, { persistKey: 'analysis.roles.chemistryBlock' });

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        const chem = await fetchAnalysisChemistry();
        if (!cancelled) setData(chem);
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
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.chemistry.loading')}
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

  if (matrixItems.length === 0 || matrixKey === undefined) {
    return <div className="py-12 text-center text-gray-500">{t('analytics.deep.chemistry.noData')}</div>;
  }
  const baseline = overview?.outcomeBreakdown ? outcomeBlocks(overview.outcomeBreakdown, 'red') : null;

  const renderMatrix = (key: MatrixKey, block: MetricBlockKey): JSX.Element => {
    const matrix = data[key] as ChemistryMatrixType | undefined;
    if (!matrix || matrix.players.length === 0) {
      return <div className="py-12 text-center text-gray-500">{t('analytics.deep.chemistry.noData')}</div>;
    }
    const { players, values } = matrix;
    const rowLabels: string[] = matrix.rowLabels && matrix.rowLabels.length > 0 ? matrix.rowLabels : players;
    const isPair = key === 'outcomePair';
    const ref = baseline?.[block].win ?? null;

    return (
      <div className="overflow-auto overscroll-contain max-h-[min(26rem,60vh)] sm:max-h-[19rem] rounded-xl border border-gray-700 bg-avalon-card/30 p-1">
        <table className="text-[10px] border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 bg-avalon-card p-1" />
              {players.map((name, i) => (
                <th
                  key={i}
                  className="sticky top-0 z-10 bg-avalon-card text-gray-400 font-semibold whitespace-nowrap"
                  style={{ height: 72, verticalAlign: 'bottom', padding: 2 }}
                >
                  <span className="inline-block" style={{ transform: 'rotate(-90deg)', transformOrigin: 'center', whiteSpace: 'nowrap' }}>
                    {name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowLabels.map((rowName, ri) => (
              <tr key={ri}>
                <th scope="row" className="sticky left-0 z-10 bg-avalon-card px-2 py-0.5 text-left text-gray-300 font-semibold whitespace-nowrap">
                  {rowName}
                </th>
                {values[ri]?.map((rawVal, ci) => {
                  const isSelf = rowLabels[ri] === players[ci];
                  let val = rawVal == null ? NaN : rawVal;
                  let title = '';
                  let colour = '';
                  if (isPair && !isSelf) {
                    const c = pairOutcomeCounts(matrix, ri, ci);
                    const b = c ? outcomeBlocks(c, 'red') : null;
                    const cell = b?.[block];
                    val = typeof cell?.win === 'number' ? cell.win : NaN;
                    const thin = !isNaN(val) && isThinPairCell(cell?.n, minPairGames);
                    colour = thin ? THIN_PAIR_CELL : isNaN(val) || ref === null ? cellColor(NaN, key) : colorForPairDeviation(val - ref);
                    if (b) {
                      title = t('analytics.r6.tabsb.chemistry.pairTitle', {
                        row: rowName, col: players[ci], games: b.mission.n,
                        mission: formatRate(b.mission.win), assassination: formatRate(b.assassination.win), nBlue: b.assassination.n,
                        final: formatRate(b.final.win),
                      });
                    }
                  } else if (!isSelf && !isNaN(val)) {
                    colour = cellColor(val, key);
                    title = `${rowName} × ${players[ci]}: ${val.toFixed(1)}`;
                  }
                  return (
                    <td key={ci} className="p-0.5">
                      <div
                        title={title || undefined}
                        className={`w-8 h-6 flex items-center justify-center rounded text-[9px] font-bold cursor-default ${
                          isSelf ? 'bg-gray-800/60 text-gray-600' : colour || cellColor(NaN, key)
                        }`}
                      >
                        {isSelf ? '-' : isNaN(val) ? '' : val.toFixed(0)}
                      </div>
                    </td>
                  );
                }) ?? null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const legend = (key: MatrixKey): JSX.Element => {
    if (key === 'coWin' || key === 'coLose') {
      return <span className="text-gray-400">{t('analytics.deep.chemistry.labelCount')}</span>;
    }
    if (key === 'winCorr') {
      return (
        <>
          <span className="text-green-400">{t('analytics.deep.chemistry.labelShareHigh')}</span>
          <span className="text-gray-400">{t('analytics.deep.chemistry.labelShareMid')}</span>
          <span className="text-gray-500">{t('analytics.deep.chemistry.labelShareLow')}</span>
        </>
      );
    }
    if (key === 'coWinMinusLose') {
      return (
        <>
          <span className="text-green-400">{t('analytics.deep.chemistry.labelHigh')}</span>
          <span className="text-gray-400">{t('analytics.deep.chemistry.labelMid')}</span>
          <span className="text-red-400">{t('analytics.deep.chemistry.labelLow')}</span>
        </>
      );
    }
    if (key === 'outcomePair') {
      return (
        <>
          <span className="text-red-400">{t('analytics.r6.tabsb.chemistry.legendRed')}</span>
          <span className="text-gray-400">{t('analytics.r6.tabsb.chemistry.legendMid')}</span>
          <span className="text-blue-400">{t('analytics.r6.tabsb.chemistry.legendBlue')}</span>
          {minPairGames > 0 && <span className="text-gray-500">{t('analytics.r6.tabsb.chemistry.legendThin', { n: minPairGames })}</span>}
        </>
      );
    }
    return (
      <>
        <span className="text-blue-400">{t('analytics.deep.chemistry.labelHighPct')}</span>
        <span className="text-gray-400">{t('analytics.deep.chemistry.labelMidPct')}</span>
        <span className="text-purple-400">{t('analytics.deep.chemistry.labelLowPct')}</span>
      </>
    );
  };

  const guide = (key: MatrixKey, block: MetricBlockKey): string => {
    switch (key) {
      case 'coWin': return t('analytics.deep.chemistry.guideCoWin');
      case 'coLose': return t('analytics.deep.chemistry.guideCoLose');
      case 'winCorr': return `${t('analytics.deep.chemistry.guideWinCorr1')} ${t('analytics.deep.chemistry.guideWinCorr2')}`;
      case 'coWinMinusLose': return `${t('analytics.deep.chemistry.guideCoWinMinusLose1')} ${t('analytics.deep.chemistry.guideCoWinMinusLose2')}`;
      default: return t(`analytics.r6.tabsb.chemistry.guide.${block}`, {
        ref: formatRate(baseline?.[block].win ?? null), n: baseline?.[block].n ?? '—',
      });
    }
  };

  return (
    <div className="space-y-2">
      <NotFilteredNote text={t('analytics.filter.chemistryFiltered')} />
      <div className="flex flex-wrap items-center gap-2">
        <SectionTabs
          items={matrixItems}
          value={matrixKey}
          onChange={setMatrixKey}
          ariaLabel={t('analytics.r6.tabsb.chemistry.matrixLabel')}
        />
        {matrixKey === 'outcomePair' && (
          <SectionTabs
            items={blockItems}
            value={block}
            onChange={setBlock}
            ariaLabel={t('analytics.r6.tabsb.seatRoles.blockLabel')}
          />
        )}
      </div>
      <p className="text-[11px] leading-snug text-zinc-400">
        <span className="font-semibold text-zinc-300">
          {MATRIX_TERM[matrixKey]
            ? <Term term={MATRIX_TERM[matrixKey]!}>{t(`analytics.deep.chemistry.descriptions.${matrixKey}`)}</Term>
            : t(`analytics.deep.chemistry.descriptions.${matrixKey}`)}
        </span>
        {matrixKey === 'outcomePair' && <> · {t('analytics.r6.tabsb.chemistry.pairDescription')}</>}
        {' — '}{guide(matrixKey, block)}
      </p>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">{legend(matrixKey)}</p>
      {renderMatrix(matrixKey, block)}
    </div>
  );
}
