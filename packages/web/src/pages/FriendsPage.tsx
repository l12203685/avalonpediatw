import { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft, Users, TrendingUp, Loader, UserMinus, UserPlus,
  Search, CheckCircle2,
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  fetchFriends, unfollowUser, followUser, searchUsers,
  FriendEntry, UserSearchEntry,
} from '../services/api';
import { getStoredToken } from '../services/socket';
import { getEloRank } from '../utils/eloRank';

type FriendsTab = 'search' | 'following';

export default function FriendsPage(): JSX.Element {
  const { setGameState, navigateToProfile, addToast } = useGameStore();

  const [tab, setTab] = useState<FriendsTab>('search');
  const [guestBlocked, setGuestBlocked] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  // Following tab state
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(true);
  const [friendsError, setFriendsError] = useState('');
  const [unfollowing, setUnfollowing] = useState<string | null>(null);

  // Search tab state
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchEntry[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [followingId, setFollowingId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Initial guest check ────────────────────────────────────────
  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setGuestBlocked(true);
      setFriendsLoading(false);
      setAuthReady(true);
      return;
    }
    if (token.split('.').length !== 3) {
      setGuestBlocked(true);
      setFriendsLoading(false);
      setAuthReady(true);
      return;
    }
    setAuthReady(true);
    // Load following list up-front so the count badge is ready
    fetchFriends(token)
      .then(setFriends)
      .catch(() => setFriendsError('無法載入追蹤清單，請確認伺服器連線'))
      .finally(() => setFriendsLoading(false));
  }, []);

  // ── Debounced search ───────────────────────────────────────────
  useEffect(() => {
    if (!authReady || guestBlocked) return;
    if (tab !== 'search') return;

    const token = getStoredToken();
    if (!token) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchError('');

    debounceRef.current = setTimeout(() => {
      setSearchLoading(true);
      searchUsers(token, query)
        .then(setSearchResults)
        .catch(() => setSearchError('搜尋失敗，請稍後再試'))
        .finally(() => setSearchLoading(false));
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, tab, authReady, guestBlocked]);

  // ── Actions ────────────────────────────────────────────────────
  const handleFollow = async (target: UserSearchEntry): Promise<void> => {
    const token = getStoredToken();
    if (!token) return;
    setFollowingId(target.id);
    try {
      await followUser(token, target.id);
      setSearchResults((prev) =>
        prev.map((u) => (u.id === target.id ? { ...u, following: true } : u)),
      );
      // Also add to following list immediately
      setFriends((prev) => {
        if (prev.some((f) => f.id === target.id)) return prev;
        return [
          ...prev,
          {
            id:           target.id,
            display_name: target.display_name,
            photo_url:    target.photo_url,
            elo_rating:   target.elo_rating,
            badges:       target.badges,
          },
        ];
      });
      addToast(`已追蹤 ${target.display_name}`, 'success');
    } catch {
      addToast('追蹤失敗', 'error');
    } finally {
      setFollowingId(null);
    }
  };

  const handleUnfollow = async (userId: string, name: string): Promise<void> => {
    const token = getStoredToken();
    if (!token) return;
    setUnfollowing(userId);
    try {
      await unfollowUser(token, userId);
      setFriends((prev) => prev.filter((f) => f.id !== userId));
      setSearchResults((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, following: false } : u)),
      );
      addToast(`已取消追蹤 ${name}`, 'info');
    } catch {
      addToast('取消追蹤失敗', 'error');
    } finally {
      setUnfollowing(null);
    }
  };

  // ── Render helpers ─────────────────────────────────────────────
  const renderGuestNotice = (): JSX.Element => (
    <div className="bg-amber-900/30 border border-amber-700/60 rounded-xl p-6 text-center space-y-3">
      <UserPlus size={40} className="mx-auto text-amber-400 opacity-70" />
      <p className="text-amber-200 font-semibold">訪客模式無法使用好友功能</p>
      <p className="text-sm text-amber-200/80">請先以 Google / Discord / Line 登入帳號</p>
      <button
        onClick={() => setGameState('home')}
        className="mt-2 px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-sm transition-colors"
      >
        回首頁登入
      </button>
    </div>
  );

  const renderSearchResult = (user: UserSearchEntry): JSX.Element => {
    const rank = getEloRank(user.elo_rating);
    const isBusy = followingId === user.id || unfollowing === user.id;
    return (
      <div
        key={user.id}
        className="bg-avalon-card/60 border border-gray-700 rounded-xl p-4 flex items-center gap-3"
      >
        {user.photo_url ? (
          <img
            src={user.photo_url}
            alt=""
            className="w-10 h-10 rounded-full object-cover flex-shrink-0"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-amber-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
            {user.display_name[0]?.toUpperCase() || '?'}
          </div>
        )}

        <button
          className="flex-1 min-w-0 text-left"
          onClick={() => navigateToProfile(user.id)}
        >
          <div className="font-semibold text-white truncate">{user.display_name}</div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-[10px] text-gray-500 font-mono">#{user.short_code}</span>
            <TrendingUp size={11} className="text-blue-400" />
            <span className="text-xs text-blue-300">{user.elo_rating}</span>
            <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full border ${rank.color} ${rank.bgColor} ${rank.borderColor}`}>
              {rank.label}
            </span>
          </div>
        </button>

        {user.following ? (
          <button
            onClick={() => handleUnfollow(user.id, user.display_name)}
            disabled={isBusy}
            className="flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-red-900/40 border border-gray-700 hover:border-red-700 text-gray-400 hover:text-red-400 rounded-lg transition-all disabled:opacity-50"
          >
            <CheckCircle2 size={12} className="text-green-400" />
            {isBusy ? '…' : '已追蹤'}
          </button>
        ) : (
          <button
            onClick={() => handleFollow(user)}
            disabled={isBusy}
            className="flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1.5 bg-blue-700/80 hover:bg-blue-600 border border-blue-600 text-white rounded-lg transition-all disabled:opacity-50"
          >
            <UserPlus size={12} />
            {isBusy ? '…' : '追蹤'}
          </button>
        )}
      </div>
    );
  };

  // ── Main layout ────────────────────────────────────────────────
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
            <Users size={22} className="text-blue-400" />
            <h1 className="text-2xl font-black text-white">好友 / 追蹤</h1>
          </div>
          <span className="ml-auto text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded-full">
            {friendsLoading ? '…' : `${friends.length} 人`}
          </span>
        </div>

        {guestBlocked && renderGuestNotice()}

        {!guestBlocked && (
          <>
            {/* Tabs */}
            <div className="flex gap-1 bg-avalon-card/40 border border-gray-700 rounded-xl p-1">
              <button
                onClick={() => setTab('search')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-1.5 ${
                  tab === 'search'
                    ? 'bg-blue-700/70 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Search size={14} /> 搜尋玩家
              </button>
              <button
                onClick={() => setTab('following')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-1.5 ${
                  tab === 'following'
                    ? 'bg-blue-700/70 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Users size={14} /> 追蹤中 ({friends.length})
              </button>
            </div>

            {/* Search tab */}
            {tab === 'search' && (
              <div className="space-y-3">
                <div className="relative">
                  <Search
                    size={16}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
                  />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="輸入暱稱或玩家編號（末 6 碼）"
                    maxLength={60}
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-avalon-card/60 border border-gray-700 focus:border-blue-500 text-white placeholder-gray-500 outline-none transition-colors"
                  />
                </div>

                {searchError && (
                  <div className="bg-red-900/50 border border-red-600 rounded-xl p-3 text-red-200 text-sm text-center">
                    {searchError}
                  </div>
                )}

                {searchLoading && (
                  <div className="flex justify-center pt-6">
                    <Loader size={24} className="animate-spin text-blue-400" />
                  </div>
                )}

                {!searchLoading && !searchError && searchResults.length === 0 && (
                  <div className="text-center py-12 text-gray-500 space-y-2">
                    <Users size={40} className="mx-auto opacity-30" />
                    <p className="text-sm">
                      {query.trim() === '' ? '輸入關鍵字開始搜尋' : '找不到符合的玩家'}
                    </p>
                  </div>
                )}

                {!searchLoading && searchResults.length > 0 && (
                  <div className="space-y-2">
                    {searchResults.map(renderSearchResult)}
                  </div>
                )}
              </div>
            )}

            {/* Following tab */}
            {tab === 'following' && (
              <div className="space-y-3">
                {friendsLoading && (
                  <div className="flex justify-center pt-10">
                    <Loader size={32} className="animate-spin text-blue-400" />
                  </div>
                )}

                {friendsError && (
                  <div className="bg-red-900/50 border border-red-600 rounded-xl p-4 text-red-200 text-sm text-center">
                    {friendsError}
                  </div>
                )}

                {!friendsLoading && !friendsError && friends.length === 0 && (
                  <div className="text-center py-16 text-gray-500 space-y-3">
                    <Users size={48} className="mx-auto opacity-30" />
                    <p>還沒有追蹤任何玩家</p>
                    <p className="text-sm text-gray-600">
                      切到「搜尋玩家」分頁，找對手並按「追蹤」加入清單
                    </p>
                    <button
                      onClick={() => setTab('search')}
                      className="mt-2 text-sm text-blue-400 hover:text-blue-300 underline transition-colors"
                    >
                      去搜尋玩家
                    </button>
                  </div>
                )}

                {!friendsLoading && !friendsError && friends.length > 0 && (
                  <div className="space-y-2">
                    {friends.map((friend) => {
                      const rank = getEloRank(friend.elo_rating);
                      return (
                        <div
                          key={friend.id}
                          className="bg-avalon-card/60 border border-gray-700 rounded-xl p-4 flex items-center gap-3"
                        >
                          {friend.photo_url ? (
                            <img
                              src={friend.photo_url}
                              alt=""
                              className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-amber-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                              {friend.display_name[0]?.toUpperCase()}
                            </div>
                          )}

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
                                {friend.badges.slice(0, 3).map((b) => (
                                  <span key={b} className="text-xs px-1.5 py-0.5 bg-amber-900/50 border border-amber-700/50 text-amber-300 rounded-full">
                                    {b}
                                  </span>
                                ))}
                                {friend.badges.length > 3 && (
                                  <span className="text-xs text-gray-600">+{friend.badges.length - 3}</span>
                                )}
                              </div>
                            )}
                          </button>

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
            )}
          </>
        )}
      </div>
    </div>
  );
}
