import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Legend,
} from 'recharts';
import { Loader, AlertCircle } from 'lucide-react';
import { fetchAnalysisMissions, getErrorMessage } from '../../services/api';
import type { MissionAnalysisData } from '../../services/api';

export default function MissionAnalysis(): JSX.Element {
  const [data, setData] = useState<MissionAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchAnalysisMissions();
        if (!cancelled) setData(d);
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
        <Loader size={20} className="animate-spin" /> 載入任務分析...
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

  // Transform pass rates for chart
  const passRateData = data.missionPassRates.map(m => ({
    name: `任務 ${m.round}`,
    passRate: m.passRate,
    failRate: Math.round((100 - m.passRate) * 10) / 10,
    totalGames: m.totalGames,
  }));

  // Fix #3: Stacked outcome by round - labels are fail cards (黑球), NOT rejection votes
  const outcomeData = data.missionOutcomeByRound.map(m => ({
    name: `任務 ${m.round}`,
    allPass: Math.round((m.allPass / m.total) * 1000) / 10,
    oneFail: Math.round((m.oneFail / m.total) * 1000) / 10,
    twoFail: Math.round((m.twoFail / m.total) * 1000) / 10,
  }));

  // Mission outcome correlation table data (missions 1-4 only, skip 5)
  const corrRows = data.missionOutcomeCorrelation
    .filter(c => c.round <= 4)
    .map(c => {
      const passedBlueWin = c.passedThenBlueWin;
      const passedRedWin = c.passedGames - c.passedThenBlueWin;
      const failedBlueWin = c.failedGames - c.failedThenRedWin;
      const failedRedWin = c.failedThenRedWin;
      return {
        round: c.round,
        passedGames: c.passedGames,
        passedBlueWin,
        passedRedWin,
        passedBlueWinPct: c.passedGames > 0 ? Math.round((passedBlueWin / c.passedGames) * 1000) / 10 : 0,
        passedRedWinPct: c.passedGames > 0 ? Math.round((passedRedWin / c.passedGames) * 1000) / 10 : 0,
        failedGames: c.failedGames,
        failedBlueWin,
        failedRedWin,
        failedBlueWinPct: c.failedGames > 0 ? Math.round((failedBlueWin / c.failedGames) * 1000) / 10 : 0,
        failedRedWinPct: c.failedGames > 0 ? Math.round((failedRedWin / c.failedGames) * 1000) / 10 : 0,
      };
    });

  return (
    <div className="space-y-6">
      {/* Mission pass rate by round */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">任務通過率</h3>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={passRateData}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip
              formatter={(val: unknown) => `${val}%`}
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              itemStyle={{ color: '#d1d5db' }}
            />
            <Legend />
            <Bar dataKey="passRate" name="通過" fill="#22c55e" stackId="a" radius={[0, 0, 0, 0]} />
            <Bar dataKey="failRate" name="失敗" fill="#ef4444" stackId="a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Fix #3: Stacked outcome breakdown - fail cards (黑球) */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">失敗球分布</h3>
        <p className="text-[10px] text-gray-600 mb-2">每次任務中出現的失敗球(黑球)數量分布</p>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={outcomeData}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip
              formatter={(val: unknown) => `${val}%`}
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              itemStyle={{ color: '#d1d5db' }}
            />
            <Legend />
            <Bar dataKey="allPass" name="0張失敗" fill="#22c55e" stackId="a" />
            <Bar dataKey="oneFail" name="1張失敗" fill="#f59e0b" stackId="a" />
            <Bar dataKey="twoFail" name="2+張失敗" fill="#ef4444" stackId="a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Mission outcome correlation table (missions 1-4) */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-1">任務結果與最終勝負關聯</h3>
        <p className="text-[10px] text-gray-600 mb-3">各任務通過/失敗後, 最終藍方勝 vs 紅方勝的次數與比例 (任務5省略, 必為100%)</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-700">
                <th rowSpan={2} className="text-left text-gray-500 py-2 px-2">任務</th>
                <th colSpan={3} className="text-center text-green-400 py-1 px-2 border-b border-gray-700">任務通過</th>
                <th colSpan={3} className="text-center text-red-400 py-1 px-2 border-b border-gray-700">任務失敗</th>
              </tr>
              <tr className="border-b border-gray-700">
                <th className="text-center text-blue-400 py-1 px-2">藍方勝</th>
                <th className="text-center text-red-400 py-1 px-2">紅方勝</th>
                <th className="text-center text-gray-500 py-1 px-2">場次</th>
                <th className="text-center text-blue-400 py-1 px-2">藍方勝</th>
                <th className="text-center text-red-400 py-1 px-2">紅方勝</th>
                <th className="text-center text-gray-500 py-1 px-2">場次</th>
              </tr>
            </thead>
            <tbody>
              {corrRows.map(r => (
                <tr key={r.round} className="border-b border-gray-800 hover:bg-gray-800/30">
                  <td className="text-gray-300 font-bold py-2 px-2">任務 {r.round}</td>
                  <td className="text-center text-blue-400 py-2 px-2">
                    {r.passedBlueWin} <span className="text-gray-600">({r.passedBlueWinPct}%)</span>
                  </td>
                  <td className="text-center text-red-400 py-2 px-2">
                    {r.passedRedWin} <span className="text-gray-600">({r.passedRedWinPct}%)</span>
                  </td>
                  <td className="text-center text-gray-500 py-2 px-2">{r.passedGames}</td>
                  <td className="text-center text-blue-400 py-2 px-2">
                    {r.failedBlueWin} <span className="text-gray-600">({r.failedBlueWinPct}%)</span>
                  </td>
                  <td className="text-center text-red-400 py-2 px-2">
                    {r.failedRedWin} <span className="text-gray-600">({r.failedRedWinPct}%)</span>
                  </td>
                  <td className="text-center text-gray-500 py-2 px-2">{r.failedGames}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}
