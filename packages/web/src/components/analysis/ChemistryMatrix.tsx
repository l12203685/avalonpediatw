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
                  style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}
                >
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.map((rowName, ri) => (
              <tr key={ri}>
                <td className="sticky left-0 z-10 bg-avalon-card px-2 py-0.5 text-gray-300 font-semibold whitespace-nowrap">
                  {rowName}
                </td>
                {values[ri]?.map((val, ci) => (
                  <td key={ci} className="p-0.5">
                    <div
                      className={`w-8 h-6 flex items-center justify-center rounded text-[9px] font-bold ${
                        ri === ci ? 'bg-gray-800/60 text-gray-600' : cellColor(val, activeKey)
                      }`}
                      title={`${rowName} x ${players[ci]}: ${isNaN(val) ? 'N/A' : val.toFixed(1)}`}
                    >
                      {ri === ci ? '-' : isNaN(val) ? '' : val.toFixed(0)}
                    </div>
                  </td>
                )) ?? null}
              </tr>
            ))}
          </tbody>
        </table>
      </motion.div>
    </div>
  );
}
