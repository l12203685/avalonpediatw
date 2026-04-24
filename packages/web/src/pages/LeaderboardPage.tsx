/**
 * LeaderboardPage — Edward 2026-04-24 重寫（5 tab 純數字 label 版）。
 *
 * - 從 `/api/leaderboard/v2` 取雙維度分類排行榜
 *   → `{ version: 2, groups: { rookie, regular, veteran, expert, master } }`
 * - 5 個 tab 為「場次組 TierGroup」（純數字門檻 label，取代舊 菜鳥/老手/大師…）：
 *     < 100 場 / ≥ 100 場 / ≥ 150 場 / ≥ 200 場 / ≥ 250 場
 * - 每張玩家卡顯示：頭像 / 暱稱 / 場次 / 勝率 / 理論勝率 / ELO + ELO 標籤 pill
 *   （入門新手 / 中堅玩家 / 頂尖高玩）
 * - 組內搜尋（filter 該 tab 內的玩家）
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Trophy,
  ArrowLeft,
  Crown,
  TrendingUp,
  Users,
  Loader,
  Search,
  AlertTriangle,
} from 'lucide-react';
import {
  TIER_GROUP_LABEL_ZH,
  ELO_TAG_ZH,
  type TierGroup,
  type EloTag,
  type LeaderboardEntryV2,
} from '@avalon/shared';
import { useGameStore } from '../store/gameStore';
import { NGROK_SKIP_HEADER } from '../services/api';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:3001';

/** TierGroup 顯示順序（低 → 高場次） */
const TIER_GROUPS: readonly TierGroup[] = [
  'rookie',
  'regular',
  'veteran',
  'expert',
  'master',
] as const;

/**
 * V2 endpoint entry shape（含 displayName/photoUrl — 由後端 enrich）。
 * 結構見：GET /api/leaderboard/v2 response.groups[TierGroup][N]。
 */
interface LeaderboardEntryV2Enriched extends LeaderboardEntryV2 {
  displayName?: string | null;
  photoUrl?: string | null;
}

interface LeaderboardV2Response {
  version: 2;
  groups: Record<TierGroup, LeaderboardEntryV2Enriched[]>;
}

/** ELO tag pill 配色 */
const ELO_TAG_STYLE: Record<EloTag, { text: string; bg: string; border: string }> = {
  novice_tag: { text: 'text-green-400', bg: 'bg-green-900/40', border: 'border-green-700' },
  mid_tag: { text: 'text-blue-400', bg: 'bg-blue-900/40', border: 'border-blue-700' },
  top_tag: { text: 'text-yellow-400', bg: 'bg-yellow-900/40', border: 'border-yellow-700' },
};

/** Tab (TierGroup) pill 配色（高組較亮） */
const TIER_TAB_STYLE: Record<TierGroup, string> = {
  rookie: 'bg-gray-700/60 text-gray-200 border-gray-500',
  regular: 'bg-blue-900/60 text-blue-200 border-blue-600',
  veteran: 'bg-purple-900/60 text-purple-200 border-purple-600',
  expert: 'bg-orange-900/60 text-orange-200 border-orange-600',
  master: 'bg-yellow-900/60 text-yellow-200 border-yellow-500',
};

const RANK_COLORS = ['text-yellow-400', 'text-gray-300', 'text-amber-600'];

export default function LeaderboardPage(): JSX.Element {
  const { t } = useTranslation(['leaderboard', 'common']);
  const { setGameState, navigateToProfile } = useGameStore();

  const [groups, setGroups] = useState<Record<TierGroup, LeaderboardEntryV2Enriched[]> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dbOffline, setDbOffline] = useState(false);
  const [activeTier, setActiveTier] = useState<TierGroup>('rookie');
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch(`${SERVER_URL}/api/leaderboard/v2`, { headers: NGROK_SKIP_HEADER })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as LeaderboardV2Response | { message: string };
      })
      .then((data) => {
        if ('message' in data && data.message === 'Database not configured') {
          setDbOffline(true);
          return;
        }
        const payload = data as LeaderboardV2Response;
        if (payload?.groups) {
          setGroups(payload.groups);
        } else {
          setError(t('leaderboard:loadFailed'));
        }
      })
      .catch(() => setError(t('leaderboard:loadFailed')))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 當前 tab 的玩家（依 search 過濾） */
  const filtered = useMemo<LeaderboardEntryV2Enriched[]>(() => {
    if (!groups) return [];
    const list = groups[activeTier] ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((e) => {
      const name = (e.displayName ?? e.playerId).toLowerCase();
      return name.includes(q);
    });
  }, [groups, activeTier, search]);

  /** 每個 tab 的玩家數（用於 tab 標籤右上角 badge） */
  const tierCounts = useMemo<Record<TierGroup, number>>(() => {
    const out: Record<TierGroup, number> = {
      rookie: 0,
      regular: 0,
      veteran: 0,
      expert: 0,
      master: 0,
    };
    if (!groups) return out;
    for (const g of TIER_GROUPS) {
      out[g] = groups[g]?.length ?? 0;
    }
    return out;
  }, [groups]);

  const totalInTier = tierCounts[activeTier];
  const isFiltered = search.trim() !== '' && groups !== null;

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
            <h1 className="text-2xl font-black text-white">{t('leaderboard:title')}</h1>
          </div>
        </div>

        {/* DB offline banner */}
        {dbOffline && (
          <div className="flex items-start gap-3 bg-yellow-900/30 border border-yellow-700/50 rounded-xl px-4 py-3 text-sm text-yellow-300">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">{t('leaderboard:dbOffline')}</p>
              <p className="text-xs text-yellow-400/70 mt-0.5">{t('leaderboard:dbOfflineHint')}</p>
            </div>
          </div>
        )}

        {/* 5 TierGroup tabs */}
        {!loading && !error && !dbOffline && groups && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5" role="tablist">
              {TIER_GROUPS.map((tier) => {
                const label = TIER_GROUP_LABEL_ZH[tier];
                const count = tierCounts[tier];
                const isActive = activeTier === tier;
                return (
                  <button
                    key={tier}
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => {
                      setActiveTier(tier);
                      setSearch('');
                    }}
                    className={`text-xs px-2.5 py-1.5 rounded-full border font-semibold transition-all ${
                      isActive
                        ? `${TIER_TAB_STYLE[tier]}`
                        : 'bg-gray-800/60 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                    }`}
                  >
                    <span>{label}</span>
                    <span className="ml-1.5 text-[10px] opacity-70">({count})</span>
                  </button>
                );
              })}
            </div>

            {/* Search within active tab */}
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('leaderboard:searchPlaceholder')}
                className="w-full bg-avalon-card/60 border border-gray-700 focus:border-blue-500/70 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none transition-colors"
              />
            </div>

            {isFiltered && (
              <p className="text-xs text-gray-500">
                {t('leaderboard:showingCount', {
                  filtered: filtered.length,
                  total: totalInTier,
                })}
              </p>
            )}
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="flex justify-center pt-10">
            <Loader size={32} className="animate-spin text-blue-400" />
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="bg-red-900/50 border border-red-600 rounded-xl p-4 text-red-200 text-sm text-center">
            {error}
          </div>
        )}

        {/* Empty — no data at all */}
        {!loading && !error && !dbOffline && groups && totalInTier === 0 && !isFiltered && (
          <div className="text-center py-12 text-gray-500">
            <Users size={48} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm">{t('leaderboard:groupEmpty')}</p>
          </div>
        )}

        {/* Empty — search/filter yielded no results */}
        {!loading && !error && groups && totalInTier > 0 && filtered.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <Search size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t('leaderboard:noResults')}</p>
            <p className="text-xs mt-1 text-gray-600">{t('leaderboard:noResultsHint')}</p>
          </div>
        )}

        {/* Player cards — active tier's filtered list */}
        {filtered.length > 0 && (
          <div className="space-y-2">
            {filtered.map((entry, idx) => {
              const tagStyle = ELO_TAG_STYLE[entry.eloTag] ?? ELO_TAG_STYLE.mid_tag;
              const name = entry.displayName ?? entry.playerId;
              const winPct = Math.round((entry.winRate ?? 0) * 100);
              const theoPct = Math.round((entry.theoreticalWinRate ?? 0) * 100);
              return (
                <button
                  key={entry.playerId}
                  onClick={() => navigateToProfile(entry.playerId)}
                  className="w-full bg-avalon-card/60 hover:bg-avalon-card/90 border border-gray-700 hover:border-blue-500/50 rounded-xl p-4 flex items-center gap-4 transition-all text-left"
                >
                  {/* Rank (1/2/3 highlighted) */}
                  <div
                    className={`w-8 text-center font-black text-lg ${
                      RANK_COLORS[idx] ?? 'text-gray-500'
                    }`}
                  >
                    {idx === 0 ? (
                      <Crown size={20} className="mx-auto text-yellow-400" />
                    ) : (
                      idx + 1
                    )}
                  </div>

                  {/* Avatar */}
                  {entry.photoUrl ? (
                    <img
                      src={entry.photoUrl}
                      alt=""
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-amber-600 flex items-center justify-center text-white font-bold text-sm">
                      {name[0]?.toUpperCase()}
                    </div>
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white truncate">{name}</span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${tagStyle.text} ${tagStyle.bg} ${tagStyle.border}`}
                      >
                        {ELO_TAG_ZH[entry.eloTag] ?? entry.eloTag}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5 flex-wrap">
                      <span>
                        {entry.totalGames} {t('leaderboard:games')}
                      </span>
                      <span className="text-blue-400">
                        {t('leaderboard:winRate')} {winPct}%
                      </span>
                      <span className="text-emerald-400">
                        {t('leaderboard:theoreticalWinRate')} {theoPct}%
                      </span>
                    </div>
                  </div>

                  {/* ELO */}
                  <div className="text-right">
                    <div className="flex items-center gap-1 justify-end">
                      <TrendingUp size={14} className="text-blue-400" />
                      <span className="font-bold text-white text-lg">{entry.elo}</span>
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5">
                      {t('leaderboard:elo')}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
