import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Legend,
} from 'recharts';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisRounds, getErrorMessage } from '../../services/api';
import type { RoundsAnalysisData, OutcomeBreakdown } from '../../services/api';
import OutcomeBar from './OutcomeBar';

/**
 * 回合分析 — Edward 2026-04-26 spec
 *
 * Vision cards now show pass rate + the three outcome breakdown instead of
 * a single 紅勝率 number. The "first vote red count", "mission 1 branch"
 * and "common game states" sections also surface the 3-outcome split so
 * users can see whether a low red rate comes from blue-merlin-alive or
 * blue-merlin-dead games.
 */

function VisionCard({ title, data, t }: {
  title: string;
  data: { games: number; mission1PassRate: number; outcomes: OutcomeBreakdown };
  t: (k: string, opts?: Record<string, unknown>) => string;
}): JSX.Element {
  return (
    <div className="bg-gray-800/40 rounded-lg p-3 space-y-2">
      <p className="text-xs font-bold text-gray-400">{title}</p>
      <div className="grid grid-cols-2 gap-1 text-xs">
        <span className="text-gray-500">{t('analytics.deep.common.games')}</span>
        <span className="text-white font-bold text-right">{data.games}</span>
        <span className="text-gray-500">{t('analytics.deep.rounds.passRateLabel')}</span>
        <span className="text-green-400 font-bold text-right">{data.mission1PassRate}%</span>
      </div>
      <OutcomeBar outcomes={data.outcomes} variant="stacked" />
    </div>
  );
}

export default function RoundsAnalysis(): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<RoundsAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchAnalysisRounds();
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
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.rounds.loading')}
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

  // Round progression chart data
  const progressionData = Object.entries(data.roundProgression).map(([round, v]) => ({
    name: round,
    bluePct: v.bluePct,
    redPct: v.redPct,
    total: v.total,
  }));

  return (
    <div className="space-y-6">
      {/* Vision stats */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-1">{t('analytics.deep.rounds.firstVoteTitle')}</h3>
        <p className="text-[10px] text-gray-600 mb-3">{t('analytics.deep.rounds.firstVoteSub')}</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <VisionCard title={t('analytics.deep.rounds.merlinIn')}    data={data.visionStats.merlinInTeam}    t={t} />
          <VisionCard title={t('analytics.deep.rounds.merlinOut')}   data={data.visionStats.merlinNotInTeam} t={t} />
          <VisionCard title={t('analytics.deep.rounds.percivalIn')}  data={data.visionStats.percivalInTeam}  t={t} />
          <VisionCard title={t('analytics.deep.rounds.percivalOut')} data={data.visionStats.percivalNotInTeam} t={t} />
        </div>
      </motion.div>

      {/* Round progression - blue/red split is mission-level so stays as-is */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">{t('analytics.deep.rounds.progressionTitle')}</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={progressionData}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip
              formatter={(val: unknown) => `${val}%`}
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              itemStyle={{ color: '#d1d5db' }}
            />
            <Legend />
            <Bar dataKey="bluePct" name={t('analytics.deep.rounds.progressionBlue')} fill="#3b82f6" stackId="a" />
            <Bar dataKey="redPct"  name={t('analytics.deep.rounds.progressionRed')}  fill="#ef4444" stackId="a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Red count in first vote + Mission 1 branch */}
      <div className="grid md:grid-cols-2 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4 space-y-3"
        >
          <div>
            <h3 className="text-sm font-bold text-gray-400 mb-1">{t('analytics.deep.rounds.redCountTitle')}</h3>
            <p className="text-[10px] text-gray-600">{t('analytics.deep.rounds.redCountSub')}</p>
          </div>
          <div className="space-y-3">
            {data.redInR11.map(r => (
              <div key={r.redCount} className="bg-gray-800/40 rounded-lg p-2 space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-white font-bold">{t('analytics.deep.rounds.redCountLabel', { count: r.redCount })}</span>
                  <span className="text-gray-500">{r.games} {t('analytics.deep.common.games')}</span>
                </div>
                <OutcomeBar outcomes={r.outcomes} variant="stacked" />
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
        >
          <h3 className="text-sm font-bold text-gray-400 mb-3">{t('analytics.deep.rounds.mission1BranchTitle')}</h3>
          <div className="space-y-3">
            {data.mission1Branch.map(b => (
              <div key={String(b.passed)} className="bg-gray-800/40 rounded-lg p-3 space-y-2">
                <div className="flex justify-between items-center">
                  <span className={`font-bold text-sm ${b.passed ? 'text-green-400' : 'text-red-400'}`}>
                    {b.passed ? t('analytics.deep.rounds.branchPassed') : t('analytics.deep.rounds.branchFailed')}
                  </span>
                  <span className="text-xs text-gray-500">{b.games} {t('analytics.deep.rounds.branchSamples')}</span>
                </div>
                <OutcomeBar outcomes={b.outcomes} variant="stacked" />
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      {/* Game states - 3-outcome stacked */}
      {data.gameStates.filter(s => s.state !== '紅紅紅' && s.state !== '藍藍藍' && s.games >= 20).length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
        >
          <h3 className="text-sm font-bold text-gray-400 mb-1">{t('analytics.deep.rounds.stateTitle')}</h3>
          <p className="text-[10px] text-gray-600 mb-3">{t('analytics.deep.rounds.stateSub')}</p>
          <div className="space-y-2">
            {data.gameStates
              .filter(s => s.state !== '紅紅紅' && s.state !== '藍藍藍' && s.games >= 20)
              .map(s => (
                <div key={s.state} className="bg-gray-800/40 rounded-lg p-2 grid grid-cols-[80px_60px_1fr] items-center gap-2">
                  <span className="text-white font-bold text-xs">{s.state}</span>
                  <span className="text-gray-500 text-[10px] text-right">{s.games} {t('analytics.deep.common.games')}</span>
                  <OutcomeBar outcomes={s.outcomes} variant="stacked" />
                </div>
              ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}
