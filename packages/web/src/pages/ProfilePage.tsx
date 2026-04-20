import { useState, useEffect } from 'react';
import { ArrowLeft, Shield, Swords, TrendingUp, Clock, Loader, Trophy, ExternalLink, UserPlus, UserMinus, Link2, Sparkles, Pencil, Check, X as XIcon, Mail, Copy } from 'lucide-react';
import { getEloRank } from '../utils/eloRank';
import { checkFollowing, followUser, unfollowUser, fetchAutoMatchCandidates, fetchMyClaims, updateMyProfile } from '../services/api';
import { useGameStore } from '../store/gameStore';
import { fetchMyProfile, fetchUserProfile, fetchGameReplay, UserProfile, RecentGame, GameEvent } from '../services/api';
import { getStoredToken } from '../services/socket';

const ROLE_NAMES: Record<string, string> = {
  merlin:   '梅林 (Merlin)',
  percival: '派西維爾 (Percival)',
  loyal:    '忠臣 (Loyal Servant)',
  assassin: '刺客 (Assassin)',
  morgana:  '莫甘娜 (Morgana)',
  mordred:  '莫德雷德 (Mordred)',
  oberon:   '奧伯倫 (Oberon)',
  minion:   '爪牙 (Minion)',
  unknown:  '未知 (Unknown)',
};

const ROLE_COLORS: Record<string, string> = {
  merlin: 'text-blue-300', percival: 'text-blue-200', loyal: 'text-blue-400',
  assassin: 'text-red-400', morgana: 'text-rose-400', mordred: 'text-red-600',
  oberon: 'text-slate-400', minion: 'text-red-300',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' });
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

function formatReplayEvent(ev: GameEvent): string {
  const d = ev.event_data as Record<string, unknown>;
  switch (ev.event_type) {
    case 'game_started':
      return `遊戲開始 — ${d.playerCount as number}人局，領袖：${d.leaderId as string}`;
    case 'voting_phase_started': {
      const leaderLabel = (d.leaderName as string) || (d.leaderId as string) || '?';
      return `第${d.round as number}輪 — 第${(d.failedVotes ?? d.failCount) as number}次提案，領袖：${leaderLabel}`;
    }
    case 'quest_team_selected':
      return `領袖提案：${(d.team as string[])?.join('、')}`;
    case 'team_auto_selected':
      return `⏱ 領袖超時，自動選隊：${(d.team as string[])?.join('、')}`;
    case 'voting_resolved': {
      const approved = (d.result === 'approved' || d.approved) ? '✅ 通過' : '❌ 否決';
      return `投票結果：${approved}（${(d.approvals ?? d.approveCount) as number}贊成，${(d.rejections ?? d.rejectCount) as number}反對）`;
    }
    case 'team_approved':
      return `提案通過，任務開始`;
    case 'quest_resolved': {
      const result = d.result === 'success' ? '✅ 成功' : '❌ 失敗';
      return `任務結果：${result}（${d.failCount as number}張失敗票）`;
    }
    case 'round_ended':
      return `第${d.round as number}局結束 — 任務${d.result === 'success' ? '成功' : '失敗'}`;
    case 'discussion_phase_started':
      return `進入暗殺階段 — 好人贏得3個任務`;
    case 'assassination_submitted':
      return `刺客 ${d.assassinId as string} 刺殺 ${d.targetId as string}`;
    case 'game_ended': {
      const winner = d.evilWins ? '邪惡方' : '好人方';
      return `遊戲結束 — ${winner}獲勝（${d.reason as string}）`;
    }
    default:
      return ev.event_type;
  }
}

function GameRow({ game, onReplay }: { game: RecentGame; onReplay: (roomId: string, game: RecentGame) => void }): JSX.Element {
  const won = game.won;
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-gray-700/50 last:border-0">
      <div className={`w-14 text-center text-xs font-bold py-1 rounded ${won ? 'bg-blue-900/60 text-blue-400' : 'bg-red-900/60 text-red-400'}`}>
        {won ? '勝' : '敗'}
      </div>
      <div className="flex-1">
        <span className={`text-sm font-semibold ${ROLE_COLORS[game.role] ?? 'text-gray-300'}`}>
          {ROLE_NAMES[game.role] ?? game.role}
        </span>
        <span className="text-xs text-gray-500 ml-2">{game.player_count}人局</span>
      </div>
      <div className={`text-sm font-bold ${game.elo_delta >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
        {game.elo_delta >= 0 ? `+${game.elo_delta}` : game.elo_delta}
      </div>
      <div className="text-xs text-gray-600 w-14 text-right">{formatDate(game.created_at)}</div>
      <button
        onClick={() => onReplay(game.room_id, game)}
        className="p-1 text-gray-600 hover:text-blue-400 transition-colors"
        title="查看遊戲紀錄"
      >
        <ExternalLink size={12} />
      </button>
    </div>
  );
}

export default function ProfilePage(): JSX.Element {
  const { setGameState, profileUserId, navigateToProfile, addToast } = useGameStore();
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
          setError('尚無遊戲記錄 — 完成一場遊戲後就能看到你的個人資料');
        } else if (msg.includes('401')) {
          setError('請先登入才能查看個人資料');
        } else {
          setError('無法載入用戶資料，請稍後再試');
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

  // On own profile, probe unclaimed records + outstanding claim applications
  useEffect(() => {
    if (!isMe) return;
    const token = getStoredToken();
    if (!token) return;
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
        addToast(`已取消追蹤 ${profile?.display_name ?? ''}`, 'info');
      } else {
        await followUser(token, profileUserId);
        setIsFollowingUser(true);
        addToast(`已追蹤 ${profile?.display_name ?? ''}`, 'success');
      }
    } catch {
      addToast('操作失敗，請稍後再試', 'error');
    } finally {
      setFollowLoading(false);
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

        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('home')}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-black text-white">個人資料 (Profile)</h1>
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
                      你有 <span className="text-amber-300">{autoMatchCount}</span> 場可能的舊戰績
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      系統比對到你可能擁有的舊紀錄 — 申請綁定後就能顯示在你的統計裡
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
                <p className="text-xs text-yellow-200 flex-1">你有尚未審核的綁定申請 — 點我查看進度</p>
              </button>
            )}
            {isMe && autoMatchCount === 0 && !hasPendingClaim && (
              <button
                onClick={() => setGameState('claimsNew')}
                className="w-full bg-avalon-card/30 hover:bg-avalon-card/50 border border-gray-700 rounded-xl p-2.5 text-center text-xs text-gray-500 hover:text-gray-300 transition-all flex items-center justify-center gap-2"
              >
                <Link2 size={12} /> 用舊暱稱搜尋並綁定舊戰績
              </button>
            )}

            {/* Avatar + name */}
            <div className="bg-avalon-card/60 border border-gray-700 rounded-2xl p-6 flex items-center gap-5">
              {profile.photo_url ? (
                <img src={profile.photo_url} alt="" className="w-20 h-20 rounded-full object-cover border-2 border-blue-500/50" />
              ) : (
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-600 to-amber-600 flex items-center justify-center text-white font-black text-3xl border-2 border-blue-500/50">
                  {profile.display_name[0]?.toUpperCase()}
                </div>
              )}
              <div>
                <h2 className="text-2xl font-black text-white">{profile.display_name}</h2>
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
                    {followLoading ? '…' : isFollowingUser ? '取消追蹤' : '追蹤'}
                  </button>
                )}
              </div>
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
                <div className="text-3xl font-black text-white">{profile.total_games}</div>
                <div className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
                  <Clock size={12} /> 總場次
                </div>
              </div>
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
                <div className="text-3xl font-black text-blue-400">{winRate}%</div>
                <div className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
                  <Trophy size={12} /> 勝率
                </div>
              </div>
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
                <div className="text-3xl font-black text-blue-400">{profile.games_won}</div>
                <div className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
                  <Shield size={12} /> 勝場
                </div>
              </div>
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
                <div className="text-3xl font-black text-red-400">{profile.games_lost}</div>
                <div className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
                  <Swords size={12} /> 敗場
                </div>
              </div>
            </div>

            {/* Good/Evil split */}
            {teamStats && (teamStats.good.total > 0 || teamStats.evil.total > 0) && (
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
                <p className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">陣營勝率 (Team Win Rates) <span className="font-normal text-gray-500">— 近 {profile.recent_games.length} 局</span></p>
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
                        <div className={`text-xs mt-1 ${isGood ? 'text-blue-400' : 'text-red-400'}`}>
                          {isGood ? '⚔️ 正義方' : '👹 邪惡方'}
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
                    <h3 className="text-sm font-bold text-gray-300">ELO 趨勢 (近 {games.length} 局)</h3>
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
                <h3 className="text-sm font-bold text-gray-300 mb-3">角色勝率 (Role Win Rates) <span className="text-gray-500 font-normal">— 近 {profile!.recent_games.length} 局</span></h3>
                <div className="space-y-2">
                  {roleStats.map(([role, { wins, total }]) => {
                    const pct = Math.round((wins / total) * 100);
                    const color = ROLE_COLORS[role] ?? 'text-gray-300';
                    return (
                      <div key={role} className="flex items-center gap-2">
                        <span className={`text-xs font-semibold w-36 truncate ${color}`}>
                          {ROLE_NAMES[role] ?? role}
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
                <h3 className="text-sm font-bold text-gray-300 mb-3">人數勝率 (Win Rate by Player Count) <span className="text-gray-500 font-normal">— 近 {profile!.recent_games.length} 局</span></h3>
                <div className="space-y-2">
                  {playerCountStats.map(({ count, wins, total }) => {
                    const pct = Math.round((wins / total) * 100);
                    return (
                      <div key={count} className="flex items-center gap-2">
                        <span className="text-xs font-semibold w-10 text-gray-300 flex-shrink-0">
                          {count} 人局
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
              <h3 className="text-sm font-bold text-gray-300 mb-3">最近 {profile.recent_games.length} 局</h3>
              {profile.recent_games.length === 0 ? (
                <p className="text-center text-gray-500 text-sm py-4">尚無遊戲記錄</p>
              ) : (
                <div>
                  {profile.recent_games.map(g => (
                    <GameRow key={g.id} game={g} onReplay={handleReplay} />
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
                    <h3 className="font-bold text-white">遊戲紀錄 — <span className="font-mono text-yellow-400 text-sm">{replay?.roomId}</span></h3>
                    <button onClick={() => setReplay(null)} className="text-gray-500 hover:text-white">✕</button>
                  </div>
                  {replayLoading && <div className="flex justify-center py-8"><Loader size={24} className="animate-spin text-blue-400" /></div>}
                  {replay && replay.events.length === 0 && (
                    <div className="space-y-3">
                      {replay.game ? (
                        <>
                          <div className="bg-gray-800/60 rounded-xl p-4 space-y-2.5">
                            <p className="text-xs text-gray-400">{replay.game.player_count} 人局</p>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gray-500">你的角色</span>
                              <span className={`text-sm font-semibold ${ROLE_COLORS[replay.game.role] ?? 'text-gray-300'}`}>
                                {ROLE_NAMES[replay.game.role] ?? replay.game.role}
                              </span>
                              <span className={`text-[10px] px-2 py-0.5 rounded-full ml-auto ${
                                replay.game.team === 'good'
                                  ? 'bg-blue-900/60 text-blue-300 border border-blue-700/60'
                                  : 'bg-red-900/60 text-red-300 border border-red-700/60'
                              }`}>
                                {replay.game.team === 'good' ? '好人方' : '邪惡方'}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 pt-1">
                              <div className={`text-sm font-bold px-3 py-1 rounded-lg ${
                                replay.game.won
                                  ? 'bg-blue-900/50 text-blue-300 border border-blue-600'
                                  : 'bg-red-900/50 text-red-300 border border-red-600'
                              }`}>
                                {replay.game.won ? '🔵 勝利' : '🔴 落敗'}
                              </div>
                              <div className={`text-sm font-bold ${replay.game.elo_delta >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
                                ELO {replay.game.elo_delta >= 0 ? `+${replay.game.elo_delta}` : replay.game.elo_delta}
                              </div>
                              <div className="text-xs text-gray-500 ml-auto">
                                {formatDate(replay.game.created_at)}
                              </div>
                            </div>
                          </div>
                          <p className="text-xs text-center text-gray-600 pt-1">
                            此局為牌譜記錄功能上線前的舊局，僅顯示基本戰績
                          </p>
                        </>
                      ) : (
                        <p className="text-center text-gray-500 py-4">此局無紀錄資料</p>
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
                            <p className="text-xs text-gray-400">{playerCount} 人局 ({playerCount}-player game)</p>
                          )}
                          {/* Quest dots */}
                          {questResults.length > 0 && (
                            <div>
                              <p className="text-xs text-gray-500 mb-2">任務結果 (Quest Results)</p>
                              <div className="flex gap-2">
                                {questResults.map((r, i) => (
                                  <div key={i} className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-black border-2 ${
                                    r === 'success'
                                      ? 'bg-blue-600/40 border-blue-400 text-blue-300'
                                      : 'bg-red-600/40 border-red-400 text-red-300'
                                  }`}>
                                    {r === 'success' ? '藍' : '紅'}
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
                            <div className={`text-sm font-bold px-3 py-1 rounded-lg inline-block ${
                              evilWins
                                ? 'bg-red-900/50 text-red-300 border border-red-600'
                                : 'bg-blue-900/50 text-blue-300 border border-blue-600'
                            }`}>
                              {evilWins ? '🔴 邪惡方獲勝 (Evil Wins)' : '🔵 正義方獲勝 (Good Wins)'}
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
                              <span className="text-gray-300">{formatReplayEvent(ev)}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* View on leaderboard */}
            <button
              onClick={() => setGameState('leaderboard')}
              className="w-full text-sm text-gray-400 hover:text-white transition-colors py-2"
            >
              查看排行榜
            </button>
          </>
        )}
      </div>
    </div>
  );
}
