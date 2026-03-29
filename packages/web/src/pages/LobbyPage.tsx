import { useState } from 'react';
import { useGameStore } from '../store/gameStore';
import { startGame, kickPlayer, addBot, removeBot, leaveRoom, setMaxPlayers } from '../services/socket';
import { Users, Play, Copy, Check, Link, X, Bot, LogOut, ChevronUp, ChevronDown } from 'lucide-react';
import { AVALON_CONFIG } from '@avalon/shared';
import ChatPanel from '../components/ChatPanel';

const ROLE_LABEL: Record<string, string> = {
  merlin: '梅林', percival: '派西維爾', loyal: '忠臣',
  assassin: '刺客', morgana: '莫甘娜', oberon: '奧伯倫', mordred: '莫德雷德',
};
const GOOD_ROLES = new Set(['merlin', 'percival', 'loyal']);

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

  // Role preview based on current player count
  const previewConfig = AVALON_CONFIG[playerList.length];
  const goodRoles  = previewConfig?.roles.filter(r => GOOD_ROLES.has(r)) ?? [];
  const evilRoles  = previewConfig?.roles.filter(r => !GOOD_ROLES.has(r)) ?? [];

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
    <>
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

        {/* Role preview for current player count */}
        {previewConfig && (
          <div className="bg-avalon-card/30 border border-gray-700 rounded-xl px-4 py-3">
            <p className="text-xs text-gray-500 mb-2 font-semibold uppercase tracking-wider">
              {playerList.length} 人局角色預覽
            </p>
            <div className="flex flex-wrap gap-1.5">
              {[...goodRoles, ...evilRoles].map((role, i) => (
                <span
                  key={i}
                  className={`text-xs px-2 py-0.5 rounded-full font-semibold border ${
                    GOOD_ROLES.has(role)
                      ? 'bg-blue-900/40 border-blue-700/60 text-blue-300'
                      : 'bg-red-900/40 border-red-700/60 text-red-300'
                  }`}
                >
                  {ROLE_LABEL[role] ?? role}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Players */}
        <div className="bg-avalon-card/50 border border-gray-600 rounded-lg p-6">
          <div className="flex items-center gap-2 mb-5">
            <Users size={22} />
            <h2 className="text-xl font-bold">
              玩家列表 ({playerList.length}/{room.maxPlayers})
            </h2>
            {/* Host: adjust max players */}
            {isHost && (
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => setMaxPlayers(room.id, room.maxPlayers - 1)}
                  disabled={room.maxPlayers <= Math.max(5, playerList.length)}
                  className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="減少人數上限"
                >
                  <ChevronDown size={14} />
                </button>
                <span className="text-xs text-gray-400 w-8 text-center">{room.maxPlayers}人</span>
                <button
                  onClick={() => setMaxPlayers(room.id, room.maxPlayers + 1)}
                  disabled={room.maxPlayers >= 10}
                  className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="增加人數上限"
                >
                  <ChevronUp size={14} />
                </button>
              </div>
            )}
            {!isHost && !canStart && (
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
            <button
              onClick={() => leaveRoom(room.id)}
              className="w-full flex items-center justify-center gap-2 bg-gray-800/40 hover:bg-red-900/20 border border-gray-700 hover:border-red-700 text-gray-500 hover:text-red-400 font-medium py-1.5 px-4 rounded-lg transition-all text-xs"
            >
              <LogOut size={13} />
              解散房間 / 移交房主 (Leave / Transfer host)
            </button>
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
          <div className="space-y-3">
            <div className="text-center text-gray-400 py-2">
              等待房主開始遊戲... (Waiting for host to start the game...)
            </div>
            <button
              onClick={() => leaveRoom(room.id)}
              className="w-full flex items-center justify-center gap-2 bg-gray-800/60 hover:bg-red-900/30 border border-gray-600 hover:border-red-600 text-gray-400 hover:text-red-400 font-semibold py-2 px-4 rounded-lg transition-all text-sm"
            >
              <LogOut size={16} />
              離開房間 (Leave Room)
            </button>
          </div>
        )}
      </div>
    </div>

    {/* Floating chat — available in lobby */}
    <ChatPanel roomId={room.id} currentPlayerId={currentPlayer.id} />
    </>
  );
}
