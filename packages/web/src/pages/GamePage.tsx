import { useState, useEffect, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { submitVote, submitAssassination, submitLadyOfTheLake, requestRematch, leaveSpectate } from '../services/socket';
import GameBoard from '../components/GameBoard';
import VotePanel from '../components/VotePanel';
import QuestPanel from '../components/QuestPanel';
import TeamSelectionPanel from '../components/TeamSelectionPanel';
import RoleRevealModal from '../components/RoleRevealModal';
import VoteRevealOverlay from '../components/VoteRevealOverlay';
import QuestResultOverlay from '../components/QuestResultOverlay';
import ChatPanel from '../components/ChatPanel';
import HistoryPanel from '../components/HistoryPanel';
import MissionTrack from '../components/MissionTrack';
import SuspicionBoard from '../components/SuspicionBoard';
import VoteAnalysisPanel from '../components/VoteAnalysisPanel';
import LiveScoresheet from '../components/LiveScoresheet';
import audioService from '../services/audio';
import { motion, AnimatePresence } from 'framer-motion';
import { Home, Bell, RefreshCw, Volume2, VolumeX, WifiOff, Loader2, ClipboardList } from 'lucide-react';
import { AVALON_CONFIG, VoteRecord, QuestRecord } from '@avalon/shared';
import { requestNotificationPermission } from '../services/notifications';

export default function GamePage(): JSX.Element {
  const { room, currentPlayer, setGameState, setRoom, setCurrentPlayer, isSpectator, socketStatus } = useGameStore();
  const [isVoting, setIsVoting] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [isAssassinating, setIsAssassinating] = useState(false);
  const [showRoleReveal, setShowRoleReveal] = useState(true);
  const prevRoomState = useRef<string | null>(null);
  const [assassinTimer, setAssassinTimer] = useState(120); // 120s matches server ASSASSINATION_TIMEOUT_MS
  const [pendingVoteReveal, setPendingVoteReveal] = useState<VoteRecord | null>(null);
  const [pendingQuestReveal, setPendingQuestReveal] = useState<QuestRecord | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(() => audioService.isEnabled());
  const [showScoresheet, setShowScoresheet] = useState(false);
  const [teamSelectTimer, setTeamSelectTimer] = useState(90);
  const prevVoteHistoryLen = useRef(0);
  const prevQuestHistoryLen = useRef(0);

  // Request browser notification permission on mount
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Show role reveal modal each time game starts (state transitions lobby → voting)
  useEffect(() => {
    if (!room) return;
    if (prevRoomState.current === 'lobby' && room.state === 'voting') {
      setShowRoleReveal(true);
      setIsVoting(false);
      setIsAssassinating(false);
      setSelectedTarget(null);
    }
    if (prevRoomState.current === null) {
      // First mount — show roles immediately
      setShowRoleReveal(true);
    }
    prevRoomState.current = room.state;
  }, [room?.state]);

  // Team-select countdown (mirrors the 90s server AFK timeout)
  useEffect(() => {
    if (!room || room.state !== 'voting' || room.questTeam.length > 0) return;
    setTeamSelectTimer(90);
    const interval = setInterval(() => {
      setTeamSelectTimer(t => Math.max(0, t - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [room?.state, room?.questTeam?.length, room?.leaderIndex]);

  // Assassination countdown
  useEffect(() => {
    if (!room || room.state !== 'discussion') return;
    setAssassinTimer(120);
    const interval = setInterval(() => {
      setAssassinTimer(t => Math.max(0, t - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [room?.state]);

  // Reset isVoting once server confirms player's vote is registered
  useEffect(() => {
    if (!room || !currentPlayer) return;
    if (room.votes[currentPlayer.id] !== undefined) {
      setIsVoting(false);
    }
  }, [room?.votes]);

  // Show vote reveal overlay when a new vote record is added
  useEffect(() => {
    if (!room) return;
    const len = room.voteHistory.length;
    if (len > prevVoteHistoryLen.current) {
      setPendingVoteReveal(room.voteHistory[len - 1]);
    }
    prevVoteHistoryLen.current = len;
  }, [room?.voteHistory?.length]);

  // Show quest result overlay when a new quest completes
  useEffect(() => {
    if (!room) return;
    const len = room.questHistory.length;
    if (len > prevQuestHistoryLen.current) {
      setPendingQuestReveal(room.questHistory[len - 1]);
    }
    prevQuestHistoryLen.current = len;
  }, [room?.questHistory?.length]);

  if (!room || !currentPlayer) {
    return <div className="text-center text-white">載入中…</div>;
  }

  const playerIds = Object.keys(room.players);
  const leaderId = playerIds[room.leaderIndex % playerIds.length];
  const isCurrentPlayerLeader = currentPlayer.id === leaderId;
  const teamSelected = room.questTeam.length > 0;

  const handleVote = (approve: boolean): void => {
    if (isVoting) return;
    setIsVoting(true);
    submitVote(room.id, currentPlayer.id, approve);
    // Reset after server ACK arrives (room.votes updates), with 3s safety fallback
    setTimeout(() => setIsVoting(false), 3000);
  };

  const handleAssassinate = (targetId: string): void => {
    if (isAssassinating) return;
    setSelectedTarget(targetId);
    setIsAssassinating(true);
    submitAssassination(room.id, currentPlayer.id, targetId);
    setTimeout(() => setIsAssassinating(false), 3000);
  };

  const handleToggleAudio = () => {
    audioService.toggleAudio();
    setAudioEnabled(audioService.isEnabled());
  };

  const handlePlayAgain = () => {
    setRoom(null);
    setCurrentPlayer(currentPlayer ? { ...currentPlayer, role: null, team: null } : null);
    setGameState('home');
  };

  const stateLabel: Record<string, string> = {
    voting: teamSelected ? '投票中 (Voting)' : '選隊中 (Team Select)',
    quest: '任務中 (Quest)',
    lady_of_the_lake: '湖中女神 (Lady of the Lake)',
    discussion: '刺殺階段 (Assassination)',
    ended: '遊戲結束 (Game Over)',
    lobby: '等待中 (Lobby)',
  };

  // Determine if this player needs to act right now
  const alreadyVoted = room.votes[currentPlayer.id] !== undefined;
  const isOnQuestTeam = room.questTeam.includes(currentPlayer.id);
  const isAssassin = currentPlayer.role === 'assassin';
  const isLadyHolder = room.ladyOfTheLakeHolder === currentPlayer.id;
  type ActionBanner = { msg: string; color: string } | null;
  const actionBanner: ActionBanner =
    room.state === 'voting' && !teamSelected && isCurrentPlayerLeader
      ? { msg: '👑 輪到你了！請選擇任務隊伍 (Your turn — select a quest team)', color: 'border-purple-500 bg-purple-900/30 text-purple-200' }
      : room.state === 'voting' && teamSelected && !alreadyVoted
      ? { msg: '🗳️ 輪到你投票！贊成或拒絕此隊伍 (Your turn to vote — approve or reject)', color: 'border-yellow-500 bg-yellow-900/30 text-yellow-200' }
      : room.state === 'quest' && isOnQuestTeam
      ? { msg: '⚔️ 你在任務隊伍中！請投票成功或失敗 (You are on the quest — vote success or fail)', color: 'border-blue-500 bg-blue-900/30 text-blue-200' }
      : room.state === 'lady_of_the_lake' && isLadyHolder
      ? { msg: '🔮 你持有湖中女神！選擇一位玩家查看陣營 (You hold the Lady — inspect a player)', color: 'border-cyan-500 bg-cyan-900/30 text-cyan-200' }
      : room.state === 'discussion' && isAssassin
      ? { msg: '🗡️ 你是刺客！選擇目標刺殺梅林 (You are the Assassin — choose your target)', color: 'border-red-500 bg-red-900/30 text-red-200' }
      : null;

  // Role composition from config
  const config = AVALON_CONFIG[playerIds.length];
  const goodCount = config?.roles.filter(r => ['merlin','percival','loyal'].includes(r)).length ?? 0;
  const evilCount = config?.roles.filter(r => !['merlin','percival','loyal'].includes(r)).length ?? 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-avalon-dark to-black p-4">
      {/* Vote Reveal Overlay */}
      <AnimatePresence>
        {pendingVoteReveal && (
          <VoteRevealOverlay
            key={`vote-${pendingVoteReveal.round}-${pendingVoteReveal.attempt}`}
            record={pendingVoteReveal}
            room={room}
            onDismiss={() => setPendingVoteReveal(null)}
          />
        )}
      </AnimatePresence>

      {/* Quest Result Overlay */}
      <AnimatePresence>
        {pendingQuestReveal && !pendingVoteReveal && (
          <QuestResultOverlay
            key={`quest-${pendingQuestReveal.round}`}
            record={pendingQuestReveal}
            room={room}
            onDismiss={() => setPendingQuestReveal(null)}
          />
        )}
      </AnimatePresence>

      {/* Role Reveal Modal */}
      {showRoleReveal && room.state !== 'ended' && !isSpectator && (
        <RoleRevealModal
          room={room}
          currentPlayer={currentPlayer}
          onClose={() => setShowRoleReveal(false)}
        />
      )}

      <div className="max-w-6xl mx-auto space-y-8">
        {/* Reconnection status banner */}
        <AnimatePresence>
          {(socketStatus === 'reconnecting' || socketStatus === 'disconnected') && (
            <motion.div
              key="reconnect-banner"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold ${
                socketStatus === 'reconnecting'
                  ? 'bg-yellow-900/60 border border-yellow-600 text-yellow-200'
                  : 'bg-red-900/60 border border-red-600 text-red-200'
              }`}
            >
              {socketStatus === 'reconnecting' ? (
                <><Loader2 size={16} className="animate-spin flex-shrink-0" />正在重新連線… (Reconnecting…)</>
              ) : (
                <><WifiOff size={16} className="flex-shrink-0" />已斷線，請檢查網路連線 (Disconnected — check your connection)</>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Spectator banner */}
        {isSpectator && (
          <div className="flex items-center justify-between bg-purple-900/40 border border-purple-600 rounded-xl px-4 py-2">
            <span className="text-purple-300 text-sm font-semibold">👁 觀戰模式 — 角色已隱藏 (Spectating — roles hidden)</span>
            <button
              onClick={() => room && leaveSpectate(room.id)}
              className="text-xs text-purple-400 hover:text-white border border-purple-600 hover:border-white px-3 py-1 rounded-lg transition-colors"
            >
              離開觀戰
            </button>
          </div>
        )}

        {/* Header */}
        <div className="text-center">
          <h1 className="text-5xl font-bold text-white mb-2">🎭 Avalon</h1>
          <div className="mt-2">
            <MissionTrack room={room} />
          </div>
          <div className="flex justify-center gap-3 mt-3 text-sm flex-wrap">
            <div className="bg-avalon-card/50 px-4 py-2 rounded-lg">
              <p className="text-gray-300">狀態：<span className="text-yellow-400 font-bold">{stateLabel[room.state] ?? room.state}</span></p>
            </div>
            <button
              onClick={() => setShowRoleReveal(true)}
              className="bg-blue-900/50 hover:bg-blue-800/70 border border-blue-600 px-4 py-2 rounded-lg text-blue-300 text-sm transition-colors"
            >
              查看角色
            </button>
            <button
              onClick={() => setShowScoresheet(s => !s)}
              title="即時牌譜 (Live Scoresheet)"
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors border ${
                showScoresheet
                  ? 'bg-emerald-900/60 hover:bg-emerald-800/70 border-emerald-500 text-emerald-300'
                  : 'bg-gray-800/50 hover:bg-gray-700/70 border-gray-600 text-gray-300'
              }`}
            >
              <ClipboardList size={16} />
              <span className="hidden sm:inline">牌譜</span>
            </button>
            <button
              onClick={handleToggleAudio}
              title={audioEnabled ? '靜音 (Mute)' : '開啟音效 (Unmute)'}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors border ${
                audioEnabled
                  ? 'bg-gray-800/50 hover:bg-gray-700/70 border-gray-600 text-gray-300'
                  : 'bg-gray-900/50 hover:bg-gray-800/70 border-gray-700 text-gray-500'
              }`}
            >
              {audioEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
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

        {/* Live Scoresheet — toggled via header button */}
        <AnimatePresence>
          {showScoresheet && (
            <motion.div
              key="live-scoresheet"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="bg-avalon-card/50 border border-gray-700 rounded-lg overflow-hidden"
            >
              <div className="px-4 py-3 border-b border-gray-700/50 flex items-center justify-between">
                <span className="text-sm font-bold text-gray-300">
                  <ClipboardList size={14} className="inline mr-1.5 -mt-0.5" />
                  即時牌譜 (Live Scoresheet)
                </span>
                <button
                  onClick={() => setShowScoresheet(false)}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  收起
                </button>
              </div>
              <div className="px-4 py-3 overflow-y-auto max-h-[60vh]">
                <LiveScoresheet room={room} currentPlayer={currentPlayer} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Suspicion Notes — personal private notepad, only shown during active game */}
        {room.state !== 'ended' && room.state !== 'lobby' && !isSpectator && (
          <SuspicionBoard room={room} currentPlayer={currentPlayer} />
        )}

        {/* Voting Phase */}
        {room.state === 'voting' && !isSpectator && (
          <>
            {!teamSelected ? (
              /* Step 1: Leader selects team */
              isCurrentPlayerLeader ? (
                <TeamSelectionPanel
                  room={room}
                  currentPlayer={currentPlayer}
                  isLoading={isVoting}
                  timer={teamSelectTimer}
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
                  <div className="flex items-center justify-center gap-3 text-sm text-gray-500">
                    <span>本輪需要 {AVALON_CONFIG[playerIds.length]?.questTeams[room.currentRound - 1] ?? '?'} 名隊員</span>
                    <span className={`px-3 py-1 rounded-full font-bold ${teamSelectTimer < 20 ? 'bg-red-900/60 text-red-300' : 'bg-gray-800 text-gray-400'}`}>
                      ⏱ {teamSelectTimer}s
                    </span>
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
        {room.state === 'quest' && !isSpectator && <QuestPanel room={room} currentPlayer={currentPlayer} />}

        {/* Lady of the Lake Phase */}
        {room.state === 'lady_of_the_lake' && !isSpectator && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-avalon-card/50 border-2 border-cyan-600 rounded-lg p-8 space-y-6"
          >
            {isLadyHolder ? (
              room.ladyOfTheLakeResult ? (
                // Result revealed to holder
                <div className="text-center space-y-4">
                  <h2 className="text-3xl font-bold text-cyan-400">🔮 湖中女神 (Lady of the Lake)</h2>
                  <p className="text-gray-300">
                    <span className="font-bold text-white">{room.players[room.ladyOfTheLakeTarget ?? '']?.name}</span> 的陣營是：
                  </p>
                  <div className={`inline-block px-6 py-3 rounded-xl text-2xl font-bold border-2 ${
                    room.ladyOfTheLakeResult === 'good'
                      ? 'bg-blue-900/40 border-blue-500 text-blue-300'
                      : 'bg-red-900/40 border-red-500 text-red-300'
                  }`}>
                    {room.ladyOfTheLakeResult === 'good' ? '⚔️ 好人 (Good)' : '👹 邪惡 (Evil)'}
                  </div>
                  <p className="text-gray-500 text-sm">湖中女神將傳遞給此玩家... (The Lady passes to this player...)</p>
                </div>
              ) : (
                // Holder selects target
                <>
                  <div className="text-center">
                    <h2 className="text-3xl font-bold text-cyan-400">🔮 湖中女神 (Lady of the Lake)</h2>
                    <p className="text-gray-300 mt-2">選擇一位玩家查看其陣營 (Choose a player to inspect their team alignment)</p>
                  </div>
                  <div className="grid grid-cols-2 gap-4 max-h-96 overflow-y-auto">
                    {Object.values(room.players)
                      .filter(p => p.id !== currentPlayer.id && !(room.ladyOfTheLakeUsed ?? []).includes(p.id))
                      .map((player) => (
                        <button
                          key={player.id}
                          onClick={() => submitLadyOfTheLake(room.id, currentPlayer.id, player.id)}
                          className="p-4 rounded-lg border-2 transition-all font-semibold bg-cyan-900/30 border-cyan-600 text-white hover:bg-cyan-800/60"
                        >
                          {player.name}
                        </button>
                      ))}
                  </div>
                </>
              )
            ) : (
              // Other players wait
              <div className="text-center space-y-4">
                <h2 className="text-3xl font-bold text-cyan-400">🔮 湖中女神 (Lady of the Lake)</h2>
                <p className="text-gray-300">
                  <span className="text-cyan-400 font-bold">{room.players[room.ladyOfTheLakeHolder ?? '']?.name}</span> 正在使用湖中女神查看一位玩家的陣營...
                </p>
                <p className="text-gray-500 text-sm">(The Lady holder is inspecting a player's team alignment...)</p>
              </div>
            )}
          </motion.div>
        )}

        {/* Spectator phase hint */}
        {isSpectator && (room.state === 'voting' || room.state === 'quest' || room.state === 'lady_of_the_lake' || room.state === 'discussion') && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-avalon-card/30 border border-purple-700/50 rounded-xl p-4 text-center"
          >
            <p className="text-purple-400 text-sm">
              {room.state === 'voting' && '👁 觀戰中 — 等待玩家投票...'}
              {room.state === 'quest' && '👁 觀戰中 — 任務隊伍正在行動...'}
              {room.state === 'lady_of_the_lake' && '👁 觀戰中 — 湖中女神查看中...'}
              {room.state === 'discussion' && '👁 觀戰中 — 刺客正在選擇目標...'}
            </p>
          </motion.div>
        )}

        {/* Discussion Phase - Assassination */}
        {room.state === 'discussion' && !isSpectator && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-avalon-card/50 border-2 border-purple-600 rounded-lg p-8 space-y-6"
          >
            {/* Quest history aide for assassin */}
            {room.questHistory.length > 0 && (
              <div className="bg-gray-800/40 border border-gray-700 rounded-xl p-3">
                <p className="text-xs text-gray-500 mb-2 font-semibold uppercase tracking-wider">任務隊伍歷史 (Quest Team History)</p>
                <div className="space-y-1.5">
                  {room.questHistory.map(q => (
                    <div key={q.round} className="flex items-center gap-2 text-xs">
                      <span className={`w-4 h-4 flex-shrink-0 flex items-center justify-center rounded-full font-bold ${q.result === 'success' ? 'bg-blue-600 text-white' : 'bg-red-600 text-white'}`}>
                        {q.result === 'success' ? '✓' : '✗'}
                      </span>
                      <span className="text-gray-400">R{q.round}:</span>
                      <span className="text-gray-300">{q.team.map(id => room.players[id]?.name ?? id).join('、')}</span>
                      {q.result === 'fail' && q.failCount > 0 && <span className="text-red-400 ml-1">({q.failCount}票失敗)</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {currentPlayer.role === 'assassin' ? (
              <>
                <div className="text-center">
                  <h2 className="text-3xl font-bold text-red-400 mb-2">🗡️ 刺殺梅林 (Assassinate Merlin)</h2>
                  <p className="text-gray-300">你認為誰是梅林？選擇你的目標 (Who do you think is Merlin? Choose your target)</p>
                  <div className={`inline-flex items-center gap-2 mt-3 px-4 py-1.5 rounded-full font-bold text-sm ${assassinTimer < 30 ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-300'}`}>
                    ⏱ {assassinTimer}s
                  </div>
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
              {room.evilWins ? '👹 邪惡方獲勝！' : '⚔️ 正義方獲勝！'}
            </motion.h2>

            {/* End reason banner */}
            {room.endReason && (
              <div className={`inline-block px-5 py-2 rounded-full text-sm font-semibold ${
                room.evilWins ? 'bg-red-900/50 border border-red-600 text-red-200' : 'bg-blue-900/50 border border-blue-600 text-blue-200'
              }`}>
                {room.endReason === 'failed_quests' && '💀 邪惡方破壞了 3 次任務'}
                {room.endReason === 'vote_rejections' && '🚫 5 次提案全數否決，邪惡方自動獲勝'}
                {room.endReason === 'merlin_assassinated' && (
                  <>🗡️ 刺客成功刺殺梅林！<span className="text-red-300 font-bold">{room.players[room.assassinTargetId ?? '']?.name ?? '?'}</span> 是梅林</>
                )}
                {room.endReason === 'assassination_failed' && (
                  <>🛡️ 刺客誤殺 <span className="text-blue-300 font-bold">{room.players[room.assassinTargetId ?? '']?.name ?? '?'}</span>，正義方獲勝！</>
                )}
                {room.endReason === 'assassination_timeout' && '⏱️ 刺殺超時，正義方獲勝！'}
              </div>
            )}

            {/* Quest result summary */}
            {room.questHistory.length > 0 && (
              <div className="flex justify-center gap-2 flex-wrap">
                {room.questHistory.map((q) => (
                  <div key={q.round} className={`flex flex-col items-center px-3 py-2 rounded-lg border text-xs ${
                    q.result === 'success' ? 'bg-blue-900/30 border-blue-600' : 'bg-red-900/30 border-red-600'
                  }`}>
                    <span className="text-lg">{q.result === 'success' ? '✓' : '✗'}</span>
                    <span className="text-gray-400">R{q.round}</span>
                    {q.failCount > 0 && <span className="text-red-400">{q.failCount}張失敗</span>}
                  </div>
                ))}
              </div>
            )}

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
                  minion:   '爪牙 (Minion)',
                };
                const isGood = ['merlin', 'percival', 'loyal'].includes(player.role ?? '');
                const wasAssassinated = room.assassinTargetId === player.id;

                return (
                  <div
                    key={player.id}
                    className={`text-sm p-3 rounded-lg border ${
                      wasAssassinated
                        ? 'bg-red-900/50 border-red-400 ring-2 ring-red-500'
                        : isGood
                        ? 'bg-blue-900/30 border-blue-600'
                        : 'bg-red-900/30 border-red-600'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <p className="font-bold text-white truncate">{player.name}{wasAssassinated && ' 🗡️'}</p>
                      {room.eloDeltas?.[player.id] !== undefined && (
                        <span className={`text-xs font-bold flex-shrink-0 ${room.eloDeltas[player.id] >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {room.eloDeltas[player.id] >= 0 ? '+' : ''}{room.eloDeltas[player.id]}
                        </span>
                      )}
                    </div>
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

            {/* Vote analysis — collapsible, only shown when there's history */}
            <VoteAnalysisPanel room={room} currentPlayer={currentPlayer} />

            <div className="flex items-center justify-center gap-3 flex-wrap">
              {room.host === currentPlayer.id && (
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => requestRematch(room.id)}
                  className="flex items-center gap-2 bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-700 hover:to-teal-700 text-white font-bold py-3 px-8 rounded-lg transition-all"
                >
                  <RefreshCw size={20} />
                  再來一局 (Rematch)
                </motion.button>
              )}
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handlePlayAgain}
                className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-bold py-3 px-8 rounded-lg transition-all"
              >
                <Home size={20} />
                返回首頁
              </motion.button>
            </div>
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
