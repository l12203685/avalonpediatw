import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
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

  // Fix #4: Mission outcome correlation (replaces fail card distribution)
  const corrData = data.missionOutcomeCorrelation.map(c => ({
    name: `任務 ${c.round}`,
    passedBlueWinRate: c.passedBlueWinRate,
    failedRedWinRate: c.failedRedWinRate,
    passedGames: c.passedGames,
    failedGames: c.failedGames,
  }));

  return (
    <div className="space-y-6">
      {/* Mission pass rate by round */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">任務通過率 (Mission Pass Rate by Round)</h3>
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
        <h3 className="text-sm font-bold text-gray-400 mb-3">失敗球分布 (Fail Card Distribution %)</h3>
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

      {/* Fix #4: Mission outcome correlation (replaces fail card distribution chart) */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">任務結果與最終勝負關聯 (Mission Outcome vs Game Result)</h3>
        <p className="text-[10px] text-gray-600 mb-2">任務通過後藍方最終勝率 vs 任務失敗後紅方最終勝率</p>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={corrData}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip
              formatter={(val: unknown, name: unknown) => [
                `${val}%`,
                name === 'passedBlueWinRate' ? '通過後藍方勝率' : '失敗後紅方勝率',
              ]}
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              itemStyle={{ color: '#d1d5db' }}
            />
            <Legend />
            <Bar dataKey="passedBlueWinRate" name="通過後藍方勝率" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            <Bar dataKey="failedRedWinRate" name="失敗後紅方勝率" fill="#ef4444" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>
    </div>
  );
}
