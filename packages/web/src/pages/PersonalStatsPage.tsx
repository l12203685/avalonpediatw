import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Users, Swords, History, Loader, AlertCircle } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { getStoredToken } from '../services/socket';
import {
  fetchFriends, fetchPairStatsBatch, fetchMyTimeline,
  FriendEntry, PairStats, TimelineEntry,
} from '../services/api';

/**
 * #98 IA 瘦身版 (2026-04-23)
 *
 * Edward 原話：
 *   個人戰績只需要保留
 *     (1) 近 50 場遊戲勝敗時間序列（點了可以看紀錄）
 *     (2) 玩家追蹤列表 & 對戰歷史（同贏率、同敗率、獨立勝率）
 *
 * 所有「深度分析 / nav.analysis / ProfilePage 的能力雷達」內容已移走到「數據排行」頁。
 *
 * 獨立勝率 = 排除同場後我方理論勝率
 *   = (我不與對方同場的場次中，我贏的次數) / (我不與對方同場的場次)
 */
export default function PersonalStatsPage(): JSX.Element {
  const { t } = useTranslation();
  const { setGameState, navigateToProfile, navigateToReplay } = useGameStore();

  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineErr, setTimelineErr] = useState<string | null>(null);

  const [watchlist, setWatchlist] = useState<FriendEntry[]>([]);
  const [watchlistLoading, setWatchlistLoading] = useState(true);
  const [watchlistErr, setWatchlistErr] = useState<string | null>(null);

  const [pairs, setPairs] = useState<Map<string, PairStats>>(new Map());
  const [pairsLoading, setPairsLoading] = useState(false);
  const [guestBlocked, setGuestBlocked] = useState(false);

  // 1. 拉 timeline (近 50 場)
  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setGuestBlocked(true);
      setTimelineLoading(false);
      setWatchlistLoading(false);
      return;
    }
    fetchMyTimeline(token, 50)
      .then(setTimeline)
      .catch(e => setTimelineErr(String((e as Error).message ?? e)))
      .finally(() => setTimelineLoading(false));

    fetchFriends(token)
      .then(setWatchlist)
      .catch(e => setWatchlistErr(String((e as Error).message ?? e)))
      .finally(() => setWatchlistLoading(false));
  }, []);

  // 2. 追蹤列表載入後，批次拉 pair stats
  useEffect(() => {
    const token = getStoredToken();
    if (!token || watchlist.length === 0) return;
    setPairsLoading(true);
    fetchPairStatsBatch(token, watchlist.map(f => f.id))
      .then(pairsArr => {
        const m = new Map<string, PairStats>();
        pairsArr.forEach(p => m.set(p.opponentId, p));
        setPairs(m);
      })
      .catch(() => {/* 靜默失敗，顯示 dash */})
      .finally(() => setPairsLoading(false));
  }, [watchlist]);

  const wins   = useMemo(() => timeline.filter(g => g.won).length, [timeline]);
  const losses = timeline.length - wins;

  return (
    <div className="min-h-screen bg-black">
      <div className="max-w-lg mx-auto px-4 pt-4 space-y-4 pb-16">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('home')}
            data-testid="personal-stats-btn-back"
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
            aria-label={t('nav.back')}
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-black text-white flex-1">{t('nav.personalStats')}</h1>
        </div>

        {guestBlocked && (
          <div className="bg-zinc-900/60 border border-zinc-700 rounded-xl p-6 text-sm text-zinc-300 flex items-start gap-3">
            <AlertCircle size={18} className="flex-shrink-0 mt-0.5 text-amber-400" />
            <div>
              <p className="font-semibold text-white mb-1">訪客模式</p>
              <p className="text-zinc-400">戰績 / 追蹤列表需要登入帳號。綁定訪客帳號後即可保留個人數據。</p>
            </div>
          </div>
        )}

        {!guestBlocked && (
          <>
            {/* (1) 近 50 場勝敗時間序列 */}
            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-zinc-900/60 border border-zinc-700 rounded-xl p-4"
            >
              <div className="flex items-center gap-3 mb-3">
                <History size={18} className="text-white" />
                <h2 className="text-lg font-bold text-white flex-1">近 50 場</h2>
                {!timelineLoading && timeline.length > 0 && (
                  <span className="text-xs text-zinc-400">
                    {wins}W / {losses}L · 勝率 {(wins / timeline.length * 100).toFixed(1)}%
                  </span>
                )}
              </div>

              {timelineLoading && (
                <div className="flex items-center justify-center py-8 text-zinc-400 gap-2">
                  <Loader size={16} className="animate-spin" /> 載入戰績...
                </div>
              )}
              {timelineErr && !timelineLoading && (
                <p className="text-sm text-amber-400 py-4">無法載入時間序列：{timelineErr}</p>
              )}
              {!timelineLoading && !timelineErr && timeline.length === 0 && (
                <p className="text-sm text-zinc-500 py-4 text-center">還沒有戰績紀錄</p>
              )}
              {!timelineLoading && !timelineErr && timeline.length > 0 && (
                <TimelineGrid timeline={timeline} onClick={gameId => navigateToReplay(gameId)} />
              )}
            </motion.section>

            {/* (2) 追蹤列表 & 對戰歷史 */}
            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 }}
              className="bg-zinc-900/60 border border-zinc-700 rounded-xl p-4"
            >
              <div className="flex items-center gap-3 mb-3">
                <Users size={18} className="text-white" />
                <h2 className="text-lg font-bold text-white flex-1">{t('settings.watchlist')}</h2>
                {!watchlistLoading && watchlist.length > 0 && (
                  <span className="text-xs text-zinc-400">{watchlist.length} 位</span>
                )}
              </div>

              {watchlistLoading && (
                <div className="flex items-center justify-center py-6 text-zinc-400 gap-2">
                  <Loader size={16} className="animate-spin" /> 載入追蹤列表...
                </div>
              )}
              {watchlistErr && !watchlistLoading && (
                <p className="text-sm text-amber-400 py-4">{watchlistErr}</p>
              )}
              {!watchlistLoading && !watchlistErr && watchlist.length === 0 && (
                <div className="py-6 text-center">
                  <p className="text-sm text-zinc-500 mb-2">還沒有追蹤玩家</p>
                  <button
                    onClick={() => setGameState('friends')}
                    className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white transition-colors"
                  >
                    去追蹤玩家
                  </button>
                </div>
              )}

              {!watchlistLoading && watchlist.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-500 px-1">
                    <Swords size={12} />
                    <span className="flex-1">對戰歷史（同贏率 / 同敗率 / 獨立勝率）</span>
                    {pairsLoading && <Loader size={12} className="animate-spin" />}
                  </div>
                  {watchlist.map(friend => {
                    const pair = pairs.get(friend.id);
                    return (
                      <PairRow
                        key={friend.id}
                        friend={friend}
                        pair={pair}
                        onClick={() => navigateToProfile(friend.id)}
                      />
                    );
                  })}
                  <p className="text-[11px] text-zinc-500 pt-2">
                    獨立勝率 = 排除與對方同場後，我自己那批場次的勝率
                  </p>
                </div>
              )}
            </motion.section>
          </>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Timeline dot grid (50 cells, row-wrapped). Green=win, red=loss.
// ──────────────────────────────────────────────────────────────

function TimelineGrid({
  timeline, onClick,
}: { timeline: TimelineEntry[]; onClick: (gameId: string) => void }): JSX.Element {
  // newest-first from API; display oldest → newest left-to-right for
  // a readable trend. Reverse copy to avoid mutating state.
  const ordered = [...timeline].reverse();
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-10 gap-1">
        {ordered.map(g => {
          const date = new Date(g.endedAt);
          const title = `${g.won ? '勝' : '敗'} · ${g.role ?? '—'} · ${date.toLocaleDateString('zh-TW')} ${date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`;
          return (
            <button
              key={g.gameId}
              onClick={() => onClick(g.gameId)}
              title={title}
              className={`aspect-square rounded-md border transition-transform hover:scale-110 ${
                g.won
                  ? 'bg-emerald-500/80 border-emerald-400 hover:bg-emerald-400'
                  : 'bg-red-500/80 border-red-400 hover:bg-red-400'
              }`}
              aria-label={title}
            />
          );
        })}
      </div>
      <p className="text-[10px] text-zinc-500 pt-1">點方塊可查看牌譜</p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Pair row: tracked player + 3 rates
// ──────────────────────────────────────────────────────────────

function PairRow({
  friend, pair, onClick,
}: { friend: FriendEntry; pair: PairStats | undefined; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="w-full bg-zinc-950/40 hover:bg-zinc-900/80 border border-zinc-800 hover:border-blue-500/40 rounded-lg p-3 flex items-center gap-3 text-left transition-colors"
    >
      {friend.photo_url ? (
        <img src={friend.photo_url} alt="" className="w-9 h-9 rounded-full object-cover" />
      ) : (
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-600 to-amber-600 flex items-center justify-center text-white font-bold text-xs">
          {friend.display_name[0]?.toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-white text-sm truncate">{friend.display_name}</p>
        <p className="text-[11px] text-zinc-500">
          {pair ? `同場 ${pair.sharedGames}/${pair.totalGames}` : 'ELO ' + friend.elo_rating}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <RateCell label="同贏率" value={pair?.sameWinRate} color="text-emerald-400" />
        <RateCell label="同敗率" value={pair?.sameLossRate} color="text-red-400" />
        <RateCell label="獨立勝率" value={pair?.independentWinRate} color="text-blue-400" />
      </div>
    </button>
  );
}

function RateCell({
  label, value, color,
}: { label: string; value: number | null | undefined; color: string }): JSX.Element {
  const display = value === undefined ? '—' : value === null ? 'N/A' : `${value.toFixed(1)}%`;
  return (
    <div className="min-w-[44px]">
      <p className="text-[9px] text-zinc-500 leading-none mb-0.5">{label}</p>
      <p className={`text-xs font-bold ${color}`}>{display}</p>
    </div>
  );
}
