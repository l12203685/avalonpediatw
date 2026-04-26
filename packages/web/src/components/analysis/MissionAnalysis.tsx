import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisMissions, getErrorMessage } from '../../services/api';
import type { MissionAnalysisData } from '../../services/api';
import OutcomeBar from './OutcomeBar';

/**
 * 任務分析 — Edward 2026-04-26 spec
 *
 * The mission pass-rate chart stays as-is (it's about missions, not game
 * outcomes). The "任務結果與最終勝負關聯" table now expands the final result
 * into three outcomes (三紅 / 三藍死 / 三藍活) instead of collapsing the blue
 * win into a single bar.
 */
export default function MissionAnalysis(): JSX.Element {
  const { t } = useTranslation('common');
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
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.mission.loading')}
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

  const passRateData = data.missionPassRates.map(m => ({
    name: t('analytics.deep.mission.missionLabel', { round: m.round }),
    passRate: m.passRate,
    failRate: Math.round((100 - m.passRate) * 10) / 10,
    totalGames: m.totalGames,
  }));

  const outcomeData = data.missionOutcomeByRound.map(m => ({
    name: t('analytics.deep.mission.missionLabel', { round: m.round }),
    allPass: Math.round((m.allPass / m.total) * 1000) / 10,
    oneFail:  Math.round((m.oneFail  / m.total) * 1000) / 10,
    twoFail:  Math.round((m.twoFail  / m.total) * 1000) / 10,
  }));

  const corrRows = data.missionOutcomeCorrelation.filter(c => c.round <= 4);

  return (
    <div className="space-y-6">
      {/* Mission pass rate by round */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">{t('analytics.deep.mission.missionPassRate')}</h3>
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
            <Bar dataKey="passRate" name={t('analytics.deep.mission.passLabel')} fill="#22c55e" stackId="a" radius={[0, 0, 0, 0]} />
            <Bar dataKey="failRate" name={t('analytics.deep.mission.failLabel')} fill="#ef4444" stackId="a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Stacked outcome breakdown - fail cards */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">{t('analytics.deep.mission.failBallTitle')}</h3>
        <p className="text-[10px] text-gray-600 mb-2">{t('analytics.deep.mission.failBallSub')}</p>
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
            <Bar dataKey="allPass" name={t('analytics.deep.mission.fail0')} fill="#22c55e" stackId="a" />
            <Bar dataKey="oneFail" name={t('analytics.deep.mission.fail1')} fill="#f59e0b" stackId="a" />
            <Bar dataKey="twoFail" name={t('analytics.deep.mission.fail2')} fill="#ef4444" stackId="a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Mission outcome correlation - now 3-outcome split per branch */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4 space-y-4"
      >
        <div>
          <h3 className="text-sm font-bold text-gray-400 mb-1">{t('analytics.deep.mission.missionVsOutcomeTitle')}</h3>
          <p className="text-[10px] text-gray-600">{t('analytics.deep.mission.missionVsOutcomeSub')}</p>
        </div>
        <div className="space-y-3">
          {corrRows.map(r => (
            <div key={r.round} className="bg-gray-800/40 rounded-lg p-3 space-y-3">
              <p className="text-xs font-bold text-gray-300">{t('analytics.deep.mission.missionLabel', { round: r.round })}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-green-400 font-bold">{t('analytics.deep.mission.missionPass')}</span>
                    <span className="text-gray-500">{r.passedGames} {t('analytics.deep.mission.samples')}</span>
                  </div>
                  <OutcomeBar outcomes={r.passedOutcomes} variant="stacked" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-red-400 font-bold">{t('analytics.deep.mission.missionFail')}</span>
                    <span className="text-gray-500">{r.failedGames} {t('analytics.deep.mission.samples')}</span>
                  </div>
                  <OutcomeBar outcomes={r.failedOutcomes} variant="stacked" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
