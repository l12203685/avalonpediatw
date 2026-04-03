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
    name: `第 ${m.round} 局`,
    passRate: m.passRate,
    failRate: Math.round((100 - m.passRate) * 10) / 10,
    totalGames: m.totalGames,
  }));

  // Stacked outcome by round
  const outcomeData = data.missionOutcomeByRound.map(m => ({
    name: `第 ${m.round} 局`,
    allPass: Math.round((m.allPass / m.total) * 1000) / 10,
    oneFail: Math.round((m.oneFail / m.total) * 1000) / 10,
    twoFail: Math.round((m.twoFail / m.total) * 1000) / 10,
  }));

  // Fail distribution
  const failData = data.failDistribution.map(f => ({
    name: `${f.fails} 票反對`,
    count: f.count,
    percentage: f.percentage,
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
            <Tooltip formatter={(val) => `${val}%`} />
            <Legend />
            <Bar dataKey="passRate" name="通過" fill="#22c55e" stackId="a" radius={[0, 0, 0, 0]} />
            <Bar dataKey="failRate" name="失敗" fill="#ef4444" stackId="a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Stacked outcome breakdown */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">任務結果分布 (Outcome Breakdown %)</h3>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={outcomeData}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip formatter={(val) => `${val}%`} />
            <Legend />
            <Bar dataKey="allPass" name="全通過" fill="#22c55e" stackId="a" />
            <Bar dataKey="oneFail" name="1票反對" fill="#f59e0b" stackId="a" />
            <Bar dataKey="twoFail" name="2+票反對" fill="#ef4444" stackId="a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Fail vote distribution */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">反對票分布 (Fail Vote Distribution)</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={failData}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
            <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip />
            <Bar dataKey="count" name="次數" radius={[4, 4, 0, 0]}>
              {failData.map((_, i) => (
                <Cell key={i} fill={i === 0 ? '#22c55e' : i === 1 ? '#f59e0b' : '#ef4444'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </motion.div>
    </div>
  );
}
