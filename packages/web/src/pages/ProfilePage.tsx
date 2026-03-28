import { useState, useEffect } from 'react';
import { ArrowLeft, Shield, Swords, TrendingUp, Clock, Loader, Trophy, ExternalLink } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { fetchMyProfile, fetchUserProfile, fetchGameReplay, UserProfile, RecentGame, GameEvent } from '../services/api';
import { getStoredToken } from '../services/socket';

const ROLE_NAMES: Record<string, string> = {
  merlin:    '梅林',
  percival:  '派西維爾',
  loyal:     '忠臣',
  assassin:  '刺客',
  morgana:   '莫甘娜',
  mordred:   '莫德雷德',
  oberon:    '奧伯倫',
  unknown:   '未知',
};

const ROLE_COLORS: Record<string, string> = {
  merlin: 'text-blue-300', percival: 'text-cyan-300', loyal: 'text-green-300',
  assassin: 'text-red-400', morgana: 'text-pink-400', mordred: 'text-red-600',
  oberon: 'text-purple-400',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' });
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
          <h1 className="text-2xl font-black text-white">個人資料</h1>
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
                    <h3 className="font-bold text-white">遊戲回放 — {replay?.roomId}</h3>
                    <button onClick={() => setReplay(null)} className="text-gray-500 hover:text-white">✕</button>
                  </div>
                  {replayLoading && <div className="flex justify-center py-8"><Loader size={24} className="animate-spin text-blue-400" /></div>}
                  {replay && replay.events.length === 0 && (
                    <p className="text-center text-gray-500 py-4">無回放資料（此局在事件記錄功能上線前進行）</p>
                  )}
                  {replay && replay.events.map(ev => (
                    <div key={ev.seq} className="flex gap-3 py-1.5 border-b border-gray-700/50 text-sm">
                      <span className="text-gray-600 w-6 text-right flex-shrink-0">{ev.seq}</span>
                      <span className="text-blue-400 font-mono w-36 flex-shrink-0">{ev.event_type}</span>
                      <span className="text-gray-400 text-xs truncate">
                        {JSON.stringify(ev.event_data).slice(0, 80)}
                      </span>
                    </div>
                  ))}
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
