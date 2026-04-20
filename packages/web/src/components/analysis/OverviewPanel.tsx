import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie } from 'recharts';
import { Loader, AlertCircle, Trophy, Users, Swords, Skull } from 'lucide-react';
import { fetchAnalysisOverview, getErrorMessage } from '../../services/api';
import type { AnalysisOverview } from '../../services/api';

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

  // Fix #10: Three-way outcome breakdown
  const outcomeData = [
    { name: '三紅 (3 Failed Missions)', value: overview.outcomeBreakdown.threeRedPct, fill: '#ef4444' },
    { name: '三藍梅活 (Blue Win, Merlin Alive)', value: overview.outcomeBreakdown.threeBlueAlivePct, fill: '#3b82f6' },
    { name: '三藍梅死 (Merlin Killed)', value: overview.outcomeBreakdown.threeBlueDeadPct, fill: '#f59e0b' },
  ];

  // Seat position win rates.
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

      {/* Fix #10: Three-way outcome pie + Fix #8: Theory ranking */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-400 mb-3">勝負結構 (Game Outcome Breakdown)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={outcomeData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={80}
                dataKey="value"
                label={({ name, value }: { name?: string; value?: number }) => `${(name ?? '').split(' ')[0]} ${value}%`}
                labelLine={false}
              >
                {outcomeData.map((entry, idx) => (
                  <Cell key={idx} fill={entry.fill} />
                ))}
              </Pie>
              <Tooltip
                formatter={(val: unknown, _name: unknown, entry: unknown) => {
                  const e = entry as { payload?: { name?: string } };
                  return [`${val}%`, e?.payload?.name ?? ''];
                }}
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
                itemStyle={{ color: '#d1d5db' }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex justify-center gap-4 mt-2 text-[10px]">
            <span className="text-red-400">三紅: {overview.outcomeBreakdown.threeRed} 場</span>
            <span className="text-blue-400">三藍梅活: {overview.outcomeBreakdown.threeBlueAlive} 場</span>
            <span className="text-yellow-400">三藍梅死: {overview.outcomeBreakdown.threeBlueDead} 場</span>
          </div>
        </div>

        {/* Fix #8: Top players by theoretical win rate */}
        <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-400 mb-3">理論勝率排行 (Theoretical Win Rate, 50+ games)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={overview.topPlayersByTheory.slice(0, 8)} layout="vertical">
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
              <YAxis type="category" dataKey="name" width={60} tick={{ fontSize: 11, fill: '#d1d5db' }} />
              <Tooltip
                formatter={(val: unknown, name: unknown) => [`${val}%`, name === 'roleTheory' ? '理論勝率' : String(name)]}
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
                itemStyle={{ color: '#d1d5db' }}
              />
              <Bar dataKey="roleTheory" name="理論勝率" radius={[0, 4, 4, 0]}>
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
        <h3 className="text-sm font-bold text-gray-400 mb-3">場次排行 (Most Games Played)</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={overview.topPlayersByGames.slice(0, 10)}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
            <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              itemStyle={{ color: '#d1d5db' }}
            />
            <Bar dataKey="games" name="場次" fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Seat position win rates by role */}
      {seatData.length > 0 && (
        <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-400 mb-3">位置勝率 (Win Rate by Seat Position)</h3>
          <p className="text-[10px] text-gray-600 mb-2">各位置整體勝率及角色勝率分布</p>
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
                      <p className="font-bold text-gray-200 mb-1">位置 {d.seat} ({d.totalGames} 場)</p>
                      <p className="text-gray-300 mb-2">整體勝率: {d.overallWinRate}%</p>
                      {d.roles.map(r => (
                        <p key={r.role} style={{ color: ROLE_COLORS[r.role] || '#9ca3af' }}>
                          {r.role}: {r.winRate}% ({r.games} 場)
                        </p>
                      ))}
                    </div>
                  );
                }}
              />
              <Bar dataKey="overallWinRate" name="整體勝率" radius={[4, 4, 0, 0]}>
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
