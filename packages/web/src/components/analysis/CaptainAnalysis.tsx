import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisCaptain, getErrorMessage } from '../../services/api';
import type { CaptainAnalysisData } from '../../services/api';
import OutcomeBar from './OutcomeBar';

const RED_COLOR  = '#ef4444';
const BLUE_COLOR = '#3b82f6';

/**
 * 隊長分析 — Edward 2026-04-26 spec
 *
 * Captain-faction × mission-result outcome cards now show the three
 * mutually-exclusive game outcomes (三紅 / 三藍死 / 三藍活) instead of two
 * single percentages (red game win / blue game win). The original
 * red/blue split hid whether blue wins came from Merlin surviving or
 * Merlin being assassinated.
 */
export default function CaptainAnalysis(): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<CaptainAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchAnalysisCaptain();
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
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.captain.loading')}
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

  if (data.perMission.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        {t('analytics.deep.captain.noData')}
      </div>
    );
  }

  const missionChartData = data.perMission.map(m => ({
    name: t('analytics.deep.mission.missionLabel', { round: m.mission }),
    red: m.redCaptainRate,
    blue: m.blueCaptainRate,
    games: m.games,
  }));

  const redRows  = data.captainFactionVsOutcome.filter(r => r.captainFaction === '紅方');
  const blueRows = data.captainFactionVsOutcome.filter(r => r.captainFaction === '藍方');
  const redPass  = redRows.find(r => r.missionResult === 'pass');
  const redFail  = redRows.find(r => r.missionResult === 'fail');
  const bluePass = blueRows.find(r => r.missionResult === 'pass');
  const blueFail = blueRows.find(r => r.missionResult === 'fail');

  const winRateRows = data.captainMissionGameWinRates;

  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/40 rounded-xl p-4 border border-gray-700"
      >
        <h2 className="text-lg font-bold text-white mb-1">{t('analytics.deep.captain.headerTitle')}</h2>
        <p className="text-xs text-gray-400">
          {t('analytics.deep.captain.headerSub', { count: data.perMission[0]?.games ?? 0 })}
        </p>
      </motion.div>

      {/* Per-mission captain faction rate */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="bg-avalon-card/40 rounded-xl p-4 border border-gray-700"
      >
        <h3 className="text-sm font-semibold text-gray-300 mb-3">{t('analytics.deep.captain.perMissionTitle')}</h3>
        <p className="text-xs text-gray-500 mb-4">{t('analytics.deep.captain.perMissionSub')}</p>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={missionChartData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
            <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#9ca3af' }} />
            <YAxis unit="%" tick={{ fontSize: 11, fill: '#9ca3af' }} domain={[0, 100]} />
            <Tooltip
              contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
              formatter={(value: unknown, name: unknown) => [
                `${value}%`,
                name === 'red' ? t('analytics.deep.captain.redCaptain') : t('analytics.deep.captain.blueCaptain'),
              ]}
            />
            <Legend
              formatter={(v) => v === 'red' ? t('analytics.deep.captain.redCaptain') : t('analytics.deep.captain.blueCaptain')}
              wrapperStyle={{ fontSize: 12 }}
            />
            <Bar dataKey="red"  name="red"  fill={RED_COLOR}  radius={[3, 3, 0, 0]} />
            <Bar dataKey="blue" name="blue" fill={BLUE_COLOR} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs text-gray-300">
            <thead>
              <tr className="border-b border-gray-700 text-gray-500">
                <th className="text-left py-2 pr-4">{t('analytics.deep.mission.missionLabel', { round: '' }).trim()}</th>
                <th className="text-right pr-4">{t('analytics.deep.captain.redCaptain')} %</th>
                <th className="text-right pr-4">{t('analytics.deep.captain.blueCaptain')} %</th>
                <th className="text-right">{t('analytics.deep.captain.captainSampleSize')}</th>
              </tr>
            </thead>
            <tbody>
              {data.perMission.map(m => (
                <tr key={m.mission} className="border-b border-gray-800 hover:bg-white/5">
                  <td className="py-1.5 pr-4 font-medium">{t('analytics.deep.mission.missionLabel', { round: m.mission })}</td>
                  <td className="text-right pr-4 text-red-400">{m.redCaptainRate}%</td>
                  <td className="text-right pr-4 text-blue-400">{m.blueCaptainRate}%</td>
                  <td className="text-right text-gray-500">{m.games}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>

      {/* Captain faction vs mission pass/fail */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-avalon-card/40 rounded-xl p-4 border border-gray-700"
      >
        <h3 className="text-sm font-semibold text-gray-300 mb-1">{t('analytics.deep.captain.factionVsResultTitle')}</h3>
        <p className="text-xs text-gray-500 mb-4">{t('analytics.deep.captain.factionVsResultSub')}</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-red-900/20 border border-red-800/40 rounded-lg p-4">
            <div className="text-xs text-red-400 font-semibold mb-3">{t('analytics.deep.captain.redCaptain')}</div>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400">{t('analytics.deep.captain.missionPass')}</span>
                <span className="text-sm font-bold text-green-400">
                  {redPass?.percentage ?? 0}%
                  <span className="text-xs text-gray-500 ml-1">({redPass?.count ?? 0})</span>
                </span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-1.5">
                <div className="bg-green-500 h-1.5 rounded-full" style={{ width: `${redPass?.percentage ?? 0}%` }} />
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400">{t('analytics.deep.captain.missionFail')}</span>
                <span className="text-sm font-bold text-red-400">
                  {redFail?.percentage ?? 0}%
                  <span className="text-xs text-gray-500 ml-1">({redFail?.count ?? 0})</span>
                </span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-1.5">
                <div className="bg-red-500 h-1.5 rounded-full" style={{ width: `${redFail?.percentage ?? 0}%` }} />
              </div>
            </div>
          </div>

          <div className="bg-blue-900/20 border border-blue-800/40 rounded-lg p-4">
            <div className="text-xs text-blue-400 font-semibold mb-3">{t('analytics.deep.captain.blueCaptain')}</div>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400">{t('analytics.deep.captain.missionPass')}</span>
                <span className="text-sm font-bold text-green-400">
                  {bluePass?.percentage ?? 0}%
                  <span className="text-xs text-gray-500 ml-1">({bluePass?.count ?? 0})</span>
                </span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-1.5">
                <div className="bg-green-500 h-1.5 rounded-full" style={{ width: `${bluePass?.percentage ?? 0}%` }} />
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400">{t('analytics.deep.captain.missionFail')}</span>
                <span className="text-sm font-bold text-red-400">
                  {blueFail?.percentage ?? 0}%
                  <span className="text-xs text-gray-500 ml-1">({blueFail?.count ?? 0})</span>
                </span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-1.5">
                <div className="bg-red-500 h-1.5 rounded-full" style={{ width: `${blueFail?.percentage ?? 0}%` }} />
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Captain faction + mission outcome -> 3-outcome game result */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="bg-avalon-card/40 rounded-xl p-4 border border-gray-700"
      >
        <h3 className="text-sm font-semibold text-gray-300 mb-1">{t('analytics.deep.captain.winRateTitle')}</h3>
        <p className="text-xs text-gray-500 mb-4">{t('analytics.deep.captain.winRateSub')}</p>
        <div className="space-y-3">
          {winRateRows.map((r, i) => {
            const factionShort = r.captainFaction === '紅方'
              ? t('analytics.deep.captain.leaderRedShort')
              : t('analytics.deep.captain.leaderBlueShort');
            const resultLabel = r.missionResult === 'pass'
              ? t('analytics.deep.captain.missionPass')
              : t('analytics.deep.captain.missionFail');
            return (
              <div key={i} className="bg-gray-800/40 rounded-lg p-3 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-bold text-gray-200">
                    <span className={r.captainFaction === '紅方' ? 'text-red-400' : 'text-blue-400'}>{factionShort}</span>
                    <span className="text-gray-500 mx-1.5">·</span>
                    <span className={r.missionResult === 'pass' ? 'text-green-400' : 'text-red-400'}>{resultLabel}</span>
                  </span>
                  <span className="text-xs text-gray-500">{r.totalMissions} {t('analytics.deep.captain.missionCount')}</span>
                </div>
                <OutcomeBar outcomes={r.outcomes} variant="stacked" />
              </div>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}
