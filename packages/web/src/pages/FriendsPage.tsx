import { useState, useEffect } from 'react';
import { ArrowLeft, Users, TrendingUp, Loader, UserMinus, UserPlus } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { fetchFriends, unfollowUser, FriendEntry } from '../services/api';
import { getStoredToken } from '../services/socket';
import { getEloRank } from '../utils/eloRank';

export default function FriendsPage(): JSX.Element {
  const { setGameState, navigateToProfile, addToast } = useGameStore();
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [unfollowing, setUnfollowing] = useState<string | null>(null);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) { setError('請先登入'); setLoading(false); return; }
    // Guest tokens are JSON (not a 3-part JWT) and carry no Supabase identity,
    // so the /api/friends endpoint will always 401/503 for them. Short-circuit
    // with a clearer message instead of showing "伺服器連線失敗".
    if (token.split('.').length !== 3) {
      setError('訪客模式無法使用追蹤功能，請先登入帳號');
      setLoading(false);
      return;
    }
    fetchFriends(token)
      .then(setFriends)
      .catch(() => setError('無法載入好友列表，請確認伺服器連線'))
      .finally(() => setLoading(false));
  }, []);

  const handleUnfollow = async (userId: string, name: string): Promise<void> => {
    const token = getStoredToken();
    if (!token) return;
    setUnfollowing(userId);
    try {
      await unfollowUser(token, userId);
      setFriends(prev => prev.filter(f => f.id !== userId));
      addToast(`已取消追蹤 ${name}`, 'info');
    } catch {
      addToast('取消追蹤失敗', 'error');
    } finally {
      setUnfollowing(null);
    }
  };

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-lg mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('home')}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex items-center gap-2">
            <UserPlus size={22} className="text-blue-400" />
            <h1 className="text-2xl font-black text-white">追蹤列表 (Following)</h1>
          </div>
          {!loading && (
            <span className="ml-auto text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded-full">
              {friends.length} 人
            </span>
          )}
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

        {!loading && !error && friends.length === 0 && (
          <div className="text-center py-16 text-gray-500 space-y-3">
            <Users size={48} className="mx-auto opacity-30" />
            <p>還沒有追蹤任何玩家</p>
            <p className="text-sm text-gray-600">在玩家個人頁面點擊「追蹤」來加入好友</p>
            <button
              onClick={() => setGameState('leaderboard')}
              className="mt-2 text-sm text-blue-400 hover:text-blue-300 underline transition-colors"
            >
              前往排行榜找玩家
            </button>
          </div>
        )}

        {!loading && !error && friends.length > 0 && (
          <div className="space-y-2">
            {friends.map(friend => {
              const rank = getEloRank(friend.elo_rating);
              return (
                <div
                  key={friend.id}
                  className="bg-avalon-card/60 border border-gray-700 rounded-xl p-4 flex items-center gap-3"
                >
                  {/* Avatar */}
                  {friend.photo_url ? (
                    <img
                      src={friend.photo_url}
                      alt=""
                      className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                      {friend.display_name[0]?.toUpperCase()}
                    </div>
                  )}

                  {/* Info */}
                  <button
                    className="flex-1 min-w-0 text-left"
                    onClick={() => navigateToProfile(friend.id)}
                  >
                    <div className="font-semibold text-white truncate">{friend.display_name}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <TrendingUp size={11} className="text-blue-400" />
                      <span className="text-xs text-blue-300">{friend.elo_rating}</span>
                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full border ${rank.color} ${rank.bgColor} ${rank.borderColor}`}>
                        {rank.label}
                      </span>
                    </div>
                    {friend.badges.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {friend.badges.slice(0, 3).map(b => (
                          <span key={b} className="text-xs px-1.5 py-0.5 bg-purple-900/50 border border-purple-700/50 text-purple-300 rounded-full">
                            {b}
                          </span>
                        ))}
                        {friend.badges.length > 3 && (
                          <span className="text-xs text-gray-600">+{friend.badges.length - 3}</span>
                        )}
                      </div>
                    )}
                  </button>

                  {/* Unfollow */}
                  <button
                    onClick={() => handleUnfollow(friend.id, friend.display_name)}
                    disabled={unfollowing === friend.id}
                    className="flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-red-900/40 border border-gray-700 hover:border-red-700 text-gray-400 hover:text-red-400 rounded-lg transition-all disabled:opacity-50"
                  >
                    <UserMinus size={12} />
                    {unfollowing === friend.id ? '…' : '取消追蹤'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
