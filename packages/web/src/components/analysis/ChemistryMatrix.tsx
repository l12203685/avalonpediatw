import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Loader, AlertCircle } from 'lucide-react';
import { fetchAnalysisChemistry, getErrorMessage } from '../../services/api';
import type { ChemistryData, ChemistryMatrix as ChemistryMatrixType } from '../../services/api';

type MatrixKey = 'coWin' | 'coLose' | 'winCorr' | 'coWinMinusLose';

const MATRIX_OPTIONS: Array<{ key: MatrixKey; label: string; desc: string }> = [
  { key: 'coWin',          label: '同贏',      desc: '兩人同時贏的比率' },
  { key: 'coLose',         label: '同輸',      desc: '兩人同時輸的比率' },
  { key: 'winCorr',        label: '贏相關',    desc: '勝率正相關程��' },
  { key: 'coWinMinusLose', label: '同贏-同輸', desc: '淨默契指標 (越高越好)' },
];

function cellColor(value: number, key: MatrixKey): string {
  if (isNaN(value)) return 'bg-gray-900/30 text-gray-700';

  if (key === 'coWinMinusLose' || key === 'winCorr') {
    // Can be negative — divergent palette
    if (value >= 15) return 'bg-green-500/70 text-green-100';
    if (value >= 5) return 'bg-green-700/50 text-green-200';
    if (value >= -5) return 'bg-gray-700/40 text-gray-300';
    if (value >= -15) return 'bg-red-700/50 text-red-200';
    return 'bg-red-500/70 text-red-100';
  }

  // Percentage 0-100
  if (value >= 60) return 'bg-blue-500/70 text-blue-100';
  if (value >= 50) return 'bg-blue-700/50 text-blue-200';
  if (value >= 40) return 'bg-gray-700/40 text-gray-300';
  if (value >= 30) return 'bg-purple-700/50 text-purple-200';
  return 'bg-purple-500/70 text-purple-100';
}

export default function ChemistryMatrixPanel(): JSX.Element {
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
        <Loader size={20} className="animate-spin" /> 載入默契矩陣...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || 'Failed to load'}
      </div>
    );
  }

  const matrix: ChemistryMatrixType = data[activeKey];
  const { players, values } = matrix;
  // Row labels come from the sheet's first column, column labels from row 0.
  // Older caches may not ship `rowLabels` — fall back to `players` in that
  // case (only valid when the sheet is symmetric). Once the backend has been
  // redeployed with row labels, this branch stops mattering and the axes stay
  // consistent even if row order drifts from column order.
  const rowLabels: string[] = matrix.rowLabels && matrix.rowLabels.length > 0
    ? matrix.rowLabels
    : players;

  if (players.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        此矩陣無數據
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Matrix selector */}
      <div className="flex flex-wrap gap-2">
        {MATRIX_OPTIONS.map(opt => (
          <button
            key={opt.key}
            onClick={() => setActiveKey(opt.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeKey === opt.key
                ? 'bg-purple-600 text-white'
                : 'bg-avalon-card/40 text-gray-500 hover:text-white border border-gray-700'
            }`}
            title={opt.desc}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-gray-500">
        {MATRIX_OPTIONS.find(o => o.key === activeKey)?.desc}
      </p>

      {/* Fix #5: Interpretation guide */}
      <div className="bg-gray-800/40 border border-gray-700 rounded-lg p-3 text-[10px] text-gray-500 space-y-1">
        <p className="font-bold text-gray-400">如何解讀:</p>
        {activeKey === 'coWin' && (
          <p>數值 = 兩人同時在同一場遊戲中勝利的次數比率(%). 越高表示兩人越常一起贏.</p>
        )}
        {activeKey === 'coLose' && (
          <p>數值 = 兩人同時輸的次數比率(%). 越高表示兩人越常一起輸.</p>
        )}
        {activeKey === 'winCorr' && (
          <>
            <p>數值 = 勝率相關係數. 正數(綠色) = 一人贏時另一人也傾向贏; 負數(紅色) = 一人贏時另一人傾向輸.</p>
            <p>接近 0 = 兩人勝負無明顯關聯.</p>
          </>
        )}
        {activeKey === 'coWinMinusLose' && (
          <>
            <p>數值 = 同贏次數 - 同輸次數. 正數(綠色) = 默契好, 一起贏多於一起輸; 負數(紅色) = 默契差, 一起輸多於一起贏.</p>
            <p>數值越大, 兩人合作效果越好.</p>
          </>
        )}
        <div className="flex gap-3 mt-1">
          {(activeKey === 'coWinMinusLose' || activeKey === 'winCorr') ? (
            <>
              <span className="text-green-400">+15 以上 = 非常好</span>
              <span className="text-gray-400">-5 ~ +5 = 中性</span>
              <span className="text-red-400">-15 以下 = 非常差</span>
            </>
          ) : (
            <>
              <span className="text-blue-400">60%+ = 高</span>
              <span className="text-gray-400">40-50% = 中</span>
              <span className="text-purple-400">30% 以下 = 低</span>
            </>
          )}
        </div>
      </div>

      {/* Scrollable matrix */}
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
                  /*
                   * Column headers rotate counter-clockwise so the ID reads
                   * bottom-to-top next to its column. The previous
                   * `writingMode: vertical-lr + rotate(180deg)` combo flipped
                   * the text so IDs appeared upside-down and visually
                   * mis-aligned with their cells. Using a single
                   * `rotate(-90deg)` on the text span keeps the header width
                   * stable and each label sits cleanly above its column.
                   */
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
                {values[ri]?.map((val, ci) => {
                  // Diagonal cells are self-vs-self only when the row and
                  // column labels truly match (symmetric sheet). If they
                  // drift we still want to show the value rather than a dash.
                  const isSelf = rowLabels[ri] === players[ci];
                  return (
                    <td key={ci} className="p-0.5">
                      <div
                        className={`group relative w-8 h-6 flex items-center justify-center rounded text-[9px] font-bold cursor-default ${
                          isSelf ? 'bg-gray-800/60 text-gray-600' : cellColor(val, activeKey)
                        }`}
                      >
                        {isSelf ? '-' : isNaN(val) ? '' : val.toFixed(0)}
                        {!isSelf && !isNaN(val) && (
                          <div className="invisible group-hover:visible absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-[10px] text-gray-200 whitespace-nowrap shadow-lg pointer-events-none">
                            {rowName} x {players[ci]}: {val.toFixed(1)}
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
