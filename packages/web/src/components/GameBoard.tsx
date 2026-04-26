import { Room, Player } from '@avalon/shared';
import PlayerCard from './PlayerCard';
import { motion } from 'framer-motion';
import audioService from '../services/audio';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface GameBoardProps {
  room: Room;
  currentPlayer: Player;
  /** Content rendered in the center column (quest/vote/history panels). */
  children?: ReactNode;
  /**
   * #83 Phase 5 — chat + scoresheet slots for the center-column 2-col layout.
   * When both are provided, the center column renders:
   *   state banner → {children} (phase panel) → [chatSlot | scoresheetSlot]
   * On `lg:` screens the pair sits side-by-side (chat=flex-1, scoresheet=320px);
   * on mobile/tablet they stack vertically (chat first with a min-height). When
   * either slot is omitted the component falls back to the pre-Phase-5 layout
   * (just children under the banner) so GameBoard stays backward-compatible.
   */
  chatSlot?: ReactNode;
  scoresheetSlot?: ReactNode;
  /**
   * Leader team-selection wiring (#83 Phase 1). When `isPicking` is true, every
   * rail `PlayerCard` becomes a shield candidate; clicking toggles membership in
   * `selectedTeamIds` via `onSeatClick`.
   */
  isPicking?: boolean;
  selectedTeamIds?: Set<string>;
  onSeatClick?: (playerId: string) => void;
  /**
   * 忠臣視角 toggle (#107 Edward 2026-04-25 right-top eye icon revamp). When true,
   * every PlayerCard suppresses role / team reveals — own role badge, evil/good
   * team gradient borders, painted role avatars — so the viewer is forced into a
   * loyal-only blind. UI-only filter; server still emits the canonical room.
   */
  loyalView?: boolean;
  /**
   * Edward 2026-04-25 23:39 unified Lobby+Game layout. When true, the rails
   * render in lobby/waiting mode:
   *   - PlayerCard `variant='lobby'` (taller portrait tile)
   *   - No leader / vote / quest indicators (those props zeroed out internally)
   *   - Per-player overlay slot enabled (host's kick-X + ready badge)
   * Defaults to false so in-game rails behave exactly as before.
   */
  lobbyMode?: boolean;
  /**
   * Optional per-player overlay renderer used in `lobbyMode`. Receives the player
   * + seat metadata and returns absolute-positioned corner UI (kick-X, ready
   * badge). Wrapped around each PlayerCard so the rail layout itself stays
   * identical between lobby and game phases.
   */
  renderPlayerOverlay?: (
    player: Player,
    seatIndex: number,
    side: 'left' | 'right'
  ) => ReactNode;
}

/**
 * 5v5 rails layout — clockwise seating (Edward 2026-04-21 revision, #93).
 *   ┌──────────────┬──────────────────────┬──────────────┐
 *   │ left rail    │   center (children)  │ right rail   │
 *   │ seats N..N/2 │   quest + history    │ seats 1..N/2 │
 *   │ (top=N)      │   + chat            │ (top=1)      │
 *   └──────────────┴──────────────────────┴──────────────┘
 * Right column runs 1→splitIndex top-to-bottom. Left column runs N→splitIndex+1
 * top-to-bottom (i.e. slice(splitIndex).reverse()). The visual rotation is
 * clockwise so a 10-player room reads: 1 top-right, down to 5 bottom-right,
 * wraps to 6 bottom-left, up to 10 top-left — matching physical table convention.
 *
 * Seat numbers stay locked to the original `playerIds` order (the server's
 * canonical seating). `seatIndex` passed to `renderPlayerCard` is the original
 * 0-based index, so `seat 10` always renders as `seatNumber={10}` regardless of
 * which rail it lives in after the reverse.
 *
 * Desktop: three columns (~210px | flex-1 | ~210px).
 * Mobile (<768px): two vertical rails side-by-side (1fr | 1fr), center column wraps
 *   below spanning both columns. No horizontal scroll — every seat visible at once.
 */
export default function GameBoard({
  room,
  currentPlayer,
  children,
  chatSlot,
  scoresheetSlot,
  isPicking = false,
  selectedTeamIds,
  onSeatClick,
  loyalView = false,
  lobbyMode = false,
  renderPlayerOverlay,
}: GameBoardProps): JSX.Element {
  const { t } = useTranslation('game');
  const players = Object.values(room.players);
  const playerIds = Object.keys(room.players);
  const leaderId = playerIds[room.leaderIndex % playerIds.length];

  // Split players into right (seats 1..splitIndex, top-to-bottom) and left
  // (seats splitIndex+1..N, reversed so highest seat sits on top). Ceil puts the
  // extra player on the RIGHT for odd counts so 5v5 lines up: 5→3+2, 6→3+3,
  // 7→4+3, 8→4+4, 9→5+4, 10→5+5.
  //
  // Each rail item carries the ORIGINAL seatIndex (0-based position in
  // `playerIds`). That keeps `seatNumber` stable through the reverse, so seat
  // 10 renders as 10 even though it sits at the top of the left rail visually.
  const splitIndex = Math.ceil(players.length / 2);
  const rightRail = players
    .slice(0, splitIndex)
    .map((player, i) => ({ player, seatIndex: i }));
  const leftRail = players
    .slice(splitIndex)
    .map((player, i) => ({ player, seatIndex: splitIndex + i }))
    .reverse();

  // Play sound on state change
  useEffect(() => {
    try {
      if (room.state === 'voting') {
        audioService.playSound('vote');
      } else if (room.state === 'quest') {
        audioService.playSound('game-start');
      } else if (room.state === 'ended') {
        if (room.evilWins) {
          audioService.playFailureSound();
        } else {
          audioService.playSuccessChord();
        }
      }
    } catch (error) {
      // Silently fail - audio is not critical to gameplay
      console.warn('Failed to play game sound:', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [room.state, room.evilWins]);

  // Determine whose turn it currently is, so the UI can draw a pulsing ring on their card.
  // Rules (match the game engine's phase semantics):
  //   • voting + empty team → leader is picking
  //   • voting + team set   → everyone who hasn't voted yet is acting
  //   • quest               → quest team members who haven't submitted
  //   • lady_of_the_lake    → holder of the Lady
  //   • discussion          → the Assassin
  const teamSelected = room.questTeam.length > 0;
  const isActiveTurn = (playerId: string): boolean => {
    if (room.state === 'voting' && !teamSelected) return playerId === leaderId;
    if (room.state === 'voting' && teamSelected) return room.votes[playerId] === undefined;
    if (room.state === 'quest') return room.questTeam.includes(playerId);
    if (room.state === 'lady_of_the_lake') return playerId === room.ladyOfTheLakeHolder;
    if (room.state === 'discussion') {
      // Only the assassin acts, but we don't always know their id client-side —
      // the server reveals the role to the assassin themselves, and others see
      // the generic "assassin is choosing" banner, so leaving this as no-ring
      // is safe for non-assassins.
      const role = room.players[playerId]?.role;
      return role === 'assassin';
    }
    return false;
  };

  // Edward 2026-04-25 redesign: compute "last quest result" lookup so each
  // PlayerCard can flash a 任務牌 (success O / fail X) badge when this player
  // participated in the most recent completed quest. Only the latest quest
  // counts — past rounds are visible in the scoresheet / mission track.
  // Edward 21:52 #7 corrected: PlayerCard 收的 prop 改成
  // `lastQuestParticipation: 'success' | 'fail' | null`，這裡 null 明示「該玩家
  // 沒參與最後任務 → 不顯示盾」（之前 undefined 也行得通，但 null 更明確）。
  const lastQuestRecord = room.questHistory.length > 0
    ? room.questHistory[room.questHistory.length - 1]
    : undefined;
  const lastQuestParticipants = new Set<string>(lastQuestRecord?.team ?? []);
  const lastQuestResult: 'success' | 'fail' | undefined = lastQuestRecord?.result;

  // Edward 2026-04-25 21:59「PlayerCard 黑白球常態保留」— last completed
  // team-vote outcomes per player. Server clears `room.votes = {}` on phase
  // transitions, so we read the persistent record from `room.voteHistory`.
  // PlayerCard renders the persistent token only when NOT currently in a
  // voting round (the in-flight `hasVoted`/`voted` props take precedence).
  const lastCompletedVote = room.voteHistory.length > 0
    ? room.voteHistory[room.voteHistory.length - 1]
    : undefined;
  const lastVotePerPlayer: Record<string, boolean> = lastCompletedVote?.votes ?? {};

  // Edward 2026-04-25 22:04 game-end role-label — 砍 GamePage inline reveal
  // panel 後 PlayerCard 自帶角色名 chip. 只在 room.state === 'ended' 派發,
  // gameplay 中不傳 (chip 不渲染). i18n 字典已在 game.json roleLabel.* 預先
  // 寫好 8 個角色 + unknown 兜底.
  const isGameEnded = room.state === 'ended';
  const resolveRoleLabel = (role: string | null | undefined): string | undefined => {
    if (!role) return undefined;
    return t(`roleLabel.${role}`, { defaultValue: t('roleLabel.unknown', { defaultValue: '未知' }) });
  };

  const renderPlayerCard = (player: Player, seatIndex: number, side: 'left' | 'right'): JSX.Element => {
    const shieldSelected = Boolean(selectedTeamIds?.has(player.id));
    // All seats are valid picks (including leader's own seat — canonical Avalon allows
    // the leader to include themselves). We hand the click handler down only when in
    // picking mode so normal gameplay ignores the shield layer.
    const isShieldCandidate = isPicking && !lobbyMode;
    // Edward 2026-04-25 23:39 lobby unified layout — when rendering for the
    // waiting room, zero out every game-phase indicator so the same rails can
    // host both `lobby` (settings) and `playing/ended` (mission state) rooms
    // without leaking stale data through the prop boundary.
    const overlay = renderPlayerOverlay?.(player, seatIndex, side);
    return (
      <motion.div
        key={player.id}
        initial={{ opacity: 0, x: side === 'left' ? -20 : 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: seatIndex * 0.05 }}
        className={overlay ? 'relative' : undefined}
      >
        <PlayerCard
          player={player}
          isCurrentPlayer={player.id === currentPlayer.id}
          hasVoted={lobbyMode ? false : room.votes[player.id] !== undefined}
          // During voting, only reveal own vote direction; others show as undefined (just "has voted")
          voted={
            lobbyMode
              ? undefined
              : room.state === 'voting' && player.id !== currentPlayer.id
              ? undefined
              : room.votes[player.id]
          }
          // Edward 2026-04-25 21:59「黑白球常態保留」— pass the player's last
          // completed vote so PlayerCard renders the persistent token in
          // non-voting phases. Only meaningful when NOT in voting state and
          // when the player has a historical vote on record.
          lastVoteApproved={
            lobbyMode
              ? undefined
              : room.state === 'voting'
              ? undefined
              : Object.prototype.hasOwnProperty.call(lastVotePerPlayer, player.id)
              ? lastVotePerPlayer[player.id]
              : undefined
          }
          isLeader={!lobbyMode && player.id === leaderId}
          isOnQuestTeam={!lobbyMode && room.questTeam.includes(player.id)}
          seatNumber={seatIndex + 1}
          side={side}
          isActiveTurn={!lobbyMode && isActiveTurn(player.id)}
          isShieldCandidate={isShieldCandidate}
          shieldSelected={shieldSelected}
          onShieldClick={isPicking && !lobbyMode ? onSeatClick : undefined}
          isLadyHolder={!lobbyMode && room.ladyOfTheLakeHolder === player.id}
          lastQuestParticipation={
            lobbyMode
              ? undefined
              : lastQuestRecord === undefined
              ? undefined
              : lastQuestParticipants.has(player.id)
              ? lastQuestResult ?? null
              : null
          }
          loyalView={loyalView}
          // Edward 2026-04-25 22:04 — game-end 角色名 chip + 刺殺標記;
          // gameplay 中傳 undefined / false 維持 portrait 乾淨。
          endGameRoleLabel={!lobbyMode && isGameEnded ? resolveRoleLabel(player.role) : undefined}
          assassinated={!lobbyMode && isGameEnded && room.assassinTargetId === player.id}
          // Edward 2026-04-25 22:38 GamePage 3-fix #3「你的投票/任務盾/湖中女神
          // 都只有最後開牌才顯示, 遊戲過程中只有未知身分牌背」: hide tracker
          // chips on the viewer's OWN tile until the game ends. Other players'
          // tiles stay untouched (their tracker info is public Avalon state).
          selfTrackerHidden={!lobbyMode && player.id === currentPlayer.id && !isGameEnded}
          variant={lobbyMode ? 'lobby' : 'game'}
        />
        {overlay}
      </motion.div>
    );
  };

  // #83 Phase 5 — chat + scoresheet 2-col block. Rendered below `children` in
  // both desktop and mobile center columns when both slots are provided.
  //
  // Edward 2026-04-25 holistic redesign (matching LobbyPage commit df6b5726):
  // GameBoard now lives inside a `flex-1 min-h-0` parent so the center column
  // owns its own viewport-bound scroll. The chat slot needs `flex-1 min-h-0`
  // so it fills remaining vertical space without pushing the page; scoresheet
  // stays `auto` height because it's a compact recap.
  // Edward 2026-04-26 18:29 spec 4「對話框變長」: 給 chat 更多 vertical 空間,
  // mobile min-height 200px → 360px, 並加 grow priority 讓 chat 在 center column
  // 吃 lebih remaining space. Scoresheet (若有) 仍保持 auto/fixed-width 不擠.
  const centerExtras = (chatSlot || scoresheetSlot) ? (
    <div className="flex flex-col lg:flex-row gap-3 flex-1 min-h-0">
      {chatSlot && (
        <div className="flex-1 min-h-[360px] lg:min-h-0 flex flex-col">
          {chatSlot}
        </div>
      )}
      {scoresheetSlot && (
        <div className="lg:w-[320px] lg:flex-shrink-0 lg:min-h-0 lg:overflow-y-auto">
          {scoresheetSlot}
        </div>
      )}
    </div>
  ) : null;

  // Edward 2026-04-25 18:28 — Direct port of LobbyPage main grid (commit
  // df6b5726 verified single-viewport). Replaces the previous `md:grid` /
  // `md:hidden` dual layout (which stacked rails on top of center on mobile
  // and pushed content past 100dvh) with the SAME 3-col grid LobbyPage uses
  // at every breakpoint:
  //   gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2.5fr) minmax(0, 1fr)'
  // Each rail owns its own overflow-y-auto + min-h-0 so player columns never
  // grow the page; center section also owns its own scroll for phase panels.
  return (
    <main
      className="grid gap-1 sm:gap-3 lg:gap-4 flex-1 min-h-0 px-1"
      style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2.5fr) minmax(0, 1fr)' }}
    >
      {/* Left player rail — seats N..splitIndex+1 top-to-bottom (clockwise wrap) */}
      <aside className="flex flex-col gap-1 sm:gap-2 bg-avalon-card/30 border border-gray-700/60 rounded-lg sm:rounded-xl p-1 sm:p-2 overflow-y-auto min-h-0 min-w-0">
        {leftRail.map(({ player, seatIndex }) => renderPlayerCard(player, seatIndex, 'left'))}
      </aside>

      {/* Center — children (quest/vote/history) + chat/scoresheet slots
          Edward 2026-04-25 19:56「上面要有一大塊空白」根因：center-column 頂部
          原有 state banner（大字「投票中」+ X/N 已投票）與 GamePage header 的
          actionBanner / MissionTrack 雙重指示 phase，多一條重複橫條 = 上方空白
          + 推擠 children。砍 banner，actionBanner / MissionTrack 已足以指示
          狀態。對齊 Edward 之前砍 currentActorLabel / goodCount/evilCount strip
          的「上方排版太佔空間」一致原則。 */}
      <section className="flex flex-col gap-2 sm:gap-3 min-w-0 min-h-0 overflow-y-auto">
        {children}
        {centerExtras}
      </section>

      {/* Right player rail — seats 1..splitIndex top-to-bottom (clockwise start) */}
      <aside className="flex flex-col gap-1 sm:gap-2 bg-avalon-card/30 border border-gray-700/60 rounded-lg sm:rounded-xl p-1 sm:p-2 overflow-y-auto min-h-0 min-w-0">
        {rightRail.map(({ player, seatIndex }) => renderPlayerCard(player, seatIndex, 'right'))}
      </aside>
    </main>
  );
}
