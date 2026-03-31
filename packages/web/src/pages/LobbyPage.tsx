import { motion } from 'framer-motion';
import { useGameStore } from '../store/gameStore';
import { startGame } from '../services/socket';
import { toast } from '../store/toastStore';
import { Users, Play, Link, Crown } from 'lucide-react';

export default function LobbyPage(): JSX.Element {
  const { room, currentPlayer } = useGameStore();

  if (!room || !currentPlayer) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-white text-center">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-400 mb-3" />
          <p>連接中...</p>
        </div>
      </div>
    );
  }

  const playerList = Object.values(room.players);
  const isHost = room.host === currentPlayer.id;
  const canStart = playerList.length >= 5;

  const handleCopyInvite = () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${room.id}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success('邀請連結已複製！'))
      .catch(() => toast.error('複製失敗，請手動複製'));
  };

  const handleStartGame = () => {
    try {
      startGame(room.id);
    } catch {
      toast.error('無法啟動遊戲，請確認連線狀態');
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4 bg-gradient-to-br from-avalon-dark via-avalon-card to-avalon-dark">
      <div className="w-full max-w-2xl space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center"
        >
          <h1 className="text-4xl font-bold text-white mb-1">{room.name}</h1>
          <div className="flex items-center justify-center gap-3 mt-2">
            <span className="text-gray-400 text-sm font-mono tracking-widest bg-gray-800 px-3 py-1 rounded-lg">
              {room.id}
            </span>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleCopyInvite}
              className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-sm bg-blue-900/30 border border-blue-600/40 px-3 py-1 rounded-lg transition-colors"
            >
              <Link size={14} />
              邀請連結
            </motion.button>
          </div>
        </motion.div>

        {/* Player Grid */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-avalon-card/50 border border-gray-600 rounded-xl p-6"
        >
          <div className="flex items-center gap-2 mb-5">
            <Users size={20} className="text-blue-400" />
            <h2 className="text-lg font-bold text-white">
              玩家列表 ({playerList.length}/{room.maxPlayers})
            </h2>
            {!canStart && (
              <span className="text-xs text-yellow-400 bg-yellow-900/30 border border-yellow-600/40 px-2 py-0.5 rounded-full ml-auto">
                至少 5 人才能開始
              </span>
            )}
          </div>

          {/* Player slots */}
          <div className="grid grid-cols-2 gap-3">
            {playerList.map((player, idx) => {
              const isMe = player.id === currentPlayer.id;
              const isDisconnected = player.status === 'disconnected';
              const isRoomHost = player.id === room.host;

              return (
                <motion.div
                  key={player.id}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: idx * 0.05 }}
                  className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                    isMe
                      ? 'border-yellow-500/60 bg-yellow-900/20'
                      : isDisconnected
                      ? 'border-gray-600/30 bg-gray-800/20 opacity-60'
                      : 'border-gray-600 bg-avalon-dark/60'
                  }`}
                >
                  {/* Avatar */}
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${
                      isMe
                        ? 'bg-gradient-to-br from-yellow-400 to-yellow-500 text-black'
                        : 'bg-gradient-to-br from-blue-500 to-purple-500 text-white'
                    }`}
                  >
                    {player.name.charAt(0).toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-semibold text-white text-sm truncate">{player.name}</p>
                      {isMe && (
                        <span className="text-xs text-yellow-400 shrink-0">（我）</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {isRoomHost && (
                        <span className="flex items-center gap-0.5 text-xs text-yellow-400">
                          <Crown size={11} />
                          房主
                        </span>
                      )}
                      {isDisconnected && (
                        <span className="text-xs text-red-400">斷線</span>
                      )}
                      {!isRoomHost && !isDisconnected && (
                        <span className="text-xs text-gray-500">玩家</span>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}

            {/* Empty slots */}
            {Array.from({ length: room.maxPlayers - playerList.length }).map((_, i) => (
              <div
                key={`empty-${i}`}
                className="flex items-center gap-3 p-3 rounded-lg border border-dashed border-gray-700 opacity-40"
              >
                <div className="w-10 h-10 rounded-full bg-gray-700 shrink-0" />
                <p className="text-gray-600 text-sm">等待玩家加入...</p>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Start / Waiting */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          {isHost ? (
            <motion.button
              whileHover={canStart ? { scale: 1.02 } : {}}
              whileTap={canStart ? { scale: 0.98 } : {}}
              onClick={handleStartGame}
              disabled={!canStart}
              className={`w-full font-bold py-4 px-6 rounded-xl transition-all flex items-center justify-center gap-2 text-lg ${
                canStart
                  ? 'bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white shadow-lg hover:shadow-green-500/30'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
            >
              <Play size={22} />
              開始遊戲
            </motion.button>
          ) : (
            <div className="text-center py-4 bg-avalon-card/30 border border-gray-700 rounded-xl">
              <motion.div
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="text-gray-400"
              >
                等待房主開始遊戲...
              </motion.div>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
