import { useState } from 'react';
import { useGameStore } from '../store/gameStore';
import { startGame, kickPlayer, addBot, removeBot } from '../services/socket';
import { Users, Play, Copy, Check, Link, X, Bot } from 'lucide-react';

export default function LobbyPage(): JSX.Element {
  const { room, currentPlayer } = useGameStore();
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  if (!room || !currentPlayer) {
    return <div className="text-center text-white">載入中…</div>;
  }

  const playerList = Object.values(room.players);
  const isHost = room.host === currentPlayer.id;
  const canStart = playerList.length >= 5;
  const shortCode = room.id.slice(0, 8).toUpperCase();

  const handleCopyRoomId = () => {
    navigator.clipboard.writeText(shortCode).then(() => {
      setCopied('code');
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const handleCopyLink = () => {
    const link = `${window.location.origin}/?room=${shortCode}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopied('link');
      setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-2xl space-y-6">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-4xl font-bold text-white mb-3">{room.name}</h1>

          {/* Room ID with copy buttons */}
          <div className="inline-flex items-center gap-3 bg-avalon-card/50 border border-gray-600 rounded-xl px-5 py-3">
            <div className="text-left">
              <p className="text-xs text-gray-500 mb-1">房間代碼 (Room Code — share with friends)</p>
              <p className="text-lg font-mono font-bold text-yellow-400 tracking-widest">{shortCode}</p>
            </div>
            <button
              onClick={handleCopyRoomId}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-all ${
                copied === 'code'
                  ? 'bg-green-700/60 text-green-300 border border-green-600'
                  : 'bg-gray-700/60 hover:bg-gray-600/60 text-gray-300 border border-gray-600'
              }`}
            >
              {copied === 'code' ? <Check size={15} /> : <Copy size={15} />}
              {copied === 'code' ? '已複製！' : '複製'}
            </button>
            <button
              onClick={handleCopyLink}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-all ${
                copied === 'link'
                  ? 'bg-green-700/60 text-green-300 border border-green-600'
                  : 'bg-blue-700/60 hover:bg-blue-600/60 text-blue-300 border border-blue-600'
              }`}
              title="複製邀請連結 (Copy invite link)"
            >
              {copied === 'link' ? <Check size={15} /> : <Link size={15} />}
              {copied === 'link' ? '已複製！' : '邀請連結 (Invite Link)'}
            </button>
          </div>
        </div>

        {/* Players */}
        <div className="bg-avalon-card/50 border border-gray-600 rounded-lg p-6">
          <div className="flex items-center gap-2 mb-5">
            <Users size={22} />
            <h2 className="text-xl font-bold">
              玩家列表 (Players) ({playerList.length}/{room.maxPlayers})
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
                    : player.isBot
                    ? 'border-indigo-600/50 bg-indigo-900/10'
                    : 'border-gray-600'
                }`}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 ${
                  player.isBot
                    ? 'bg-gradient-to-br from-indigo-500 to-purple-600'
                    : 'bg-gradient-to-br from-blue-400 to-purple-400'
                }`}>
                  {player.isBot ? <Bot size={18} /> : player.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`font-bold truncate ${player.status === 'disconnected' ? 'text-gray-500' : 'text-white'}`}>
                    {player.name}
                  </p>
                  <p className="text-xs text-gray-400">
                    {player.id === room.host ? '👑 房主 (Host)' : player.isBot ? '🤖 AI 機器人 (Bot)' : '玩家 (Player)'}
                    {player.id === currentPlayer.id && ' · 你 (You)'}
                    {player.status === 'disconnected' && !player.isBot && <span className="text-red-400"> · 斷線 (Disconnected)</span>}
                  </p>
                </div>
                {isHost && player.id !== currentPlayer.id && (
                  <button
                    onClick={() => player.isBot ? removeBot(room.id, player.id) : kickPlayer(room.id, player.id)}
                    className="flex-shrink-0 p-1.5 text-gray-600 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
                    title={player.isBot ? `移除機器人 (Remove Bot)` : `踢出 ${player.name} (Kick)`}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Start Button */}
        {isHost && (
          <div className="space-y-3">
            {!canStart && (
              <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-3 text-yellow-200 text-sm text-center">
                至少需要 5 名玩家才能開始（目前 {playerList.length} 人）(At least 5 players required to start)
              </div>
            )}
            {/* Add Bot button (only if room not full) */}
            {playerList.length < room.maxPlayers && (
              <button
                onClick={() => addBot(room.id)}
                className="w-full bg-indigo-700/60 hover:bg-indigo-600/80 border border-indigo-500 text-indigo-200 font-semibold py-2 px-4 rounded-lg transition-all flex items-center justify-center gap-2"
              >
                <Bot size={18} />
                加入 AI 機器人 (Add AI Bot)
              </button>
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
              開始遊戲 (Start Game)
            </button>
          </div>
        )}

        {!isHost && (
          <div className="text-center text-gray-400 py-2">
            等待房主開始遊戲... (Waiting for host to start the game...)
          </div>
        )}
      </div>
    </div>
  );
}
