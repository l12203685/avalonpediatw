import { useState, useEffect, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useGameStore } from '../store/gameStore';
import { submitVote, submitAssassination, submitLadyOfTheLake, declareLakeResult, skipLakeDeclaration, leaveSpectate } from '../services/socket';
import GameBoard from '../components/GameBoard';
import VotePanel from '../components/VotePanel';
import QuestPanel from '../components/QuestPanel';
import QuestTeamToolbar from '../components/QuestTeamToolbar';
import RoleRevealModal from '../components/RoleRevealModal';
import VoteRevealOverlay from '../components/VoteRevealOverlay';
import QuestResultOverlay from '../components/QuestResultOverlay';
import ChatPanel from '../components/ChatPanel';
import MissionTrack from '../components/MissionTrack';
import VoteAnalysisPanel from '../components/VoteAnalysisPanel';
import CompactScoresheet from '../components/CompactScoresheet';
import { motion, AnimatePresence } from 'framer-motion';
import { DoorOpen, Bell, WifiOff, Loader2, Eye } from 'lucide-react';
import { AVALON_CONFIG, VoteRecord, QuestRecord } from '@avalon/shared';
import { requestNotificationPermission } from '../services/notifications';
import { displaySeatNumber, seatOf } from '../utils/seatDisplay';
import { LAKE_IMAGE, getBoardImage, getCampLakeIcon } from '../utils/avalonAssets';
import { CampDisc } from '../components/CampDisc';

export default function GamePage(): JSX.Element {
  const { t } = useTranslation(['game', 'common']);
  const { room, currentPlayer, setGameState, isSpectator, socketStatus } = useGameStore();
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
  const [teamSelectTimer, setTeamSelectTimer] = useState(teamSelectBase);
  // 忠臣視角 toggle (#107 Edward 2026-04-25 right-top eye icon revamp).
  // 開啟時暫時隱藏所有非忠臣資訊（自己角色 / 敵我隊友 / 紅藍隊配色），
  // 玩家被迫像忠臣一樣只看公開行為線索 — 用於教學 / 直播 / 挑戰自我。
  // 不影響伺服器端資料；純 UI 過濾，再次點擊即還原原本視角。
  const [loyalView, setLoyalView] = useState(false);
  // Leader team-selection state lifted from the old TeamSelectionPanel so rail clicks
  // (#83 Phase 1) can toggle membership directly on PlayerCards.
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(new Set());
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

  // Reset leader's selected-team picks whenever a new team-select phase starts (new round,
  // new leader after a rejection, or server auto-fill clearing the board). Once the server
  // locks in a questTeam we also clear so stale Set<string> doesn't linger into the next round.
  useEffect(() => {
    if (!room) return;
    if (room.state !== 'voting' || room.questTeam.length > 0) {
      setSelectedTeamIds(new Set());
    }
  }, [room?.state, room?.questTeam?.length, room?.leaderIndex, room?.currentRound]);

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
  // Role composition from config — hoisted up because team-select handlers below also need it.
  // 2026-04-25: Header 排版精簡 — goodCount/evilCount strip 已砍（Edward「上方排版太佔空間」），
  // 只保留 config 解構供 expectedTeamSize 使用。陣營人數計分盤已隱含 N/Y col 對應，無需重複顯示。
  const config = AVALON_CONFIG[playerIds.length];

  const handleVote = (approve: boolean): void => {
    if (isVoting) return;
    setIsVoting(true);
    submitVote(room.id, currentPlayer.id, approve);
    // Reset after server ACK arrives (room.votes updates), with 3s safety fallback
    setTimeout(() => setIsVoting(false), 3000);
  };

  // Rail-click handler for leader team-selection (#83 Phase 1).
  // Toggles membership in `selectedTeamIds`; silently ignores adds beyond the quest team
  // size so the UI never out-picks the server's accept cap.
  const expectedTeamSize = config?.questTeams[room.currentRound - 1] ?? 0;
  const handleSeatClick = (playerId: string): void => {
    setSelectedTeamIds(prev => {
      const next = new Set(prev);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else if (next.size < expectedTeamSize) {
        next.add(playerId);
      }
      return next;
    });
  };
  const clearSelectedTeam = (): void => setSelectedTeamIds(new Set());
  const isLeaderPicking =
    room.state === 'voting' && !teamSelected && isCurrentPlayerLeader && !isSpectator;

  const handleAssassinate = (targetId: string): void => {
    if (isAssassinating) return;
    setSelectedTarget(targetId);
    setIsAssassinating(true);
    submitAssassination(room.id, currentPlayer.id, targetId);
    setTimeout(() => setIsAssassinating(false), 3000);
  };

  // 2026-04-25 Edward「結束應該是 [返回房間] => 要返回首頁的再從房間內的右上角直接離開」
  // 結束揭曉頁的按鈕只回 lobby（房間 waiting room），等下一局；要回首頁的玩家
  // 從 LobbyPage 右上角既有 leaveRoom 按鈕走。不清 room／不清 role，保留房間連線。
  const handleBackToRoom = () => {
    setGameState('lobby');
  };

  // 2026-04-25: stateLabel 字典已砍（Edward「上方排版太佔空間」）— 狀態徽章從 header 移除，
  // 由主面板各 phase 標題（湖中女神 / 暗殺梅林 / 任務派遣等）承擔狀態指示。

  // Determine if this player needs to act right now
  const alreadyVoted = room.votes[currentPlayer.id] !== undefined;
  const isOnQuestTeam = room.questTeam.includes(currentPlayer.id);
  const isAssassin = currentPlayer.role === 'assassin';
  const isLadyHolder = room.ladyOfTheLakeHolder === currentPlayer.id;
  // #90 Part 4 — the player who just performed an inspection is the
  // DECLARER, regardless of token transfer. Engine updates
  // ladyOfTheLakeHolder → target synchronously with the result broadcast,
  // so we must read history[last].holderId to identify the declarer.
  const lastLadyRecord = (room.ladyOfTheLakeHistory ?? [])[
    (room.ladyOfTheLakeHistory?.length ?? 0) - 1
  ];
  const isRecentLadyDeclarer =
    !!lastLadyRecord
    && lastLadyRecord.round === room.currentRound
    && lastLadyRecord.holderId === currentPlayer.id;
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

  // 2026-04-25: currentActorLabel 字串組合 + 顯示已砍（Edward「上方排版太佔空間」）—
  // 玩家圈的 crown / pulsing ring / 各 phase 主面板標題已足以指示當前 actor。

  // #107 Edward 2026-04-25 「派票跟黑白球不要一直跳視窗出來」 —
  // sticky inline action toolbars replace the old center-column big-card panels.
  // Three sources keep their docked footer presence:
  //   1. Leader picking team → QuestTeamToolbar (existing)
  //   2. Voting on a proposed team → new sticky VotePanel
  //   3. Quest mission vote → new sticky QuestPanel (always sticky now —
  //      both team-members and bystanders see the bottom strip)
  const teamVotePhaseSticky =
    room.state === 'voting' && teamSelected && !isSpectator;
  const questPhaseSticky = room.state === 'quest' && !isSpectator;
  const stickyToolbarActive = isLeaderPicking || teamVotePhaseSticky || questPhaseSticky;

  // Per-table-size board watermark — Edward 2026-04-25 image batch: render the
  // painted scoresheet board as a low-opacity background layer matching the
  // current table size (5..10). null when the count falls outside the supplied
  // range (we ship art for 5..10 only); no fallback to keep file size honest.
  const boardImageUrl = getBoardImage(playerIds.length);

  // Edward 2026-04-25 holistic redesign (matches LobbyPage commit df6b5726)
  // + 2026-04-25 18:08 root fix (Edward「版面還是沒有一次顯示全部 一直上拉下拉」):
  //
  // Single-viewport guarantee — entire GamePage fits 375x667 (iPhone SE),
  // 414x896 (iPhone 11), and 1920x1080 (desktop) without page scroll. Header
  // rows are shrink-0; the GameBoard owns flex-1 min-h-0 so its inner layout
  // (rails + chat + phase panel) self-scrolls. Sticky toolbars
  // (QuestTeamToolbar/VotePanel/QuestPanel) stay fixed at the bottom and use
  // safe-area-inset so the iOS home indicator never overlaps action buttons.
  //
  // Critical fix: phase-specific panels (Lady-of-the-Lake / Discussion-
  // Assassinate / Ended reveal / Spectator hint) used to render as siblings of
  // GameBoard inside <main>, which let their content push <main>'s scroll
  // height past viewport. They now render inside `<GameBoard>` as part of
  // `children`, sharing the existing center-column overflow-y-auto. The whole
  // GamePage column flow is now: header (shrink-0) → GameBoard (flex-1 min-h-0)
  // → fixed sticky toolbars. No `<main>` middle scroll layer. No phase panel
  // siblings outside GameBoard.
  return (
    <div className="relative h-[100dvh] flex flex-col overflow-hidden bg-gradient-to-b from-avalon-dark to-black">
      {/* Painted board art — fixed background watermark behind every phase so
          the table size reads visually without consuming column space. Sized
          to cover the viewport while preserving aspect ratio (no distortion
          regardless of board art ratio); blur + low alpha keep typography
          readable on top. `pointer-events-none` so it never blocks touches. */}
      {boardImageUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0 bg-no-repeat bg-center bg-cover opacity-[0.08] sm:opacity-10 mix-blend-luminosity"
          style={{ backgroundImage: `url('${boardImageUrl}')` }}
        />
      )}
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

      {/* ────────── HEADER (shrink-0 rows: banners + MissionTrack + actionBanner) ────────── */}
      {/* Reconnection status banner */}
      <AnimatePresence>
        {(socketStatus === 'reconnecting' || socketStatus === 'disconnected') && (
          <motion.div
            key="reconnect-banner"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`relative z-10 shrink-0 flex items-center gap-2 mx-3 mt-2 rounded-xl px-4 py-2 text-[11px] sm:text-xs font-semibold ${
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
        <div className="relative z-10 shrink-0 flex items-center justify-between mx-3 mt-2 bg-slate-800/40 border border-slate-600 rounded-xl px-4 py-1.5">
          <span className="text-slate-300 text-[11px] sm:text-xs font-semibold">{t('game:spectator.bannerTitle')}</span>
          <button
            onClick={() => room && leaveSpectate(room.id)}
            className="text-[10px] sm:text-[11px] text-slate-400 hover:text-white border border-slate-600 hover:border-white px-3 py-0.5 rounded-lg transition-colors"
          >
            {t('game:spectator.leave')}
          </button>
        </div>
      )}

      {/*
        Edward 2026-04-25 GamePage 4-revamp #1+#4 — 對齊 LobbyPage 排序：
          row 1: 否決計數 chip + 忠臣視角眼睛 (header shrink-0)
          row 2: MissionTrack 5 局結果一覽 (牌譜 shrink-0)
          row 3+: actionBanner / main (rails+chat)
        Old combined MissionTrack was a single block with mission circles +
        rejection diamonds; we split via `variant` prop so rejection lives in
        the header band and mission circles sit just below as their own row,
        matching the Edward spec「牌譜放在『否決計數』下方 / 玩家列表上方」.
      */}
      {/* Header row — rejection chip (left) + loyal-view toggle (right) */}
      <div className="relative z-10 shrink-0 flex items-center justify-between gap-2 px-3 pt-2">
        <div className="flex-1 min-w-0">
          <MissionTrack room={room} variant="rejection-only" />
        </div>
        <button
          onClick={() => setLoyalView(v => !v)}
          title={loyalView ? t('game:header.loyalViewOff') : t('game:header.loyalViewOn')}
          aria-label={loyalView ? t('game:header.loyalViewOff') : t('game:header.loyalViewOn')}
          aria-pressed={loyalView}
          className={`flex-shrink-0 flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-full transition-colors border ${
            loyalView
              ? 'bg-yellow-500/30 hover:bg-yellow-500/50 border-yellow-400 text-yellow-200 shadow-md shadow-yellow-400/30'
              : 'bg-blue-900/40 hover:bg-blue-800/70 border-blue-700/60 text-blue-300'
          }`}
        >
          <Eye size={14} />
        </button>
      </div>

      {/* 牌譜 — MissionTrack mission circles only (Edward「介於否決計數與玩家列之間」) */}
      <div className="relative z-10 shrink-0 px-3 pt-1.5">
        <MissionTrack room={room} variant="mission-only" />
      </div>

      {/* Your-turn action banner — kept (not part of header clutter; signals required action) */}
      <AnimatePresence>
        {actionBanner && (
          <motion.div
            key={actionBanner.msg}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`relative z-10 shrink-0 mx-3 mt-1 flex items-center gap-2 border rounded-lg px-3 py-1.5 text-[11px] sm:text-xs font-semibold ${actionBanner.color}`}
          >
            <Bell size={14} className="flex-shrink-0" />
            {actionBanner.msg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ────────── MAIN (flex-1 min-h-0): GameBoard owns ALL phase panels ──────────
          2026-04-25 18:08 root fix: removed the outer <main> scroll layer that
          previously hosted Lady/Discussion/Ended panels as GameBoard siblings.
          GameBoard's center column already self-scrolls via flex-1 min-h-0
          overflow-y-auto, so wrapping it inside another scroll container only
          duplicated padding + created a second scroll axis users could pull. */}
      {/* Edward 2026-04-25 19:56 根因修正：上一版 padding-bottom 在 stickyToolbar
          開關時 (pb-1 ↔ pb-[32dvh]) 整塊 main 高度跳動，從 lobby→voting 進入投票
          時整個版面位移 = Edward「投票時畫面會跑掉」。改為：room.state 一進入
          遊戲流程就鎖定 pb-[32dvh]，不再依 stickyToolbarActive 開關，避免 phase
          切換之間的 layout shift。lobby 狀態 (start screen) 維持 pb-1。 */}
      <div
        className={`relative z-10 flex-1 min-h-0 flex flex-col px-2 sm:px-3 ${
          room.state !== 'lobby' ? 'pb-[32dvh] sm:pb-[28dvh]' : 'pb-1'
        }`}
      >
        <GameBoard
          room={room}
          currentPlayer={currentPlayer}
          isPicking={isLeaderPicking}
          selectedTeamIds={selectedTeamIds}
          onSeatClick={handleSeatClick}
          loyalView={loyalView}
          chatSlot={
            room.state !== 'lobby'
              ? <ChatPanel roomId={room.id} currentPlayerId={currentPlayer.id} variant="inline" room={room} />
              : undefined
          }
          scoresheetSlot={<CompactScoresheet room={room} currentPlayer={currentPlayer} />}
        >
          {/* Center column content — phase panel only; scoresheet now lives in scoresheetSlot */}

          {/* Voting Phase */}
          {room.state === 'voting' && !isSpectator && (
            !teamSelected ? (
              isCurrentPlayerLeader ? (
                // #83 Phase 1: picking happens on rail PlayerCards + bottom QuestTeamToolbar.
                // Keep a slim prompt in the center column so leaders immediately understand the
                // new interaction model (no more modal player picker).
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-avalon-card/50 border-2 border-amber-500 rounded-lg p-4 sm:p-5 text-center space-y-2"
                >
                  <h2 className="text-base sm:text-lg font-bold text-amber-200">
                    {t('game:teamSelect.youAreLeaderBanner')}
                  </h2>
                  <p className="text-xs sm:text-[13px] text-amber-100">
                    {t('game:teamSelect.youAreLeaderInstruction', { count: expectedTeamSize })}
                  </p>
                  <p className="text-[11px] sm:text-xs text-gray-400">
                    {t('game:teamSelect.shieldHint')}
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-avalon-card/50 border-2 border-yellow-700 rounded-lg p-6 text-center space-y-3"
                >
                  <div className="text-3xl">⏳</div>
                  <h2 className="text-base sm:text-lg font-bold text-white">{t('game:teamSelect.waitingTitle')}</h2>
                  <p className="text-gray-300 text-xs sm:text-[13px]">
                    <Trans
                      i18nKey="game:teamSelect.waitingDesc"
                      values={{
                        name: leaderId
                          ? `${displaySeatNumber(seatOf(leaderId, room.players))}家`
                          : '',
                      }}
                      components={{ leader: <span className="text-yellow-400 font-bold" /> }}
                    />
                  </p>
                  <div className="flex items-center justify-center gap-3 text-[11px] sm:text-xs text-gray-500 flex-wrap">
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
              // #107 Edward 2026-04-25: VotePanel moved to sticky-bottom toolbar
              // outside <GameBoard> so the screen no longer scrolls up/down on
              // every phase. Center column shows a slim recap so the player
              // can still see WHO was proposed at a glance while voting.
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-avalon-card/40 border border-yellow-700/60 rounded-lg px-4 py-2.5 flex items-center gap-2 flex-wrap"
              >
                <span className="text-[11px] sm:text-xs font-semibold text-yellow-300 whitespace-nowrap">
                  {t('game:votePanel.questTeamLabel')}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {room.questTeam.map(id => {
                    const p = room.players[id];
                    if (!p) return null;
                    return (
                      <span
                        key={id}
                        className={`text-[10px] sm:text-[11px] px-2 py-0.5 rounded-full border font-semibold ${
                          id === currentPlayer.id
                            ? 'bg-yellow-900/40 border-yellow-600 text-yellow-200'
                            : 'bg-avalon-card/60 border-gray-600 text-gray-200'
                        }`}
                      >
                        {displaySeatNumber(seatOf(id, room.players))}家
                      </span>
                    );
                  })}
                </div>
              </motion.div>
            )
          )}

          {/* Quest Phase — sticky-bottom toolbar (see render below GameBoard);
              center column intentionally empty so the screen stops sliding up/down. */}

          {/* Lady of the Lake Phase — Edward 2026-04-25 18:08 mobile root fix:
              moved INTO GameBoard children (was sibling of GameBoard before)
              so it rides the existing flex-1 min-h-0 overflow-y-auto in the
              center column instead of pushing a second-level scroll past
              viewport. Padding p-8 → p-3 sm:p-4 so a 5-button picker grid +
              lake icon + headline fits the iPhone SE 667px viewport. */}
        {room.state === 'lady_of_the_lake' && !isSpectator && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-avalon-card/50 border-2 border-blue-600 rounded-lg p-3 sm:p-4 space-y-3"
          >
            <motion.img
              key="lake-header"
              src={LAKE_IMAGE}
              alt=""
              aria-hidden="true"
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 280, damping: 20 }}
              className="mx-auto w-14 h-14 sm:w-20 sm:h-20 object-cover rounded-full border-2 border-cyan-400/70 shadow-lg shadow-cyan-500/30 drop-shadow-xl"
              draggable={false}
            />
            {isRecentLadyDeclarer && room.ladyOfTheLakeResult ? (
              <div className="text-center space-y-2">
                <h2 className="text-base sm:text-xl font-bold text-blue-400">{t('game:lady.title')}</h2>
                <p className="text-[11px] sm:text-xs text-gray-300">
                  <Trans
                    i18nKey="game:lady.targetTeamLabel"
                    values={{
                      name: room.ladyOfTheLakeTarget
                        ? `${displaySeatNumber(seatOf(room.ladyOfTheLakeTarget, room.players))}家`
                        : '',
                    }}
                    components={{ target: <span className="font-bold text-white" /> }}
                  />
                </p>
                {/* Edward 2026-04-25 19:40 emoji→lake-disc swap: 湖中女神結果
                    chip 前綴 lake-yes/lake-no 圓盤取代 ⚔️/👹 emoji。 */}
                <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm sm:text-lg font-bold border-2 ${
                  room.ladyOfTheLakeResult === 'good'
                    ? 'bg-blue-900/40 border-blue-500 text-blue-300'
                    : 'bg-red-900/40 border-red-500 text-red-300'
                }`}>
                  <CampDisc team={room.ladyOfTheLakeResult === 'good' ? 'good' : 'evil'} className="w-4 h-4 sm:w-5 sm:h-5" />
                  {room.ladyOfTheLakeResult === 'good' ? t('game:lady.resultGood') : t('game:lady.resultEvil')}
                </div>

                {lastLadyRecord?.declared ? (
                  <div className="pt-1">
                    <p className="text-amber-300 text-[11px] sm:text-xs font-semibold">
                      {t('game:lady.declared', {
                        claim: lastLadyRecord.declaredClaim === 'good'
                          ? t('game:lady.declareGood')
                          : t('game:lady.declareEvil'),
                      })}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2 pt-1">
                    <p className="text-[10px] sm:text-[11px] text-gray-400 uppercase tracking-wider font-semibold">
                      {t('game:lady.declareTitle')}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => declareLakeResult(room.id, 'good')}
                        className="py-2 px-3 rounded-lg border-2 bg-blue-900/30 border-blue-600 text-blue-200 hover:bg-blue-800/60 font-semibold text-xs sm:text-[13px] transition-all"
                      >
                        {t('game:lady.declareGood')}
                      </button>
                      <button
                        onClick={() => declareLakeResult(room.id, 'evil')}
                        className="py-2 px-3 rounded-lg border-2 bg-red-900/30 border-red-600 text-red-200 hover:bg-red-800/60 font-semibold text-xs sm:text-[13px] transition-all"
                      >
                        {t('game:lady.declareEvil')}
                      </button>
                    </div>
                    <p className="text-[10px] sm:text-[11px] text-gray-500">{t('game:lady.declareKeepPrivate')}</p>
                    <button
                      onClick={() => skipLakeDeclaration(room.id)}
                      className="mt-1 py-1.5 px-3 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-700/40 text-[11px] sm:text-xs font-medium transition-all"
                    >
                      {t('game:lady.skipDeclaration')}
                    </button>
                  </div>
                )}
              </div>
            ) : isLadyHolder && !room.ladyOfTheLakeResult ? (
              <>
                <div className="text-center">
                  <h2 className="text-base sm:text-xl font-bold text-blue-400">{t('game:lady.title')}</h2>
                  <p className="text-xs sm:text-sm text-gray-300 mt-1">{t('game:lady.pickTitle')}</p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {Object.values(room.players)
                    .filter(p => p.id !== currentPlayer.id && !(room.ladyOfTheLakeUsed ?? []).includes(p.id))
                    .map((player) => (
                      <button
                        key={player.id}
                        onClick={() => submitLadyOfTheLake(room.id, currentPlayer.id, player.id)}
                        className="py-2 px-3 rounded-lg border-2 transition-all font-semibold text-xs sm:text-[13px] bg-blue-900/30 border-blue-600 text-white hover:bg-blue-800/60"
                      >
                        {displaySeatNumber(seatOf(player.id, room.players))}家
                      </button>
                    ))}
                </div>
              </>
            ) : (
              <div className="text-center space-y-2">
                <h2 className="text-base sm:text-xl font-bold text-blue-400">{t('game:lady.title')}</h2>
                <p className="text-[11px] sm:text-xs text-gray-300">
                  <Trans
                    i18nKey="game:lady.waitingDesc"
                    values={{
                      name: room.ladyOfTheLakeHolder
                        ? `${displaySeatNumber(seatOf(room.ladyOfTheLakeHolder, room.players))}家`
                        : '',
                    }}
                    components={{ holder: <span className="text-blue-400 font-bold" /> }}
                  />
                </p>
                <p className="text-gray-500 text-[10px] sm:text-[11px]">{t('game:lady.waitingNote')}</p>
              </div>
            )}
          </motion.div>
        )}

        {/* Spectator phase hint — moved INTO GameBoard children (root fix). */}
        {isSpectator && (room.state === 'voting' || room.state === 'quest' || room.state === 'lady_of_the_lake' || room.state === 'discussion') && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-avalon-card/30 border border-slate-700/50 rounded-xl p-3 text-center"
          >
            <p className="text-slate-400 text-[11px] sm:text-xs">
              {room.state === 'voting' && t('game:spectator.hintVoting')}
              {room.state === 'quest' && t('game:spectator.hintQuest')}
              {room.state === 'lady_of_the_lake' && t('game:spectator.hintLady')}
              {room.state === 'discussion' && t('game:spectator.hintDiscussion')}
            </p>
          </motion.div>
        )}

        {/* Discussion Phase — Assassination — moved INTO GameBoard children
            (root fix). Padding tightened p-8 → p-3 sm:p-4; assassin target
            picker uses 2-col on mobile / 3-col on sm+ so a 9-target table
            fits the 667px viewport without an inner overflow-y-auto. */}
        {room.state === 'discussion' && !isSpectator && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-avalon-card/50 border-2 border-red-700 rounded-lg p-3 sm:p-4 space-y-3"
          >
            {room.questHistory.length > 0 && (
              <div className="bg-gray-800/40 border border-gray-700 rounded-xl p-2">
                <p className="text-[10px] sm:text-xs text-gray-500 mb-1 font-semibold uppercase tracking-wider">{t('game:assassin.questHistoryHeader')}</p>
                <div className="space-y-1">
                  {room.questHistory.map(q => (
                    <div key={q.round} className="flex items-center gap-2 text-[11px] sm:text-xs">
                      <span className={`w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center rounded-full font-bold ${q.result === 'success' ? 'bg-blue-600 text-white' : 'bg-red-600 text-white'}`}>
                        {q.result === 'success' ? '✓' : '✗'}
                      </span>
                      <span className="text-gray-400">{t('game:assassin.roundPrefix', { round: q.round })}</span>
                      <span className="text-gray-300 truncate">{q.team.map(id => `${displaySeatNumber(seatOf(id, room.players))}家`).join('、')}</span>
                      {q.result === 'fail' && q.failCount > 0 && <span className="text-red-400 ml-1">{t('game:assassin.failBadge', { count: q.failCount })}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {currentPlayer.role === 'assassin' ? (
              <>
                <div className="text-center">
                  <h2 className="text-base sm:text-xl font-bold text-red-400 mb-1">{t('game:assassin.title')}</h2>
                  <p className="text-[11px] sm:text-xs text-gray-300">{t('game:assassin.prompt')}</p>
                  {isUnlimitedTimer ? (
                    <div className="inline-flex items-center gap-2 mt-2 px-3 py-1 rounded-full font-bold text-xs bg-blue-700 text-blue-100">
                      {t('game:teamSelect.unlimitedTimer')}
                    </div>
                  ) : (
                    <div className={`inline-flex items-center gap-2 mt-2 px-3 py-1 rounded-full font-bold text-xs ${assassinTimer < 30 ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-300'}`}>
                      {t('game:teamSelect.timer', { seconds: assassinTimer })}
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {Object.values(room.players)
                    .filter(p => p.id !== currentPlayer.id)
                    .map((player) => (
                    <button
                      key={player.id}
                      onClick={() => handleAssassinate(player.id)}
                      disabled={isAssassinating || selectedTarget !== null}
                      className={`py-2 px-2 rounded-lg border-2 transition-all font-semibold text-xs sm:text-[13px] ${
                        selectedTarget === player.id
                          ? 'bg-red-600/40 border-red-400 text-white'
                          : 'bg-avalon-evil/30 border-red-600 text-white hover:bg-avalon-evil/60 disabled:opacity-50'
                      }`}
                    >
                      {displaySeatNumber(seatOf(player.id, room.players))}家
                      {selectedTarget === player.id && ' ✓'}
                    </button>
                  ))}
                </div>
                {selectedTarget && (
                  <p className="text-center text-gray-400 text-[10px] sm:text-xs">{t('game:assassin.selectedHint')}</p>
                )}
              </>
            ) : (
              <div className="text-center space-y-2">
                <h2 className="text-base sm:text-xl font-bold text-red-400">{t('game:assassin.discussionTitle')}</h2>
                <p className="text-[11px] sm:text-xs text-gray-300">{t('game:assassin.goodWonIntro')}</p>
                <p className="text-[11px] sm:text-xs text-gray-400">{t('game:assassin.pickingTarget')}</p>
                <div className="text-[10px] sm:text-[11px] text-yellow-500 bg-yellow-900/20 border border-yellow-700 rounded-lg p-2">
                  {t('game:assassin.warning')}
                </div>
              </div>
            )}
          </motion.div>
        )}

        {/* Game Ended — Edward 2026-04-25「這個要展示角色卡 而且直接展示在
            遊戲畫面上就好 不要跳視窗出來」. Compact inline reveal panel that
            sits below the GameBoard rails (seat ring still visible) instead of
            the old modal-style cup celebration. Strict 2-col grid for role
            cards mirrors Edward's reference screenshot; container is a slim
            card so background UI stays readable and total content height fits
            inside the existing main `overflow-y-auto`. */}
        {room.state === 'ended' && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className={`rounded-lg p-3 border space-y-2 ${
              room.evilWins
                ? 'bg-avalon-evil/10 border-avalon-evil/60'
                : 'bg-avalon-good/10 border-avalon-good/60'
            }`}
          >
            {/* Slim winner header — small camp emblem + outcome chip. Replaces
                the giant cup + 5xl headline so the post-game UI no longer eats
                the viewport like a modal. */}
            <div className="flex items-center justify-center gap-2 flex-wrap">
              {/* Edward 2026-04-25 19:40 emoji→lake-disc swap: end-screen winner
                  emblem now uses the lake-yes/lake-no painted disc (blue circle
                  for good, red circle for evil) instead of the dragon/phoenix
                  shield art, matching the unified camp-icon vocabulary. */}
              <img
                src={getCampLakeIcon(room.evilWins ? 'evil' : 'good')}
                alt={room.evilWins ? t('game:ended.evilWins') : t('game:ended.goodWins')}
                className="w-6 h-6 object-cover rounded-full flex-shrink-0 drop-shadow"
                style={{ objectPosition: '50% 48%' }}
                draggable={false}
              />
              <h2 className={`text-sm sm:text-base font-bold ${room.evilWins ? 'text-red-300' : 'text-blue-300'}`}>
                {room.evilWins ? t('game:ended.evilWins') : t('game:ended.goodWins')}
              </h2>
              {room.endReason && (
                <span className={`text-[10px] sm:text-[11px] px-2 py-0.5 rounded-full font-semibold ${
                  room.evilWins ? 'bg-red-900/50 border border-red-600 text-red-200' : 'bg-blue-900/50 border border-blue-600 text-blue-200'
                }`}>
                  {room.endReason === 'failed_quests' && t('game:ended.reasonFailedQuests')}
                  {room.endReason === 'vote_rejections' && t('game:ended.reasonVoteRejections')}
                  {room.endReason === 'merlin_assassinated' && (
                    <>{t('game:ended.reasonMerlinKilledPrefix')}<span className="text-red-200 font-bold"> {room.assassinTargetId ? `${displaySeatNumber(seatOf(room.assassinTargetId, room.players))}家` : '?'} </span>{t('game:ended.reasonMerlinKilledSuffix')}</>
                  )}
                  {room.endReason === 'assassination_failed' && (
                    <>{t('game:ended.reasonWrongKillPrefix')} <span className="text-blue-200 font-bold">{room.assassinTargetId ? `${displaySeatNumber(seatOf(room.assassinTargetId, room.players))}家` : '?'}</span>{t('game:ended.reasonWrongKillSuffix')}</>
                  )}
                  {room.endReason === 'assassination_timeout' && t('game:ended.reasonAssassinationTimeout')}
                </span>
              )}
            </div>

            {room.questHistory.length > 0 && (
              <div className="flex justify-center gap-1.5 flex-wrap">
                {room.questHistory.map((q) => (
                  <div key={q.round} className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${
                    q.result === 'success' ? 'bg-blue-900/30 border-blue-600 text-blue-200' : 'bg-red-900/30 border-red-600 text-red-200'
                  }`}>
                    <span className="font-bold">R{q.round}</span>
                    <span>{q.result === 'success' ? '✓' : '✗'}</span>
                    {q.failCount > 0 && <span className="text-red-300">{t('game:ended.roundFailLabel', { count: q.failCount })}</span>}
                  </div>
                ))}
              </div>
            )}

            <p className="text-center text-[11px] font-semibold text-gray-300 pt-0.5">
              {t('game:ended.rolesReveal')}
            </p>

            <div className="grid grid-cols-2 gap-1.5">
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
                const isYou = player.id === currentPlayer.id;

                return (
                  <div
                    key={player.id}
                    className={`text-[10px] p-1.5 rounded-md border-2 ${
                      wasAssassinated
                        ? isGood
                          ? 'bg-blue-900/30 border-blue-400 ring-2 ring-red-500/70'
                          : 'bg-red-900/40 border-red-400 ring-2 ring-red-500/70'
                        : isGood
                        ? 'bg-blue-900/25 border-blue-400'
                        : 'bg-red-900/25 border-red-400'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <p className="font-bold text-white truncate flex items-center gap-1">
                        <CampDisc team={isGood ? 'good' : 'evil'} className="w-3 h-3" alt={isGood ? '正義方' : '邪惡方'} />
                        {displaySeatNumber(seatOf(player.id, room.players))}家{wasAssassinated && ' 🗡️'}
                      </p>
                      {room.eloDeltas?.[player.id] !== undefined && (
                        <span className={`text-[9px] font-bold flex-shrink-0 ${room.eloDeltas[player.id] >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
                          {room.eloDeltas[player.id] >= 0 ? '+' : ''}{room.eloDeltas[player.id]}
                        </span>
                      )}
                    </div>
                    <p className={`mt-0.5 font-semibold ${isGood ? 'text-blue-300' : 'text-red-300'}`}>
                      {roleLabel[player.role ?? ''] ?? player.role}
                      {isYou && <span className="text-gray-400 font-normal"> {t('game:ended.youLabel')}</span>}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* Vote analysis — collapsible, only shown when there's history */}
            <VoteAnalysisPanel room={room} currentPlayer={currentPlayer} />

            {/* 2026-04-25 Edward 揭曉頁底部按鈕簡化：刪「再來一局」+「返回首頁」，
                只留「返回房間」回 lobby waiting room；要回首頁的玩家從 LobbyPage
                右上角既有 leaveRoom 走。 */}
            <div className="flex items-center justify-center gap-2 flex-wrap pt-1">
              <motion.button
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.96 }}
                onClick={handleBackToRoom}
                className="flex items-center gap-1.5 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white text-xs sm:text-[13px] font-bold py-2 px-5 rounded-md transition-all"
              >
                <DoorOpen size={16} />
                {t('game:ended.backToRoom')}
              </motion.button>
            </div>
          </motion.div>
        )}
        </GameBoard>
      </div>

      {/* #83 Phase 5 — chat docks inline inside GameBoard center column via
          `chatSlot`, so no floating ChatPanel here during active game. If you
          land on GamePage in the lobby state (shouldn't happen, but defensive),
          render the floating launcher so players still have chat access. */}
      {room.state === 'lobby' && (
        <ChatPanel roomId={room.id} currentPlayerId={currentPlayer.id} />
      )}

      {/*
        #83 Phase 1 — Leader team-select toolbar. Renders sticky at the bottom only when
        the leader is currently picking a team; auto-unmounts when the server confirms
        the questTeam or when AFK auto-fill fires.
      */}
      <AnimatePresence>
        {isLeaderPicking && (
          <QuestTeamToolbar
            key="quest-team-toolbar"
            room={room}
            selectedTeamIds={selectedTeamIds}
            onClear={clearSelectedTeam}
            isSubmitting={isVoting}
            timer={teamSelectTimer}
            timerTotal={teamSelectBase}
          />
        )}
      </AnimatePresence>

      {/*
        #107 Edward 2026-04-25 — sticky-bottom inline VotePanel for the team
        proposal vote ("黑白球"). Replaces the old center-column modal-style
        VotePanel so the screen stops scrolling up/down on every phase.
      */}
      <AnimatePresence>
        {teamVotePhaseSticky && (
          <VotePanel
            key="vote-panel-sticky"
            room={room}
            currentPlayer={currentPlayer}
            onVote={handleVote}
            isLoading={isVoting}
          />
        )}
      </AnimatePresence>

      {/*
        #107 Edward 2026-04-25 — sticky-bottom inline QuestPanel for the
        mission vote. Renders for every player in the quest phase: team
        members get the Success/Fail buttons; bystanders get a thin progress
        strip ("X/N voted"). Both modes are docked at the bottom so the
        viewport doesn't shift.
      */}
      <AnimatePresence>
        {questPhaseSticky && (
          <QuestPanel
            key="quest-panel-sticky"
            room={room}
            currentPlayer={currentPlayer}
          />
        )}
      </AnimatePresence>

      {/*
        2026-04-24 Edward: persistent night-info / role panel removed — the
        "view role" header button (line ~349) already reopens RoleRevealModal
        on demand, so the always-on corner panel was redundant and cluttered
        the viewport. Keep the modal as the single source of truth for role
        details + night info.
      */}
    </div>
  );
}
