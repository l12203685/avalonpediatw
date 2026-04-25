import { Player, Role } from '@avalon/shared';
import { motion } from 'framer-motion';
import { Crown, Shield, WifiOff, Droplet } from 'lucide-react';
import { displaySeatNumber } from '../utils/seatDisplay';
import RoleAvatar from './RoleAvatar';

const ROLE_NAMES: Record<string, string> = {
  merlin:   '梅林 (Merlin)',
  percival: '派西維爾 (Percival)',
  loyal:    '忠臣 (Loyal Servant)',
  assassin: '刺客 (Assassin)',
  morgana:  '莫甘娜 (Morgana)',
  oberon:   '奧伯倫 (Oberon)',
  mordred:  '莫德雷德 (Mordred)',
  minion:   '爪牙 (Minion)',
};

interface PlayerCardProps {
  player: Player;
  isCurrentPlayer: boolean;
  hasVoted: boolean;
  voted?: boolean;
  isLeader?: boolean;
  isOnQuestTeam?: boolean;
  /** 1-indexed seat number shown as a gold badge on the avatar. */
  seatNumber?: number;
  /** Direction the card leans — affects inner flex order for the 5v5 rail layout. */
  side?: 'left' | 'right';
  /** Pulses a ring around this player when it's their turn to act. */
  isActiveTurn?: boolean;
  /**
   * Team-selection shield props — active only while the leader is picking a quest team.
   * When `isShieldCandidate` is true, the card becomes clickable and surfaces a dim
   * outline shield to signal "tap to add". When `shieldSelected` is true, a big solid
   * 黃盾 overlay dominates the avatar so the leader can see the active pick at a glance.
   */
  isShieldCandidate?: boolean;
  shieldSelected?: boolean;
  onShieldClick?: (playerId: string) => void;
  /**
   * Lady of the Lake holder — render a 💧 (Droplet) icon on the avatar so every
   * player can spot the holder at a glance during the lady_of_the_lake phase
   * (Edward 2026-04-25 redesign: 重點是玩家座位號碼&任務牌&湖中女神&黑白球).
   */
  isLadyHolder?: boolean;
  /**
   * Last completed quest result for this player — shows a small mission card
   * badge (success = 藍 O, fail = 紅 X) when the player participated in the
   * most recent quest. `undefined` = player did not participate (no badge).
   */
  lastQuestResult?: 'success' | 'fail';
}

export default function PlayerCard({
  player,
  isCurrentPlayer,
  hasVoted,
  voted,
  isLeader = false,
  isOnQuestTeam = false,
  seatNumber,
  side = 'left',
  isActiveTurn = false,
  isShieldCandidate = false,
  shieldSelected = false,
  onShieldClick,
  isLadyHolder = false,
  lastQuestResult,
}: PlayerCardProps): JSX.Element {
  // Horizontal row layout: left side → avatar on right edge (info-left), right side → avatar on left edge (info-right)
  const rowDirection = side === 'left' ? 'flex-row' : 'flex-row-reverse';
  const textAlign = side === 'left' ? 'text-right items-end' : 'text-left items-start';

  // Shield click wiring: leader picking a quest team. Only clickable when this card is a
  // candidate (plan #83 Phase 1 swap from center modal → rail-click + bottom toolbar).
  const isShieldInteractive = isShieldCandidate && typeof onShieldClick === 'function';
  const handleShieldClick = (): void => {
    if (isShieldInteractive) {
      onShieldClick?.(player.id);
    }
  };

  return (
    <motion.div
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      onClick={isShieldInteractive ? handleShieldClick : undefined}
      role={isShieldInteractive ? 'button' : undefined}
      aria-pressed={isShieldInteractive ? shieldSelected : undefined}
      tabIndex={isShieldInteractive ? 0 : undefined}
      onKeyDown={
        isShieldInteractive
          ? (event): void => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleShieldClick();
              }
            }
          : undefined
      }
      className={`relative flex ${rowDirection} items-center gap-2 w-full px-2 py-1.5 rounded-lg transition-colors ${
        shieldSelected
          ? 'bg-yellow-500/25 ring-2 ring-yellow-400 shadow-md shadow-yellow-400/30'
          : isActiveTurn
          ? 'bg-amber-500/20 ring-2 ring-amber-400 shadow-md shadow-amber-400/30'
          : isCurrentPlayer
          ? 'bg-yellow-500/10 ring-1 ring-yellow-400/60'
          : 'hover:bg-white/5'
      } ${isShieldInteractive ? 'cursor-pointer' : ''}`}
    >
      {/* Pulsing halo around the active-turn player so everyone can see whose move it is */}
      {isActiveTurn && (
        <motion.span
          aria-hidden="true"
          initial={{ opacity: 0.5, scale: 1 }}
          animate={{ opacity: [0.5, 0, 0.5], scale: [1, 1.04, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          className="pointer-events-none absolute inset-0 rounded-lg ring-2 ring-amber-300"
        />
      )}
      {/*
        Avatar — Edward 2026-04-25 redesign: name + seat number + game-state
        indicators (mission card / 湖中女神 / 黑白球) live inside the avatar so
        the rail surfaces every status at a glance, not as outer labels.

        Layout (top → bottom inside the circle):
          ┌────────────────────────┐
          │ [N] (seat — top-left)  │  ← seat badge dominates
          │   (avatar bg)          │
          │   ╭────────╮           │
          │   │ name   │ (overlay) │  ← player name strip on bottom 35%
          │   ╰────────╯           │
          └────────────────────────┘
        Outer overlays (corners):
          - top-center:    Crown (leader)
          - top-right:     Shield (on quest team)
          - bottom-left:   WifiOff (disconnected)
          - bottom-right:  Vote ball (黑/白 + / - 標記)
          - center-overlay: Droplet (lady holder) when active
          - top-left big:  last-quest result badge (O / X)
      */}
      <div className="relative flex-shrink-0">
        <motion.div
          className={`w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center font-bold text-sm sm:text-base border-[3px] transition-all relative overflow-hidden ${
            player.status === 'disconnected'
              ? 'border-gray-600 bg-gradient-to-br from-gray-600 to-gray-700 opacity-50'
              : isCurrentPlayer
              ? 'border-yellow-400 bg-gradient-to-br from-yellow-400 to-yellow-500 shadow-lg shadow-yellow-400/50'
              : player.team === 'evil'
              ? 'border-red-500 bg-gradient-to-br from-red-500 to-red-700'
              : player.team === 'good'
              ? 'border-blue-500 bg-gradient-to-br from-blue-500 to-blue-700'
              : player.isBot
              ? 'border-slate-500 bg-gradient-to-br from-slate-600 to-slate-800'
              : 'border-gray-500 bg-gradient-to-br from-slate-500 to-slate-700'
          }`}
        >
          {/* Avatar background — image or emoji fallback. Sized smaller and shifted up so
              the name strip on the bottom 35% has room. */}
          <div className="absolute inset-0 flex items-start justify-center pt-1">
            {player.isBot ? (
              <span className="text-2xl sm:text-3xl leading-none">🤖</span>
            ) : player.avatar ? (
              <img
                src={player.avatar}
                alt={player.name}
                className="w-9 h-9 sm:w-10 sm:h-10 rounded-full object-cover"
              />
            ) : (
              <span className="text-base sm:text-lg leading-none mt-1.5 text-white drop-shadow">
                {player.name.charAt(0).toUpperCase()}
              </span>
            )}
          </div>

          {/* Player name strip — bottom 35% of the circle, semi-transparent dark
              backing so the white text reads regardless of avatar color. Edward
              2026-04-25: 「玩家名字直接顯示在圓圈裡面」. */}
          <div className="absolute bottom-0 inset-x-0 bg-black/65 backdrop-blur-[1px] px-0.5 py-0.5">
            <p
              className={`text-center font-bold leading-tight truncate text-[9px] sm:text-[10px] ${
                player.status === 'disconnected' ? 'text-gray-400' : 'text-white'
              }`}
            >
              {player.name}
            </p>
          </div>
        </motion.div>

        {/*
          Seat number badge — top-left corner. Edward 2026-04-25 spec calls
          out "玩家座位號碼" as a key indicator, so the badge is enlarged
          (6→7 mobile / 8 desktop) and uses gold-on-black to dominate the
          card silhouette. Seat 10 renders as "0" per paper-scoresheet
          convention (#93).
        */}
        {seatNumber !== undefined && (
          <div
            className="absolute -top-1.5 -left-1.5 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-gradient-to-br from-yellow-300 to-yellow-500 border-2 border-yellow-700 flex items-center justify-center shadow-lg pointer-events-none z-10"
            aria-label={`座位 ${seatNumber}`}
          >
            <span className="text-[12px] sm:text-[14px] font-black text-black leading-none">
              {displaySeatNumber(seatNumber)}
            </span>
          </div>
        )}

        {/*
          Last-quest result badge — top-right corner (replaces the small
          "on-quest" shield when a quest result exists). Blue O = success,
          red X = fail. Only shown when this player participated in the
          most recent completed quest (Edward 2026-04-25 「任務牌」).
        */}
        {lastQuestResult !== undefined && (
          <motion.div
            initial={{ scale: 0, rotate: -10 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 22 }}
            className={`absolute -top-1.5 -right-1.5 w-6 h-6 sm:w-7 sm:h-7 rounded-md flex items-center justify-center pointer-events-none shadow-md z-10 border-2 ${
              lastQuestResult === 'success'
                ? 'bg-blue-500 border-blue-200 text-white'
                : 'bg-red-600 border-red-200 text-white'
            }`}
            aria-label={lastQuestResult === 'success' ? '最近任務成功' : '最近任務失敗'}
          >
            <span className="text-[14px] sm:text-[16px] font-black leading-none">
              {lastQuestResult === 'success' ? 'O' : 'X'}
            </span>
          </motion.div>
        )}

        {/* Leader crown — top center above avatar (only when no quest result badge
            in the same corner so they don't collide; crown sits center-top and
            won't fight the top-right quest badge). */}
        {isLeader && (
          <motion.div
            initial={{ scale: 0, y: -5 }}
            animate={{ scale: 1, y: 0 }}
            className="absolute -top-3 left-1/2 -translate-x-1/2 pointer-events-none z-20"
          >
            <Crown size={16} className="text-yellow-400 drop-shadow-md" />
          </motion.div>
        )}

        {/* Quest team shield — only render the small gold shield when there's no
            last-quest badge competing for the top-right corner. */}
        {isOnQuestTeam && !shieldSelected && lastQuestResult === undefined && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -top-1 -right-1 bg-yellow-400 border border-yellow-600 rounded-full p-0.5 pointer-events-none shadow-md z-10"
            aria-label="任務隊員"
          >
            <Shield size={12} className="text-yellow-900" fill="currentColor" />
          </motion.div>
        )}

        {/*
          Team-select shield overlay — plan #83 Phase 1.
          - `shieldSelected` → big solid 黃盾 (28px) sitting on the top-right quadrant so the
            leader spots selected players instantly across the rail.
          - `isShieldCandidate && !shieldSelected` → dim outline shield hinting "tap to add".
          The two are mutually exclusive; once picked, the solid overlay takes over.
        */}
        {shieldSelected && (
          <motion.div
            initial={{ scale: 0, rotate: -12 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 22 }}
            className="absolute -top-1.5 -right-1.5 pointer-events-none drop-shadow-[0_2px_4px_rgba(250,204,21,0.55)] z-20"
            aria-label="已選入任務隊伍"
          >
            <Shield
              size={30}
              className="text-yellow-400"
              fill="#facc15"
              strokeWidth={2}
            />
          </motion.div>
        )}
        {isShieldCandidate && !shieldSelected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.55 }}
            className="absolute -top-1.5 -right-1.5 pointer-events-none z-10"
            aria-hidden="true"
          >
            <Shield
              size={26}
              className="text-yellow-300/70"
              strokeWidth={2}
            />
          </motion.div>
        )}

        {/*
          Lady of the Lake holder — Droplet 💧 overlay center-left of the
          avatar. Cyan tint matches the scoresheet legend. Edward 2026-04-25
          「湖中女神」.
        */}
        {isLadyHolder && (
          <motion.div
            initial={{ scale: 0, rotate: -8 }}
            animate={{ scale: 1, rotate: 0 }}
            className="absolute top-1/2 -left-2 -translate-y-1/2 bg-cyan-500 border-2 border-cyan-200 rounded-full p-0.5 pointer-events-none shadow-md z-10"
            aria-label="持有湖中女神"
          >
            <Droplet size={12} className="text-white" fill="currentColor" />
          </motion.div>
        )}

        {/* Disconnected marker — bottom-left */}
        {player.status === 'disconnected' && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -bottom-1 -left-1 bg-red-700 rounded-full p-0.5 pointer-events-none z-10"
          >
            <WifiOff size={10} className="text-white" />
          </motion.div>
        )}

        {/*
          Vote ball — bottom-right. Edward 2026-04-25「黑白球」+ visible
          + / − symbols so the marker is unambiguous even at small sizes:
            白球 + 黑 "+"  → 贊成
            黑球 + 白 "−"  → 反對
            灰球 + "?"    → 已投但對外隱藏
        */}
        {hasVoted && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className={`absolute -bottom-1.5 -right-1.5 w-5 h-5 sm:w-6 sm:h-6 rounded-full pointer-events-none shadow-md flex items-center justify-center font-black leading-none text-[12px] sm:text-[14px] z-10 border-2 ${
              voted === undefined
                ? 'bg-gray-500 border-gray-300 text-gray-200'
                : voted
                ? 'bg-white border-gray-300 text-black'
                : 'bg-gray-900 border-gray-700 text-white'
            }`}
            aria-label={voted === undefined ? '已投票' : voted ? '贊成' : '反對'}
          >
            {voted === undefined ? '?' : voted ? '+' : '−'}
          </motion.div>
        )}
      </div>

      {/*
        Side info — name moved INTO the avatar (Edward 2026-04-25), so the
        outer column shrinks to "own role only". Other players show no
        outer text; the avatar alone carries identity + state. Keeps the
        rail width tight on mobile.
      */}
      <div className={`flex-1 min-w-0 flex flex-col gap-0.5 ${textAlign}`}>
        {/* Show own role + team inline — only the viewer sees their own role badge
            so they can scan it at a glance. Other players' names already appear
            inside their avatar circle, so no outer label is needed. */}
        {isCurrentPlayer && player.role && (
          <div className={`flex flex-wrap items-center gap-1 ${side === 'left' ? 'justify-end' : 'justify-start'}`}>
            <RoleAvatar role={player.role as Role} size="sm" />
            <span className="text-[9px] sm:text-[10px] font-semibold bg-yellow-600/90 text-white px-1.5 py-0.5 rounded-full whitespace-nowrap shadow-sm">
              {ROLE_NAMES[player.role] ?? player.role}
            </span>
            {player.team && (
              <span
                className={`text-[9px] sm:text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                  player.team === 'good'
                    ? 'bg-blue-600/80 text-white'
                    : 'bg-red-600/80 text-white'
                }`}
              >
                {player.team === 'good' ? '⚔️ 好人' : '👹 邪惡'}
              </span>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
