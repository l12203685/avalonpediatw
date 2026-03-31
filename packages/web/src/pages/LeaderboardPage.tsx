import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Trophy, Medal, TrendingUp, Users } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  MOCK_LEADERBOARD,
  ALL_BADGES,
  BADGE_RARITY_COLORS,
  ROLE_DISPLAY,
  LeaderboardEntry,
} from '../data/mockData';

const ELO_TIER = (elo: number): { label: string; color: string; icon: string } => {
  if (elo >= 1800) return { label: '傳奇', color: 'text-yellow-400', icon: '👑' };
  if (elo >= 1700) return { label: '大師', color: 'text-purple-400', icon: '💎' };
  if (elo >= 1600) return { label: '白金', color: 'text-cyan-400', icon: '🏆' };
  if (elo >= 1500) return { label: '黃金', color: 'text-yellow-500', icon: '🥇' };
  if (elo >= 1400) return { label: '白銀', color: 'text-gray-300', icon: '🥈' };
  return { label: '青銅', color: 'text-orange-400', icon: '🥉' };
};

function RankMedal({ rank }: { rank: number }): JSX.Element {
  if (rank === 1) return <span className="text-2xl">🥇</span>;
  if (rank === 2) return <span className="text-2xl">🥈</span>;
  if (rank === 3) return <span className="text-2xl">🥉</span>;
  return <span className="text-gray-400 font-bold text-lg w-8 text-center">{rank}</span>;
}

function EntryRow({
  entry,
  isHighlighted,
  onClick,
}: {
  entry: LeaderboardEntry;
  isHighlighted: boolean;
  onClick: () => void;
}): JSX.Element {
  const tier = ELO_TIER(entry.eloRating);
  const role = ROLE_DISPLAY[entry.favoriteRole ?? ''];

  return (
    <motion.tr
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: entry.rank * 0.04 }}
      whileHover={{ backgroundColor: 'rgba(255,255,255,0.04)' }}
      onClick={onClick}
      className={`cursor-pointer border-b border-gray-700/50 transition-colors ${
        isHighlighted ? 'bg-yellow-900/20 border-yellow-600/30' : ''
      }`}
    >
      {/* Rank */}
      <td className="px-4 py-3 text-center w-12">
        <RankMedal rank={entry.rank} />
      </td>

      {/* Avatar + Name */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center font-bold text-white shrink-0">
            {entry.displayName.charAt(0)}
          </div>
          <div>
            <p className="font-bold text-white">{entry.displayName}</p>
            <div className="flex items-center gap-1 mt-0.5">
              {entry.badges.slice(0, 3).map((b) => {
                const badge = ALL_BADGES.find((x) => x.id === b);
                return badge ? (
                  <span key={b} title={badge.name} className="text-sm">
                    {badge.icon}
                  </span>
                ) : null;
              })}
              {entry.badges.length > 3 && (
                <span className="text-xs text-gray-500">+{entry.badges.length - 3}</span>
              )}
            </div>
          </div>
        </div>
      </td>

      {/* ELO */}
      <td className="px-4 py-3 text-center">
        <div>
          <span className={`font-bold text-lg ${tier.color}`}>{entry.eloRating}</span>
          <p className={`text-xs ${tier.color}`}>
            {tier.icon} {tier.label}
          </p>
        </div>
      </td>

      {/* Win Rate */}
      <td className="px-4 py-3 text-center">
        <div>
          <p className="text-white font-semibold">{entry.winRate.toFixed(1)}%</p>
          <p className="text-xs text-gray-400">
            {entry.gamesWon}W / {entry.totalGames - entry.gamesWon}L
          </p>
        </div>
      </td>

      {/* Fav Role */}
      <td className="px-4 py-3 text-center hidden md:table-cell">
        {role ? (
          <span className={`text-sm font-medium ${role.color}`}>
            {role.icon} {role.label}
          </span>
        ) : (
          <span className="text-gray-500">—</span>
        )}
      </td>

      {/* Games */}
      <td className="px-4 py-3 text-center hidden lg:table-cell">
        <span className="text-gray-300">{entry.totalGames}</span>
      </td>
    </motion.tr>
  );
}

export default function LeaderboardPage(): JSX.Element {
  const { setGameState } = useGameStore();
  const [selected, setSelected] = useState<LeaderboardEntry | null>(null);

  // Summary stats
  const totalGames = MOCK_LEADERBOARD.reduce((s, e) => s + e.totalGames, 0);
  const topElo = MOCK_LEADERBOARD[0]?.eloRating ?? 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-avalon-dark to-black">
      {/* Back */}
      <div className="absolute top-4 left-4 z-10">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setGameState('home')}
          className="flex items-center gap-2 bg-avalon-card/50 hover:bg-avalon-card/80 text-white px-4 py-2 rounded-lg border border-gray-600 transition-all"
        >
          <ArrowLeft size={18} />
          返回
        </motion.button>
      </div>

      {/* Hero */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-r from-yellow-600/20 to-orange-600/20 border-b border-gray-700 px-8 pt-16 pb-8 mb-8"
      >
        <div className="max-w-4xl mx-auto text-center">
          <div className="flex items-center justify-center gap-3 mb-3">
            <Trophy size={32} className="text-yellow-400" />
            <h1 className="text-4xl font-bold text-white">排行榜</h1>
          </div>
          <p className="text-gray-400 mb-6">全球 Avalon 玩家 ELO 排名</p>

          {/* Quick Stats */}
          <div className="grid grid-cols-3 gap-4 max-w-md mx-auto">
            <div className="bg-avalon-card/50 border border-gray-600 rounded-lg p-3">
              <p className="text-2xl font-bold text-yellow-400">{MOCK_LEADERBOARD.length}</p>
              <p className="text-xs text-gray-400">排名玩家</p>
            </div>
            <div className="bg-avalon-card/50 border border-gray-600 rounded-lg p-3">
              <p className="text-2xl font-bold text-blue-400">{totalGames}</p>
              <p className="text-xs text-gray-400">總遊戲場次</p>
            </div>
            <div className="bg-avalon-card/50 border border-gray-600 rounded-lg p-3">
              <p className="text-2xl font-bold text-purple-400">{topElo}</p>
              <p className="text-xs text-gray-400">最高 ELO</p>
            </div>
          </div>
        </div>
      </motion.div>

      <div className="max-w-4xl mx-auto px-4 pb-16">
        {/* Tier Legend */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="flex flex-wrap justify-center gap-3 mb-6"
        >
          {[
            { label: '傳奇', color: 'text-yellow-400', min: 1800, icon: '👑' },
            { label: '大師', color: 'text-purple-400', min: 1700, icon: '💎' },
            { label: '白金', color: 'text-cyan-400', min: 1600, icon: '🏆' },
            { label: '黃金', color: 'text-yellow-500', min: 1500, icon: '🥇' },
            { label: '白銀', color: 'text-gray-300', min: 1400, icon: '🥈' },
            { label: '青銅', color: 'text-orange-400', min: 0, icon: '🥉' },
          ].map((t) => (
            <span
              key={t.label}
              className={`text-xs px-3 py-1 rounded-full bg-gray-800 border border-gray-600 ${t.color}`}
            >
              {t.icon} {t.label} ({t.min}+)
            </span>
          ))}
        </motion.div>

        {/* Table */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-avalon-card/50 border border-gray-600 rounded-xl overflow-hidden"
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-600 bg-gray-800/50 text-gray-400 text-sm">
                <th className="px-4 py-3 text-center w-12">#</th>
                <th className="px-4 py-3 text-left">玩家</th>
                <th className="px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <TrendingUp size={14} />
                    ELO
                  </div>
                </th>
                <th className="px-4 py-3 text-center">勝率</th>
                <th className="px-4 py-3 text-center hidden md:table-cell">慣用角色</th>
                <th className="px-4 py-3 text-center hidden lg:table-cell">
                  <div className="flex items-center justify-center gap-1">
                    <Users size={14} />
                    場次
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {MOCK_LEADERBOARD.map((entry) => (
                <EntryRow
                  key={entry.userId}
                  entry={entry}
                  isHighlighted={selected?.userId === entry.userId}
                  onClick={() => setSelected(selected?.userId === entry.userId ? null : entry)}
                />
              ))}
            </tbody>
          </table>
        </motion.div>

        {/* Selected Player Detail */}
        {selected && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-6 bg-avalon-card/50 border border-yellow-600/40 rounded-xl p-6"
          >
            <div className="flex items-start gap-4">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center font-bold text-2xl text-white shrink-0">
                {selected.displayName.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <h3 className="text-2xl font-bold text-white">{selected.displayName}</h3>
                  <span className={`text-sm font-semibold ${ELO_TIER(selected.eloRating).color}`}>
                    {ELO_TIER(selected.eloRating).icon} {ELO_TIER(selected.eloRating).label}
                  </span>
                </div>
                <p className="text-gray-400 text-sm mt-1">
                  ELO {selected.eloRating} · {selected.totalGames} 場 · {selected.winRate.toFixed(1)}% 勝率
                </p>

                {/* Badges */}
                <div className="mt-4">
                  <p className="text-xs text-gray-500 mb-2">徽章</p>
                  <div className="flex flex-wrap gap-2">
                    {selected.badges.map((bid) => {
                      const badge = ALL_BADGES.find((b) => b.id === bid);
                      if (!badge) return null;
                      return (
                        <motion.div
                          key={bid}
                          whileHover={{ scale: 1.05 }}
                          title={badge.description}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-gray-800/60 text-xs font-medium cursor-default ${BADGE_RARITY_COLORS[badge.rarity]}`}
                        >
                          <span>{badge.icon}</span>
                          <span>{badge.name}</span>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Rank medal */}
              <div className="text-4xl shrink-0">
                {selected.rank === 1 ? '🥇' : selected.rank === 2 ? '🥈' : selected.rank === 3 ? '🥉' : (
                  <span className="text-gray-400 font-bold text-2xl">#{selected.rank}</span>
                )}
              </div>
            </div>
          </motion.div>
        )}

        {/* API Note */}
        <p className="text-center text-xs text-gray-600 mt-8">
          資料來源：/api/leaderboard（目前顯示模擬資料）
        </p>
      </div>
    </div>
  );
}
