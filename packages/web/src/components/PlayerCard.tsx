import { useEffect, useState } from 'react';
import { Player, Role } from '@avalon/shared';
import { motion, AnimatePresence } from 'framer-motion';
import { WifiOff } from 'lucide-react';
import { displaySeatNumber } from '../utils/seatDisplay';
import {
  pickAvatarUrl,
  getLakeImage,
  getLeaderCrownUrl,
  getMissionShieldUrl,
  getRoleBackUrl,
  getVoteBackUrl,
  VOTE_IMAGES,
} from '../utils/avalonAssets';
import { useChatStore } from '../store/chatStore';

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
  /**
   * 忠臣視角 (#107 Edward 2026-04-25 right-top eye toggle). When true:
   *   - Self & others render as a generic loyal silhouette: avatar uses the
   *     unknown / 雜魚 portrait, border drops the team-coloured gradient.
   *   - Own inline role badge (RoleAvatar + 角色名 + 陣營 chip) is hidden.
   * Server data isn't mutated — it's a UI-only blindfold so the viewer is
   * forced to read public behaviour like a vanilla 忠臣. Toggling off restores
   * the original reveals immediately.
   */
  loyalView?: boolean;
}

/**
 * PlayerCard — Edward 2026-04-25 20:09 + 20:12 corrected 4-corner spec.
 *
 * Square tile (`aspect-square`) where the portrait fills the whole tile as a
 * `background-image` and four corners surface game state via painted icons.
 * No role / camp text overlay — the avatar carries identity by itself.
 *
 *   ┌────────────────────────────┐
 *   │ [N家]      [👑王冠]   [湖]  │  ← TL: seat#, TC: leader crown, TR: lake holder
 *   │   (full-square portrait    │
 *   │    bg-cover, no overlay    │
 *   │    role/camp text)         │
 *   │                            │
 *   │ [球]                  [盾] │  ← BL: vote token, BR: mission shield
 *   └────────────────────────────┘
 *
 * Edward 20:09 corner config (verbatim):
 *   - 左上: 玩家號碼 (1家, 2家, ...)
 *   - 正上: 隊長王冠 (`leader-crown.jpg`)
 *   - 右上: 湖中 (`lake.jpg` — 只有湖中女神持有者才顯示)
 *   - 左下: 黑白球 (`vote-back.jpg` / `vote-yes.jpg` / `vote-no.jpg`)
 *   - 右下: 任務盾牌 (`mission-shield.jpg`)
 *   - 中: 大頭照 portrait (full square)
 *
 * Edward 20:12 add-ons:
 *   - PlayerCard = square aspect (already enforced via `aspect-square w-full`).
 *   - 未揭角色 (`effectiveRole === null`) → 整 tile bg 用 `role-back.jpg` 取代
 *     大頭，且**隱藏 corner indicators (除了 seat 號碼)**。所以 role-back tile
 *     上看不到王冠 / 湖 / 球 / 盾，只有座位號碼 + 名字 + 斷線旗 (狀態旗為避免
 *     遊戲性遺失，仍保留 disconnected 半透明 dim — 與 corner indicator 不同類)。
 *
 * Replaced overlays (carry-over from 20:05 rewrite, still applies):
 *   - 中央「否決 / 通過」popup (VoteRevealOverlay) → vote ball (左下)
 *   - 右上角任務 banner (QuestResultOverlay) → mission shield (右下)
 *
 * Asset registry: see `utils/avalonAssets.ts` — `getLeaderCrownUrl`,
 * `getMissionShieldUrl`, `getVoteBackUrl`, `getRoleBackUrl`, `getLakeImage`.
 */

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
  loyalView = false,
}: PlayerCardProps): JSX.Element {
  // 忠臣視角 — derive the displayed role for the bg portrait. We never mutate
  // the player prop; we just compute the view-only role used to pick avatar
  // art. `effectiveRole === null` forces pickAvatarUrl to return the generic
  // 雜魚 silhouette so loyal-view collapses to the same UI as unknown roles.
  const effectiveRole = loyalView ? null : (player.role ?? null);
  const effectiveTeam = loyalView ? null : (player.team ?? null);

  // Edward 2026-04-25 19:40 — chat bubble overlay below the PlayerCard.
  // Subscribes only to this player's latest entry so updates for other
  // players don't re-render this card. Bubble fades out after 5s using a
  // local boolean toggled by setTimeout; the timer resets whenever a fresh
  // message arrives (timestamp change).
  const latestEntry = useChatStore((s) => s.latestByPlayer[player.id]);
  const [showBubble, setShowBubble] = useState(false);
  useEffect(() => {
    if (!latestEntry) return;
    setShowBubble(true);
    const ageMs = Date.now() - latestEntry.timestamp;
    const remaining = Math.max(0, 5000 - ageMs);
    if (remaining === 0) {
      setShowBubble(false);
      return;
    }
    const id = window.setTimeout(() => setShowBubble(false), remaining);
    return () => window.clearTimeout(id);
  }, [latestEntry?.timestamp]);

  // Shield click wiring: leader picking a quest team. Only clickable when this
  // card is a candidate (plan #83 Phase 1 swap from center modal → rail-click).
  const isShieldInteractive = isShieldCandidate && typeof onShieldClick === 'function';
  const handleShieldClick = (): void => {
    if (isShieldInteractive) {
      onShieldClick?.(player.id);
    }
  };

  // Bubble alignment mirrors the avatar side so the bubble looks like it
  // hangs from the card (left rail → bubble pinned right; right rail →
  // bubble pinned left).
  const bubbleAlign = side === 'left' ? 'items-end pr-1' : 'items-start pl-1';

  // 未揭角色 — Edward 2026-04-25 20:12「未知角色用牌背顯示」. When the viewer
  // hasn't been told this seat's role (or 忠臣視角 blindfold is on), the whole
  // tile background flips to `role-back.jpg` (紫色 3 王冠旗幟卡背) and ALL
  // corner indicators are suppressed except the seat number — matches Edward's
  // verbatim「整個 tile bg 用 role-back.jpg 取代大頭」+「隱藏 corner indicators
  // (除了 seat 號碼)」directive.
  const isRoleHidden = effectiveRole === null;

  // Portrait URL for the bg-cover layer. Decision tree:
  //   1. role hidden → painted role-back card (overrides everything else; the
  //      viewer is not allowed to see who this seat is)
  //   2. role known + custom user-uploaded `player.avatar` → user photo
  //   3. role known + bot/no-avatar → deterministic painted variant via
  //      pickAvatarUrl(role, id) (canonical role art or 雜魚 variant)
  // The resulting URL is stamped onto the tile via inline style so we don't
  // leak a per-player class into Tailwind's JIT manifest.
  const portraitUrl = isRoleHidden
    ? getRoleBackUrl()
    : (player.avatar ?? pickAvatarUrl(effectiveRole as Role | null | undefined, player.id));

  // Border colour — encodes the mission/team state at a glance. Disconnected
  // wins so a dropped player is unmistakable; current-player gold beats team
  // gradients so the viewer can always find their own seat. loyalView force-
  // suppresses team colours so the rail looks 「忠臣視角」 uniform.
  const borderClass = (() => {
    if (player.status === 'disconnected') return 'border-gray-600 opacity-60';
    if (isCurrentPlayer && !loyalView) return 'border-yellow-400 shadow-lg shadow-yellow-400/40';
    if (effectiveTeam === 'evil') return 'border-red-500';
    if (effectiveTeam === 'good') return 'border-blue-500';
    if (player.isBot) return 'border-slate-500';
    return 'border-gray-500';
  })();

  // Mission-shield border: success = blue, fail = red. We tint the shield's
  // ring instead of recolouring the painted asset so the shield art stays
  // recognisable while the outcome reads at a glance.
  const missionShieldRing = lastQuestResult === 'success'
    ? 'ring-blue-400'
    : lastQuestResult === 'fail'
    ? 'ring-red-500'
    : 'ring-yellow-400';

  // Quest-team selection overlay state — leader picking phase only. Mutually
  // exclusive: shieldSelected (big solid yellow shield) > isShieldCandidate
  // (dim outline hint) > nothing.
  const showSelectOverlay = shieldSelected;
  const showCandidateHint = isShieldCandidate && !shieldSelected;

  return (
    <div className={`flex flex-col w-full gap-1 ${bubbleAlign}`}>
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
        className={`relative aspect-square w-full rounded-xl overflow-hidden border-[3px] bg-cover bg-center transition-all ${borderClass} ${
          shieldSelected
            ? 'ring-2 ring-yellow-400 shadow-md shadow-yellow-400/40'
            : isActiveTurn
            ? 'ring-2 ring-amber-400 shadow-md shadow-amber-400/40'
            : ''
        } ${isShieldInteractive ? 'cursor-pointer' : ''}`}
        style={{ backgroundImage: `url('${portraitUrl}')` }}
        aria-label={`${seatNumber !== undefined ? `${displaySeatNumber(seatNumber)}家 ` : ''}${player.name}`}
      >
        {/* Pulsing halo around the active-turn player so everyone can see whose move it is */}
        {isActiveTurn && (
          <motion.span
            aria-hidden="true"
            initial={{ opacity: 0.5, scale: 1 }}
            animate={{ opacity: [0.5, 0, 0.5], scale: [1, 1.04, 1] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
            className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-amber-300"
          />
        )}

        {/*
          Player name strip — bottom edge of the tile. Semi-transparent black
          backing so white text reads regardless of portrait luminance. Seat
          number sits TOP-LEFT (separate corner) so the bottom strip carries
          name only.
        */}
        <div className="absolute bottom-0 inset-x-0 bg-black/65 backdrop-blur-[1px] px-1 py-0.5">
          <p
            className={`text-center font-bold leading-tight truncate text-[10px] sm:text-xs ${
              player.status === 'disconnected' ? 'text-gray-400' : 'text-white'
            }`}
            title={player.name}
          >
            {player.name}
          </p>
        </div>

        {/*
          Top-left — seat number badge. Edward 2026-04-25 spec calls out
          「玩家號碼 (1家, 2家, ..., 9家, 0家)」 as the dominant top-left marker.
          Gold-on-black so it stays legible against any portrait.
        */}
        {seatNumber !== undefined && (
          <div
            className="absolute top-1 left-1 px-1.5 py-0.5 rounded-md bg-black/70 border border-yellow-500/70 pointer-events-none z-10 shadow-sm"
            aria-label={`${displaySeatNumber(seatNumber)}家`}
          >
            <span className="text-[10px] sm:text-xs font-black text-yellow-300 leading-none whitespace-nowrap">
              {displaySeatNumber(seatNumber)}家
            </span>
          </div>
        )}

        {/*
          Top-center — leader crown. Edward 2026-04-25「正上方: 隊長王冠
          (僅輪到隊長時顯示)」. Painted asset, only renders when isLeader.
          Suppressed on role-back tiles per 20:12「隱藏 corner indicators
          (除了 seat 號碼)」.
        */}
        {!isRoleHidden && isLeader && (
          <motion.div
            initial={{ scale: 0, y: -4 }}
            animate={{ scale: 1, y: 0 }}
            className="absolute top-0.5 left-1/2 -translate-x-1/2 pointer-events-none z-10"
            aria-label="隊長"
          >
            <img
              src={getLeaderCrownUrl()}
              alt=""
              aria-hidden="true"
              className="w-6 h-6 sm:w-7 sm:h-7 object-contain drop-shadow-lg"
              loading="lazy"
              draggable={false}
            />
          </motion.div>
        )}

        {/*
          Top-right — Lady-of-the-Lake holder lake disc. Edward 2026-04-25 20:09
          corrected spec「右上: 湖中」relocates the lake-holder indicator from
          the previous center-left floating slot up to the right-top corner.
          Only renders when this seat currently holds the lady-of-the-lake.
          Suppressed on role-back tiles.
        */}
        {!isRoleHidden && isLadyHolder && (
          <motion.div
            initial={{ scale: 0, rotate: -8 }}
            animate={{ scale: 1, rotate: 0 }}
            className="absolute top-1 right-1 bg-cyan-500 border-2 border-cyan-200 rounded-full overflow-hidden pointer-events-none shadow-md z-10 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center"
            aria-label="持有湖中女神"
          >
            <img
              src={getLakeImage()}
              alt=""
              aria-hidden="true"
              className="w-full h-full object-cover"
              draggable={false}
              loading="lazy"
            />
          </motion.div>
        )}

        {/*
          Bottom-left — vote token (黑白球). Edward 2026-04-25 20:09 corrected
          spec「左下: 黑白球」moves the vote ball from the previous bottom-right
          slot to the bottom-left so the bottom-right is freed for the mission
          shield (per the new corner config).
            - hasVoted=false → no token (player hasn't voted yet)
            - hasVoted=true, voted=undefined → 紫色背面 (private vote, hidden)
            - hasVoted=true, voted=true → 白球 / vote-yes.jpg (贊成)
            - hasVoted=true, voted=false → 黑球 / vote-no.jpg (反對)
          Vote stays visible until the next vote round so the rail keeps the
          previous outcome on display (Edward「投票結果一直保留到下輪投票結束」).
          Suppressed on role-back tiles.
        */}
        {!isRoleHidden && hasVoted && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 22 }}
            className="absolute bottom-1 left-1 pointer-events-none z-10 rounded-full overflow-hidden border-2 border-white/80 shadow-md w-7 h-7 sm:w-8 sm:h-8 bg-black/40"
            aria-label={voted === undefined ? '已投票' : voted ? '贊成' : '反對'}
          >
            <img
              src={
                voted === undefined
                  ? getVoteBackUrl()
                  : voted
                  ? VOTE_IMAGES.yes
                  : VOTE_IMAGES.no
              }
              alt=""
              aria-hidden="true"
              className="w-full h-full object-cover"
              loading="lazy"
              draggable={false}
            />
          </motion.div>
        )}

        {/*
          Bottom-right — mission shield. Edward 2026-04-25 20:09 corrected spec
         「右下: 任務盾牌」moves the shield from the previous top-right slot to
          the bottom-right (top-right now belongs to the lake-holder icon).
          Three phases (mutually exclusive, priority top-down):
            1. Leader picking team + shield candidate / selected → quest-team
               selection overlay (yellow outline hint / solid yellow shield).
            2. Otherwise, when this player participated in the most recent
               completed quest → painted shield + coloured ring (blue=success,
               red=fail).
            3. Otherwise, active quest member with no result yet → soft yellow
               ring shield so the rail flags the current quest team.
          Suppressed on role-back tiles.
        */}
        {!isRoleHidden && showSelectOverlay && (
          <motion.div
            initial={{ scale: 0, rotate: -10 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 22 }}
            className="absolute bottom-1 right-1 pointer-events-none z-20 rounded-full ring-2 ring-yellow-300 shadow-lg shadow-yellow-400/40"
            aria-label="已選入任務隊伍"
          >
            <img
              src={getMissionShieldUrl()}
              alt=""
              aria-hidden="true"
              className="w-7 h-7 sm:w-8 sm:h-8 object-contain"
              loading="lazy"
              draggable={false}
            />
          </motion.div>
        )}
        {!isRoleHidden && showCandidateHint && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.55 }}
            className="absolute bottom-1 right-1 pointer-events-none z-10 rounded-full ring-2 ring-yellow-300/60"
            aria-hidden="true"
          >
            <img
              src={getMissionShieldUrl()}
              alt=""
              aria-hidden="true"
              className="w-6 h-6 sm:w-7 sm:h-7 object-contain opacity-70"
              loading="lazy"
              draggable={false}
            />
          </motion.div>
        )}
        {!isRoleHidden && !showSelectOverlay && !showCandidateHint && lastQuestResult !== undefined && (
          <motion.div
            initial={{ scale: 0, rotate: -8 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 22 }}
            className={`absolute bottom-1 right-1 pointer-events-none z-10 rounded-full ring-2 ${missionShieldRing} shadow-md`}
            aria-label={lastQuestResult === 'success' ? '最近任務成功' : '最近任務失敗'}
          >
            <img
              src={getMissionShieldUrl()}
              alt=""
              aria-hidden="true"
              className="w-6 h-6 sm:w-7 sm:h-7 object-contain"
              loading="lazy"
              draggable={false}
            />
          </motion.div>
        )}
        {!isRoleHidden && !showSelectOverlay && !showCandidateHint && lastQuestResult === undefined && isOnQuestTeam && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute bottom-1 right-1 pointer-events-none z-10 rounded-full ring-2 ring-yellow-400 shadow-md"
            aria-label="任務隊員"
          >
            <img
              src={getMissionShieldUrl()}
              alt=""
              aria-hidden="true"
              className="w-6 h-6 sm:w-7 sm:h-7 object-contain"
              loading="lazy"
              draggable={false}
            />
          </motion.div>
        )}

        {/*
          Bot icon — Edward's 4-corner spec doesn't reserve a slot, so we tuck
          the 🤖 chip just to the right of the seat-number badge in the
          top-left cluster. Suppressed on role-back tiles (the unknown card
          intentionally hides identity hints; the operator can still spot bots
          via the lobby roster).
        */}
        {!isRoleHidden && player.isBot && (
          <div
            className="absolute top-1 left-10 sm:left-12 bg-slate-900/80 border border-slate-500 rounded-full w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center pointer-events-none z-10 shadow-sm"
            aria-label="AI 玩家"
          >
            <span className="text-[10px] sm:text-xs leading-none">🤖</span>
          </div>
        )}

        {/* Disconnected marker — overlays the seat row top-left so a dropped
            player flags as offline regardless of role-back state. Disconnected
            is a system status (not a corner indicator), so we deliberately
            keep it visible even when corner indicators are suppressed. */}
        {player.status === 'disconnected' && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute top-1 right-1 bg-red-700 rounded-full p-0.5 pointer-events-none z-30"
            aria-label="斷線"
          >
            <WifiOff size={12} className="text-white" />
          </motion.div>
        )}
      </motion.div>

      {/*
        Edward 2026-04-25 19:40 — chat bubble overlay below the PlayerCard.
        Renders the player's most recent chat line for ~5s then fades out.
        Truncated to one line at small max-width so it doesn't push neighbour
        cards down the rail; the full conversation still lives in ChatPanel.
      */}
      <AnimatePresence>
        {showBubble && latestEntry && (
          <motion.div
            key={`bubble-${latestEntry.timestamp}`}
            initial={{ opacity: 0, y: -4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.18 }}
            className={`pointer-events-none max-w-[140px] truncate rounded-xl bg-white/15 backdrop-blur-sm border border-white/20 px-2 py-1 text-[10px] leading-tight text-white shadow-md ${
              side === 'left' ? 'rounded-tr-none' : 'rounded-tl-none'
            }`}
            data-testid={`player-chat-bubble-${player.id}`}
            title={latestEntry.text}
          >
            {latestEntry.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
