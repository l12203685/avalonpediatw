import { useState, useEffect } from 'react';
import { useGameStore } from '../store/gameStore';
import { submitVote, submitAssassination } from '../services/socket';
import GameBoard from '../components/GameBoard';
import VotePanel from '../components/VotePanel';
import QuestPanel from '../components/QuestPanel';
import TeamSelectionPanel from '../components/TeamSelectionPanel';
import RoleRevealModal from '../components/RoleRevealModal';
import ChatPanel from '../components/ChatPanel';
import HistoryPanel from '../components/HistoryPanel';
import { motion, AnimatePresence } from 'framer-motion';
import { Home, Bell } from 'lucide-react';
import { AVALON_CONFIG } from '@avalon/shared';

export default function GamePage(): JSX.Element {
  const { room, currentPlayer, setGameState, setRoom, setCurrentPlayer } = useGameStore();
  const [isVoting, setIsVoting] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [isAssassinating, setIsAssassinating] = useState(false);
  const [showRoleReveal, setShowRoleReveal] = useState(true);

  // Show role reveal modal each time game starts (state goes from lobby → voting)
  useEffect(() => {
    setShowRoleReveal(true);
  }, []);

  if (!room || !currentPlayer) {
    return <div className="text-center text-white">載入中…</div>;
  }

  const playerIds = Object.keys(room.players);
  const leaderId = playerIds[room.leaderIndex % playerIds.length];
  const isCurrentPlayerLeader = currentPlayer.id === leaderId;
  const teamSelected = room.questTeam.length > 0;

  const handleVote = (approve: boolean) => {
    setIsVoting(true);
    try {
      submitVote(room.id, currentPlayer.id, approve);
    } finally {
      setIsVoting(false);
    }
  };

  const handleAssassinate = (targetId: string) => {
    setSelectedTarget(targetId);
    setIsAssassinating(true);
    try {
      submitAssassination(room.id, currentPlayer.id, targetId);
    } finally {
      setIsAssassinating(false);
    }
  };

  const handlePlayAgain = () => {
    setRoom(null);
    setCurrentPlayer(currentPlayer ? { ...currentPlayer, role: null, team: null } : null);
    setGameState('home');
  };

  const stateLabel: Record<string, string> = {
    voting: teamSelected ? '投票中 (Voting)' : '選隊中 (Team Select)',
    quest: '任務中 (Quest)',
    discussion: '刺殺階段 (Assassination)',
    ended: '遊戲結束 (Game Over)',
    lobby: '等待中 (Lobby)',
  };

  // Determine if this player needs to act right now
  const alreadyVoted = room.votes[currentPlayer.id] !== undefined;
  const isOnQuestTeam = room.questTeam.includes(currentPlayer.id);
  const isAssassin = currentPlayer.role === 'assassin';
  type ActionBanner = { msg: string; color: string } | null;
  const actionBanner: ActionBanner =
    room.state === 'voting' && !teamSelected && isCurrentPlayerLeader
      ? { msg: '👑 輪到你了！請選擇任務隊伍 (Your turn — select a quest team)', color: 'border-purple-500 bg-purple-900/30 text-purple-200' }
      : room.state === 'voting' && teamSelected && !alreadyVoted
      ? { msg: '🗳️ 輪到你投票！贊成或拒絕此隊伍 (Your turn to vote — approve or reject)', color: 'border-yellow-500 bg-yellow-900/30 text-yellow-200' }
      : room.state === 'quest' && isOnQuestTeam
      ? { msg: '⚔️ 你在任務隊伍中！請投票成功或失敗 (You are on the quest — vote success or fail)', color: 'border-blue-500 bg-blue-900/30 text-blue-200' }
      : room.state === 'discussion' && isAssassin
      ? { msg: '🗡️ 你是刺客！選擇目標刺殺梅林 (You are the Assassin — choose your target)', color: 'border-red-500 bg-red-900/30 text-red-200' }
      : null;

  // Role composition from config
  const config = AVALON_CONFIG[playerIds.length];
  const goodCount = config?.roles.filter(r => ['merlin','percival','loyal'].includes(r)).length ?? 0;
  const evilCount = config?.roles.filter(r => !['merlin','percival','loyal'].includes(r)).length ?? 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-avalon-dark to-black p-4">
      {/* Role Reveal Modal */}
      {showRoleReveal && room.state !== 'ended' && (
        <RoleRevealModal
          room={room}
          currentPlayer={currentPlayer}
          onClose={() => setShowRoleReveal(false)}
        />
      )}

      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-5xl font-bold text-white mb-2">🎭 Avalon</h1>
          <p className="text-gray-400">第 {room.currentRound}/{room.maxRounds} 輪</p>
          <div className="flex justify-center gap-3 mt-4 text-sm flex-wrap">
            <div className="bg-avalon-card/50 px-4 py-2 rounded-lg">
              <p className="text-gray-300">狀態：<span className="text-yellow-400 font-bold">{stateLabel[room.state] ?? room.state}</span></p>
            </div>
            {room.failCount > 0 && (
              <div className="bg-avalon-card/50 px-4 py-2 rounded-lg">
                <p className="text-gray-300">拒絕次數：<span className={`font-bold ${room.failCount >= 4 ? 'text-red-400' : 'text-yellow-400'}`}>{room.failCount}/5</span></p>
              </div>
            )}
            <button
              onClick={() => setShowRoleReveal(true)}
              className="bg-blue-900/50 hover:bg-blue-800/70 border border-blue-600 px-4 py-2 rounded-lg text-blue-300 text-sm transition-colors"
            >
              查看角色
            </button>
          </div>
        </div>

        {/* Role composition + action banner row */}
        <div className="flex flex-col gap-2">
          {/* Role composition strip */}
          {room.state !== 'ended' && config && (
            <div className="flex justify-center gap-3 text-xs text-gray-400 flex-wrap">
              <span className="bg-blue-900/30 border border-blue-700/50 px-3 py-1 rounded-full">
                🔵 正義方 {goodCount} 人
              </span>
              <span className="bg-red-900/30 border border-red-700/50 px-3 py-1 rounded-full">
                🔴 邪惡方 {evilCount} 人
              </span>
            </div>
          )}

          {/* Your-turn action banner */}
          <AnimatePresence>
            {actionBanner && (
              <motion.div
                key={actionBanner.msg}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className={`flex items-center gap-2 border rounded-lg px-4 py-3 text-sm font-semibold ${actionBanner.color}`}
              >
                <Bell size={16} className="flex-shrink-0" />
                {actionBanner.msg}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Game Board */}
        <GameBoard room={room} currentPlayer={currentPlayer} />

        {/* Round History */}
        <HistoryPanel room={room} currentPlayer={currentPlayer} />

        {/* Voting Phase */}
        {room.state === 'voting' && (
          <>
            {!teamSelected ? (
              /* Step 1: Leader selects team */
              isCurrentPlayerLeader ? (
                <TeamSelectionPanel
                  room={room}
                  currentPlayer={currentPlayer}
                  isLoading={isVoting}
                />
              ) : (
                /* Non-leaders wait for leader */
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-avalon-card/50 border-2 border-yellow-700 rounded-lg p-8 text-center space-y-4"
                >
                  <div className="text-4xl">⏳</div>
                  <h2 className="text-2xl font-bold text-white">等待隊長選隊</h2>
                  <p className="text-gray-300">
                    隊長 <span className="text-yellow-400 font-bold">{room.players[leaderId]?.name}</span> 正在選擇任務隊員...
                  </p>
                  <div className="text-sm text-gray-500">
                    本輪需要 {AVALON_CONFIG[playerIds.length]?.questTeams[room.currentRound - 1] ?? '?'} 名隊員
                  </div>
                </motion.div>
              )
            ) : (
              /* Step 2: All players vote on the proposed team */
              <VotePanel
                room={room}
                currentPlayer={currentPlayer}
                onVote={handleVote}
                isLoading={isVoting}
              />
            )}
          </>
        )}

        {/* Quest Phase */}
        {room.state === 'quest' && <QuestPanel room={room} currentPlayer={currentPlayer} />}

        {/* Discussion Phase - Assassination */}
        {room.state === 'discussion' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-avalon-card/50 border-2 border-purple-600 rounded-lg p-8 space-y-6"
          >
            {currentPlayer.role === 'assassin' ? (
              <>
                <div className="text-center">
                  <h2 className="text-3xl font-bold text-red-400 mb-2">🗡️ 刺殺梅林 (Assassinate Merlin)</h2>
                  <p className="text-gray-300">你認為誰是梅林？選擇你的目標 (Who do you think is Merlin? Choose your target)</p>
                </div>
                <div className="grid grid-cols-2 gap-4 max-h-96 overflow-y-auto">
                  {Object.values(room.players)
                    .filter(p => p.id !== currentPlayer.id)
                    .map((player) => (
                    <button
                      key={player.id}
                      onClick={() => handleAssassinate(player.id)}
                      disabled={isAssassinating || selectedTarget !== null}
                      className={`p-4 rounded-lg border-2 transition-all font-semibold ${
                        selectedTarget === player.id
                          ? 'bg-red-600/40 border-red-400 text-white'
                          : 'bg-avalon-evil/30 border-red-600 text-white hover:bg-avalon-evil/60 disabled:opacity-50'
                      }`}
                    >
                      {player.name}
                      {selectedTarget === player.id && ' ✓'}
                    </button>
                  ))}
                </div>
                {selectedTarget && (
                  <p className="text-center text-gray-400 text-sm">已選擇目標，等待結果...</p>
                )}
              </>
            ) : (
              <div className="text-center space-y-4">
                <h2 className="text-3xl font-bold text-purple-400">💬 刺殺階段 (Assassination Phase)</h2>
                <p className="text-gray-300">好人贏得了 3 次任務！(Good team won 3 quests!)</p>
                <p className="text-gray-400">刺客正在選擇目標，試圖找出梅林... (The Assassin is choosing a target, trying to find Merlin...)</p>
                <div className="text-sm text-yellow-500 bg-yellow-900/20 border border-yellow-700 rounded-lg p-3">
                  若刺客成功刺殺梅林，邪惡方獲勝！(If the Assassin kills Merlin, Evil wins!)
                </div>
              </div>
            )}
          </motion.div>
        )}

        {/* Game Ended */}
        {room.state === 'ended' && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`rounded-lg p-8 text-center border-4 space-y-6 ${
              room.evilWins
                ? 'bg-avalon-evil/20 border-avalon-evil'
                : 'bg-avalon-good/20 border-avalon-good'
            }`}
          >
            <motion.h2
              initial={{ y: -20 }}
              animate={{ y: 0 }}
              className="text-5xl font-bold"
            >
              {room.evilWins ? '👹 邪惡方獲勝！(Evil Wins!)' : '⚔️ 正義方獲勝！(Good Wins!)'}
            </motion.h2>

            <p className="text-gray-300 text-lg">最終角色揭曉：</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {Object.values(room.players).map((player) => {
                const roleLabel: Record<string, string> = {
                  merlin:   '梅林 (Merlin)',
                  percival: '派西維爾 (Percival)',
                  loyal:    '忠臣 (Loyal Servant)',
                  assassin: '刺客 (Assassin)',
                  morgana:  '莫甘娜 (Morgana)',
                  oberon:   '奧伯倫 (Oberon)',
                  mordred:  '莫德雷德 (Mordred)',
                };
                const isGood = ['merlin', 'percival', 'loyal'].includes(player.role ?? '');

                return (
                  <div
                    key={player.id}
                    className={`text-sm p-3 rounded-lg border ${
                      isGood
                        ? 'bg-blue-900/30 border-blue-600'
                        : 'bg-red-900/30 border-red-600'
                    }`}
                  >
                    <p className="font-bold text-white">{player.name}</p>
                    <p className={isGood ? 'text-blue-400' : 'text-red-400'}>
                      {roleLabel[player.role ?? ''] ?? player.role}
                    </p>
                    {player.id === currentPlayer.id && (
                      <p className="text-xs text-gray-500 mt-1">（你）</p>
                    )}
                  </div>
                );
              })}
            </div>

            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={handlePlayAgain}
              className="flex items-center gap-2 mx-auto bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-bold py-3 px-8 rounded-lg transition-all"
            >
              <Home size={20} />
              返回首頁
            </motion.button>
          </motion.div>
        )}
      </div>

      {/* Floating chat — available during all game phases */}
      {room.state !== 'lobby' && (
        <ChatPanel roomId={room.id} currentPlayerId={currentPlayer.id} />
      )}
    </div>
  );
}
