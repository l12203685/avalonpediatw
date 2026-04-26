import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Loader, AlertCircle, Trophy, Users, Swords, Skull } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisOverview, getErrorMessage } from '../../services/api';
import type { AnalysisOverview } from '../../services/api';
import OutcomeBar from './OutcomeBar';

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: typeof Trophy;
  label: string;
  value: string;
  sub?: string;
  color: string;
}): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`bg-avalon-card/40 border rounded-xl p-4 ${color}`}
    >
      <Icon size={18} className="mb-2 opacity-70" />
      <p className="text-2xl font-black">{value}</p>
      <p className="text-xs opacity-60">{label}</p>
      {sub && <p className="text-xs mt-1 opacity-40">{sub}</p>}
    </motion.div>
  );
}

export default function OverviewPanel(): JSX.Element {
  const { t } = useTranslation('common');
  const [overview, setOverview] = useState<AnalysisOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ov = await fetchAnalysisOverview();
        if (!cancelled) setOverview(ov);
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
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  // Edward 2026-04-26: Outcome breakdown is THE primary chart now.
  // Three mutually exclusive game results, fixed display order
  // 三紅 → 三藍死 → 三藍活 (matches rank baseline).
  const overallOutcomes = overview.outcomeBreakdown;

  // Canonical role names only. The old short forms (娜美/德魯/奧伯/派西)
  // have been purged from analysis_cache.json.
  const ROLE_COLORS: Record<string, string> = {
    '刺客': '#ef4444',
    '莫甘娜': '#f87171',
    '莫德雷德': '#fb923c',
    '奧伯倫': '#fbbf24',
    '派西維爾': '#3b82f6',
    '梅林': '#60a5fa',
    '忠臣': '#93c5fd',
  };

  const seatData = overview.seatPositionWinRates;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Swords}
          label={t('analytics.deep.common.totalGames')}
          value={overview.totalGames.toLocaleString()}
          color="border-blue-700/50 text-blue-300"
        />
        <StatCard
          icon={Users}
          label={t('analytics.deep.common.totalPlayers')}
          value={overview.totalPlayers.toString()}
          color="border-purple-700/50 text-purple-300"
        />
        <StatCard
          icon={Trophy}
          label={t('analytics.deep.common.redWinRate')}
          value={`${overview.redWinRate}%`}
          sub={`${t('analytics.deep.common.blueWinRate')} ${overview.blueWinRate}%`}
          color="border-red-700/50 text-red-300"
        />
        <StatCard
          icon={Skull}
          label={t('analytics.deep.common.merlinKillRate')}
          value={`${overview.merlinKillRate}%`}
          sub={t('analytics.deep.common.merlinKillSub')}
          color="border-yellow-700/50 text-yellow-300"
        />
      </div>

      {/* Outcome breakdown + theoretical win-rate ranking */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-400 mb-3">{t('analytics.deep.overview.outcomeBreakdown')}</h3>
          <OutcomeBar outcomes={overallOutcomes} variant="rows" showRawCounts={true} />
          <div className="mt-3">
            <OutcomeBar outcomes={overallOutcomes} variant="stacked" />
          </div>
        </div>

        <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-400 mb-3">{t('analytics.deep.overview.theoryRanking')}</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={overview.topPlayersByTheory.slice(0, 8)} layout="vertical">
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
              <YAxis type="category" dataKey="name" width={60} tick={{ fontSize: 11, fill: '#d1d5db' }} />
              <Tooltip
                formatter={(val: unknown) => [`${val}%`, t('analytics.deep.overview.theoryColumn')]}
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
                itemStyle={{ color: '#d1d5db' }}
              />
              <Bar dataKey="roleTheory" name={t('analytics.deep.overview.theoryColumn')} radius={[0, 4, 4, 0]}>
                {overview.topPlayersByTheory.slice(0, 8).map((_, i) => (
                  <Cell key={i} fill={i === 0 ? '#f59e0b' : i < 3 ? '#3b82f6' : '#6b7280'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top players by games played */}
      <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
        <h3 className="text-sm font-bold text-gray-400 mb-3">{t('analytics.deep.overview.gamesRanking')}</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={overview.topPlayersByGames.slice(0, 10)}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
            <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              itemStyle={{ color: '#d1d5db' }}
            />
            <Bar dataKey="games" name={t('analytics.deep.overview.gamesColumn')} fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Seat position win rates by role */}
      {seatData.length > 0 && (
        <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-400 mb-3">{t('analytics.deep.overview.seatPositionTitle')}</h3>
          <p className="text-[10px] text-gray-600 mb-2">{t('analytics.deep.overview.seatPositionSub')}</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={seatData}>
              <XAxis dataKey="seat" tick={{ fontSize: 11, fill: '#d1d5db' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null;
                  const d = payload[0].payload as typeof seatData[number];
                  return (
                    <div className="bg-gray-800 border border-gray-600 rounded-lg p-3 text-xs">
                      <p className="font-bold text-gray-200 mb-1">{t('analytics.deep.overview.seatGames', { seat: d.seat, games: d.totalGames })}</p>
                      <p className="text-gray-300 mb-2">{t('analytics.deep.overview.overallWinRate')}: {d.overallWinRate}%</p>
                      {d.roles.map(r => (
                        <p key={r.role} style={{ color: ROLE_COLORS[r.role] || '#9ca3af' }}>
                          {r.role}: {r.winRate}% ({r.games} {t('analytics.deep.common.games')})
                        </p>
                      ))}
                    </div>
                  );
                }}
              />
              <Bar dataKey="overallWinRate" name={t('analytics.deep.overview.overallWinRate')} radius={[4, 4, 0, 0]}>
                {seatData.map((_, i) => (
                  <Cell key={i} fill={i < 5 ? '#6366f1' : '#8b5cf6'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
