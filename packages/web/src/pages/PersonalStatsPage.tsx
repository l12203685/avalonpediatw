import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Users, Swords, History, Loader, AlertCircle, Copy, Check,
  Link2, UserCircle, Mail, Lock, Eye, EyeOff, Shield, TrendingUp,
  Clock, Trophy, BarChart3, ExternalLink,
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { getStoredToken } from '../services/socket';
import { getEloRank } from '../utils/eloRank';
import { CampDisc } from '../components/CampDisc';
import ArchetypeRadar from '../components/profile/ArchetypeRadar';
import StrengthSignature from '../components/profile/StrengthSignature';
import PlaystyleSnapshot from '../components/profile/PlaystyleSnapshot';
import {
  fetchFriends, fetchPairStatsBatch, fetchMyTimeline, mergeAccountByUuid,
  fetchMyProfile, fetchGameReplay,
  FriendEntry, PairStats, TimelineEntry, UserProfile, RecentGame, GameEvent,
} from '../services/api';
import { claimHistory } from '../services/auth';

/**
 * 2026-04-27 IA 拆分 (Edward 23:47)
 *
 * 個人資料頁 vs 個人戰績頁職責分離：
 *   - ProfilePage: 帳號相關 (綁定 / 密碼 / 信箱 / 清除本機資料)
 *   - PersonalStatsPage (本檔): 所有戰績相關 — 總場次 / 勝率 / 角色分布 /
 *     ELO 趨勢 / Panel A 角色雷達 / Panel B 強項簽名 / Panel C 對戰風格 /
 *     近 50 場 / 玩家追蹤列表 + 對戰歷史 + 兩個外連 link (數據分析 / 排行榜)
 *
 * 獨立勝率 = 排除同場後我方理論勝率
 *   = (我不與對方同場的場次中，我贏的次數) / (我不與對方同場的場次)
 */

const ROLE_COLORS: Record<string, string> = {
  merlin: 'text-blue-300', percival: 'text-blue-200', loyal: 'text-blue-400',
  assassin: 'text-red-400', morgana: 'text-rose-400', mordred: 'text-red-600',
  oberon: 'text-slate-400', minion: 'text-red-300',
};

const EVENT_ICONS: Record<string, string> = {
  game_started:              '🎮',
  voting_phase_started:      '🗳️',
  quest_team_selected:       '⚔️',
  team_auto_selected:        '⏱️',
  voting_resolved:           '📊',
  team_approved:             '✅',
  quest_vote_submitted:      '⚔️',
  quest_resolved:            '🏰',
  round_ended:               '🔄',
  discussion_phase_started:  '🎯',
  assassination_submitted:   '🗡️',
  game_ended:                '🏁',
  game_final_stats:          '📈',
};

type TranslateFn = (key: string, values?: Record<string, unknown>) => string;

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

function formatReplayEvent(ev: GameEvent, t: TranslateFn): string {
  const d = ev.event_data as Record<string, unknown>;
  switch (ev.event_type) {
    case 'game_started':
      return t('profile:replayEvent.gameStarted', {
        playerCount: d.playerCount as number,
        leaderId: d.leaderId as string,
      });
    case 'voting_phase_started': {
      const leaderLabel = (d.leaderName as string) || (d.leaderId as string) || '?';
      return t('profile:replayEvent.votingPhaseStarted', {
        round: d.round as number,
        proposal: (d.failedVotes ?? d.failCount) as number,
        leader: leaderLabel,
      });
    }
    case 'quest_team_selected':
      return t('profile:replayEvent.questTeamSelected', {
        team: (d.team as string[])?.join('、'),
      });
    case 'team_auto_selected':
      return t('profile:replayEvent.teamAutoSelected', {
        team: (d.team as string[])?.join('、'),
      });
    case 'voting_resolved': {
      const approved = (d.result === 'approved' || d.approved)
        ? t('profile:replayEvent.voteApproved')
        : t('profile:replayEvent.voteRejected');
      return t('profile:replayEvent.votingResolved', {
        result: approved,
        approvals: (d.approvals ?? d.approveCount) as number,
        rejections: (d.rejections ?? d.rejectCount) as number,
      });
    }
    case 'team_approved':
      return t('profile:replayEvent.teamApproved');
    case 'quest_resolved': {
      const result = d.result === 'success'
        ? t('profile:replayEvent.questSuccess')
        : t('profile:replayEvent.questFail');
      return t('profile:replayEvent.questResolved', {
        result,
        failCount: d.failCount as number,
      });
    }
    case 'round_ended':
      return d.result === 'success'
        ? t('profile:replayEvent.roundEndedSuccess', { round: d.round as number })
        : t('profile:replayEvent.roundEndedFail', { round: d.round as number });
    case 'discussion_phase_started':
      return t('profile:replayEvent.discussionPhaseStarted');
    case 'assassination_submitted':
      return t('profile:replayEvent.assassinationSubmitted', {
        assassin: d.assassinId as string,
        target: d.targetId as string,
      });
    case 'game_ended': {
      const winner = d.evilWins
        ? t('profile:replayEvent.gameEndedEvil')
        : t('profile:replayEvent.gameEndedGood');
      return t('profile:replayEvent.gameEnded', {
        winner,
        reason: d.reason as string,
      });
    }
    default:
      return ev.event_type;
  }
}

interface GameRowProps {
  game: RecentGame;
  onReplay: (roomId: string, game: RecentGame) => void;
  roleNames: Record<string, string>;
  t: TranslateFn;
  locale: string;
}

function GameRow({ game, onReplay, roleNames, t, locale }: GameRowProps): JSX.Element {
  const won = game.won;
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-gray-700/50 last:border-0">
      <div className={`w-14 text-center text-xs font-bold py-1 rounded ${won ? 'bg-blue-900/60 text-blue-400' : 'bg-red-900/60 text-red-400'}`}>
        {won ? t('profile:record.win') : t('profile:record.loss')}
      </div>
      <div className="flex-1">
        <span className={`text-sm font-semibold ${ROLE_COLORS[game.role] ?? 'text-gray-300'}`}>
          {roleNames[game.role] ?? game.role}
        </span>
        <span className="text-xs text-gray-500 ml-2">{t('profile:record.playerCount', { count: game.player_count })}</span>
      </div>
      <div className={`text-sm font-bold ${game.elo_delta >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
        {game.elo_delta >= 0 ? `+${game.elo_delta}` : game.elo_delta}
      </div>
      <div className="text-xs text-gray-600 w-14 text-right">{formatDate(game.created_at, locale)}</div>
      <button
        onClick={() => onReplay(game.room_id, game)}
        className="p-1 text-gray-600 hover:text-blue-400 transition-colors"
        title={t('profile:viewReplay')}
      >
        <ExternalLink size={12} />
      </button>
    </div>
  );
}

export default function PersonalStatsPage(): JSX.Element {
  const { t, i18n } = useTranslation(['profile', 'common', 'game']);
  const locale = i18n.language.startsWith('en') ? 'en-US' : 'zh-TW';
  const roleNames: Record<string, string> = {
    merlin:   t('game:roleLabel.merlin'),
    percival: t('game:roleLabel.percival'),
    loyal:    t('game:roleLabel.loyal'),
    assassin: t('game:roleLabel.assassin'),
    morgana:  t('game:roleLabel.morgana'),
    mordred:  t('game:roleLabel.mordred'),
    oberon:   t('game:roleLabel.oberon'),
    minion:   t('game:roleLabel.minion'),
    unknown:  t('game:roleLabel.unknown'),
  };
  const { setGameState, navigateToProfile, navigateToReplay, currentPlayer, addToast } = useGameStore();

  // Profile (own) — for stats grid / team rates / panels
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineErr, setTimelineErr] = useState<string | null>(null);

  const [watchlist, setWatchlist] = useState<FriendEntry[]>([]);
  const [watchlistLoading, setWatchlistLoading] = useState(true);
  const [watchlistErr, setWatchlistErr] = useState<string | null>(null);

  const [pairs, setPairs] = useState<Map<string, PairStats>>(new Map());
  const [pairsLoading, setPairsLoading] = useState(false);
  const [guestBlocked, setGuestBlocked] = useState(false);

  // Replay modal
  const [replay, setReplay] = useState<{ roomId: string; events: GameEvent[]; game: RecentGame | null } | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  // 2026-04-23 Edward：uuid 複製 + 以 uuid 合併戰績 state
  const [copiedUuid, setCopiedUuid] = useState(false);
  const [mergeExpanded, setMergeExpanded] = useState(false);
  const [mergeUuid, setMergeUuid] = useState('');
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Phase B (2026-04-23 新登入架構)：歷史戰績認領 — uuid + email + 密碼 3 件
  const [claimExpanded, setClaimExpanded] = useState(false);
  const [claimUuid,     setClaimUuid]     = useState('');
  const [claimEmail,    setClaimEmail]    = useState('');
  const [claimPassword, setClaimPassword] = useState('');
  const [claimShowPw,   setClaimShowPw]   = useState(false);
  const [claimBusy,     setClaimBusy]     = useState(false);
  const [claimError,    setClaimError]    = useState<string | null>(null);

  const handleCopyUuid = async (): Promise<void> => {
    if (!currentPlayer?.id) return;
    try {
      await navigator.clipboard.writeText(currentPlayer.id);
      setCopiedUuid(true);
      setTimeout(() => setCopiedUuid(false), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = currentPlayer.id;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* noop */ }
      document.body.removeChild(ta);
      setCopiedUuid(true);
      setTimeout(() => setCopiedUuid(false), 1500);
    }
  };

  const handleClaimHistory = async (): Promise<void> => {
    const token = getStoredToken();
    if (!token) return;
    const uuid = claimUuid.trim();
    const email = claimEmail.trim();
    if (!uuid || !email || !claimPassword) {
      setClaimError(t('common:stats.claimAllRequired', { defaultValue: 'UUID、信箱、密碼三項必填' }));
      return;
    }
    if (uuid === currentPlayer?.id) {
      setClaimError(t('common:stats.mergeUuidSelf', { defaultValue: '不能把自己合併到自己' }));
      return;
    }
    setClaimBusy(true);
    setClaimError(null);
    try {
      await claimHistory(token, uuid, email, claimPassword);
      addToast(t('common:stats.claimSuccess', { defaultValue: '歷史戰績認領完成' }), 'success');
      setClaimExpanded(false);
      setClaimUuid(''); setClaimEmail(''); setClaimPassword('');
      // 重新載入 timeline + profile
      setTimelineLoading(true);
      try {
        const fresh = await fetchMyTimeline(token, 50);
        setTimeline(fresh);
        const freshProfile = await fetchMyProfile(token);
        setProfile(freshProfile);
      } finally {
        setTimelineLoading(false);
      }
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : t('common:stats.claimFailed', { defaultValue: '認領失敗' }));
    } finally {
      setClaimBusy(false);
    }
  };

  const handleMergeByUuid = async (): Promise<void> => {
    const token = getStoredToken();
    if (!token) return;
    const trimmed = mergeUuid.trim();
    if (trimmed.length === 0) {
      setMergeError(t('common:stats.mergeUuidRequired', { defaultValue: '請輸入要合併的 UUID' }));
      return;
    }
    if (trimmed === currentPlayer?.id) {
      setMergeError(t('common:stats.mergeUuidSelf', { defaultValue: '不能把自己合併到自己' }));
      return;
    }
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('common:stats.mergeUuidConfirm', {
      defaultValue: '合併後該 UUID 的戰績/徽章/好友會併入當前帳號，原帳號會刪除。確定繼續？',
    }))) return;

    setMergeBusy(true);
    setMergeError(null);
    try {
      await mergeAccountByUuid(token, trimmed);
      addToast(t('common:stats.mergeUuidSuccess', { defaultValue: '戰績合併完成' }), 'success');
      setMergeExpanded(false);
      setMergeUuid('');
      setTimelineLoading(true);
      try {
        const fresh = await fetchMyTimeline(token, 50);
        setTimeline(fresh);
        const freshProfile = await fetchMyProfile(token);
        setProfile(freshProfile);
      } finally {
        setTimelineLoading(false);
      }
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : t('common:stats.mergeUuidFailed', { defaultValue: '合併失敗' }));
    } finally {
      setMergeBusy(false);
    }
  };

  const handleReplay = (roomId: string, game: RecentGame | null = null): void => {
    setReplayLoading(true);
    fetchGameReplay(roomId)
      .then(events => setReplay({ roomId, events, game }))
      .catch(() => setReplay({ roomId, events: [], game }))
      .finally(() => setReplayLoading(false));
  };

  // 1. 拉 profile (own) + timeline (近 50 場) + watchlist
  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setGuestBlocked(true);
      setProfileLoading(false);
      setTimelineLoading(false);
      setWatchlistLoading(false);
      return;
    }
    fetchMyProfile(token)
      .then(setProfile)
      .catch(() => setProfile(null))
      .finally(() => setProfileLoading(false));

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

  const winRate = profile && profile.total_games > 0
    ? Math.round((profile.games_won / profile.total_games) * 100)
    : 0;

  // Compute good/evil win rates from recent game data
  const teamStats = profile
    ? profile.recent_games.reduce<Record<'good' | 'evil', { wins: number; total: number }>>(
        (acc, g) => {
          const team = g.team as 'good' | 'evil';
          if (!acc[team]) return acc;
          acc[team].total++;
          if (g.won) acc[team].wins++;
          return acc;
        },
        { good: { wins: 0, total: 0 }, evil: { wins: 0, total: 0 } }
      )
    : null;

  // Compute per-role stats from recent games
  const roleStats = profile
    ? Object.entries(
        profile.recent_games.reduce<Record<string, { wins: number; total: number }>>((acc, g) => {
          if (!acc[g.role]) acc[g.role] = { wins: 0, total: 0 };
          acc[g.role].total++;
          if (g.won) acc[g.role].wins++;
          return acc;
        }, {})
      ).sort((a, b) => b[1].total - a[1].total)
    : [];

  // Compute per-player-count stats from recent games
  const playerCountStats: Array<{ count: number; wins: number; total: number }> = profile
    ? [5, 6, 7, 8, 9, 10]
        .reduce<Array<{ count: number; wins: number; total: number }>>((acc, count) => {
          const games = profile.recent_games.filter(g => g.player_count === count);
          if (games.length > 0) {
            acc.push({ count, wins: games.filter(g => g.won).length, total: games.length });
          }
          return acc;
        }, [])
    : [];

  return (
    <div className="min-h-screen bg-black">
      <div className="max-w-lg mx-auto px-4 pt-4 space-y-4 pb-16">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('home')}
            data-testid="personal-stats-btn-back"
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
            aria-label={t('common:nav.back')}
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-black text-white flex-1">{t('common:nav.personalStats')}</h1>
          {/* 2026-04-27 Edward 23:47 IA：戰績頁右上角放「數據分析」外連入口 */}
          <button
            onClick={() => setGameState('analysis')}
            data-testid="personal-stats-btn-analysis"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white transition-colors"
            title={t('common:nav.analysis')}
          >
            <BarChart3 size={14} />
            {t('common:nav.analysis')}
          </button>
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
            {/* 2026-04-23 Edward：個人戰績頁加 uuid 顯示 + 以 uuid 綁定歷史戰績按鈕 */}
            {currentPlayer?.id && (
              <motion.section
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-zinc-900/60 border border-zinc-700 rounded-xl p-4 space-y-3"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-zinc-500">UUID:</span>
                  <code
                    className="text-[11px] bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-300 font-mono break-all"
                    data-testid="personal-stats-uuid-value"
                  >
                    {currentPlayer.id}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyUuid}
                    data-testid="personal-stats-btn-copy-uuid"
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white transition-colors"
                    title={t('common:settings.copyUuid', { defaultValue: '複製 UUID' })}
                  >
                    {copiedUuid ? <Check size={12} /> : <Copy size={12} />}
                    {copiedUuid
                      ? t('common:settings.copied', { defaultValue: '已複製' })
                      : t('common:settings.copy', { defaultValue: '複製' })}
                  </button>
                </div>

                {/* Phase B (2026-04-23)：歷史戰績認領 — uuid + email + 密碼 3 件 */}
                {!claimExpanded ? (
                  <button
                    type="button"
                    onClick={() => setClaimExpanded(true)}
                    data-testid="personal-stats-btn-claim-history"
                    className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg bg-amber-900/40 hover:bg-amber-800/50 border border-amber-700/60 text-amber-200 hover:text-white transition-colors"
                  >
                    <Link2 size={12} />
                    {t('common:stats.claimHistoryBtn', { defaultValue: '歷史戰績認領' })}
                  </button>
                ) : (
                  <div className="space-y-2 bg-zinc-950/40 border border-amber-700/40 rounded-lg p-3">
                    <p className="text-[11px] text-zinc-400">
                      {t('common:stats.claimHistoryHint', {
                        defaultValue: '輸入舊帳號的 UUID + 主要信箱 + 密碼，三項全對才能併入戰績/徽章/好友',
                      })}
                    </p>
                    <div className="relative">
                      <UserCircle size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                      <input
                        type="text"
                        value={claimUuid}
                        onChange={e => { setClaimUuid(e.target.value); if (claimError) setClaimError(null); }}
                        placeholder={t('common:stats.mergeUuidPlaceholder', { defaultValue: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' })}
                        data-testid="personal-stats-input-claim-uuid"
                        maxLength={128}
                        className="w-full bg-zinc-950 border border-zinc-700 rounded-lg pl-7 pr-3 py-2 text-white placeholder-zinc-600 font-mono text-xs focus:outline-none focus:border-white"
                      />
                    </div>
                    <div className="relative">
                      <Mail size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                      <input
                        type="email"
                        value={claimEmail}
                        onChange={e => { setClaimEmail(e.target.value); if (claimError) setClaimError(null); }}
                        placeholder={t('common:stats.claimEmailPlaceholder', { defaultValue: '舊帳號的主要信箱' })}
                        data-testid="personal-stats-input-claim-email"
                        className="w-full bg-zinc-950 border border-zinc-700 rounded-lg pl-7 pr-3 py-2 text-white placeholder-zinc-600 text-xs focus:outline-none focus:border-white"
                      />
                    </div>
                    <div className="relative">
                      <Lock size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                      <input
                        type={claimShowPw ? 'text' : 'password'}
                        value={claimPassword}
                        onChange={e => { setClaimPassword(e.target.value); if (claimError) setClaimError(null); }}
                        placeholder={t('common:stats.claimPasswordPlaceholder', { defaultValue: '舊帳號的密碼' })}
                        data-testid="personal-stats-input-claim-password"
                        autoComplete="current-password"
                        className="w-full bg-zinc-950 border border-zinc-700 rounded-lg pl-7 pr-8 py-2 text-white placeholder-zinc-600 text-xs focus:outline-none focus:border-white"
                      />
                      <button
                        type="button"
                        onClick={() => setClaimShowPw(v => !v)}
                        aria-label={claimShowPw ? '隱藏' : '顯示'}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                      >
                        {claimShowPw ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    </div>
                    {claimError && (
                      <p className="text-xs text-red-400" data-testid="personal-stats-claim-error">{claimError}</p>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleClaimHistory}
                        disabled={claimBusy}
                        data-testid="personal-stats-btn-confirm-claim"
                        className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-semibold py-1.5 px-3 rounded-lg text-sm transition-colors"
                      >
                        {claimBusy && <Loader size={14} className="animate-spin" />}
                        {t('common:stats.claimConfirm', { defaultValue: '認領' })}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setClaimExpanded(false);
                          setClaimUuid(''); setClaimEmail(''); setClaimPassword('');
                          setClaimError(null);
                        }}
                        disabled={claimBusy}
                        className="inline-flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-1.5 px-3 rounded-lg text-sm border border-zinc-700 disabled:opacity-50 transition-colors"
                      >
                        {t('common:action.cancel')}
                      </button>
                    </div>
                  </div>
                )}

                {/* 以 uuid 綁定歷史戰績 — collapsed 時只顯按鈕，expanded 時顯輸入表單 */}
                {!mergeExpanded ? (
                  <button
                    type="button"
                    onClick={() => setMergeExpanded(true)}
                    data-testid="personal-stats-btn-merge-uuid"
                    className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white transition-colors"
                  >
                    <Link2 size={12} />
                    {t('common:stats.mergeByUuid', { defaultValue: '以 UUID 綁定歷史戰績' })}
                  </button>
                ) : (
                  <div className="space-y-2 bg-zinc-950/40 border border-zinc-800 rounded-lg p-3">
                    <p className="text-[11px] text-zinc-500">
                      {t('common:stats.mergeUuidHint', {
                        defaultValue: '輸入另一個帳號的 UUID，戰績/徽章/好友會併入當前帳號，原帳號將刪除。',
                      })}
                    </p>
                    <input
                      type="text"
                      value={mergeUuid}
                      onChange={e => { setMergeUuid(e.target.value); if (mergeError) setMergeError(null); }}
                      placeholder={t('common:stats.mergeUuidPlaceholder', { defaultValue: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' })}
                      data-testid="personal-stats-input-merge-uuid"
                      maxLength={128}
                      className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white placeholder-zinc-600 font-mono text-xs focus:outline-none focus:border-white"
                    />
                    {mergeError && (
                      <p className="text-xs text-red-400">{mergeError}</p>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleMergeByUuid}
                        disabled={mergeBusy}
                        data-testid="personal-stats-btn-confirm-merge"
                        className="inline-flex items-center gap-2 bg-white hover:bg-zinc-200 disabled:opacity-50 text-black font-semibold py-1.5 px-3 rounded-lg text-sm transition-colors"
                      >
                        {mergeBusy && <Loader size={14} className="animate-spin" />}
                        {t('common:stats.mergeConfirm', { defaultValue: '合併' })}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setMergeExpanded(false); setMergeUuid(''); setMergeError(null); }}
                        disabled={mergeBusy}
                        className="inline-flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-1.5 px-3 rounded-lg text-sm border border-zinc-700 disabled:opacity-50 transition-colors"
                      >
                        {t('common:action.cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </motion.section>
            )}

            {/* 2026-04-27 Edward 23:47：從 ProfilePage 搬來 — ELO + 段位 + 徽章 */}
            {profileLoading && (
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 flex items-center justify-center text-zinc-400 gap-2">
                <Loader size={16} className="animate-spin" /> 載入戰績...
              </div>
            )}
            {!profileLoading && profile && (
              <>
                {/* ELO + 段位 + 徽章 一行 */}
                <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <TrendingUp size={16} className="text-blue-400" />
                    <span className="text-blue-300 font-bold text-lg" data-testid="personal-stats-elo">{profile.elo_rating}</span>
                    <span className="text-gray-500 text-sm">ELO</span>
                    {(() => {
                      const rank = getEloRank(profile.elo_rating, profile.total_games);
                      return (
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${rank.color} ${rank.bgColor} ${rank.borderColor}`}>
                          {rank.label}
                        </span>
                      );
                    })()}
                    {profile.badges.length > 0 && (
                      <div className="flex gap-1 flex-wrap ml-1">
                        {profile.badges.map(b => (
                          <span key={b} className="text-xs px-2 py-0.5 bg-amber-900/60 border border-amber-600/50 text-amber-300 rounded-full">
                            {b}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Stats grid: 總場次 / 勝率 / 勝場 / 敗場 */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
                    <div className="text-3xl font-black text-white" data-testid="personal-stats-total">{profile.total_games}</div>
                    <div className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
                      <Clock size={12} /> {t('profile:totalGamesLabel')}
                    </div>
                  </div>
                  <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
                    <div className="text-3xl font-black text-blue-400" data-testid="personal-stats-winrate">{winRate}%</div>
                    <div className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
                      <Trophy size={12} /> {t('profile:winRate')}
                    </div>
                  </div>
                  <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
                    <div className="text-3xl font-black text-blue-400">{profile.games_won}</div>
                    <div className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
                      <Shield size={12} /> {t('profile:stats.winsLabel')}
                    </div>
                  </div>
                  <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
                    <div className="text-3xl font-black text-red-400">{profile.games_lost}</div>
                    <div className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
                      <Swords size={12} /> {t('profile:stats.lossesLabel')}
                    </div>
                  </div>
                </div>

                {/* 陣營勝率 (good/evil) */}
                {teamStats && (teamStats.good.total > 0 || teamStats.evil.total > 0) && (
                  <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                    <p className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">{t('profile:stats.teamWinRates')} <span className="font-normal text-gray-500">{t('profile:stats.recentGamesSuffix', { count: profile.recent_games.length })}</span></p>
                    <div className="grid grid-cols-2 gap-3">
                      {(['good', 'evil'] as const).map(team => {
                        const { wins: tWins, total: tTotal } = teamStats[team];
                        const pct = tTotal > 0 ? Math.round((tWins / tTotal) * 100) : 0;
                        const isGood = team === 'good';
                        return (
                          <div key={team} className={`rounded-lg border p-3 text-center ${isGood ? 'bg-blue-900/20 border-blue-700/50' : 'bg-red-900/20 border-red-700/50'}`}>
                            <div className={`text-2xl font-black ${pct >= 50 ? (isGood ? 'text-blue-300' : 'text-red-300') : 'text-gray-400'}`}>
                              {tTotal > 0 ? `${pct}%` : '—'}
                            </div>
                            <div className={`text-xs mt-1 inline-flex items-center justify-center gap-1 ${isGood ? 'text-blue-400' : 'text-red-400'}`}>
                              <CampDisc team={isGood ? 'good' : 'evil'} className="w-3 h-3" />
                              {isGood ? t('profile:stats.good') : t('profile:stats.evil')}
                            </div>
                            {tTotal > 0 && <div className="text-xs text-gray-600 mt-0.5">{tWins}/{tTotal}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ELO 趨勢 sparkline */}
                {profile.recent_games.length >= 2 && (() => {
                  const games = [...profile.recent_games].reverse();
                  const points: number[] = [];
                  const startElo = games.reduce((acc, g) => acc - g.elo_delta, profile.elo_rating);
                  let elo = startElo;
                  points.push(elo);
                  for (const g of games) {
                    elo += g.elo_delta;
                    points.push(elo);
                  }

                  const W = 320, H = 80, PAD = 12;
                  const minElo = Math.min(...points) - 10;
                  const maxElo = Math.max(...points) + 10;
                  const range = maxElo - minElo || 1;
                  const toX = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
                  const toY = (v: number) => PAD + (1 - (v - minElo) / range) * (H - PAD * 2);

                  const pathD = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
                  const trend = points[points.length - 1] - points[0];
                  const strokeColor = trend >= 0 ? '#60a5fa' : '#f87171';
                  const fillId = `elo-fill-${trend >= 0 ? 'up' : 'down'}`;

                  const areaD = pathD
                    + ` L${toX(points.length - 1).toFixed(1)},${(H - PAD).toFixed(1)}`
                    + ` L${toX(0).toFixed(1)},${(H - PAD).toFixed(1)} Z`;

                  return (
                    <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-sm font-bold text-gray-300">{t('profile:stats.eloTrend', { count: games.length })}</h3>
                        <span className={`text-sm font-bold ${trend >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
                          {trend >= 0 ? '+' : ''}{trend.toFixed(0)} pts
                        </span>
                      </div>
                      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 80 }}>
                        <defs>
                          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.25" />
                            <stop offset="100%" stopColor={strokeColor} stopOpacity="0.02" />
                          </linearGradient>
                        </defs>
                        <path d={areaD} fill={`url(#${fillId})`} />
                        <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        {points.map((v, i) => {
                          const g = games[i - 1];
                          const dotColor = !g ? '#9ca3af' : g.won ? '#60a5fa' : '#f87171';
                          return <circle key={i} cx={toX(i)} cy={toY(v)} r="3" fill={dotColor} />;
                        })}
                        <text x={toX(0)} y={H - 2} textAnchor="middle" fontSize="9" fill="#6b7280">{points[0].toFixed(0)}</text>
                        <text x={toX(points.length - 1)} y={H - 2} textAnchor="middle" fontSize="9" fill={strokeColor}>{points[points.length - 1].toFixed(0)}</text>
                      </svg>
                    </div>
                  );
                })()}

                {/* 角色勝率 */}
                {roleStats.length > 0 && (
                  <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                    <h3 className="text-sm font-bold text-gray-300 mb-3">{t('profile:stats.roleWinRates')} <span className="text-gray-500 font-normal">{t('profile:stats.recentGamesSuffix', { count: profile.recent_games.length })}</span></h3>
                    <div className="space-y-2">
                      {roleStats.map(([role, { wins: rWins, total: rTotal }]) => {
                        const pct = Math.round((rWins / rTotal) * 100);
                        const color = ROLE_COLORS[role] ?? 'text-gray-300';
                        return (
                          <div key={role} className="flex items-center gap-2">
                            <span className={`text-xs font-semibold w-36 truncate ${color}`}>
                              {roleNames[role] ?? role}
                            </span>
                            <div className="flex-1 bg-gray-800 rounded-full h-1.5">
                              <div
                                className={`h-1.5 rounded-full ${pct >= 50 ? 'bg-blue-500' : 'bg-red-500'}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className={`text-xs font-bold w-10 text-right ${pct >= 50 ? 'text-blue-400' : 'text-red-400'}`}>
                              {pct}%
                            </span>
                            <span className="text-xs text-gray-600 w-10 text-right">{rWins}/{rTotal}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 人數勝率 */}
                {playerCountStats.length > 0 && (
                  <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                    <h3 className="text-sm font-bold text-gray-300 mb-3">{t('profile:stats.playerCountWinRates')} <span className="text-gray-500 font-normal">{t('profile:stats.recentGamesSuffix', { count: profile.recent_games.length })}</span></h3>
                    <div className="space-y-2">
                      {playerCountStats.map(({ count, wins: pWins, total: pTotal }) => {
                        const pct = Math.round((pWins / pTotal) * 100);
                        return (
                          <div key={count} className="flex items-center gap-2">
                            <span className="text-xs font-semibold w-10 text-gray-300 flex-shrink-0">
                              {t('profile:stats.playersCount', { count })}
                            </span>
                            <div className="flex-1 bg-gray-800 rounded-full h-1.5">
                              <div
                                className={`h-1.5 rounded-full ${pct >= 50 ? 'bg-blue-500' : 'bg-red-500'}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className={`text-xs font-bold w-10 text-right ${pct >= 50 ? 'text-blue-400' : 'text-red-400'}`}>
                              {pct}%
                            </span>
                            <span className="text-xs text-gray-600 w-10 text-right">{pWins}/{pTotal}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Panel A 角色雷達 + Panel B 強項簽名 (Edward 2026-04-26) */}
                {profile.display_name && (
                  <div className="grid md:grid-cols-2 gap-3">
                    <ArchetypeRadar playerName={profile.display_name} />
                    <StrengthSignature playerName={profile.display_name} />
                  </div>
                )}

                {/* Panel C 對戰風格快照 (Edward 2026-04-26 夜間任務 3) */}
                {profile.display_name && (
                  <PlaystyleSnapshot playerName={profile.display_name} />
                )}

                {/* 近 N 場 (recent_games — 與下方近 50 場 timeline 不同 source；
                    這裡走 profile.recent_games 含 ELO delta + role + 牌譜入口) */}
                <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                  <h3 className="text-sm font-bold text-gray-300 mb-3">{t('profile:stats.recentNGames', { count: profile.recent_games.length })}</h3>
                  {profile.recent_games.length === 0 ? (
                    <p className="text-center text-gray-500 text-sm py-4">{t('profile:noGamesShort')}</p>
                  ) : (
                    <div>
                      {profile.recent_games.map(g => (
                        <GameRow key={g.id} game={g} onReplay={handleReplay} roleNames={roleNames} t={t} locale={locale} />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* (1) 近 50 場勝敗時間序列 — 與上方 recent_games 不同 source；
                this is fetchMyTimeline (純勝敗 + 牌譜 ID 走 navigateToReplay) */}
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
                <h2 className="text-lg font-bold text-white flex-1">{t('common:settings.watchlist')}</h2>
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

            {/* 2026-04-27 Edward 23:47 IA：戰績頁底部「查看排行榜」外連 */}
            <button
              onClick={() => setGameState('leaderboard')}
              data-testid="personal-stats-btn-leaderboard"
              className="w-full text-sm text-gray-400 hover:text-white transition-colors py-2"
            >
              {t('profile:viewLeaderboard')}
            </button>

            {/* Replay modal — 從 ProfilePage 搬來；近 N 場列點 ExternalLink 觸發 */}
            {(replay || replayLoading) && (
              <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
                onClick={() => setReplay(null)}>
                <div className="bg-avalon-card border border-gray-600 rounded-2xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto"
                  onClick={e => e.stopPropagation()}>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-white">{t('profile:replay.title')} <span className="font-mono text-yellow-400 text-sm">{replay?.roomId}</span></h3>
                    <button onClick={() => setReplay(null)} className="text-gray-500 hover:text-white">✕</button>
                  </div>
                  {replayLoading && <div className="flex justify-center py-8"><Loader size={24} className="animate-spin text-blue-400" /></div>}
                  {replay && replay.events.length === 0 && (
                    <div className="space-y-3">
                      {replay.game ? (
                        <>
                          <div className="bg-gray-800/60 rounded-xl p-4 space-y-2.5">
                            <p className="text-xs text-gray-400">{t('profile:replay.playerCount', { count: replay.game.player_count })}</p>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gray-500">{t('profile:replay.yourRole')}</span>
                              <span className={`text-sm font-semibold ${ROLE_COLORS[replay.game.role] ?? 'text-gray-300'}`}>
                                {roleNames[replay.game.role] ?? replay.game.role}
                              </span>
                              <span className={`text-[10px] px-2 py-0.5 rounded-full ml-auto ${
                                replay.game.team === 'good'
                                  ? 'bg-blue-900/60 text-blue-300 border border-blue-700/60'
                                  : 'bg-red-900/60 text-red-300 border border-red-700/60'
                              }`}>
                                {replay.game.team === 'good' ? t('profile:replay.teamGood') : t('profile:replay.teamEvil')}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 pt-1">
                              <div className={`text-sm font-bold px-3 py-1 rounded-lg flex items-center gap-1.5 ${
                                replay.game.won
                                  ? 'bg-blue-900/50 text-blue-300 border border-blue-600'
                                  : 'bg-red-900/50 text-red-300 border border-red-600'
                              }`}>
                                <CampDisc team={replay.game.won ? 'good' : 'evil'} className="w-4 h-4" />
                                {replay.game.won ? t('profile:replay.win') : t('profile:replay.loss')}
                              </div>
                              <div className={`text-sm font-bold ${replay.game.elo_delta >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
                                ELO {replay.game.elo_delta >= 0 ? `+${replay.game.elo_delta}` : replay.game.elo_delta}
                              </div>
                              <div className="text-xs text-gray-500 ml-auto">
                                {formatDate(replay.game.created_at, locale)}
                              </div>
                            </div>
                          </div>
                          <p className="text-xs text-center text-gray-600 pt-1">
                            {t('profile:replay.legacyNote')}
                          </p>
                        </>
                      ) : (
                        <p className="text-center text-gray-500 py-4">{t('profile:replay.noData')}</p>
                      )}
                    </div>
                  )}
                  {replay && replay.events.length > 0 && (() => {
                    const questResults = replay.events
                      .filter(e => e.event_type === 'round_ended')
                      .map(e => (e.event_data as Record<string, unknown>).result as string);
                    const endEvent = replay.events.find(e => e.event_type === 'game_ended');
                    const evilWins = endEvent ? (endEvent.event_data as Record<string, unknown>).evilWins as boolean : null;
                    const playerCount = (replay.events[0]?.event_data as Record<string, unknown>)?.playerCount as number | undefined;

                    return (
                      <>
                        <div className="bg-gray-800/60 rounded-xl p-4 mb-4 space-y-3">
                          {playerCount && (
                            <p className="text-xs text-gray-400">{t('profile:replay.playerCountFull', { count: playerCount })}</p>
                          )}
                          {questResults.length > 0 && (
                            <div>
                              <p className="text-xs text-gray-500 mb-2">{t('profile:replay.questResults')}</p>
                              <div className="flex gap-2">
                                {questResults.map((r, i) => (
                                  <div key={i} className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-black border-2 ${
                                    r === 'success'
                                      ? 'bg-blue-600/40 border-blue-400 text-blue-300'
                                      : 'bg-red-600/40 border-red-400 text-red-300'
                                  }`}>
                                    {r === 'success' ? t('profile:replay.questSuccessChar') : t('profile:replay.questFailChar')}
                                  </div>
                                ))}
                                {Array.from({ length: Math.max(0, 5 - questResults.length) }).map((_, i) => (
                                  <div key={`empty-${i}`} className="w-9 h-9 rounded-full border-2 border-gray-600 bg-gray-700/30" />
                                ))}
                              </div>
                            </div>
                          )}
                          {evilWins !== null && (
                            <div className={`text-sm font-bold px-3 py-1 rounded-lg inline-flex items-center gap-1.5 ${
                              evilWins
                                ? 'bg-red-900/50 text-red-300 border border-red-600'
                                : 'bg-blue-900/50 text-blue-300 border border-blue-600'
                            }`}>
                              <CampDisc team={evilWins ? 'evil' : 'good'} className="w-4 h-4" />
                              {evilWins ? t('profile:replay.winnerEvil') : t('profile:replay.winnerGood')}
                            </div>
                          )}
                        </div>
                        <div className="space-y-0">
                          {replay.events.map(ev => (
                            <div key={ev.seq} className={`flex gap-2 py-1.5 border-b border-gray-700/30 text-sm items-start ${
                              ev.event_type === 'round_ended' || ev.event_type === 'game_ended' ? 'bg-gray-700/20' : ''
                            }`}>
                              <span className="text-gray-600 w-5 text-right flex-shrink-0 text-xs pt-0.5">{ev.seq}</span>
                              <span className="flex-shrink-0">{EVENT_ICONS[ev.event_type] ?? '•'}</span>
                              <span className="text-gray-300">{formatReplayEvent(ev, t)}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
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

