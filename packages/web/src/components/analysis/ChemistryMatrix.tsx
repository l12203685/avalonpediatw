import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisChemistry, getErrorMessage } from '../../services/api';
import type { ChemistryData, ChemistryMatrix as ChemistryMatrixType } from '../../services/api';

type MatrixKey = 'coWin' | 'coLose' | 'winCorr' | 'coWinMinusLose' | 'outcomePair';

const MATRIX_KEYS: MatrixKey[] = ['coWin', 'coLose', 'winCorr', 'coWinMinusLose', 'outcomePair'];

function colorForOutcomePair(value: number): string {
  if (isNaN(value)) return 'bg-gray-900/30 text-gray-700';
  if (value >= 55) return 'bg-red-500/70 text-red-100';
  if (value >= 50) return 'bg-red-700/50 text-red-200';
  if (value >= 40) return 'bg-gray-700/40 text-gray-300';
  if (value >= 35) return 'bg-blue-700/50 text-blue-200';
  return 'bg-blue-500/70 text-blue-100';
}

function cellColor(value: number, key: MatrixKey): string {
  if (isNaN(value)) return 'bg-gray-900/30 text-gray-700';

  if (key === 'outcomePair') {
    return colorForOutcomePair(value);
  }

  if (key === 'coWinMinusLose' || key === 'winCorr') {
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
 * unchanged. Edward 2026-04-27: a 5th matrix ``outcomePair`` shows the
 * three-outcome distribution across each pair's co-played games — primary
 * cell value is threeRedPct, with tooltip surfacing 三紅 / 三藍死 / 三藍活
 * altogether. Hidden when the cache predates the field.
 */
export default function ChemistryMatrixPanel(): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<ChemistryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<MatrixKey>('coWinMinusLose');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const chem = await fetchAnalysisChemistry();
        if (!cancelled) setData(chem);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.chemistry.loading')}
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

  // Hide outcomePair button if cache predates the field. Coerce activeKey
  // back to a safe default in that case so we never render a missing matrix.
  const availableKeys: MatrixKey[] = MATRIX_KEYS.filter(k => Boolean(data[k]));
  const safeActiveKey: MatrixKey = data[activeKey] ? activeKey : 'coWinMinusLose';
  const matrix = data[safeActiveKey] as ChemistryMatrixType | undefined;

  if (!matrix) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        {t('analytics.deep.chemistry.noData')}
      </div>
    );
  }

  const { players, values } = matrix;
  const rowLabels: string[] = matrix.rowLabels && matrix.rowLabels.length > 0
    ? matrix.rowLabels
    : players;
  const threeBlueDeadPct = matrix.threeBlueDeadPct;
  const threeBlueAlivePct = matrix.threeBlueAlivePct;

  if (players.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        {t('analytics.deep.chemistry.noData')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {availableKeys.map(k => (
          <button
            key={k}
            onClick={() => setActiveKey(k)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              safeActiveKey === k
                ? 'bg-purple-600 text-white'
                : 'bg-avalon-card/40 text-gray-500 hover:text-white border border-gray-700'
            }`}
            title={t(`analytics.deep.chemistry.descriptions.${k}`)}
          >
            {t(`analytics.deep.chemistry.matrices.${k}`)}
          </button>
        ))}
      </div>

      <p className="text-xs text-gray-500">
        {t(`analytics.deep.chemistry.descriptions.${safeActiveKey}`)}
      </p>

      <div className="bg-gray-800/40 border border-gray-700 rounded-lg p-3 text-[10px] text-gray-500 space-y-1">
        <p className="font-bold text-gray-400">{t('analytics.deep.chemistry.guideTitle')}</p>
        {safeActiveKey === 'coWin'  && <p>{t('analytics.deep.chemistry.guideCoWin')}</p>}
        {safeActiveKey === 'coLose' && <p>{t('analytics.deep.chemistry.guideCoLose')}</p>}
        {safeActiveKey === 'winCorr' && (
          <>
            <p>{t('analytics.deep.chemistry.guideWinCorr1')}</p>
            <p>{t('analytics.deep.chemistry.guideWinCorr2')}</p>
          </>
        )}
        {safeActiveKey === 'coWinMinusLose' && (
          <>
            <p>{t('analytics.deep.chemistry.guideCoWinMinusLose1')}</p>
            <p>{t('analytics.deep.chemistry.guideCoWinMinusLose2')}</p>
          </>
        )}
        {safeActiveKey === 'outcomePair' && (
          <>
            <p>{t('analytics.deep.chemistry.guideOutcomePair1')}</p>
            <p>{t('analytics.deep.chemistry.guideOutcomePair2')}</p>
          </>
        )}
        <div className="flex flex-wrap gap-3 mt-1">
          {(safeActiveKey === 'coWinMinusLose' || safeActiveKey === 'winCorr') ? (
            <>
              <span className="text-green-400">{t('analytics.deep.chemistry.labelHigh')}</span>
              <span className="text-gray-400">{t('analytics.deep.chemistry.labelMid')}</span>
              <span className="text-red-400">{t('analytics.deep.chemistry.labelLow')}</span>
            </>
          ) : safeActiveKey === 'outcomePair' ? (
            <>
              <span className="text-red-400">{t('analytics.deep.chemistry.labelOutcomeHighRed')}</span>
              <span className="text-gray-400">{t('analytics.deep.chemistry.labelOutcomeMid')}</span>
              <span className="text-blue-400">{t('analytics.deep.chemistry.labelOutcomeHighBlue')}</span>
            </>
          ) : (
            <>
              <span className="text-blue-400">{t('analytics.deep.chemistry.labelHighPct')}</span>
              <span className="text-gray-400">{t('analytics.deep.chemistry.labelMidPct')}</span>
              <span className="text-purple-400">{t('analytics.deep.chemistry.labelLowPct')}</span>
            </>
          )}
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-2 overflow-auto max-h-[70vh]"
      >
        <table className="text-[10px] border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 bg-avalon-card p-1" />
              {players.map((name, i) => (
                <th
                  key={i}
                  className="sticky top-0 z-10 bg-avalon-card p-1 text-gray-400 font-semibold whitespace-nowrap"
                  style={{ height: 80, verticalAlign: 'bottom', padding: 2 }}
                >
                  <span
                    className="inline-block"
                    style={{
                      transform: 'rotate(-90deg)',
                      transformOrigin: 'center',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowLabels.map((rowName, ri) => (
              <tr key={ri}>
                <td className="sticky left-0 z-10 bg-avalon-card px-2 py-0.5 text-gray-300 font-semibold whitespace-nowrap">
                  {rowName}
                </td>
                {values[ri]?.map((rawVal, ci) => {
                  const isSelf = rowLabels[ri] === players[ci];
                  const val = rawVal == null ? NaN : rawVal;
                  const blueDeadVal = threeBlueDeadPct?.[ri]?.[ci];
                  const blueAliveVal = threeBlueAlivePct?.[ri]?.[ci];
                  const showOutcomeTooltip =
                    safeActiveKey === 'outcomePair' &&
                    !isSelf &&
                    !isNaN(val) &&
                    blueDeadVal != null &&
                    blueAliveVal != null;
                  return (
                    <td key={ci} className="p-0.5">
                      <div
                        className={`group relative w-8 h-6 flex items-center justify-center rounded text-[9px] font-bold cursor-default ${
                          isSelf ? 'bg-gray-800/60 text-gray-600' : cellColor(val, safeActiveKey)
                        }`}
                      >
                        {isSelf ? '-' : isNaN(val) ? '' : val.toFixed(0)}
                        {!isSelf && !isNaN(val) && (
                          <div className="invisible group-hover:visible absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-[10px] text-gray-200 whitespace-nowrap shadow-lg pointer-events-none space-y-0.5">
                            <div>{rowName} × {players[ci]}: {val.toFixed(1)}</div>
                            {showOutcomeTooltip && (
                              <div className="text-[9px] text-gray-400">
                                <span className="text-red-300">{t('analytics.deep.outcomes.threeRed')} {val.toFixed(1)}%</span>
                                <span className="mx-1 text-gray-600">·</span>
                                <span className="text-amber-300">{t('analytics.deep.outcomes.threeBlueDead')} {(blueDeadVal as number).toFixed(1)}%</span>
                                <span className="mx-1 text-gray-600">·</span>
                                <span className="text-blue-300">{t('analytics.deep.outcomes.threeBlueAlive')} {(blueAliveVal as number).toFixed(1)}%</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                  );
                }) ?? null}
              </tr>
            ))}
          </tbody>
        </table>
      </motion.div>
    </div>
  );
}
