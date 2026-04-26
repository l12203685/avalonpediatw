import { useState, useEffect, useMemo } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { ArrowLeft, Shield, Swords, TrendingUp, Clock, Loader, Trophy, ExternalLink, UserPlus, UserMinus, Link2, Sparkles, Pencil, Check, X as XIcon, Mail, Copy, BarChart3, Camera, Lock, Eye, EyeOff, RefreshCcw } from 'lucide-react';
import { getEloRank } from '../utils/eloRank';
import { CampDisc } from '../components/CampDisc';
import { checkFollowing, followUser, unfollowUser, fetchAutoMatchCandidates, fetchMyClaims, updateMyProfile, uploadAvatar } from '../services/api';
import { useGameStore } from '../store/gameStore';
import { fetchMyProfile, fetchUserProfile, fetchGameReplay, UserProfile, RecentGame, GameEvent } from '../services/api';
import { fetchLinkedAccounts, unlinkAccount, buildLinkProviderUrl, type LinkedAccount, type LinkProvider } from '../services/api';
import { getStoredToken } from '../services/socket';
import { changePassword, estimatePasswordStrength } from '../services/auth';
import { forceRefresh } from '../utils/forceRefresh';

const ROLE_COLORS: Record<string, string> = {
  merlin: 'text-blue-300', percival: 'text-blue-200', loyal: 'text-blue-400',
  assassin: 'text-red-400', morgana: 'text-rose-400', mordred: 'text-red-600',
  oberon: 'text-slate-400', minion: 'text-red-300',
};

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

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

export default function ProfilePage(): JSX.Element {
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
  const { setGameState, profileUserId, navigateToProfile, addToast, currentPlayer, setCurrentPlayer } = useGameStore();
  const [profile, setProfile]       = useState<UserProfile | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [replay, setReplay]         = useState<{ roomId: string; events: GameEvent[]; game: RecentGame | null } | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [isFollowingUser, setIsFollowingUser] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [autoMatchCount, setAutoMatchCount] = useState<number | null>(null);
  const [hasPendingClaim, setHasPendingClaim] = useState(false);

  // Profile edit mode — only visible on own profile
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhotoUrl, setEditPhotoUrl] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  // Avatar upload — Edward 2026-04-25
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError]         = useState('');

  // #42 Linked accounts — own profile only
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[] | null>(null);
  const [linkBusy, setLinkBusy] = useState<LinkProvider | null>(null);
  const [linkNotice, setLinkNotice] = useState<{ kind: 'ok' | 'merged' | 'error'; msg: string } | null>(null);

  // Edward 2026-04-25 19:44: 把 SettingsPage 獨有功能 (密碼/信箱/清除本機資料)
  // 搬到 ProfilePage，HomePage 不再放「登入綁定」入口。Provider='password' 帳號
  // 才看得到密碼修改區；其他 OAuth 帳號顯示提示訊息。
  const isPasswordAccount = (currentPlayer as { provider?: string } | null)?.provider === 'password';
  const [pwForm, setPwForm] = useState({ old: '', new: '', confirm: '' });
  const [pwShow, setPwShow] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');
  const pwStrength = useMemo(() => estimatePasswordStrength(pwForm.new), [pwForm.new]);
  const pwConfirmMismatch = pwForm.confirm.length > 0 && pwForm.new !== pwForm.confirm;

  const isMe = !profileUserId || profileUserId === 'me';

  useEffect(() => {
    const token = getStoredToken();

    const fetch = isMe && token
      ? fetchMyProfile(token)
      : profileUserId
        ? fetchUserProfile(profileUserId)
        : Promise.reject(new Error('no user'));

    fetch
      .then(setProfile)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('404')) {
          setError(t('profile:error.noRecords'));
        } else if (msg.includes('401')) {
          setError(t('profile:error.notLoggedIn'));
        } else {
          setError(t('profile:error.loadFailed'));
        }
      })
      .finally(() => setLoading(false));
  }, [profileUserId]);

  useEffect(() => {
    if (isMe || !profileUserId) return;
    const token = getStoredToken();
    if (!token) return;
    checkFollowing(token, profileUserId)
      .then(setIsFollowingUser)
      .catch(() => {});
  }, [profileUserId, isMe]);

  // #42 — own profile: fetch linked accounts + parse redirect flags on mount
  // 2026-04-22 hotfix：訪客 session 跳過 linked-accounts fetch（server 回 403），
  // 避免 Promise rejection 被全域 error listener 捕獲誤報為應用崩潰。
  useEffect(() => {
    if (!isMe) return;
    const token = getStoredToken();
    if (!token) return;

    const guestNow = useGameStore.getState().currentPlayer?.provider === 'guest';
    if (guestNow) {
      setLinkedAccounts([]);
    } else {
      fetchLinkedAccounts(token)
        .then(setLinkedAccounts)
        .catch(() => setLinkedAccounts([]));
    }

    // 讀 URL 是否從綁定 callback 回來
    const params = new URLSearchParams(window.location.search);
    const mergedProvider = params.get('link_merged');
    const okProvider     = params.get('link_ok');
    const errProvider    = params.get('link_error');
    const provider       = params.get('provider') || '';
    if (mergedProvider) {
      setLinkNotice({ kind: 'merged', msg: t('profile:linked.noticeMerged', { provider }) });
    } else if (okProvider) {
      setLinkNotice({ kind: 'ok', msg: t('profile:linked.noticeOk', { provider }) });
    } else if (errProvider) {
      setLinkNotice({ kind: 'error', msg: t('profile:linked.noticeError', { provider, reason: errProvider }) });
    }
    if (mergedProvider || okProvider || errProvider) {
      // 清掉 URL query 避免重整時重複跳提示
      ['link_merged', 'link_ok', 'link_error', 'provider'].forEach((k) => params.delete(k));
      const qs = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
  }, [isMe]);

  // On own profile, probe unclaimed records + outstanding claim applications.
  // 訪客無任何 claim 權利（claim 需綁正式帳號），直接跳過避免 API 噪音。
  useEffect(() => {
    if (!isMe) return;
    const token = getStoredToken();
    if (!token) return;
    const guestNow = useGameStore.getState().currentPlayer?.provider === 'guest';
    if (guestNow) {
      setAutoMatchCount(0);
      setHasPendingClaim(false);
      return;
    }
    fetchAutoMatchCandidates(token)
      .then(records => setAutoMatchCount(records.length))
      .catch(() => setAutoMatchCount(null));
    fetchMyClaims(token)
      .then(claims => setHasPendingClaim(claims.some(c => c.status === 'pending')))
      .catch(() => setHasPendingClaim(false));
  }, [isMe]);

  const handleFollowToggle = async (): Promise<void> => {
    const token = getStoredToken();
    if (!token || !profileUserId) return;
    setFollowLoading(true);
    try {
      if (isFollowingUser) {
        await unfollowUser(token, profileUserId);
        setIsFollowingUser(false);
        addToast(t('profile:follow.unfollowSuccess', { name: profile?.display_name ?? '' }), 'info');
      } else {
        await followUser(token, profileUserId);
        setIsFollowingUser(true);
        addToast(t('profile:follow.followSuccess', { name: profile?.display_name ?? '' }), 'success');
      }
    } catch {
      addToast(t('profile:error.operationFailed'), 'error');
    } finally {
      setFollowLoading(false);
    }
  };

  const handleStartEdit = (): void => {
    if (!profile) return;
    setEditName(profile.display_name ?? '');
    setEditPhotoUrl(profile.photo_url ?? '');
    setEditError('');
    setEditing(true);
  };

  const handleCancelEdit = (): void => {
    setEditing(false);
    setEditError('');
  };

  const handleSaveEdit = async (): Promise<void> => {
    const token = getStoredToken();
    if (!token || !profile) {
      setEditError(t('profile:edit.errLogin'));
      return;
    }
    const trimmedName = editName.trim();
    if (trimmedName.length === 0 || trimmedName.length > 40) {
      setEditError(t('profile:edit.errNameLength'));
      return;
    }
    const trimmedUrl = editPhotoUrl.trim();
    if (trimmedUrl.length > 0 && !/^https?:\/\//i.test(trimmedUrl)) {
      setEditError(t('profile:edit.errUrlFormat'));
      return;
    }
    if (trimmedUrl.length > 500) {
      setEditError(t('profile:edit.errUrlTooLong'));
      return;
    }

    setEditSaving(true);
    setEditError('');
    try {
      const patch: { display_name?: string; photo_url?: string | null } = {};
      if (trimmedName !== (profile.display_name ?? '')) {
        patch.display_name = trimmedName;
      }
      if (trimmedUrl !== (profile.photo_url ?? '')) {
        patch.photo_url = trimmedUrl.length === 0 ? null : trimmedUrl;
      }
      if (Object.keys(patch).length === 0) {
        setEditing(false);
        return;
      }
      const updated = await updateMyProfile(token, patch);
      setProfile(updated);
      // 2026-04-23 bind-name-sync：把新 display_name / photo_url 同步到 gameStore
      // 的 currentPlayer，讓 SettingsPage / Header 等地方立刻顯示新名稱，不用
      // 等 socket 重連（上次 Edward 回報改名後 UI 沒同步）。
      if (currentPlayer && (patch.display_name !== undefined || patch.photo_url !== undefined)) {
        setCurrentPlayer({
          ...currentPlayer,
          ...(patch.display_name !== undefined ? { name: updated.display_name } : {}),
          ...(patch.photo_url !== undefined ? { avatar: updated.photo_url ?? undefined } : {}),
        });
      }
      setEditing(false);
      addToast(t('profile:edit.updateSuccess'), 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('profile:edit.updateFail');
      setEditError(msg);
      addToast(t('profile:edit.updateFail'), 'error');
    } finally {
      setEditSaving(false);
    }
  };

  // Avatar upload — submit a File to the server, Firebase Storage stores it,
  // server writes photo_url back to auth_users + Supabase, returns the public URL.
  // We then merge into local profile so the avatar updates immediately.
  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    // Reset input so the same file can be reselected after a failure.
    e.target.value = '';
    if (!file) return;

    const token = getStoredToken();
    if (!token) {
      setAvatarError(t('profile:edit.errLogin'));
      return;
    }

    setAvatarError('');
    setAvatarUploading(true);
    try {
      const { avatarUrl } = await uploadAvatar(token, file);
      // Reflect new URL into local profile + gameStore so PlayerCard rerenders.
      if (profile) {
        setProfile({ ...profile, photo_url: avatarUrl });
      }
      if (currentPlayer) {
        setCurrentPlayer({ ...currentPlayer, avatar: avatarUrl });
      }
      // If user is mid-edit, sync the URL field too.
      setEditPhotoUrl(avatarUrl);
      addToast(t('profile:edit.updateSuccess'), 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('profile:edit.updateFail');
      setAvatarError(msg);
      addToast(msg, 'error');
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleCopyId = (): void => {
    if (!profile) return;
    const id = profile.id;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(id).then(
        () => addToast(t('profile:identity.copyId'), 'success'),
        () => addToast(t('profile:error.copyFailed'), 'error'),
      );
    }
  };

  const handleCopyShortCode = (): void => {
    if (!profile?.short_code) return;
    const code = profile.short_code;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(
        () => addToast('已複製玩家短碼', 'success'),
        () => addToast('複製失敗', 'error'),
      );
    }
  };

  // #42 Bind / unbind handlers
  const handleLinkProvider = (provider: LinkProvider): void => {
    const token = getStoredToken();
    if (!token) return;
    if (provider === 'google') {
      // Google 需要前端先拿 Firebase ID token；目前系統尚未掛 Firebase web SDK 在此頁，
      // 導回登入頁讓使用者用 Google 重新登入（系統會偵測同一信箱後觸發合併）。
      addToast(t('profile:linked.googleHint'), 'info');
      return;
    }
    // Discord / Line — 整頁跳轉到 /auth/link/<provider>，流程完畢 callback 會回到 /profile
    window.location.href = buildLinkProviderUrl(token, provider);
  };

  const handleUnlinkProvider = async (provider: LinkProvider): Promise<void> => {
    const token = getStoredToken();
    if (!token) return;
    setLinkBusy(provider);
    try {
      const updated = await unlinkAccount(token, provider);
      setLinkedAccounts(updated);
      addToast(t('profile:linked.unlinked', { provider }), 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('LAST_PROVIDER')) {
        addToast(t('profile:linked.cannotUnlinkLast'), 'error');
      } else {
        addToast(t('profile:linked.unlinkFailed'), 'error');
      }
    } finally {
      setLinkBusy(null);
    }
  };

  // Edward 2026-04-25 19:44: 改密碼 (provider='password' 帳號)。從 SettingsPage
  // 搬過來；驗證邏輯與後端 contract 一致 (≥8 字 + 英文字母 + 數字)。
  const handleChangePassword = async (): Promise<void> => {
    const token = getStoredToken();
    if (!token) { setPwError(t('common:settings.pwOldPlaceholder', { defaultValue: '未登入' })); return; }
    if (!pwForm.old) { setPwError('請輸入原密碼'); return; }
    if (pwForm.new.length < 8) { setPwError('新密碼至少 8 字元'); return; }
    if (!/[A-Za-z]/.test(pwForm.new)) { setPwError('新密碼需要至少一個英文字母'); return; }
    if (!/\d/.test(pwForm.new)) { setPwError('新密碼需要至少一個數字'); return; }
    if (pwForm.new !== pwForm.confirm) { setPwError('兩次輸入不一致'); return; }
    if (pwForm.old === pwForm.new) { setPwError('新密碼不能跟原密碼相同'); return; }
    setPwBusy(true);
    setPwError('');
    try {
      await changePassword(token, pwForm.old, pwForm.new);
      addToast(t('common:settings.pwChanged', { defaultValue: '密碼已更新' }), 'success');
      setPwForm({ old: '', new: '', confirm: '' });
    } catch (err) {
      setPwError(err instanceof Error ? err.message : '改密碼失敗');
    } finally {
      setPwBusy(false);
    }
  };

  const handleReplay = (roomId: string, game: RecentGame | null = null): void => {
    setReplayLoading(true);
    fetchGameReplay(roomId)
      .then(events => setReplay({ roomId, events, game }))
      .catch(() => setReplay({ roomId, events: [], game }))
      .finally(() => setReplayLoading(false));
  };

  const winRate = profile && profile.total_games > 0
    ? Math.round((profile.games_won / profile.total_games) * 100)
    : 0;

  // Compute good/evil win rates from recent game data
  const teamStats = profile
    ? profile.recent_games.reduce<Record<'good' | 'evil', { wins: number; total: number }>>(
        (acc, g) => {
          const t = g.team as 'good' | 'evil';
          if (!acc[t]) return acc;
          acc[t].total++;
          if (g.won) acc[t].wins++;
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
    <div className="min-h-screen p-4">
      <div className="max-w-lg mx-auto space-y-6">

        {/* Header — #86 IA 整合：右側加「數據分析」入口，戰績頁不再拆成獨立按鈕 */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('home')}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-black text-white flex-1">{t('profile:headerTitle')}</h1>
          {/* Edward 2026-04-25 19:44: 修「nav.analysis」未翻譯 bug。
              useTranslation(['profile', 'common', 'game']) 讓 profile 成為
              default namespace，t('nav.analysis') 會去查 profile:nav.analysis
              (不存在) → fallback 到字面 key。改用明確 common: 前綴。 */}
          <button
            onClick={() => setGameState('analysis')}
            data-testid="profile-btn-analysis"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white transition-colors"
            title={t('common:nav.analysis')}
          >
            <BarChart3 size={14} />
            {t('common:nav.analysis')}
          </button>
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

        {profile && (
          <>
            {/* Claim banner — own profile only */}
            {isMe && (autoMatchCount !== null && autoMatchCount > 0) && (
              <button
                onClick={() => setGameState('claimsNew')}
                className="w-full bg-gradient-to-r from-blue-900/50 to-amber-900/50 hover:from-blue-800/60 hover:to-amber-800/60 border border-blue-700/60 rounded-xl p-4 text-left transition-all group"
              >
                <div className="flex items-center gap-3">
                  <Sparkles size={24} className="text-amber-300 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-white">
                      <Trans
                        i18nKey="profile:claims.maybeOld"
                        values={{ count: autoMatchCount }}
                        components={{ count: <span className="text-amber-300" /> }}
                      />
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {t('profile:claims.maybeOldHint')}
                    </p>
                  </div>
                  <Link2 size={16} className="text-blue-300 group-hover:translate-x-0.5 transition-transform flex-shrink-0" />
                </div>
              </button>
            )}
            {isMe && autoMatchCount === 0 && hasPendingClaim && (
              <button
                onClick={() => setGameState('claimsNew')}
                className="w-full bg-yellow-900/40 hover:bg-yellow-900/50 border border-yellow-700/50 rounded-xl p-3 text-left transition-all flex items-center gap-3"
              >
                <Clock size={16} className="text-yellow-300 flex-shrink-0" />
                <p className="text-xs text-yellow-200 flex-1">{t('profile:claims.pending')}</p>
              </button>
            )}
            {isMe && autoMatchCount === 0 && !hasPendingClaim && (
              <button
                onClick={() => setGameState('claimsNew')}
                className="w-full bg-avalon-card/30 hover:bg-avalon-card/50 border border-gray-700 rounded-xl p-2.5 text-center text-xs text-gray-500 hover:text-gray-300 transition-all flex items-center justify-center gap-2"
              >
                <Link2 size={12} /> {t('profile:claims.searchOld')}
              </button>
            )}

            {/* Avatar + name */}
            <div className="bg-avalon-card/60 border border-gray-700 rounded-2xl p-6">
              {editing && isMe ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-5">
                    <div className="relative flex-shrink-0">
                      {editPhotoUrl.trim() ? (
                        <img
                          src={editPhotoUrl.trim()}
                          alt=""
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                          className="w-20 h-20 rounded-full object-cover border-2 border-blue-500/50 bg-gray-800"
                        />
                      ) : (
                        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-600 to-amber-600 flex items-center justify-center text-white font-black text-3xl border-2 border-blue-500/50">
                          {(editName || profile.display_name)[0]?.toUpperCase()}
                        </div>
                      )}
                      <label
                        className={`absolute -bottom-1 -right-1 flex items-center justify-center w-7 h-7 rounded-full border-2 border-blue-500/70 shadow-md transition-all cursor-pointer ${
                          avatarUploading
                            ? 'bg-gray-700 cursor-wait'
                            : 'bg-blue-600 hover:bg-blue-500 hover:scale-110'
                        }`}
                        title={avatarUploading ? t('profile:saving') : t('profile:avatarUpload.button')}
                        aria-label={t('profile:avatarUpload.button')}
                      >
                        {avatarUploading ? (
                          <Loader size={14} className="animate-spin text-white" />
                        ) : (
                          <Camera size={14} className="text-white" />
                        )}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          className="hidden"
                          disabled={avatarUploading}
                          onChange={handleAvatarFile}
                        />
                      </label>
                    </div>
                    <div className="flex-1 min-w-0">
                      <label className="block text-xs font-bold text-gray-400 mb-1">{t('profile:displayNameLabel')}</label>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        maxLength={40}
                        placeholder={t('profile:displayNamePlaceholder')}
                        className="w-full bg-avalon-card/80 border border-gray-600 focus:border-blue-500 rounded-lg px-3 py-2 text-white text-sm outline-none"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-400 mb-1">{t('profile:photoUrlLabel')}</label>
                    <input
                      type="url"
                      value={editPhotoUrl}
                      onChange={(e) => setEditPhotoUrl(e.target.value)}
                      maxLength={500}
                      placeholder="https://..."
                      className="w-full bg-avalon-card/80 border border-gray-600 focus:border-blue-500 rounded-lg px-3 py-2 text-white text-sm outline-none"
                    />
                    <p className="text-[10px] text-gray-500 mt-1">{t('profile:avatarUpload.hint')}</p>
                  </div>
                  {avatarError && (
                    <div className="text-xs text-red-400 bg-red-900/20 border border-red-700/50 rounded-lg px-3 py-2">
                      {avatarError}
                    </div>
                  )}
                  {editError && (
                    <div className="text-xs text-red-400 bg-red-900/20 border border-red-700/50 rounded-lg px-3 py-2">
                      {editError}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={handleSaveEdit}
                      disabled={editSaving}
                      className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg border border-blue-700 bg-blue-900/40 hover:bg-blue-800/60 text-blue-200 hover:text-white font-semibold transition-all disabled:opacity-50"
                    >
                      <Check size={14} />
                      {editSaving ? t('profile:saving') : t('profile:save')}
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      disabled={editSaving}
                      className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg border border-gray-600 bg-gray-800/40 hover:bg-gray-700/60 text-gray-300 hover:text-white font-semibold transition-all disabled:opacity-50"
                    >
                      <XIcon size={14} /> {t('profile:cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-5">
                  {/* Avatar circle + upload button overlay (own profile only).
                      Edward 2026-04-25「讓玩家顯圖可以自行上傳」— 點頭像直接觸發
                      file picker，不必先進入 Edit 模式，門檻最低。 */}
                  <div className="relative flex-shrink-0">
                    {profile.photo_url ? (
                      <img src={profile.photo_url} alt="" className="w-20 h-20 rounded-full object-cover border-2 border-blue-500/50" />
                    ) : (
                      <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-600 to-amber-600 flex items-center justify-center text-white font-black text-3xl border-2 border-blue-500/50">
                        {profile.display_name[0]?.toUpperCase()}
                      </div>
                    )}
                    {isMe && (
                      <label
                        className={`absolute -bottom-1 -right-1 flex items-center justify-center w-7 h-7 rounded-full border-2 border-blue-500/70 shadow-md transition-all cursor-pointer ${
                          avatarUploading
                            ? 'bg-gray-700 cursor-wait'
                            : 'bg-blue-600 hover:bg-blue-500 hover:scale-110'
                        }`}
                        title={avatarUploading ? t('profile:saving') : t('profile:avatarUpload.button')}
                        aria-label={t('profile:avatarUpload.button')}
                      >
                        {avatarUploading ? (
                          <Loader size={14} className="animate-spin text-white" />
                        ) : (
                          <Camera size={14} className="text-white" />
                        )}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          className="hidden"
                          disabled={avatarUploading}
                          onChange={handleAvatarFile}
                        />
                      </label>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-2xl font-black text-white">{profile.display_name}</h2>
                      {isMe && (
                        <button
                          onClick={handleStartEdit}
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-gray-600 bg-gray-800/40 hover:bg-gray-700/60 text-gray-300 hover:text-white transition-all"
                          title={t('profile:editProfile')}
                        >
                          <Pencil size={12} /> {t('profile:editShort')}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <TrendingUp size={16} className="text-blue-400" />
                      <span className="text-blue-300 font-bold text-lg">{profile.elo_rating}</span>
                      <span className="text-gray-500 text-sm">ELO</span>
                      {(() => {
                        const rank = getEloRank(profile.elo_rating, profile.total_games);
                        return (
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${rank.color} ${rank.bgColor} ${rank.borderColor}`}>
                            {rank.label}
                          </span>
                        );
                      })()}
                    </div>
                    {profile.badges.length > 0 && (
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {profile.badges.map(b => (
                          <span key={b} className="text-xs px-2 py-0.5 bg-amber-900/60 border border-amber-600/50 text-amber-300 rounded-full">
                            {b}
                          </span>
                        ))}
                      </div>
                    )}
                    {!isMe && (
                      <button
                        onClick={handleFollowToggle}
                        disabled={followLoading}
                        className={`mt-3 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border font-semibold transition-all disabled:opacity-50 ${
                          isFollowingUser
                            ? 'bg-gray-800 hover:bg-red-900/40 border-gray-600 hover:border-red-700 text-gray-300 hover:text-red-400'
                            : 'bg-blue-900/40 hover:bg-blue-800/60 border-blue-700 text-blue-300 hover:text-white'
                        }`}
                      >
                        {isFollowingUser ? <UserMinus size={12} /> : <UserPlus size={12} />}
                        {followLoading ? t('profile:follow.loading') : isFollowingUser ? t('profile:unfollow') : t('profile:follow')}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Avatar upload error in view mode */}
              {!editing && avatarError && isMe && (
                <div className="mt-3 text-xs text-red-400 bg-red-900/20 border border-red-700/50 rounded-lg px-3 py-2">
                  {avatarError}
                </div>
              )}

              {/* Identity block — user ID + email (own profile only) */}
              {isMe && !editing && (
                <div className="mt-4 pt-4 border-t border-gray-700/60 space-y-2">
                  {profile.short_code && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-500 min-w-[72px]">玩家短碼</span>
                      <code className="flex-1 text-amber-300 font-mono text-sm font-bold tracking-widest">
                        {profile.short_code}
                      </code>
                      <button
                        onClick={handleCopyShortCode}
                        className="flex items-center gap-1 px-2 py-1 rounded border border-amber-600/50 bg-amber-900/20 hover:bg-amber-900/40 text-amber-300 hover:text-amber-200 transition-all"
                        title="複製短碼 — 分享給朋友加好友"
                      >
                        <Copy size={10} />
                      </button>
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-gray-500 min-w-[72px]">{t('profile:identity.userId')}</span>
                    <code className="flex-1 text-gray-300 font-mono text-[10px] break-all">{profile.id}</code>
                    <button
                      onClick={handleCopyId}
                      className="flex items-center gap-1 px-2 py-1 rounded border border-gray-600 bg-gray-800/40 hover:bg-gray-700/60 text-gray-400 hover:text-white transition-all"
                      title={t('profile:identity.copyId')}
                    >
                      <Copy size={10} />
                    </button>
                  </div>
                  {profile.email && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-500 min-w-[72px] flex items-center gap-1"><Mail size={11} /> {t('profile:identity.email')}</span>
                      <span className="flex-1 text-gray-300 break-all">{profile.email}</span>
                    </div>
                  )}
                </div>
              )}

              {/* #42 Linked accounts — own profile only */}
              {isMe && !editing && linkedAccounts && (
                <div className="mt-4 pt-4 border-t border-gray-700/60">
                  <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wider text-gray-500">
                    <Link2 size={11} /> {t('profile:linked.title')}
                  </div>
                  {linkNotice && (
                    <div className={`mb-2 px-3 py-1.5 rounded text-xs ${
                      linkNotice.kind === 'error'
                        ? 'bg-red-900/40 border border-red-700 text-red-300'
                        : linkNotice.kind === 'merged'
                          ? 'bg-amber-900/40 border border-amber-700 text-amber-300'
                          : 'bg-blue-900/40 border border-blue-700 text-blue-300'
                    }`}>
                      {linkNotice.msg}
                    </div>
                  )}
                  <ul className="space-y-1.5">
                    {linkedAccounts.map((acc) => (
                      <li key={acc.provider} className="flex items-center gap-2 text-xs">
                        <span className="min-w-[72px] capitalize text-gray-300">{t(`profile:linked.provider.${acc.provider}`)}</span>
                        <span className={`flex-1 truncate ${acc.linked ? 'text-gray-300' : 'text-gray-600'}`}>
                          {acc.linked
                            ? (acc.external_id ? acc.external_id : t('profile:linked.connected'))
                            : t('profile:linked.notConnected')}
                          {acc.primary && <span className="ml-1 text-[10px] text-amber-400">({t('profile:linked.primary')})</span>}
                        </span>
                        {acc.linked ? (
                          <button
                            onClick={() => handleUnlinkProvider(acc.provider)}
                            disabled={linkBusy === acc.provider || linkedAccounts.filter((l) => l.linked).length <= 1}
                            className="px-2 py-1 text-[11px] rounded border border-gray-600 text-gray-400 hover:border-red-700 hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            title={linkedAccounts.filter((l) => l.linked).length <= 1 ? t('profile:linked.cannotUnlinkLast') : t('profile:linked.unlinkBtn')}
                          >
                            {linkBusy === acc.provider ? '…' : t('profile:linked.unlinkBtn')}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleLinkProvider(acc.provider)}
                            disabled={linkBusy !== null}
                            className="px-2 py-1 text-[11px] rounded border border-blue-700 bg-blue-900/40 text-blue-300 hover:bg-blue-800/60 disabled:opacity-40 transition-colors"
                          >
                            {t('profile:linked.linkBtn')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[10px] text-gray-600 leading-relaxed">
                    {t('profile:linked.helpText')}
                  </p>
                </div>
              )}
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
                <div className="text-3xl font-black text-white">{profile.total_games}</div>
                <div className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
                  <Clock size={12} /> {t('profile:totalGamesLabel')}
                </div>
              </div>
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
                <div className="text-3xl font-black text-blue-400">{winRate}%</div>
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

            {/* Good/Evil split */}
            {teamStats && (teamStats.good.total > 0 || teamStats.evil.total > 0) && (
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                <p className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">{t('profile:stats.teamWinRates')} <span className="font-normal text-gray-500">{t('profile:stats.recentGamesSuffix', { count: profile.recent_games.length })}</span></p>
                <div className="grid grid-cols-2 gap-3">
                  {(['good', 'evil'] as const).map(team => {
                    const { wins, total } = teamStats[team];
                    const pct = total > 0 ? Math.round((wins / total) * 100) : 0;
                    const isGood = team === 'good';
                    return (
                      <div key={team} className={`rounded-lg border p-3 text-center ${isGood ? 'bg-blue-900/20 border-blue-700/50' : 'bg-red-900/20 border-red-700/50'}`}>
                        <div className={`text-2xl font-black ${pct >= 50 ? (isGood ? 'text-blue-300' : 'text-red-300') : 'text-gray-400'}`}>
                          {total > 0 ? `${pct}%` : '—'}
                        </div>
                        {/* Edward 2026-04-25 19:40 emoji→lake-disc swap: 陣營勝率
                            label 前綴用 lake-yes/lake-no 圓圈取代 ⚔️/👹 emoji。 */}
                        <div className={`text-xs mt-1 inline-flex items-center justify-center gap-1 ${isGood ? 'text-blue-400' : 'text-red-400'}`}>
                          <CampDisc team={isGood ? 'good' : 'evil'} className="w-3 h-3" />
                          {isGood ? t('profile:stats.good') : t('profile:stats.evil')}
                        </div>
                        {total > 0 && <div className="text-xs text-gray-600 mt-0.5">{wins}/{total}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ELO trend sparkline */}
            {profile.recent_games.length >= 2 && (() => {
              // Compute ELO at each game (games are newest-first, so reconstruct chronologically)
              const games = [...profile.recent_games].reverse(); // oldest first
              const points: number[] = [];
              let elo = profile.elo_rating;
              // Work backwards to get starting ELO
              const startElo = games.reduce((acc, g) => acc - g.elo_delta, profile.elo_rating);
              elo = startElo;
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

              // Area fill path (close to bottom)
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
                    {/* Area */}
                    <path d={areaD} fill={`url(#${fillId})`} />
                    {/* Line */}
                    <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    {/* Dots */}
                    {points.map((v, i) => {
                      const g = games[i - 1];
                      const dotColor = !g ? '#9ca3af' : g.won ? '#60a5fa' : '#f87171';
                      return <circle key={i} cx={toX(i)} cy={toY(v)} r="3" fill={dotColor} />;
                    })}
                    {/* Start/end labels */}
                    <text x={toX(0)} y={H - 2} textAnchor="middle" fontSize="9" fill="#6b7280">{points[0].toFixed(0)}</text>
                    <text x={toX(points.length - 1)} y={H - 2} textAnchor="middle" fontSize="9" fill={strokeColor}>{points[points.length - 1].toFixed(0)}</text>
                  </svg>
                </div>
              );
            })()}

            {/* Role stats (from recent games) */}
            {roleStats.length > 0 && (
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                <h3 className="text-sm font-bold text-gray-300 mb-3">{t('profile:stats.roleWinRates')} <span className="text-gray-500 font-normal">{t('profile:stats.recentGamesSuffix', { count: profile!.recent_games.length })}</span></h3>
                <div className="space-y-2">
                  {roleStats.map(([role, { wins, total }]) => {
                    const pct = Math.round((wins / total) * 100);
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
                        <span className="text-xs text-gray-600 w-10 text-right">{wins}/{total}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Win rate by player count */}
            {playerCountStats.length > 0 && (
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                <h3 className="text-sm font-bold text-gray-300 mb-3">{t('profile:stats.playerCountWinRates')} <span className="text-gray-500 font-normal">{t('profile:stats.recentGamesSuffix', { count: profile!.recent_games.length })}</span></h3>
                <div className="space-y-2">
                  {playerCountStats.map(({ count, wins, total }) => {
                    const pct = Math.round((wins / total) * 100);
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
                        <span className="text-xs text-gray-600 w-10 text-right">{wins}/{total}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Recent games */}
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

            {/* Replay modal */}
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
                                {/* Edward 2026-04-25 emoji→disc: 中央圓盤陣營徽章取代 🔵/🔴。 */}
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
                    // Extract quest results and winner for visual summary
                    const questResults = replay.events
                      .filter(e => e.event_type === 'round_ended')
                      .map(e => (e.event_data as Record<string, unknown>).result as string);
                    const endEvent = replay.events.find(e => e.event_type === 'game_ended');
                    const evilWins = endEvent ? (endEvent.event_data as Record<string, unknown>).evilWins as boolean : null;
                    const playerCount = (replay.events[0]?.event_data as Record<string, unknown>)?.playerCount as number | undefined;

                    return (
                      <>
                        {/* Visual summary */}
                        <div className="bg-gray-800/60 rounded-xl p-4 mb-4 space-y-3">
                          {playerCount && (
                            <p className="text-xs text-gray-400">{t('profile:replay.playerCountFull', { count: playerCount })}</p>
                          )}
                          {/* Quest dots */}
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
                                {/* remaining quests */}
                                {Array.from({ length: Math.max(0, 5 - questResults.length) }).map((_, i) => (
                                  <div key={`empty-${i}`} className="w-9 h-9 rounded-full border-2 border-gray-600 bg-gray-700/30" />
                                ))}
                              </div>
                            </div>
                          )}
                          {/* Winner */}
                          {evilWins !== null && (
                            <div className={`text-sm font-bold px-3 py-1 rounded-lg inline-flex items-center gap-1.5 ${
                              evilWins
                                ? 'bg-red-900/50 text-red-300 border border-red-600'
                                : 'bg-blue-900/50 text-blue-300 border border-blue-600'
                            }`}>
                              {/* Edward 2026-04-25 emoji→disc: 中央圓盤陣營徽章取代 🔵/🔴。 */}
                              <CampDisc team={evilWins ? 'evil' : 'good'} className="w-4 h-4" />
                              {evilWins ? t('profile:replay.winnerEvil') : t('profile:replay.winnerGood')}
                            </div>
                          )}
                        </div>
                        {/* Event log */}
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

            {/* Edward 2026-04-25 19:44 整合：HomePage 的「登入綁定」按鈕已砍，
                以下三段 (密碼修改 / 主要信箱 / 清除本機資料) 從 SettingsPage 搬過
                來放這裡。只在 own profile + 非編輯模式顯示。SettingsPage 元件保
                留 (BindingField / OAuth callback 仍 route 到 settings)，但
                HomePage 不再放入口，避免兩頁功能重疊。 */}
            {isMe && !editing && (
              <>
                {/* 密碼修改 — 僅 provider='password' 帳號可見 */}
                <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Lock size={16} className="text-white" />
                    <h3 className="text-sm font-bold text-gray-300">
                      {t('common:settings.password', { defaultValue: '密碼' })}
                    </h3>
                  </div>
                  {!isPasswordAccount ? (
                    <p className="text-xs text-gray-500" data-testid="profile-password-unavailable">
                      {t('common:settings.pwOnlyForPasswordAccount', {
                        defaultValue: '僅密碼帳號可修改密碼。社群登入帳號請到對應平台更改。',
                      })}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-xs text-gray-500">
                        {t('common:settings.pwHint', { defaultValue: '至少 8 字，含英文字母 + 數字' })}
                      </p>
                      {pwError && (
                        <div className="bg-red-900/50 border border-red-600 rounded-lg p-2 text-red-200 text-xs" data-testid="profile-password-error">
                          {pwError}
                        </div>
                      )}
                      <div className="space-y-2">
                        <div className="relative">
                          <input
                            type={pwShow ? 'text' : 'password'}
                            autoComplete="current-password"
                            placeholder={t('common:settings.pwOldPlaceholder', { defaultValue: '原密碼' })}
                            value={pwForm.old}
                            onChange={e => setPwForm(f => ({ ...f, old: e.target.value }))}
                            data-testid="profile-input-pw-old"
                            className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 pr-10 text-white placeholder-zinc-500 focus:outline-none focus:border-white text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => setPwShow(v => !v)}
                            aria-label={pwShow ? '隱藏密碼' : '顯示密碼'}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                          >
                            {pwShow ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                        <input
                          type={pwShow ? 'text' : 'password'}
                          autoComplete="new-password"
                          placeholder={t('common:settings.pwNewPlaceholder', { defaultValue: '新密碼' })}
                          value={pwForm.new}
                          onChange={e => setPwForm(f => ({ ...f, new: e.target.value }))}
                          data-testid="profile-input-pw-new"
                          className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-white text-sm"
                        />
                        {pwForm.new.length > 0 && (
                          <div className="flex gap-1" data-testid="profile-pw-strength">
                            {[0, 1, 2, 3, 4].map(i => (
                              <div
                                key={i}
                                className={`h-1 flex-1 rounded ${
                                  i < pwStrength.score
                                    ? (['bg-red-500', 'bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-emerald-500'])[pwStrength.score]
                                    : 'bg-zinc-800'
                                }`}
                              />
                            ))}
                          </div>
                        )}
                        <input
                          type={pwShow ? 'text' : 'password'}
                          autoComplete="new-password"
                          placeholder={t('common:settings.pwConfirmPlaceholder', { defaultValue: '再次輸入新密碼' })}
                          value={pwForm.confirm}
                          onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
                          data-testid="profile-input-pw-confirm"
                          className={`w-full bg-zinc-950 border rounded-lg px-3 py-2 text-white placeholder-zinc-500 focus:outline-none text-sm ${
                            pwConfirmMismatch ? 'border-red-500' : 'border-zinc-700 focus:border-white'
                          }`}
                        />
                        {pwConfirmMismatch && (
                          <p className="text-[11px] text-red-400">兩次輸入不一致</p>
                        )}
                      </div>
                      <button
                        onClick={handleChangePassword}
                        disabled={pwBusy}
                        data-testid="profile-btn-change-pw"
                        className="inline-flex items-center gap-2 bg-white hover:bg-zinc-200 disabled:opacity-50 text-black font-semibold py-1.5 px-4 rounded-lg text-sm transition-colors"
                      >
                        {pwBusy && <Loader size={14} className="animate-spin" />}
                        {t('common:settings.pwSubmit', { defaultValue: '更新密碼' })}
                      </button>
                    </div>
                  )}
                </div>

                {/* 主要信箱管理 */}
                <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Mail size={16} className="text-white" />
                    <h3 className="text-sm font-bold text-gray-300">
                      {t('common:settings.email', { defaultValue: '信箱管理' })}
                    </h3>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    {t('common:settings.emailHint', { defaultValue: '主要信箱用於忘密重設與帳號通知' })}
                  </p>
                  {(() => {
                    const primary = (currentPlayer as { primaryEmail?: string; email?: string } | null)?.primaryEmail
                      ?? (currentPlayer as { primaryEmail?: string; email?: string } | null)?.email
                      ?? profile.email
                      ?? null;
                    return primary ? (
                      <div className="flex items-center gap-2 bg-zinc-950/40 border border-zinc-800 rounded-lg px-3 py-2">
                        <Mail size={14} className="text-zinc-400" />
                        <code
                          className="text-[11px] text-zinc-200 font-mono break-all flex-1"
                          data-testid="profile-email-primary"
                        >{primary}</code>
                        <span className="text-[10px] text-amber-400">
                          {t('common:settings.primaryEmailLabel', { defaultValue: '主要' })}
                        </span>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500" data-testid="profile-email-empty">
                        {t('common:settings.noPrimaryEmail', { defaultValue: '尚未設定主要信箱' })}
                      </p>
                    );
                  })()}
                  <p className="mt-2 text-[11px] text-gray-600">
                    {t('common:settings.emailManageHint', {
                      defaultValue: '主要信箱來自登入時使用的 Google / Discord / Email 帳號；如需更換請重新綁定對應帳號。',
                    })}
                  </p>
                </div>

                {/* 清除本機資料並重新載入 */}
                <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <RefreshCcw size={16} className="text-white" />
                    <h3 className="text-sm font-bold text-gray-300">
                      {t('common:settings.advanced.title', { defaultValue: '進階' })}
                    </h3>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    {t('common:settings.advanced.clearWarning', {
                      defaultValue: '此動作會清除本機儲存的登入狀態與快取，完成後需重新登入',
                    })}
                  </p>
                  <button
                    type="button"
                    data-testid="profile-btn-force-refresh"
                    onClick={() => { void forceRefresh(); }}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-amber-50 text-sm font-semibold transition-colors"
                  >
                    <RefreshCcw size={14} />
                    {t('common:settings.advanced.clearLocalAndReload', {
                      defaultValue: '清除本機資料並重新載入',
                    })}
                  </button>
                </div>
              </>
            )}

            {/* View on leaderboard */}
            <button
              onClick={() => setGameState('leaderboard')}
              className="w-full text-sm text-gray-400 hover:text-white transition-colors py-2"
            >
              {t('profile:viewLeaderboard')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
