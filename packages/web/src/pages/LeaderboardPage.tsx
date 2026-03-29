import { useState, useEffect } from 'react';
import { Trophy, ArrowLeft, Crown, TrendingUp, Users, Loader } from 'lucide-react';
import { getEloRank } from '../utils/eloRank';
import { useGameStore } from '../store/gameStore';
import { fetchLeaderboard, LeaderboardEntry } from '../services/api';

const PROVIDER_BADGE: Record<string, string> = {
  google:  'G',
  discord: 'D',
  line:    'L',
  email:   'E',
  guest:   '?',
};

const RANK_COLORS = ['text-yellow-400', 'text-gray-300', 'text-amber-600'];

export default function LeaderboardPage(): JSX.Element {
  const { setGameState, navigateToProfile } = useGameStore();
  const [entries, setEntries]   = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');

  useEffect(() => {
    fetchLeaderboard()
      .then(setEntries)
      .catch(() => setError('無法載入排行榜，請確認伺服器連線'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('home')}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex items-center gap-2">
            <Trophy size={24} className="text-yellow-400" />
            <h1 className="text-2xl font-black text-white">排行榜 (Leaderboard)</h1>
          </div>
        </div>

        {loading && (
          <div className="flex justify-center pt-10">
            <Loader size={32} className="animate-spin text-blue-400" />
          </div>
        )}

        {error && (
          <div className="bg-red-900/50 border border-red-600 rounded-xl p-4 text-red-200 text-sm text-center">
            {error}
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            <Users size={48} className="mx-auto mb-3 opacity-40" />
            <p>還沒有排行榜資料 (No leaderboard data yet)</p>
            <p className="text-sm mt-1">完成遊戲後將自動更新 (Auto-updates after completing games)</p>
          </div>
        )}

        {/* List */}
        {entries.length > 0 && (
          <div className="space-y-2">
            {entries.map((entry, idx) => (
              <button
                key={entry.id}
                onClick={() => navigateToProfile(entry.id)}
                className="w-full bg-avalon-card/60 hover:bg-avalon-card/90 border border-gray-700 hover:border-blue-500/50 rounded-xl p-4 flex items-center gap-4 transition-all text-left"
              >
                {/* Rank */}
                <div className={`w-8 text-center font-black text-lg ${RANK_COLORS[idx] ?? 'text-gray-500'}`}>
                  {idx === 0 ? <Crown size={20} className="mx-auto text-yellow-400" /> : idx + 1}
                </div>

                {/* Avatar */}
                {entry.photo_url ? (
                  <img src={entry.photo_url} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center text-white font-bold text-sm">
                    {entry.display_name[0]?.toUpperCase()}
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white truncate">{entry.display_name}</span>
                    <span className="text-xs px-1.5 py-0.5 bg-gray-700 rounded text-gray-400">
                      {PROVIDER_BADGE[entry.provider] ?? '?'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5">
                    <span>{entry.games_won}勝 {entry.games_lost}敗</span>
                    <span className="text-green-400">{entry.win_rate}%</span>
                  </div>
                  {entry.badges.length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {entry.badges.slice(0, 4).map(b => (
                        <span key={b} className="text-xs px-1.5 py-0.5 bg-purple-900/50 border border-purple-700/50 text-purple-300 rounded-full">
                          {b}
                        </span>
                      ))}
                      {entry.badges.length > 4 && (
                        <span className="text-xs text-gray-600">+{entry.badges.length - 4}</span>
                      )}
                    </div>
                  )}
                </div>

                {/* ELO + Rank */}
                <div className="text-right">
                  <div className="flex items-center gap-1 justify-end">
                    <TrendingUp size={14} className="text-blue-400" />
                    <span className="font-bold text-white text-lg">{entry.elo_rating}</span>
                  </div>
                  {(() => {
                    const rank = getEloRank(entry.elo_rating);
                    return (
                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full border ${rank.color} ${rank.bgColor} ${rank.borderColor}`}>
                        {rank.label}
                      </span>
                    );
                  })()}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
