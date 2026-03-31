import { motion } from 'framer-motion';
import { ArrowLeft, TrendingUp, Award, Calendar, Clock, Play } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  MOCK_MY_PROFILE,
  ALL_BADGES,
  BADGE_RARITY_COLORS,
  ROLE_DISPLAY,
  RecentGame,
} from '../data/mockData';

// ─── Win-Rate Bar Chart ──────────────────────────────────────────────────────

function RoleWinRateChart(): JSX.Element {
  const { winRateByRole } = MOCK_MY_PROFILE;

  return (
    <div className="space-y-3">
      {Object.entries(winRateByRole).map(([role, stats]) => {
        const display = ROLE_DISPLAY[role];
        if (!display) return null;
        return (
          <div key={role}>
            <div className="flex items-center justify-between mb-1">
              <span className={`text-sm font-medium ${display.color}`}>
                {display.icon} {display.label}
              </span>
              <span className="text-xs text-gray-400">
                {stats.won}/{stats.played} 場 ({stats.winRate.toFixed(0)}%)
              </span>
            </div>
            <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${stats.winRate}%` }}
                transition={{ duration: 0.8, ease: 'easeOut', delay: 0.2 }}
                className={`h-full rounded-full ${
                  stats.winRate >= 65
                    ? 'bg-gradient-to-r from-green-500 to-green-400'
                    : stats.winRate >= 50
                    ? 'bg-gradient-to-r from-blue-500 to-blue-400'
                    : 'bg-gradient-to-r from-red-600 to-red-500'
                }`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Quest Result Dots ───────────────────────────────────────────────────────

function QuestDots({ results }: { results: RecentGame['questResults'] }): JSX.Element {
  return (
    <div className="flex items-center gap-1">
      {results.map((r, i) => (
        <div
          key={i}
          className={`w-3 h-3 rounded-full ${r === 'success' ? 'bg-green-500' : 'bg-red-500'}`}
          title={r === 'success' ? '成功' : '失敗'}
        />
      ))}
    </div>
  );
}

// ─── Recent Game Row ─────────────────────────────────────────────────────────

function RecentGameRow({ game }: { game: RecentGame }): JSX.Element {
  const role = ROLE_DISPLAY[game.role];
  const ago = (() => {
    const diff = Date.now() - game.playedAt;
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(diff / 86400000);
    if (d > 0) return `${d} 天前`;
    if (h > 0) return `${h} 小時前`;
    return '剛才';
  })();

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      className={`flex items-center gap-4 p-4 rounded-lg border ${
        game.won
          ? 'bg-green-900/20 border-green-700/40'
          : 'bg-red-900/20 border-red-700/40'
      }`}
    >
      {/* Win/Loss */}
      <div className={`text-lg font-black w-8 text-center ${game.won ? 'text-green-400' : 'text-red-400'}`}>
        {game.won ? 'W' : 'L'}
      </div>

      {/* Role */}
      <div className="w-24 shrink-0">
        {role ? (
          <span className={`text-sm font-medium ${role.color}`}>
            {role.icon} {role.label}
          </span>
        ) : (
          <span className="text-gray-400 text-sm">{game.role}</span>
        )}
      </div>

      {/* Quest dots */}
      <div className="flex-1">
        <QuestDots results={game.questResults} />
        <p className="text-xs text-gray-500 mt-1">
          {game.winner === 'good' ? '⚔️ 好陣營勝' : '👹 邪惡陣營勝'} · {game.playerCount} 人局
        </p>
      </div>

      {/* Duration + Time + Replay */}
      <div className="text-right shrink-0 space-y-1">
        <div className="flex items-center gap-1 text-xs text-gray-400 justify-end">
          <Clock size={12} />
          {game.durationMinutes} 分鐘
        </div>
        <div className="flex items-center gap-1 text-xs text-gray-500 justify-end">
          <Calendar size={12} />
          {ago}
        </div>
        <ReplayButton roomId={game.roomId} />
      </div>
    </motion.div>
  );
}

function ReplayButton({ roomId }: { roomId: string }): JSX.Element {
  const { setGameState, setReplayRoomId } = useGameStore();
  return (
    <button
      onClick={() => { setReplayRoomId(roomId); setGameState('replay'); }}
      className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors"
    >
      <Play size={11} />
      回放
    </button>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function ProfilePage(): JSX.Element {
  const { setGameState, setReplayRoomId } = useGameStore();
  const profile = MOCK_MY_PROFILE;

  const favoriteRole = ROLE_DISPLAY[profile.favoriteRole ?? ''];
  const eloChange = +15; // mock recent ELO change

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

      {/* Profile Hero */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-r from-blue-600/20 to-purple-600/20 border-b border-gray-700 px-8 pt-16 pb-8 mb-8"
      >
        <div className="max-w-4xl mx-auto">
          <div className="flex flex-col md:flex-row items-center md:items-start gap-6">
            {/* Avatar */}
            <motion.div
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-4xl font-bold text-white border-4 border-purple-400 shadow-lg shadow-purple-400/30 shrink-0"
            >
              {profile.displayName.charAt(0)}
            </motion.div>

            {/* Info */}
            <div className="text-center md:text-left flex-1">
              <h1 className="text-3xl font-bold text-white">{profile.displayName}</h1>
              <div className="flex items-center gap-3 justify-center md:justify-start mt-2 flex-wrap">
                <span className="flex items-center gap-1 text-yellow-400 font-semibold">
                  <TrendingUp size={16} />
                  ELO {profile.eloRating}
                </span>
                {eloChange > 0 ? (
                  <span className="text-green-400 text-sm">+{eloChange}</span>
                ) : (
                  <span className="text-red-400 text-sm">{eloChange}</span>
                )}
                {favoriteRole && (
                  <span className={`text-sm ${favoriteRole.color}`}>
                    {favoriteRole.icon} 擅長 {favoriteRole.label}
                  </span>
                )}
              </div>
            </div>

            {/* Summary Stats */}
            <div className="grid grid-cols-3 gap-3 shrink-0">
              <div className="text-center bg-avalon-card/60 rounded-lg p-3 border border-gray-600">
                <p className="text-2xl font-bold text-white">{profile.totalGames}</p>
                <p className="text-xs text-gray-400">場次</p>
              </div>
              <div className="text-center bg-green-900/30 rounded-lg p-3 border border-green-700/40">
                <p className="text-2xl font-bold text-green-400">{profile.gamesWon}</p>
                <p className="text-xs text-gray-400">勝場</p>
              </div>
              <div className="text-center bg-blue-900/30 rounded-lg p-3 border border-blue-700/40">
                <p className="text-2xl font-bold text-blue-400">{profile.winRate.toFixed(1)}%</p>
                <p className="text-xs text-gray-400">勝率</p>
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      <div className="max-w-4xl mx-auto px-4 pb-16 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Win Rate by Role */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-avalon-card/50 border border-gray-600 rounded-xl p-6"
          >
            <h2 className="text-lg font-bold text-white mb-5 flex items-center gap-2">
              <TrendingUp size={18} className="text-blue-400" />
              各角色勝率
            </h2>
            <RoleWinRateChart />
          </motion.div>

          {/* Badges */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="bg-avalon-card/50 border border-gray-600 rounded-xl p-6"
          >
            <h2 className="text-lg font-bold text-white mb-5 flex items-center gap-2">
              <Award size={18} className="text-yellow-400" />
              成就徽章
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {ALL_BADGES.map((badge) => {
                const unlocked = profile.badges.includes(badge.id);
                return (
                  <motion.div
                    key={badge.id}
                    whileHover={{ scale: 1.03 }}
                    className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                      unlocked
                        ? `bg-gray-800/60 ${BADGE_RARITY_COLORS[badge.rarity].split(' ')[0]}`
                        : 'bg-gray-800/20 border-gray-700 opacity-40'
                    }`}
                  >
                    <span className="text-2xl">{badge.icon}</span>
                    <div className="min-w-0">
                      <p className={`text-sm font-semibold truncate ${unlocked ? BADGE_RARITY_COLORS[badge.rarity].split(' ')[1] : 'text-gray-500'}`}>
                        {badge.name}
                      </p>
                      <p className="text-xs text-gray-500 truncate">{badge.description}</p>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        </div>

        {/* Recent Games */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-avalon-card/50 border border-gray-600 rounded-xl p-6"
        >
          <h2 className="text-lg font-bold text-white mb-5 flex items-center gap-2">
            <Calendar size={18} className="text-purple-400" />
            近期對戰記錄
          </h2>
          <div className="space-y-3">
            {profile.recentGames.map((game) => (
              <RecentGameRow key={game.id} game={game} />
            ))}
          </div>
        </motion.div>

        <p className="text-center text-xs text-gray-600">
          資料來源：/api/profile/me（目前顯示模擬資料）
        </p>
      </div>
    </div>
  );
}
