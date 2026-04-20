import { useState, useEffect, useMemo } from 'react';
import { Trophy, ArrowLeft, Crown, TrendingUp, Users, Loader, Search, AlertTriangle } from 'lucide-react';
import { ALL_TIERS, ROOKIE_TIER, rankLeaderboard, type EloRank } from '../utils/eloRank';
import { useGameStore } from '../store/gameStore';
import type { LeaderboardEntry } from '../services/api';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:3001';

const PROVIDER_BADGE: Record<string, string> = {
  google:  'G',
  discord: 'D',
  line:    'L',
  email:   'E',
  guest:   '?',
};

const RANK_COLORS = ['text-yellow-400', 'text-gray-300', 'text-amber-600'];

const ALL_RANK_LABELS = ['全部', ...ALL_TIERS.map(r => r.label)];

export default function LeaderboardPage(): JSX.Element {
  const { setGameState, navigateToProfile } = useGameStore();
  const [entries, setEntries]   = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [dbOffline, setDbOffline] = useState(false);
  const [search, setSearch]     = useState('');
  const [rankFilter, setRankFilter] = useState('全部');

  useEffect(() => {
    // Fetch raw to detect "Database not configured" message
    fetch(`${SERVER_URL}/api/leaderboard`)
      .then(r => r.json() as Promise<{ leaderboard?: LeaderboardEntry[]; message?: string }>)
      .then(data => {
        if (data.message === 'Database not configured') setDbOffline(true);
        setEntries(data.leaderboard ?? []);
      })
      .catch(() => setError('無法載入排行榜，請確認伺服器連線'))
      .finally(() => setLoading(false));
  }, []);

  // Compute tier per entry using the percentile-based distribution.
  // Re-runs only when the underlying entries change.
  const tierMap = useMemo(() => rankLeaderboard(entries), [entries]);

  const getTier = (entry: LeaderboardEntry): EloRank =>
    tierMap.get(entry.id) ?? ROOKIE_TIER;

  const filtered = useMemo(() => {
    let result = entries;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(e => e.display_name.toLowerCase().includes(q));
    }
    if (rankFilter !== '全部') {
      result = result.filter(e => getTier(e).label === rankFilter);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, search, rankFilter, tierMap]);

  const isFiltered = search.trim() !== '' || rankFilter !== '全部';

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

        {/* DB offline banner */}
        {dbOffline && (
          <div className="flex items-start gap-3 bg-yellow-900/30 border border-yellow-700/50 rounded-xl px-4 py-3 text-sm text-yellow-300">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">資料庫未連線 (Database offline)</p>
              <p className="text-xs text-yellow-400/70 mt-0.5">ELO 排名暫時不可用。遊戲功能正常運作，數據將在資料庫恢復後顯示。</p>
            </div>
          </div>
        )}

        {/* Search + Rank Filter */}
        {!loading && !error && entries.length > 0 && (
          <div className="space-y-3">
            {/* Search bar */}
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="搜尋玩家名稱..."
                className="w-full bg-avalon-card/60 border border-gray-700 focus:border-blue-500/70 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none transition-colors"
              />
            </div>

            {/* Rank tier pills */}
            <div className="flex flex-wrap gap-1.5">
              {ALL_RANK_LABELS.map(label => {
                const rankDef = ALL_TIERS.find(r => r.label === label);
                const isActive = rankFilter === label;
                if (label === '全部') {
                  return (
                    <button
                      key={label}
                      onClick={() => setRankFilter('全部')}
                      className={`text-xs px-2.5 py-1 rounded-full border font-semibold transition-all ${
                        isActive
                          ? 'bg-white/20 border-white/50 text-white'
                          : 'bg-gray-800/60 border-gray-600 text-gray-400 hover:border-gray-400 hover:text-gray-200'
                      }`}
                    >
                      全部
                    </button>
                  );
                }
                if (!rankDef) return null;
                return (
                  <button
                    key={label}
                    onClick={() => setRankFilter(label)}
                    className={`text-xs px-2.5 py-1 rounded-full border font-semibold transition-all ${
                      isActive
                        ? `${rankDef.color} ${rankDef.bgColor} ${rankDef.borderColor}`
                        : 'bg-gray-800/60 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {/* Result count when filtered */}
            {isFiltered && (
              <p className="text-xs text-gray-500">
                顯示 <span className="text-gray-300 font-semibold">{filtered.length}</span> / 總計 <span className="text-gray-300 font-semibold">{entries.length}</span> 人
              </p>
            )}
          </div>
        )}

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

        {!loading && !error && !dbOffline && entries.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            <Users size={48} className="mx-auto mb-3 opacity-40" />
            <p>還沒有排行榜資料 (No leaderboard data yet)</p>
            <p className="text-sm mt-1">完成遊戲後將自動更新 (Auto-updates after completing games)</p>
          </div>
        )}

        {/* Empty state when search/filter yields no results */}
        {!loading && !error && entries.length > 0 && filtered.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <Search size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">找不到符合條件的玩家</p>
            <p className="text-xs mt-1 text-gray-600">請嘗試其他搜尋條件</p>
          </div>
        )}

        {/* List */}
        {filtered.length > 0 && (
          <div className="space-y-2">
            {filtered.map((entry, idx) => (
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
                    const rank = getTier(entry);
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
