import { useState, useEffect } from 'react';
import { ArrowLeft, Shield, Swords, TrendingUp, Clock, Loader, Trophy, ExternalLink } from 'lucide-react';
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
  unknown:  '未知 (Unknown)',
};

const ROLE_COLORS: Record<string, string> = {
  merlin: 'text-blue-300', percival: 'text-cyan-300', loyal: 'text-green-300',
  assassin: 'text-red-400', morgana: 'text-pink-400', mordred: 'text-red-600',
  oberon: 'text-purple-400',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' });
}

const EVENT_ICONS: Record<string, string> = {
  game_started:              '🎮',
  voting_phase_started:      '🗳️',
  quest_team_selected:       '⚔️',
  voting_resolved:           '📊',
  team_approved:             '✅',
  quest_vote_submitted:      '🗡️',
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
    case 'voting_phase_started':
      return `第${d.round as number}局開始 — 第${d.failedVotes as number}次提案，領袖：${d.leaderId as string}`;
    case 'quest_team_selected':
      return `領袖提案：${(d.team as string[])?.join('、')}`;
    case 'voting_resolved': {
      const approved = d.approved ? '✅ 通過' : '❌ 否決';
      return `投票結果：${approved}（${d.approveCount as number}贊成，${d.rejectCount as number}反對）`;
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

function GameRow({ game, onReplay }: { game: RecentGame; onReplay: (roomId: string) => void }): JSX.Element {
  const won = game.won;
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-gray-700/50 last:border-0">
      <div className={`w-14 text-center text-xs font-bold py-1 rounded ${won ? 'bg-green-900/60 text-green-400' : 'bg-red-900/60 text-red-400'}`}>
        {won ? '勝' : '敗'}
      </div>
      <div className="flex-1">
        <span className={`text-sm font-semibold ${ROLE_COLORS[game.role] ?? 'text-gray-300'}`}>
          {ROLE_NAMES[game.role] ?? game.role}
        </span>
        <span className="text-xs text-gray-500 ml-2">{game.player_count}人局</span>
      </div>
      <div className={`text-sm font-bold ${game.elo_delta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
        {game.elo_delta >= 0 ? `+${game.elo_delta}` : game.elo_delta}
      </div>
      <div className="text-xs text-gray-600 w-14 text-right">{formatDate(game.created_at)}</div>
      <button
        onClick={() => onReplay(game.room_id)}
        className="p-1 text-gray-600 hover:text-blue-400 transition-colors"
        title="查看回放"
      >
        <ExternalLink size={12} />
      </button>
    </div>
  );
}

export default function ProfilePage(): JSX.Element {
  const { setGameState, profileUserId, navigateToProfile } = useGameStore();
  const [profile, setProfile]       = useState<UserProfile | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [replay, setReplay]         = useState<{ roomId: string; events: GameEvent[] } | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  useEffect(() => {
    const token = getStoredToken();
    const isMe  = !profileUserId || profileUserId === 'me';

    const fetch = isMe && token
      ? fetchMyProfile(token)
      : profileUserId
        ? fetchUserProfile(profileUserId)
        : Promise.reject(new Error('no user'));

    fetch
      .then(setProfile)
      .catch(() => setError('無法載入用戶資料'))
      .finally(() => setLoading(false));
  }, [profileUserId]);

  const handleReplay = (roomId: string): void => {
    setReplayLoading(true);
    fetchGameReplay(roomId)
      .then(events => setReplay({ roomId, events }))
      .catch(() => setReplay({ roomId, events: [] }))
      .finally(() => setReplayLoading(false));
  };

  const winRate = profile && profile.total_games > 0
    ? Math.round((profile.games_won / profile.total_games) * 100)
    : 0;

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
            {/* Avatar + name */}
            <div className="bg-avalon-card/60 border border-gray-700 rounded-2xl p-6 flex items-center gap-5">
              {profile.photo_url ? (
                <img src={profile.photo_url} alt="" className="w-20 h-20 rounded-full object-cover border-2 border-blue-500/50" />
              ) : (
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center text-white font-black text-3xl border-2 border-blue-500/50">
                  {profile.display_name[0]?.toUpperCase()}
                </div>
              )}
              <div>
                <h2 className="text-2xl font-black text-white">{profile.display_name}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <TrendingUp size={16} className="text-blue-400" />
                  <span className="text-blue-300 font-bold text-lg">{profile.elo_rating}</span>
                  <span className="text-gray-500 text-sm">ELO</span>
                </div>
                {profile.badges.length > 0 && (
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {profile.badges.map(b => (
                      <span key={b} className="text-xs px-2 py-0.5 bg-purple-900/60 border border-purple-600/50 text-purple-300 rounded-full">
                        {b}
                      </span>
                    ))}
                  </div>
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
                <div className="text-3xl font-black text-green-400">{winRate}%</div>
                <div className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
                  <Trophy size={12} /> 勝率
                </div>
              </div>
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
                <div className="text-3xl font-black text-green-400">{profile.games_won}</div>
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
                            className={`h-1.5 rounded-full ${pct >= 50 ? 'bg-green-500' : 'bg-red-500'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className={`text-xs font-bold w-10 text-right ${pct >= 50 ? 'text-green-400' : 'text-red-400'}`}>
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
              <h3 className="text-sm font-bold text-gray-300 mb-3">最近 10 局</h3>
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
                    <h3 className="font-bold text-white">遊戲回放 (Replay) — <span className="font-mono text-yellow-400 text-sm">{replay?.roomId}</span></h3>
                    <button onClick={() => setReplay(null)} className="text-gray-500 hover:text-white">✕</button>
                  </div>
                  {replayLoading && <div className="flex justify-center py-8"><Loader size={24} className="animate-spin text-blue-400" /></div>}
                  {replay && replay.events.length === 0 && (
                    <p className="text-center text-gray-500 py-4">無回放資料（此局在事件記錄功能上線前進行）</p>
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
