import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Loader, AlertCircle } from 'lucide-react';
import { fetchAnalysisPlayers, getErrorMessage } from '../../services/api';
import type { AnalysisPlayerStats } from '../../services/api';

const SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

type Mode = 'overall' | 'red' | 'blue';

function colorForDeviation(deviation: number): string {
  // deviation = (this cell's win rate) - (seat average win rate)
  // Green = above seat average, Red = below seat average
  if (deviation >= 8) return 'bg-green-600/80 text-green-100';
  if (deviation >= 3) return 'bg-green-700/60 text-green-200';
  if (deviation >= -3) return 'bg-gray-600/60 text-gray-200';
  if (deviation >= -8) return 'bg-red-700/60 text-red-200';
  return 'bg-red-600/80 text-red-100';
}

export default function SeatHeatmap(): JSX.Element {
  const [players, setPlayers] = useState<AnalysisPlayerStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('overall');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { players: pl } = await fetchAnalysisPlayers();
        if (!cancelled) setPlayers(pl.filter(p => p.totalGames >= 30));
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
        <Loader size={20} className="animate-spin" /> 載入座位資料...
      </div>
    );
  }

  if (error || players.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || '無足夠數據 (insufficient data)'}
      </div>
    );
  }

  const getSeatRate = (p: AnalysisPlayerStats, seat: string): number => {
    if (mode === 'red') return p.seatRedWinRates[seat] || 0;
    if (mode === 'blue') return p.seatBlueWinRates[seat] || 0;
    return p.seatWinRates[seat] || 0;
  };

  // Compute seat averages across all displayed players for deviation-based coloring
  const displayedPlayers = players.slice(0, 25);
  const seatAverages: Record<string, number> = {};
  for (const seat of SEATS) {
    const rates = displayedPlayers.map(p => getSeatRate(p, seat)).filter(r => r > 0);
    seatAverages[seat] = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 50;
  }

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div className="flex gap-2">
        {([
          { id: 'overall' as Mode, label: '總勝率', color: 'bg-gray-600' },
          { id: 'red' as Mode, label: '紅方勝率', color: 'bg-red-700' },
          { id: 'blue' as Mode, label: '藍方勝率', color: 'bg-blue-700' },
        ]).map(m => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              mode === m.id
                ? `${m.color} text-white`
                : 'bg-avalon-card/40 text-gray-500 hover:text-white border border-gray-700'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Fix #6: Seat position explanation */}
      <div className="bg-gray-800/40 border border-gray-700 rounded-lg p-3 text-[10px] text-gray-500 space-y-1">
        <p className="font-bold text-gray-400">座位分析說明:</p>
        <p>Avalon 的座位順序影響資訊流和投票順序. 座位號碼 = 遊戲中的固定位置(1-10).</p>
        <p>不同座位有不同的策略優劣: 靠近隊長的位置更容易被選入任務, 發言順序影響資訊判斷.</p>
        <p>數值 = 該玩家在該座位的{mode === 'red' ? '紅方' : mode === 'blue' ? '藍方' : '總'}勝率(%). 顏色 = 與該座位所有玩家平均勝率的偏差. 綠色 = 高於座位平均, 紅色 = 低於座位平均.</p>
      </div>

      {/* Heatmap grid */}
      <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className="text-left text-gray-500 px-2 py-1 font-semibold sticky left-0 bg-avalon-card/30">
                玩家
              </th>
              {SEATS.map(s => (
                <th key={s} className="text-center text-gray-500 px-2 py-1 font-semibold min-w-[44px]">
                  座位 {s === '0' ? '10' : s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.slice(0, 25).map((p, i) => (
              <motion.tr
                key={p.name}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.02 }}
              >
                <td className="text-white font-semibold px-2 py-1 sticky left-0 bg-avalon-card/30 whitespace-nowrap">
                  {p.name}
                </td>
                {SEATS.map(seat => {
                  const rate = getSeatRate(p, seat);
                  const deviation = rate > 0 ? rate - seatAverages[seat] : 0;
                  return (
                    <td key={seat} className="px-1 py-1">
                      <div
                        className={`group relative text-center rounded px-1 py-0.5 font-bold cursor-default ${
                          rate > 0 ? colorForDeviation(deviation) : 'bg-gray-800/40 text-gray-700'
                        }`}
                      >
                        {rate > 0 ? `${rate}` : '-'}
                        {rate > 0 && (
                          <div className="invisible group-hover:visible absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-[10px] text-gray-200 whitespace-nowrap shadow-lg pointer-events-none">
                            {p.name} 座位{seat === '0' ? '10' : seat}: {rate}% (平均 {seatAverages[seat].toFixed(1)}%, {deviation >= 0 ? '+' : ''}{deviation.toFixed(1)}%)
                          </div>
                        )}
                      </div>
                    </td>
                  );
                })}
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-600 text-center">
        30+ 場次的玩家 -- 數值為 {mode === 'red' ? '紅方' : mode === 'blue' ? '藍方' : '總'}勝率(%)
      </p>
    </div>
  );
}
