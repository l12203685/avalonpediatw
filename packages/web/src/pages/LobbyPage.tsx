import { useState } from 'react';
import { useGameStore } from '../store/gameStore';
import { startGame } from '../services/socket';
import { Users, Play, Copy, Check } from 'lucide-react';

export default function LobbyPage(): JSX.Element {
  const { room, currentPlayer } = useGameStore();
  const [copied, setCopied] = useState(false);

  if (!room || !currentPlayer) {
    return <div className="text-center text-white">載入中…</div>;
  }

  const playerList = Object.values(room.players);
  const isHost = room.host === currentPlayer.id;
  const canStart = playerList.length >= 5;

  const handleCopyRoomId = () => {
    navigator.clipboard.writeText(room.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-2xl space-y-6">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-4xl font-bold text-white mb-3">{room.name}</h1>

          {/* Room ID with copy button */}
          <div className="inline-flex items-center gap-3 bg-avalon-card/50 border border-gray-600 rounded-xl px-5 py-3">
            <div className="text-left">
              <p className="text-xs text-gray-500 mb-1">房間代碼（分享給朋友）</p>
              <p className="text-lg font-mono font-bold text-yellow-400 tracking-widest">{room.id.slice(0, 8).toUpperCase()}</p>
            </div>
            <button
              onClick={handleCopyRoomId}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-all ${
                copied
                  ? 'bg-green-700/60 text-green-300 border border-green-600'
                  : 'bg-gray-700/60 hover:bg-gray-600/60 text-gray-300 border border-gray-600'
              }`}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? '已複製！' : '複製'}
            </button>
          </div>
        </div>

        {/* Players */}
        <div className="bg-avalon-card/50 border border-gray-600 rounded-lg p-6">
          <div className="flex items-center gap-2 mb-5">
            <Users size={22} />
            <h2 className="text-xl font-bold">
              玩家列表 ({playerList.length}/{room.maxPlayers})
            </h2>
            {!canStart && (
              <span className="ml-auto text-xs text-yellow-400 bg-yellow-900/30 border border-yellow-700 px-2 py-1 rounded-full">
                還需要 {5 - playerList.length} 人
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {playerList.map((player) => (
              <div
                key={player.id}
                className={`bg-avalon-dark rounded-lg p-3 border flex items-center gap-3 ${
                  player.id === currentPlayer.id
                    ? 'border-blue-500/60 bg-blue-900/20'
                    : 'border-gray-600'
                }`}
              >
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-purple-400 flex items-center justify-center font-bold text-sm flex-shrink-0">
                  {player.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-white truncate">{player.name}</p>
                  <p className="text-xs text-gray-400">
                    {player.id === room.host ? '👑 房主' : '玩家'}
                    {player.id === currentPlayer.id && ' · 你'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Start Button */}
        {isHost && (
          <div className="space-y-3">
            {!canStart && (
              <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-3 text-yellow-200 text-sm text-center">
                至少需要 5 名玩家才能開始（目前 {playerList.length} 人）
              </div>
            )}
            <button
              onClick={() => startGame(room.id)}
              disabled={!canStart}
              className={`w-full font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2 ${
                canStart
                  ? 'bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white shadow-lg hover:shadow-green-500/30'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
            >
              <Play size={20} />
              開始遊戲
            </button>
          </div>
        )}

        {!isHost && (
          <div className="text-center text-gray-400 py-2">
            等待房主開始遊戲...
          </div>
        )}
      </div>
    </div>
  );
}
