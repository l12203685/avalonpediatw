import { useState, useEffect, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useGameStore } from '../store/gameStore';
import { submitVote, submitAssassination, submitLadyOfTheLake, requestRematch, leaveSpectate } from '../services/socket';
import GameBoard from '../components/GameBoard';
import VotePanel from '../components/VotePanel';
import QuestPanel from '../components/QuestPanel';
import TeamSelectionPanel from '../components/TeamSelectionPanel';
import RoleRevealModal from '../components/RoleRevealModal';
// [TASK #41 night-info] persistent panel so per-player night info never disappears
import PersistentNightInfoPanel from '../components/PersistentNightInfoPanel';
import VoteRevealOverlay from '../components/VoteRevealOverlay';
import QuestResultOverlay from '../components/QuestResultOverlay';
import ChatPanel from '../components/ChatPanel';
import MissionTrack from '../components/MissionTrack';
import SuspicionBoard from '../components/SuspicionBoard';
import VoteAnalysisPanel from '../components/VoteAnalysisPanel';
import CompactScoresheet from '../components/CompactScoresheet';
import audioService from '../services/audio';
import { motion, AnimatePresence } from 'framer-motion';
import { Home, Bell, RefreshCw, Volume2, VolumeX, WifiOff, Loader2 } from 'lucide-react';
import { AVALON_CONFIG, VoteRecord, QuestRecord } from '@avalon/shared';
import { requestNotificationPermission } from '../services/notifications';

export default function GamePage(): JSX.Element {
  const { t } = useTranslation(['game', 'common']);
  const { room, currentPlayer, setGameState, setRoom, setCurrentPlayer, isSpectator, socketStatus } = useGameStore();
  const [isVoting, setIsVoting] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [isAssassinating, setIsAssassinating] = useState(false);
  const [showRoleReveal, setShowRoleReveal] = useState(true);
  const prevRoomState = useRef<string | null>(null);
  // Base seconds per phase (match server constants at 1x multiplier).
  const TEAM_SELECT_BASE = 90;
  const ASSASSIN_BASE = 180;
  const timerMultiplier = room?.timerConfig?.multiplier ?? 1;
  const isUnlimitedTimer = timerMultiplier === null;
  const teamSelectBase = isUnlimitedTimer ? 0 : Math.round(TEAM_SELECT_BASE * (timerMultiplier as number));
  const assassinBase = isUnlimitedTimer ? 0 : Math.round(ASSASSIN_BASE * (timerMultiplier as number));
  const [assassinTimer, setAssassinTimer] = useState(assassinBase);
  const [pendingVoteReveal, setPendingVoteReveal] = useState<VoteRecord | null>(null);
  const [pendingQuestReveal, setPendingQuestReveal] = useState<QuestRecord | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(() => audioService.isEnabled());
  const [teamSelectTimer, setTeamSelectTimer] = useState(teamSelectBase);
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

  // Team-select countdown (mirrors the server AFK timeout, scaled by multiplier).
  // Unlimited mode: skip the interval entirely.
  useEffect(() => {
    if (!room || room.state !== 'voting' || room.questTeam.length > 0) return;
    if (isUnlimitedTimer) {
      setTeamSelectTimer(0);
      return;
    }
    setTeamSelectTimer(teamSelectBase);
    const interval = setInterval(() => {
      setTeamSelectTimer(t => Math.max(0, t - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [room?.state, room?.questTeam?.length, room?.leaderIndex, isUnlimitedTimer, teamSelectBase]);

  // Assassination countdown (scaled by multiplier; skipped when unlimited).
  useEffect(() => {
    if (!room || room.state !== 'discussion') return;
    if (isUnlimitedTimer) {
      setAssassinTimer(0);
      return;
    }
    setAssassinTimer(assassinBase);
    const interval = setInterval(() => {
      setAssassinTimer(t => Math.max(0, t - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [room?.state, isUnlimitedTimer, assassinBase]);

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
    return <div className="text-center text-white">{t('common:app.loading')}</div>;
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
    voting: teamSelected ? t('game:phaseLabel.votingInProgress') : t('game:phaseLabel.voting'),
    quest: t('game:phaseLabel.quest'),
    lady_of_the_lake: t('game:phaseLabel.ladyOfTheLake'),
    discussion: t('game:phaseLabel.discussion'),
    ended: t('game:phaseLabel.ended'),
    lobby: t('game:phaseLabel.lobby'),
  };

  // Determine if this player needs to act right now
  const alreadyVoted = room.votes[currentPlayer.id] !== undefined;
  const isOnQuestTeam = room.questTeam.includes(currentPlayer.id);
  const isAssassin = currentPlayer.role === 'assassin';
  const isLadyHolder = room.ladyOfTheLakeHolder === currentPlayer.id;
  type ActionBanner = { msg: string; color: string } | null;
  const actionBanner: ActionBanner =
    room.state === 'voting' && !teamSelected && isCurrentPlayerLeader
      ? { msg: t('game:action.leaderTurn'), color: 'border-amber-500 bg-amber-900/30 text-amber-200' }
      : room.state === 'voting' && teamSelected && !alreadyVoted
      ? { msg: t('game:action.voteTurn'), color: 'border-yellow-500 bg-yellow-900/30 text-yellow-200' }
      : room.state === 'quest' && isOnQuestTeam
      ? { msg: t('game:action.questTurn'), color: 'border-blue-500 bg-blue-900/30 text-blue-200' }
      : room.state === 'lady_of_the_lake' && isLadyHolder
      ? { msg: t('game:action.ladyTurn'), color: 'border-blue-500 bg-blue-900/30 text-blue-200' }
      : room.state === 'discussion' && isAssassin
      ? { msg: t('game:action.assassinTurn'), color: 'border-red-500 bg-red-900/30 text-red-200' }
      : null;

  // Role composition from config
  const config = AVALON_CONFIG[playerIds.length];
  const goodCount = config?.roles.filter(r => ['merlin','percival','loyal'].includes(r)).length ?? 0;
  const evilCount = config?.roles.filter(r => !['merlin','percival','loyal'].includes(r)).length ?? 0;

  // Current-actor summary — small strip shown to EVERYONE (including the current actor) so
  // spectators / non-leaders always know whose turn it is. Pairs with the pulsing ring on
  // PlayerCard for the visual cue.
  const currentActorLabel: string | null = (() => {
    if (room.state === 'voting' && !teamSelected) {
      const name = room.players[leaderId]?.name ?? '';
      return t('game:currentActor.leaderLabel', { name });
    }
    if (room.state === 'voting' && teamSelected) {
      const pending = playerIds.length - Object.keys(room.votes).length;
      return pending > 0 ? t('game:currentActor.voteWaitingLabel', { count: pending }) : null;
    }
    if (room.state === 'quest') {
      const voted = room.questVotedCount ?? 0;
      return t('game:currentActor.questWaitingLabel', { voted, total: room.questTeam.length });
    }
    if (room.state === 'lady_of_the_lake') {
      const name = room.players[room.ladyOfTheLakeHolder ?? '']?.name ?? '';
      return t('game:currentActor.ladyLabel', { name });
    }
    if (room.state === 'discussion') {
      return t('game:currentActor.assassinLabel');
    }
    return null;
  })();

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

      <div className="max-w-7xl mx-auto space-y-6">
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
                <><Loader2 size={16} className="animate-spin flex-shrink-0" />{t('game:connection.reconnecting')}</>
              ) : (
                <><WifiOff size={16} className="flex-shrink-0" />{t('game:connection.disconnected')}</>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Spectator banner */}
        {isSpectator && (
          <div className="flex items-center justify-between bg-slate-800/40 border border-slate-600 rounded-xl px-4 py-2">
            <span className="text-slate-300 text-sm font-semibold">{t('game:spectator.bannerTitle')}</span>
            <button
              onClick={() => room && leaveSpectate(room.id)}
              className="text-xs text-slate-400 hover:text-white border border-slate-600 hover:border-white px-3 py-1 rounded-lg transition-colors"
            >
              {t('game:spectator.leave')}
            </button>
          </div>
        )}

        {/* Header */}
        <div className="text-center">
          <h1 className="text-5xl font-bold text-white mb-2">🎭 {t('game:header.title')}</h1>
          <div className="mt-2">
            <MissionTrack room={room} />
          </div>
          <div className="flex justify-center gap-3 mt-3 text-sm flex-wrap">
            <div className="bg-avalon-card/50 px-4 py-2 rounded-lg">
              <p className="text-gray-300">{t('game:header.state')}<span className="text-yellow-400 font-bold">{stateLabel[room.state] ?? room.state}</span></p>
            </div>
            <button
              onClick={() => setShowRoleReveal(true)}
              className="bg-blue-900/50 hover:bg-blue-800/70 border border-blue-600 px-4 py-2 rounded-lg text-blue-300 text-sm transition-colors"
            >
              {t('game:header.viewRole')}
            </button>
            <button
              onClick={handleToggleAudio}
              title={audioEnabled ? t('game:header.mute') : t('game:header.unmute')}
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
                {t('game:roster.goodCount', { count: goodCount })}
              </span>
              <span className="bg-red-900/30 border border-red-700/50 px-3 py-1 rounded-full">
                {t('game:roster.evilCount', { count: evilCount })}
              </span>
            </div>
          )}

          {/* Current-actor strip — tells every player whose move it is right now */}
          {currentActorLabel && room.state !== 'ended' && room.state !== 'lobby' && (
            <div className="flex justify-center">
              <span className="bg-amber-950/50 border border-amber-700/60 text-amber-200 px-3 py-1 rounded-full text-xs font-semibold">
                {currentActorLabel}
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

        {/* Game Board — 5v5 rails with center panel (quest/vote/history) per Edward spec */}
        <GameBoard room={room} currentPlayer={currentPlayer}>
          {/* Center column content — phase panel + history */}

          {/* Voting Phase */}
          {room.state === 'voting' && !isSpectator && (
            !teamSelected ? (
              isCurrentPlayerLeader ? (
                <TeamSelectionPanel
                  room={room}
                  currentPlayer={currentPlayer}
                  isLoading={isVoting}
                  timer={teamSelectTimer}
                  timerTotal={teamSelectBase}
                />
              ) : (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-avalon-card/50 border-2 border-yellow-700 rounded-lg p-6 text-center space-y-3"
                >
                  <div className="text-4xl">⏳</div>
                  <h2 className="text-xl font-bold text-white">{t('game:teamSelect.waitingTitle')}</h2>
                  <p className="text-gray-300 text-sm">
                    <Trans
                      i18nKey="game:teamSelect.waitingDesc"
                      values={{ name: room.players[leaderId]?.name ?? '' }}
                      components={{ leader: <span className="text-yellow-400 font-bold" /> }}
                    />
                  </p>
                  <div className="flex items-center justify-center gap-3 text-xs text-gray-500 flex-wrap">
                    <span>{t('game:teamSelect.needMembers', { count: AVALON_CONFIG[playerIds.length]?.questTeams[room.currentRound - 1] ?? 0 })}</span>
                    {isUnlimitedTimer ? (
                      <span className="px-3 py-1 rounded-full font-bold bg-blue-900/60 text-blue-300">
                        {t('game:teamSelect.unlimitedTimer')}
                      </span>
                    ) : (
                      <span className={`px-3 py-1 rounded-full font-bold ${teamSelectTimer < 20 ? 'bg-red-900/60 text-red-300' : 'bg-gray-800 text-gray-400'}`}>
                        {t('game:teamSelect.timer', { seconds: teamSelectTimer })}
                      </span>
                    )}
                  </div>
                  {/* Countdown bar so everyone (not just the leader) can see how long until auto-select kicks in */}
                  {!isUnlimitedTimer && teamSelectBase > 0 && (
                    <div className="mt-1 w-full max-w-sm mx-auto">
                      <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
                        <motion.div
                          animate={{ width: `${Math.max(0, Math.min(100, (teamSelectTimer / teamSelectBase) * 100))}%` }}
                          transition={{ duration: 0.6, ease: 'linear' }}
                          className={`h-full rounded-full ${teamSelectTimer < 20 ? 'bg-gradient-to-r from-red-500 to-red-400' : 'bg-gradient-to-r from-amber-500 to-yellow-400'}`}
                        />
                      </div>
                      <p className="mt-1 text-[11px] text-gray-500">
                        {t('game:teamSelect.autoSelectHint')}
                      </p>
                    </div>
                  )}
                </motion.div>
              )
            ) : (
              <VotePanel
                room={room}
                currentPlayer={currentPlayer}
                onVote={handleVote}
                isLoading={isVoting}
              />
            )
          )}

          {/* Quest Phase */}
          {room.state === 'quest' && !isSpectator && <QuestPanel room={room} currentPlayer={currentPlayer} />}

          {/*
            Live Scoresheet — collapsible wrapper (#83 Phase 2). Defaults collapsed mid-game;
            auto-expands on `room.state === 'ended'`. Owns its own chrome so the outer div
            wrapper from the pre-collapse era is gone.
          */}
          <CompactScoresheet room={room} currentPlayer={currentPlayer} />
        </GameBoard>

        {/* Suspicion Notes — personal private notepad, only shown during active game */}
        {room.state !== 'ended' && room.state !== 'lobby' && !isSpectator && (
          <SuspicionBoard room={room} currentPlayer={currentPlayer} />
        )}

        {/* Lady of the Lake Phase */}
        {room.state === 'lady_of_the_lake' && !isSpectator && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-avalon-card/50 border-2 border-blue-600 rounded-lg p-8 space-y-6"
          >
            {isLadyHolder ? (
              room.ladyOfTheLakeResult ? (
                // Result revealed to holder
                <div className="text-center space-y-4">
                  <h2 className="text-3xl font-bold text-blue-400">{t('game:lady.title')}</h2>
                  <p className="text-gray-300">
                    <Trans
                      i18nKey="game:lady.targetTeamLabel"
                      values={{ name: room.players[room.ladyOfTheLakeTarget ?? '']?.name ?? '' }}
                      components={{ target: <span className="font-bold text-white" /> }}
                    />
                  </p>
                  <div className={`inline-block px-6 py-3 rounded-xl text-2xl font-bold border-2 ${
                    room.ladyOfTheLakeResult === 'good'
                      ? 'bg-blue-900/40 border-blue-500 text-blue-300'
                      : 'bg-red-900/40 border-red-500 text-red-300'
                  }`}>
                    {room.ladyOfTheLakeResult === 'good' ? t('game:lady.resultGood') : t('game:lady.resultEvil')}
                  </div>
                  <p className="text-gray-500 text-sm">{t('game:lady.pass')}</p>
                </div>
              ) : (
                // Holder selects target
                <>
                  <div className="text-center">
                    <h2 className="text-3xl font-bold text-blue-400">{t('game:lady.title')}</h2>
                    <p className="text-gray-300 mt-2">{t('game:lady.pickTitle')}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-4 max-h-96 overflow-y-auto">
                    {Object.values(room.players)
                      .filter(p => p.id !== currentPlayer.id && !(room.ladyOfTheLakeUsed ?? []).includes(p.id))
                      .map((player) => (
                        <button
                          key={player.id}
                          onClick={() => submitLadyOfTheLake(room.id, currentPlayer.id, player.id)}
                          className="p-4 rounded-lg border-2 transition-all font-semibold bg-blue-900/30 border-blue-600 text-white hover:bg-blue-800/60"
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
                <h2 className="text-3xl font-bold text-blue-400">{t('game:lady.title')}</h2>
                <p className="text-gray-300">
                  <Trans
                    i18nKey="game:lady.waitingDesc"
                    values={{ name: room.players[room.ladyOfTheLakeHolder ?? '']?.name ?? '' }}
                    components={{ holder: <span className="text-blue-400 font-bold" /> }}
                  />
                </p>
                <p className="text-gray-500 text-sm">{t('game:lady.waitingNote')}</p>
              </div>
            )}
          </motion.div>
        )}

        {/* Spectator phase hint */}
        {isSpectator && (room.state === 'voting' || room.state === 'quest' || room.state === 'lady_of_the_lake' || room.state === 'discussion') && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-avalon-card/30 border border-slate-700/50 rounded-xl p-4 text-center"
          >
            <p className="text-slate-400 text-sm">
              {room.state === 'voting' && t('game:spectator.hintVoting')}
              {room.state === 'quest' && t('game:spectator.hintQuest')}
              {room.state === 'lady_of_the_lake' && t('game:spectator.hintLady')}
              {room.state === 'discussion' && t('game:spectator.hintDiscussion')}
            </p>
          </motion.div>
        )}

        {/* Discussion Phase - Assassination */}
        {room.state === 'discussion' && !isSpectator && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-avalon-card/50 border-2 border-red-700 rounded-lg p-8 space-y-6"
          >
            {/* Quest history aide for assassin */}
            {room.questHistory.length > 0 && (
              <div className="bg-gray-800/40 border border-gray-700 rounded-xl p-3">
                <p className="text-xs text-gray-500 mb-2 font-semibold uppercase tracking-wider">{t('game:assassin.questHistoryHeader')}</p>
                <div className="space-y-1.5">
                  {room.questHistory.map(q => (
                    <div key={q.round} className="flex items-center gap-2 text-xs">
                      <span className={`w-4 h-4 flex-shrink-0 flex items-center justify-center rounded-full font-bold ${q.result === 'success' ? 'bg-blue-600 text-white' : 'bg-red-600 text-white'}`}>
                        {q.result === 'success' ? '✓' : '✗'}
                      </span>
                      <span className="text-gray-400">{t('game:assassin.roundPrefix', { round: q.round })}</span>
                      <span className="text-gray-300">{q.team.map(id => room.players[id]?.name ?? id).join('、')}</span>
                      {q.result === 'fail' && q.failCount > 0 && <span className="text-red-400 ml-1">{t('game:assassin.failBadge', { count: q.failCount })}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {currentPlayer.role === 'assassin' ? (
              <>
                <div className="text-center">
                  <h2 className="text-3xl font-bold text-red-400 mb-2">{t('game:assassin.title')}</h2>
                  <p className="text-gray-300">{t('game:assassin.prompt')}</p>
                  {isUnlimitedTimer ? (
                    <div className="inline-flex items-center gap-2 mt-3 px-4 py-1.5 rounded-full font-bold text-sm bg-blue-700 text-blue-100">
                      {t('game:teamSelect.unlimitedTimer')}
                    </div>
                  ) : (
                    <div className={`inline-flex items-center gap-2 mt-3 px-4 py-1.5 rounded-full font-bold text-sm ${assassinTimer < 30 ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-300'}`}>
                      {t('game:teamSelect.timer', { seconds: assassinTimer })}
                    </div>
                  )}
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
                  <p className="text-center text-gray-400 text-sm">{t('game:assassin.selectedHint')}</p>
                )}
              </>
            ) : (
              <div className="text-center space-y-4">
                <h2 className="text-3xl font-bold text-red-400">{t('game:assassin.discussionTitle')}</h2>
                <p className="text-gray-300">{t('game:assassin.goodWonIntro')}</p>
                <p className="text-gray-400">{t('game:assassin.pickingTarget')}</p>
                <div className="text-sm text-yellow-500 bg-yellow-900/20 border border-yellow-700 rounded-lg p-3">
                  {t('game:assassin.warning')}
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
              {room.evilWins ? t('game:ended.evilWins') : t('game:ended.goodWins')}
            </motion.h2>

            {/* End reason banner */}
            {room.endReason && (
              <div className={`inline-block px-5 py-2 rounded-full text-sm font-semibold ${
                room.evilWins ? 'bg-red-900/50 border border-red-600 text-red-200' : 'bg-blue-900/50 border border-blue-600 text-blue-200'
              }`}>
                {room.endReason === 'failed_quests' && t('game:ended.reasonFailedQuests')}
                {room.endReason === 'vote_rejections' && t('game:ended.reasonVoteRejections')}
                {room.endReason === 'merlin_assassinated' && (
                  <>{t('game:ended.reasonMerlinKilledPrefix')}<span className="text-red-300 font-bold"> {room.players[room.assassinTargetId ?? '']?.name ?? '?'} </span>{t('game:ended.reasonMerlinKilledSuffix')}</>
                )}
                {room.endReason === 'assassination_failed' && (
                  <>{t('game:ended.reasonWrongKillPrefix')} <span className="text-blue-300 font-bold">{room.players[room.assassinTargetId ?? '']?.name ?? '?'}</span>{t('game:ended.reasonWrongKillSuffix')}</>
                )}
                {room.endReason === 'assassination_timeout' && t('game:ended.reasonAssassinationTimeout')}
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
                    {q.failCount > 0 && <span className="text-red-400">{t('game:ended.roundFailLabel', { count: q.failCount })}</span>}
                  </div>
                ))}
              </div>
            )}

            <p className="text-gray-300 text-lg">{t('game:ended.rolesReveal')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {Object.values(room.players).map((player) => {
                const roleLabel: Record<string, string> = {
                  merlin:   t('game:roleLabel.merlin'),
                  percival: t('game:roleLabel.percival'),
                  loyal:    t('game:roleLabel.loyal'),
                  assassin: t('game:roleLabel.assassin'),
                  morgana:  t('game:roleLabel.morgana'),
                  oberon:   t('game:roleLabel.oberon'),
                  mordred:  t('game:roleLabel.mordred'),
                  minion:   t('game:roleLabel.minion'),
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
                        <span className={`text-xs font-bold flex-shrink-0 ${room.eloDeltas[player.id] >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
                          {room.eloDeltas[player.id] >= 0 ? '+' : ''}{room.eloDeltas[player.id]}
                        </span>
                      )}
                    </div>
                    <p className={isGood ? 'text-blue-400' : 'text-red-400'}>
                      {roleLabel[player.role ?? ''] ?? player.role}
                    </p>
                    {player.id === currentPlayer.id && (
                      <p className="text-xs text-gray-500 mt-1">{t('game:ended.youLabel')}</p>
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
                  className="flex items-center gap-2 bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-700 hover:to-yellow-700 text-white font-bold py-3 px-8 rounded-lg transition-all"
                >
                  <RefreshCw size={20} />
                  {t('game:ended.rematch')}
                </motion.button>
              )}
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handlePlayAgain}
                className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white font-bold py-3 px-8 rounded-lg transition-all"
              >
                <Home size={20} />
                {t('game:ended.backHome')}
              </motion.button>
            </div>
          </motion.div>
        )}
      </div>

      {/* Floating chat — available during all game phases */}
      {room.state !== 'lobby' && (
        <ChatPanel roomId={room.id} currentPlayerId={currentPlayer.id} />
      )}

      {/* [TASK #41 night-info] Always-on role + night-info panel. Docked bottom-left so
          players can re-check their night vision any time without hunting for a button.
          Shows only the viewer's own role — never leaks other players' secrets. */}
      {room.state !== 'lobby' && room.state !== 'ended' && !isSpectator && currentPlayer.role && (
        <PersistentNightInfoPanel room={room} currentPlayer={currentPlayer} />
      )}
    </div>
  );
}
