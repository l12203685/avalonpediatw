import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie } from 'recharts';
import { Loader, AlertCircle, Trophy, Users, Swords, Skull } from 'lucide-react';
import { fetchAnalysisOverview, fetchAnalysisPlayers, getErrorMessage } from '../../services/api';
import type { AnalysisOverview, AnalysisPlayerStats } from '../../services/api';

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
  const [overview, setOverview] = useState<AnalysisOverview | null>(null);
  const [players, setPlayers] = useState<AnalysisPlayerStats[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ov, pl] = await Promise.all([
          fetchAnalysisOverview(),
          fetchAnalysisPlayers().then(r => r.players).catch(() => [] as AnalysisPlayerStats[]),
        ]);
        if (!cancelled) {
          setOverview(ov);
          setPlayers(pl);
        }
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
        <Loader size={20} className="animate-spin" /> 載入分析資料...
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || 'Failed to load'}
      </div>
    );
  }

  const factionData = [
    { name: '紅方 (Evil)', value: overview.redWinRate, fill: '#ef4444' },
    { name: '藍方 (Good)', value: overview.blueWinRate, fill: '#3b82f6' },
  ];

  // Role distribution from players data
  const ROLE_LABELS: Record<string, string> = {
    '刺客': 'Assassin', '娜美': 'Morgana', '德魯': 'Mordred',
    '奧伯': 'Oberon', '派西': 'Percival', '梅林': 'Merlin', '忠臣': 'Loyal',
  };

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Swords}
          label="總場次 (Total Games)"
          value={overview.totalGames.toLocaleString()}
          color="border-blue-700/50 text-blue-300"
        />
        <StatCard
          icon={Users}
          label="玩家數 (Players)"
          value={overview.totalPlayers.toString()}
          color="border-purple-700/50 text-purple-300"
        />
        <StatCard
          icon={Trophy}
          label="紅方勝率 (Evil Win%)"
          value={`${overview.redWinRate}%`}
          sub={`藍方 ${overview.blueWinRate}%`}
          color="border-red-700/50 text-red-300"
        />
        <StatCard
          icon={Skull}
          label="梅林擊殺率 (Merlin Kill%)"
          value={`${overview.merlinKillRate}%`}
          sub="三藍局中刺殺成功"
          color="border-yellow-700/50 text-yellow-300"
        />
      </div>

      {/* Faction win rate pie + bar */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-400 mb-3">陣營勝率 (Faction Win Rate)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={factionData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={80}
                dataKey="value"
                label={({ name, value }) => `${name} ${value}%`}
                labelLine={false}
              >
                {factionData.map((entry, idx) => (
                  <Cell key={idx} fill={entry.fill} />
                ))}
              </Pie>
              <Tooltip formatter={(val) => `${val}%`} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Top players by win rate */}
        <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-400 mb-3">勝率排行 (Top Win Rate, 50+ games)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={overview.topPlayersByWinRate.slice(0, 8)} layout="vertical">
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
              <YAxis type="category" dataKey="name" width={60} tick={{ fontSize: 11, fill: '#d1d5db' }} />
              <Tooltip formatter={(val) => `${val}%`} />
              <Bar dataKey="winRate" radius={[0, 4, 4, 0]}>
                {overview.topPlayersByWinRate.slice(0, 8).map((_, i) => (
                  <Cell key={i} fill={i === 0 ? '#f59e0b' : i < 3 ? '#3b82f6' : '#6b7280'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top players by games played */}
      <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
        <h3 className="text-sm font-bold text-gray-400 mb-3">場次排行 (Most Games Played)</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={overview.topPlayersByGames.slice(0, 10)}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
            <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip />
            <Bar dataKey="games" name="場次" fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Role distribution (if player data available) */}
      {players.length > 0 && (() => {
        const roleAgg: Record<string, number> = {};
        for (const p of players) {
          for (const [role, games] of Object.entries(p.rawRoleGames || {})) {
            roleAgg[role] = (roleAgg[role] || 0) + games;
          }
        }
        const roleData = Object.entries(roleAgg)
          .filter(([, v]) => v > 0)
          .map(([role, games]) => ({
            role: `${role} ${ROLE_LABELS[role] || ''}`.trim(),
            games,
            fill: ['刺客', '娜美', '德魯', '奧伯'].includes(role) ? '#ef4444' : '#3b82f6',
          }))
          .sort((a, b) => b.games - a.games);

        if (roleData.length === 0) return null;

        return (
          <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
            <h3 className="text-sm font-bold text-gray-400 mb-3">角色分布 (Role Distribution)</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={roleData}>
                <XAxis dataKey="role" tick={{ fontSize: 10, fill: '#d1d5db' }} />
                <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
                <Tooltip />
                <Bar dataKey="games" name="場次" radius={[4, 4, 0, 0]}>
                  {roleData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        );
      })()}
    </div>
  );
}
