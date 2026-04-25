import { motion } from 'framer-motion';
import { BarChart3, Target, Users, TrendingUp } from 'lucide-react';
import { type RoleData, formatWinRate, TOTAL_UNIQUE_GAMES } from '../data/roleStats';
import { getCampImage } from '../utils/avalonAssets';

interface RoleStatsCardProps {
  role: RoleData;
}

function WinRateBar({ label, rate, color }: { label: string; rate: number; color: string }): JSX.Element {
  const pct = rate * 100;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 text-gray-400 shrink-0">{label}</span>
      <div className="flex-1 bg-gray-700 rounded-full h-3 overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          className={`h-full rounded-full ${color}`}
        />
      </div>
      <span className="w-12 text-right text-gray-300 font-mono">{formatWinRate(rate)}</span>
    </div>
  );
}

export default function RoleStatsCard({ role }: RoleStatsCardProps): JSX.Element {
  const { stats, faction, name_zh, name_en } = role;
  const isGood = faction === 'good';
  const factionColor = isGood ? 'text-blue-400' : 'text-red-400';
  const factionBg = isGood ? 'border-blue-500/40' : 'border-red-500/40';
  const barColor = isGood ? 'bg-blue-500' : 'bg-red-500';
  const factionLabel = isGood ? '正義方' : '邪惡方';

  const breakdown = stats.result_breakdown;
  const totalBreakdown = breakdown['\u4e09\u7d05'] + breakdown['\u4e09\u85cd\u6b7b'] + breakdown['\u4e09\u85cd\u6d3b'];

  // For Merlin, assassination rate is meaningful
  const isMerlin = role.id === 'merlin';
  const assassinationRate = isMerlin && totalBreakdown > 0
    ? breakdown['\u4e09\u85cd\u6b7b'] / (breakdown['\u4e09\u85cd\u6b7b'] + breakdown['\u4e09\u85cd\u6d3b'])
    : null;

  // Sort seats by win rate descending
  const seatEntries = Object.entries(stats.seat_win_rates)
    .sort(([, a], [, b]) => b - a);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={`bg-avalon-card/60 border ${factionBg} rounded-lg p-4 space-y-4`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 size={18} className="text-yellow-400" />
          <h3 className="text-sm font-bold text-white">
            {name_zh} ({name_en}) 實戰數據
          </h3>
        </div>
        {/* Edward 2026-04-25 camp emblem unification: faction chip now leads
            with the painted shield art (team-good / team-evil) so the
            analytics surface uses the same visual language as the live
            game's role-reveal and end-screen. Background tint kept for
            colour-coded scanning at glance distance. */}
        <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded ${isGood ? 'bg-blue-900/60 text-blue-300' : 'bg-red-900/60 text-red-300'}`}>
          <img
            src={getCampImage(isGood ? 'good' : 'evil')}
            alt={factionLabel}
            className="w-3.5 h-3.5 object-contain flex-shrink-0"
            draggable={false}
          />
          {factionLabel}
        </span>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-gray-800/50 rounded-lg p-3 text-center">
          <div className="text-lg font-bold text-yellow-400">{stats.total_games.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">場次</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3 text-center">
          <div className={`text-lg font-bold ${factionColor}`}>{formatWinRate(stats.win_rate)}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">勝率</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3 text-center">
          <div className="text-lg font-bold text-blue-400">{stats.wins}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">勝場</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3 text-center">
          <div className="text-lg font-bold text-gray-400">{stats.losses}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">敗場</div>
        </div>
      </div>

      {/* Result breakdown */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <Target size={14} className="text-yellow-400" />
          <span className="text-xs font-semibold text-gray-300">結果分布 (2,146 局)</span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="bg-red-900/30 border border-red-800/40 rounded p-2">
            <div className="font-bold text-red-400">{breakdown['\u4e09\u7d05']}</div>
            <div className="text-gray-500 text-[10px]">三紅</div>
            <div className="text-gray-500 text-[10px]">{totalBreakdown > 0 ? formatWinRate(breakdown['\u4e09\u7d05'] / totalBreakdown) : '-'}</div>
          </div>
          <div className="bg-blue-900/30 border border-blue-800/40 rounded p-2">
            <div className="font-bold text-blue-300">{breakdown['\u4e09\u85cd\u6b7b']}</div>
            <div className="text-gray-500 text-[10px]">三藍死</div>
            <div className="text-gray-500 text-[10px]">{totalBreakdown > 0 ? formatWinRate(breakdown['\u4e09\u85cd\u6b7b'] / totalBreakdown) : '-'}</div>
          </div>
          <div className="bg-amber-900/30 border border-amber-800/40 rounded p-2">
            <div className="font-bold text-amber-400">{breakdown['\u4e09\u85cd\u6d3b']}</div>
            <div className="text-gray-500 text-[10px]">三藍活</div>
            <div className="text-gray-500 text-[10px]">{totalBreakdown > 0 ? formatWinRate(breakdown['\u4e09\u85cd\u6d3b'] / totalBreakdown) : '-'}</div>
          </div>
        </div>
        {isMerlin && assassinationRate !== null && (
          <div className="mt-2 text-xs text-center">
            <span className="text-gray-400">三藍後被刺殺率：</span>
            <span className="text-red-400 font-bold">{formatWinRate(assassinationRate)}</span>
          </div>
        )}
      </div>

      {/* Seat win rates */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <Users size={14} className="text-yellow-400" />
          <span className="text-xs font-semibold text-gray-300">各座位勝率</span>
        </div>
        <div className="space-y-1.5">
          {seatEntries.map(([seat, rate]) => (
            <WinRateBar
              key={seat}
              label={`${Number(seat) + 1} 號位`}
              rate={rate}
              color={barColor}
            />
          ))}
        </div>
      </div>

      {/* Data source note */}
      <div className="text-[10px] text-gray-600 text-center pt-1 border-t border-gray-700/50">
        資料來源：阿瓦隆百科 {TOTAL_UNIQUE_GAMES.toLocaleString()} 局實戰紀錄 (2020-2023)
      </div>
    </motion.div>
  );
}
