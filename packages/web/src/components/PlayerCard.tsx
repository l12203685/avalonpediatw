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
  ROLE_AVATAR_IMAGES,
  VOTE_IMAGES,
} from '../utils/avalonAssets';
import { useChatStore } from '../store/chatStore';

interface PlayerCardProps {
  player: Player;
  isCurrentPlayer: boolean;
  /**
   * Whether this player has cast a vote in the *currently active* team-vote
   * round. Drives the in-flight face-down vote-back token (others) and the
   * own-vote yes/no token (self) while `room.state === 'voting'`.
   */
  hasVoted: boolean;
  /**
   * The player's vote outcome on the in-flight round. `undefined` while voting
   * is still ongoing for other players (so we render the face-down purple
   * back); resolved boolean once the round ends or for the viewer's own vote.
   */
  voted?: boolean;
  /**
   * Edward 2026-04-25 21:59「PlayerCard 黑白球常態顯示」— last completed
   * team-vote outcome for this player, derived by GameBoard from
   * `room.voteHistory[len-1].votes[id]`. Persists the 黑白球 across phase
   * transitions (quest / lady_of_the_lake / next-round team-select) so the
   * rail keeps showing「上一輪你投了什麼」until the next vote round resolves.
   *   - `true`      → painted vote-yes (white ball)
   *   - `false`     → painted vote-no  (black ball)
   *   - `undefined` → no completed vote yet OR currently in voting phase
   *                   (in-flight token from `hasVoted`/`voted` takes over)
   *
   * Why a separate prop: server clears `room.votes = {}` on round transitions,
   * so `hasVoted`/`voted` only tells the in-flight story. Persistent display
   * needs a stable lookup that survives phase changes — `voteHistory` is it.
   */
  lastVoteApproved?: boolean;
  isLeader?: boolean;
  /**
   * Retained for API compatibility (consumed by GamePage). The PlayerCard
   * itself no longer paints a "current quest member" shield because Edward
   * 21:52 #7 collapsed the shield to「依參與最後任務顯示」only.
   */
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
   * Per-player participation in the most recently completed quest. Edward
   * 2026-04-25 21:52「盾牌每個玩家不一定正確顯示 — 任務盾應每玩家依參與最後
   * 任務顯示, 不能 hardcode 一樣」.
   *   - `'success'` → this player joined the last quest and it succeeded
   *   - `'fail'`    → this player joined the last quest and it failed
   *   - `null`      → this player did NOT join the last quest (no shield)
   *   - `undefined` → no quest has completed yet (no shield)
   * Renders the painted mission shield with a coloured ring (blue=success,
   * red=fail) ONLY when the value is `'success'` or `'fail'`. The legacy
   * fallback that flashed a yellow shield on every current quest-team member
   * was removed because it made every player's shield look identical during
   * the quest phase.
   */
  lastQuestParticipation?: 'success' | 'fail' | null;
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
  /**
   * Edward 2026-04-25 22:04「最終角色揭曉的內容不需要」— 砍 GamePage 中央/底部
   * inline reveal panel 後, PlayerCard 必須自己承擔角色名顯示. 遊戲結束時
   * (room.state === 'ended') 由 GameBoard 傳本地化過的 role label
   * (e.g.「梅林」/「刺客」), PlayerCard 在 portrait 上方加一條小 chip 揭出角色.
   * `undefined` 不渲染 — 對齊正常遊戲中無 role text overlay 的 spec.
   */
  endGameRoleLabel?: string;
  /**
   * Edward 2026-04-25 22:04 game-end 揭曉 — 該玩家被刺殺. 砍 panel 後 🗡️
   * 指示需移到 PlayerCard 自己上, 否則玩家無法在牌面看誰被刺. seat 號碼旁
   * 加一個小紅圈 + 🗡️ glyph; 純 game-end 用, gameplay 中忽略.
   */
  assassinated?: boolean;
  /**
   * Edward 2026-04-26 18:23 反前 ship —「這是 lobby 嗎 為什麼還是跟 game 一樣 /
   * 前一版 (方框拉長填滿) 而且牌背有正常顯示的 才是正確版本」. Reverts the
   * 16:54 unified `aspect-square` attempt: lobby tiles must be tall portrait
   * (`aspect-[3/4]`) so the role-back card art fills the tile like a real
   * playing card; game tiles stay `aspect-square` because in-game corner
   * indicators (王冠 / 球 / 盾 / 湖) need the wider square to breathe.
   *   - `'lobby'` → `aspect-[3/4]` (taller portrait, role-back fills)
   *   - `'game'`  → `aspect-square` (default; corner indicators visible)
   */
  variant?: 'game' | 'lobby';
  /**
   * Edward 2026-04-25 22:38 GamePage 3-fix #3「你的投票/任務盾/湖中女神 都
   * 只有最後開牌才顯示, 遊戲過程中只有未知身分牌背」.
   *
   * When true, the viewer's OWN PlayerCard hides the three "tracker" indicators
   * (BL vote ball, BR mission shield, TR lake disc) behind a generic 牌背
   * placeholder so other people glancing at this device can't read the local
   * player's vote / mission shield / lake holder state mid-game. GameBoard
   * sets this to `(player.id === currentPlayer.id) && room.state !== 'ended'`
   * — i.e. only the local seat in non-ended rooms gets the blindfold; once the
   * game ends, the real indicators come back so the recap reads correctly.
   *
   * Other players' tiles are never affected — their tracker chips already use
   * the proper public-state semantics (face-down purple during voting, painted
   * outcomes after). Only the *self* tile previously leaked the local player's
   * own vote / mission participation / lake holding to anyone watching the
   * device. With this flag, the self tile now shows neutral 牌背 placeholders
   * during gameplay; real values come back at game-end (room.state==='ended').
   */
  selfTrackerHidden?: boolean;
}

/**
 * PlayerCard — Edward 2026-04-25 20:09 + 20:12 + 21:52 corrected corner spec.
 *
 * Square tile (`aspect-square`) where the portrait fills the whole tile as a
 * `background-image` and the corners surface game state via painted icons.
 * No role / camp text overlay — the avatar carries identity by itself.
 *
 *   ┌────────────────────────────┐
 *   │ [N]        [👑王冠]   [湖]  │  ← TL: seat#, TC: leader crown, TR: lake holder
 *   │   (full-square portrait    │
 *   │    bg-cover, no overlay    │
 *   │    role/camp text)         │
 *   │                            │
 *   │ [球]                  [盾] │  ← BL: vote token (持久), BR: 任務盾牌
 *   └────────────────────────────┘
 *
 * Edward 20:09 / 21:59 corner config (verbatim, 「家」suffix 21:59 已撤):
 *   - 左上: 玩家號碼 (1, 2, ..., 9, 0)
 *   - 正上: 隊長王冠 (`leader-crown.jpg`)
 *   - 右上: 湖中 (`lake.jpg` — 只有湖中女神持有者才顯示)
 *   - 左下: 黑白球 (持久顯示 `lastVoteApproved` / 投票進行中用 `hasVoted`+`voted`)
 *   - 右下: 任務盾牌 (`mission-shield.jpg`)
 *   - 中: 大頭照 portrait (full square)
 *
 * Edward 20:12 add-ons (Edward 2026-04-26 18:23 反前 ship — 撤回 16:54 統一):
 *   - PlayerCard aspect 條件式: `variant === 'lobby' ? 'aspect-[3/4]' : 'aspect-square'`.
 *     16:54 把 lobby 統一成 `aspect-square` 讓 lobby 看起來跟 game 一樣方框, 但
 *     Edward 18:23 verbatim「這是lobby嗎 為什麼還是跟game一樣 / 前一版(方框拉長
 *     填滿)而且牌背有正常顯示的才是正確版本」→ revert. Lobby `aspect-[3/4]` =
 *     真實撲克牌比例, role-back 圖填滿; game `aspect-square` = 4 corner indicator
 *     需要的寬方版面.
 *   - 未揭角色 (`effectiveRole === null`) → 整 tile bg 用 `role-back.jpg` 取代
 *     大頭, 玩家名 chip 浮層. **2026-04-26 16:53 起所有 4-corner 公開狀態
 *     indicator (隊長王冠 / 任務盾 / 黑白球 / 湖中) 全部 unconditional 渲染**,
 *     不再被 `isRoleHidden` 抑制 — 因為 Avalon 規則桌面上隊長 / 任務參與 /
 *     投票結果 / 湖中持有都是公開資訊, viewer 不知具體角色 ≠ viewer 不知公開資訊.
 *     原本 20:12 的「隱藏 corner indicators」實作製造了 bug C/D「shield + 球
 *     不顯」, 撤回. 狀態旗為避免遊戲性遺失，仍保留 disconnected 半透明 dim — 與
 *     corner indicator 不同類。
 *
 * Edward 21:52 / 21:59 corrections (#7-#9 + 撤回 #9):
 *   - #7「盾牌每玩家依參與最後任務顯示，不能 hardcode 一樣」→ 用
 *     `lastQuestParticipation: 'success' | 'fail' | null`，沒參與最後任務 = 不
 *     顯示盾。砍掉之前 `isOnQuestTeam` 的 fallback（讓所有當前 quest 隊員看
 *     起來都長一樣的黃盾）。
 *   - #8「牌背拉長砍下方空白」→ 未揭角色 tile (role-back / camp-only / candidate
 *     split) 不再用 `bg-black/65` 全寬黑條鋪底 player name；改成 role-back 從頭
 *     到尾鋪滿，玩家名以 text-shadow + 局部 bg-black/40 小條 overlay 在 role-
 *     back 上。
 *   - #9 + 21:59 撤回:「黑白球常態保留」← Edward 2026-04-25 21:59 改變主意,
 *     左下黑白球 *回來* 但改「常態保留」: 一旦投過票, 球持續顯示到下輪投票
 *     結果出來前. 由 GameBoard 從 `room.voteHistory` 推導後傳 `lastVoteApproved`,
 *     PlayerCard 用該 prop 渲染持久 token; 投票進行中(`room.state==='voting'`)
 *     用 `hasVoted`/`voted` 渲 in-flight token (face-down purple for others,
 *     own actual vote for self). VotePanel 按鈕內球(M batch #9 加的)留著,
 *     兩處不衝突 — VotePanel 是即時投票 UI, PlayerCard 球是公開歷史結果.
 *
 * Edward 21:59 corner spill: 4 個 corner indicators 可微出 tile 邊框 (用 negative
 * inset 例如 `-top-1 -left-1`)，視覺上更突顯，只要不擋中央 portrait 即可。
 * Edward 21:59 撤回「N家」: 座位號顯示改純數字 (1, 2, ..., 9, 0)，不加「家」suffix。
 *
 * Replaced overlays (carry-over from 20:05 rewrite, still applies):
 *   - 中央「否決 / 通過」popup (VoteRevealOverlay) → 由 VotePanel 按鈕內球 +
 *     PlayerCard 左下持久球承擔
 *   - 右上角任務 banner (QuestResultOverlay) → mission shield (右下)
 *
 * Asset registry: see `utils/avalonAssets.ts` — `getLeaderCrownUrl`,
 * `getMissionShieldUrl`, `getVoteBackUrl`, `getRoleBackUrl`, `getLakeImage`,
 * `VOTE_IMAGES`, `ROLE_AVATAR_IMAGES`.
 */

export default function PlayerCard({
  player,
  isCurrentPlayer,
  hasVoted,
  voted,
  lastVoteApproved,
  isLeader = false,
  isOnQuestTeam: _isOnQuestTeam = false,
  seatNumber,
  side = 'left',
  isActiveTurn = false,
  isShieldCandidate = false,
  shieldSelected = false,
  onShieldClick,
  isLadyHolder = false,
  lastQuestParticipation,
  loyalView = false,
  endGameRoleLabel,
  assassinated = false,
  variant = 'game',
  selfTrackerHidden = false,
}: PlayerCardProps): JSX.Element {
  // `isOnQuestTeam` retained for API compat (GamePage still passes it) but the
  // 21:52 #7 redesign drives the shield purely off `lastQuestParticipation`.
  void _isOnQuestTeam;

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

  // Edward 2026-04-25 21:52 角色揭露 logic 三檔位 (修正前: 只要 role===null
  // 一律 role-back; 修正後: 視陣營 / candidates 細分):
  //   A. revealedCandidates (派西看到的兩位 Merlin/Morgana candidate) →
  //      half/half split tile (左半梅林 / 右半莫甘娜). Server-side fix 把這兩
  //      位的 role/team 都 mask 成 null 但設 revealedCandidates 欄位.
  //   B. effectiveRole === null && effectiveTeam === 'evil'
  //      (梅林看紅方 / 紅方互看) → 紅色陣營卡 (red bg + ❓), 不揭具體角色.
  //   C. effectiveRole === null && effectiveTeam === null
  //      (完全不可見 / 忠臣視角 blindfold) → role-back 牌背 (現行).
  //   D. effectiveRole !== null → 正常 portrait (自己 / revealAll 後).
  // loyalView 強制走 C 檔位 (effectiveRole/effectiveTeam 都被覆寫成 null).
  const candidateRoles: Role[] = (
    !loyalView && effectiveRole === null
      && Array.isArray(player.revealedCandidates) && player.revealedCandidates.length >= 2
      ? player.revealedCandidates.slice(0, 2)
      : []
  );
  const isCandidateSplit = candidateRoles.length >= 2;
  const isCampOnly = !isCandidateSplit && effectiveRole === null && effectiveTeam === 'evil';
  const isRoleBack = !isCandidateSplit && !isCampOnly && effectiveRole === null;
  // Aggregate flag — any of the three "role not directly known" modes hides
  // identity-revealing corner indicators (王冠 / 湖 / 盾 / bot icon). Seat#
  // and disconnected flag stay visible because they're system-level not role-level.
  const isRoleHidden = isCandidateSplit || isCampOnly || isRoleBack;

  // Portrait URL for the bg-cover layer. Decision tree (matches檔位 above):
  //   - candidate split → no bg portrait (overlay JSX paints both halves)
  //   - camp-only       → no bg portrait (overlay JSX paints solid red tile)
  //   - role-back       → painted role-back card
  //   - role known      → custom avatar OR pickAvatarUrl(role, id)
  // empty string suppresses the bg-image so the JSX overlay can fully own the visual.
  const portraitUrl = isCandidateSplit || isCampOnly
    ? ''
    : isRoleBack
    ? getRoleBackUrl()
    : (player.avatar ?? pickAvatarUrl(effectiveRole as Role | null | undefined, player.id));

  // Border colour — encodes the mission/team state at a glance. Disconnected
  // wins so a dropped player is unmistakable; team gradients show camp colour
  // when known (loyalView force-suppresses for 「忠臣視角」 uniform look).
  //
  // Edward 2026-04-26 18:38 spec 12「不要讓自己的方塊變黃色 不然容易跟任務選人時
  // 疊在一起誤會」: 砍 isCurrentPlayer 的 yellow border + shadow — 跟
  // shieldSelected (任務選人 yellow) 視覺撞色. 自己用 seat-number 的螢光黃
  // (PlayerCard top-left badge, spec 11) 區隔即可, 方塊 border 走 effective
  // team / role-back grey 即可.
  const borderClass = (() => {
    if (player.status === 'disconnected') return 'border-gray-600 opacity-60';
    if (effectiveTeam === 'evil') return 'border-red-500';
    if (effectiveTeam === 'good') return 'border-blue-500';
    if (player.isBot) return 'border-slate-500';
    return 'border-gray-500';
  })();

  // Mission-shield border: success = blue, fail = red. We tint the shield's
  // ring instead of recolouring the painted asset so the shield art stays
  // recognisable while the outcome reads at a glance. Only meaningful when
  // `lastQuestParticipation` is `'success'` or `'fail'`.
  const missionShieldRing = lastQuestParticipation === 'success'
    ? 'ring-blue-400'
    : lastQuestParticipation === 'fail'
    ? 'ring-red-500'
    : 'ring-yellow-400';

  // Quest-team selection overlay state — leader picking phase only. Mutually
  // exclusive: shieldSelected (big solid yellow shield) > isShieldCandidate
  // (dim outline hint) > nothing.
  const showSelectOverlay = shieldSelected;
  const showCandidateHint = isShieldCandidate && !shieldSelected;

  // Edward 21:52 #7 — only render the result shield when this player joined
  // the last completed quest AND we have a definitive outcome. `null` means
  // the player did not join (no shield). `undefined` means no quest completed
  // yet (also no shield). The legacy `isOnQuestTeam` fallback was removed.
  const showResultShield =
    !showSelectOverlay &&
    !showCandidateHint &&
    (lastQuestParticipation === 'success' || lastQuestParticipation === 'fail');

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
        className={`relative ${variant === 'lobby' ? 'aspect-[3/4]' : 'aspect-square'} w-full rounded-xl overflow-hidden border-[3px] bg-cover bg-center transition-all ${borderClass} ${
          shieldSelected
            ? 'ring-2 ring-yellow-400 shadow-md shadow-yellow-400/40'
            : isActiveTurn
            ? 'ring-2 ring-amber-400 shadow-md shadow-amber-400/40'
            : ''
        } ${isShieldInteractive ? 'cursor-pointer' : ''}`}
        // Edward 2026-04-26: 牌背 (role-back) 改走 explicit <img> 而非 bg-image,
        // 讓我們可以掛 onError diagnostic 抓到 404 / encoding hazard. 其他角色
        // 仍走 bg-image 維持原 layout. backgroundImage 設給非 role-back 的 portraitUrl.
        style={portraitUrl !== '' && !isRoleBack ? { backgroundImage: `url('${portraitUrl}')` } : undefined}
        aria-label={`${seatNumber !== undefined ? `${displaySeatNumber(seatNumber)} ` : ''}${player.name}`}
      >
        {/*
          Edward 2026-04-26 「圖檔不見」診斷: 把 role-back 牌背從 bg-image 提到
          explicit <img> 並掛 onError. 若 console.warn 噴 [role-back miss] 即知
          asset URL 真的 404 / 編碼問題; 否則就是 CSS background-image 沒套到的
          bug (例如 portraitUrl 拼錯或被 isRoleHidden chain 短路掉).
        */}
        {isRoleBack && (
          <img
            src={getRoleBackUrl()}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
            draggable={false}
            onError={(e) => {
              // eslint-disable-next-line no-console
              console.warn('[asset miss] role-back', (e.target as HTMLImageElement).src);
            }}
          />
        )}
        {/*
          Edward 2026-04-25 21:52「camp-only」red 陣營卡 — 梅林看紅方 / 紅方互看
          時, server 已把具體 role mask 成 null, 但 keep team='evil'. 此處渲染
          紅色滿版 + 中央 ❓ 取代具體角色 portrait, 讓 viewer 一眼讀出「這座位
          是紅方陣營, 但我不知道具體是刺/娜/德/奧」.
        */}
        {isCampOnly && (
          <div
            aria-label="紅方陣營"
            className="absolute inset-0 bg-gradient-to-br from-red-900 via-red-700 to-red-950 flex items-center justify-center"
          >
            <span className="text-white/90 text-3xl sm:text-4xl font-black drop-shadow-lg select-none">
              ?
            </span>
          </div>
        )}

        {/*
          Edward 2026-04-25 21:52「Percival candidate split」— 派西看到的兩位
          candidates (梅林|莫甘娜). Server 把這兩位的 role/team 都 mask 成 null
          並設 revealedCandidates=['merlin','morgana']. 此處用左半 / 右半圖呈現
          「半梅林半莫甘娜」, 派西自己分不出哪個是真梅林.
        */}
        {isCandidateSplit && (
          <div
            aria-label={`可能是${candidateRoles.join('或')}`}
            className="absolute inset-0 flex"
          >
            <div
              className="w-1/2 h-full bg-cover bg-center"
              style={{ backgroundImage: `url('${ROLE_AVATAR_IMAGES[candidateRoles[0]]}')` }}
              aria-hidden="true"
            />
            <div
              className="w-1/2 h-full bg-cover bg-center"
              style={{ backgroundImage: `url('${ROLE_AVATAR_IMAGES[candidateRoles[1]]}')` }}
              aria-hidden="true"
            />
            {/* Center divider so the two halves read as a split tile, not as a single weird portrait */}
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-1/2 w-px bg-white/60 pointer-events-none"
            />
          </div>
        )}

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
          Player name overlay — Edward 2026-04-25 21:52 #8「牌背拉長砍下方空白」.
          When the role is hidden (role-back / camp-only / candidate split), the
          painted card art needs to fill the entire tile so the previously-
          visible black band beneath the card disappears. We swap the full-
          bleed bg-black/65 strip for a compact, centred chip with a heavy
          text-shadow so the card art stays visible behind and around the name.
          When the role is revealed, the original full-width strip is kept so
          portraits with bright lower-thirds still have legible name text.
        */}
        {isRoleHidden ? (
          <div className="absolute bottom-1 inset-x-1 pointer-events-none flex justify-center z-10">
            <span
              className={`max-w-full truncate rounded-md bg-black/40 px-1.5 py-0.5 text-[10px] sm:text-xs font-bold leading-tight ${
                player.status === 'disconnected' ? 'text-gray-300' : 'text-white'
              }`}
              style={{ textShadow: '0 1px 2px rgba(0,0,0,0.85)' }}
              title={player.name}
            >
              {player.name}
            </span>
          </div>
        ) : (
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
        )}

        {/*
          Top-left — seat number. Edward 2026-04-26 18:38 spec 11「玩家號碼可以
          不要有方框嗎 直接用螢光白顯示在左上角 (自己的號碼顯示黃色)」:
          砍方框 (no border, no bg), 純螢光文字 overlay. 自己 = 螢光黃, 其他 = 螢光白.
          drop-shadow 雙層黑色描邊維持任何 portrait 上的可讀性.
        */}
        {seatNumber !== undefined && (
          <div
            className="absolute top-0.5 left-1 pointer-events-none z-20"
            aria-label={`座位 ${displaySeatNumber(seatNumber)}`}
          >
            <span
              className={`text-xs sm:text-sm font-black leading-none whitespace-nowrap ${
                isCurrentPlayer ? 'text-yellow-300' : 'text-white'
              }`}
              style={{
                textShadow:
                  '0 0 3px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.95)',
              }}
            >
              {displaySeatNumber(seatNumber)}
            </span>
          </div>
        )}

        {/*
          Top-center — leader crown. Edward 2026-04-25「正上方: 隊長王冠
          (僅輪到隊長時顯示)」. Painted asset, only renders when isLeader.
          Edward 2026-04-26 16:53 corner-fix:「任務盾牌+黑白球 corner 不顯」根因
          就是 4-corner 公開資訊被 isRoleHidden 抑制了, 導致紅方 / 牌背 / split
          tile 上看不到隊長王冠 / 任務盾 / 球. 隊長身份 / 任務參與 / 投票結果都是
          公開資訊 (Avalon 規則桌面上人人看得到), 不該因為「viewer 不知該座位
          具體角色」就藏起來. 從這條開始 4 corner indicators 全部 unconditional 渲染.
        */}
        {isLeader && (
          <motion.div
            initial={{ scale: 0, y: -4 }}
            animate={{ scale: 1, y: 0 }}
            className="absolute -top-2 left-1/2 -translate-x-1/2 pointer-events-none z-10"
            aria-label="隊長"
          >
            <img
              src={getLeaderCrownUrl()}
              alt=""
              aria-hidden="true"
              className="w-6 h-6 sm:w-7 sm:h-7 object-contain drop-shadow-lg"
              loading="lazy"
              draggable={false}
              onError={(e) => {
                // eslint-disable-next-line no-console
                console.warn('[asset miss] leader-crown', (e.target as HTMLImageElement).src);
              }}
            />
          </motion.div>
        )}

        {/*
          Top-right — Lady-of-the-Lake holder lake disc. Edward 2026-04-25 20:09
          corrected spec「右上: 湖中」relocates the lake-holder indicator from
          the previous center-left floating slot up to the right-top corner.
          Only renders when this seat currently holds the lady-of-the-lake.

          Edward 2026-04-26 00:17: 湖中持有者是 **公開資訊** (誰持湖每個玩家都知道),
          所以這個 indicator 跟 seat# / disconnected 一樣是 system-level 資訊,
          不該因為 role-back / camp-only / candidate-split 等 role-hidden state
          被隱藏. 原本 `!isRoleHidden && isLadyHolder` 導致梅林看到的紅方陣營卡
          / 派西看到的 split tile 上失去湖中 indicator (即使該紅方就是現役持湖者),
          畫面上找不到湖中誰持. 改成 always render, 只在 role 揭曉前不依賴 role.
        */}
        {isLadyHolder && (
          <motion.div
            initial={{ scale: 0, rotate: -8 }}
            animate={{ scale: 1, rotate: 0 }}
            className={`absolute -top-1 -right-1 ${
              selfTrackerHidden
                ? 'bg-purple-700 border-2 border-purple-300'
                : 'bg-cyan-500 border-2 border-cyan-200'
            } rounded-full overflow-hidden pointer-events-none shadow-md z-10 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center`}
            aria-label={selfTrackerHidden ? '你持有湖中女神（遊戲結束才揭曉）' : '持有湖中女神'}
          >
            {/* Edward 2026-04-25 22:38 GamePage 3-fix #3: when this is the
                local player's own tile mid-game, swap the painted lake disc
                for a generic role-back placeholder so onlookers can't see the
                viewer is the lake holder. The frame itself stays (purple ring
                instead of cyan) so the corner slot remains visually anchored —
                we just hide the *contents*. The local player still knows
                they're the holder via the lady-of-the-lake phase panel +
                action banner. At game-end (selfTrackerHidden=false) the cyan
                lake disc returns. */}
            <img
              src={selfTrackerHidden ? getRoleBackUrl() : getLakeImage()}
              alt=""
              aria-hidden="true"
              className="w-full h-full object-cover"
              draggable={false}
              loading="lazy"
              onError={(e) => {
                // eslint-disable-next-line no-console
                console.warn('[asset miss] lake-disc', (e.target as HTMLImageElement).src);
              }}
            />
          </motion.div>
        )}

        {/*
          Bottom-right — mission shield. Edward 2026-04-25 21:52 #7 collapses
          the previous 3-phase shield logic to per-player participation in the
          most recently completed quest. Picking-phase overlays still take
          priority (so the leader can see active picks), but the resting-state
          shield is now strictly outcome-based:
            1. Leader picking team + shield candidate / selected → quest-team
               selection overlay (yellow outline hint / solid yellow shield).
            2. Otherwise, when this player joined the most recent completed
               quest → painted shield + coloured ring (blue=success, red=fail).
            3. Otherwise → no shield. The legacy "active quest member with no
               result yet" fallback that flashed yellow on every current quest
               team member was removed (Edward「盾牌應每玩家依參與最後任務顯
               示，不能 hardcode 一樣」).
          Suppressed on role-hidden tiles.
        */}
        {showSelectOverlay && (
          <motion.div
            initial={{ scale: 0, rotate: -10 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 22 }}
            className="absolute -bottom-1 -right-1 pointer-events-none z-20 rounded-full ring-2 ring-yellow-300 shadow-lg shadow-yellow-400/40"
            aria-label="已選入任務隊伍"
          >
            <img
              src={getMissionShieldUrl()}
              alt=""
              aria-hidden="true"
              className="w-7 h-7 sm:w-8 sm:h-8 object-contain"
              loading="lazy"
              draggable={false}
              onError={(e) => {
                // eslint-disable-next-line no-console
                console.warn('[asset miss] mission-shield(select)', (e.target as HTMLImageElement).src);
              }}
            />
          </motion.div>
        )}
        {showCandidateHint && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.55 }}
            className="absolute -bottom-1 -right-1 pointer-events-none z-10 rounded-full ring-2 ring-yellow-300/60"
            aria-hidden="true"
          >
            <img
              src={getMissionShieldUrl()}
              alt=""
              aria-hidden="true"
              className="w-6 h-6 sm:w-7 sm:h-7 object-contain opacity-70"
              loading="lazy"
              draggable={false}
              onError={(e) => {
                // eslint-disable-next-line no-console
                console.warn('[asset miss] mission-shield(hint)', (e.target as HTMLImageElement).src);
              }}
            />
          </motion.div>
        )}
        {showResultShield && (
          <motion.div
            initial={{ scale: 0, rotate: -8 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 22 }}
            // Edward 2026-04-25 22:38 GamePage 3-fix #3: when this is the
            // local player's own tile mid-game, the shield ring colour stops
            // encoding pass/fail (would leak whether the viewer's last quest
            // succeeded). We render a neutral gray ring + role-back graphic
            // so the slot is visually anchored but the outcome stays hidden
            // until the game ends (selfTrackerHidden=false → ring returns).
            className={`absolute -bottom-1 -right-1 pointer-events-none z-10 rounded-full ring-2 ${
              selfTrackerHidden ? 'ring-gray-500' : missionShieldRing
            } shadow-md`}
            aria-label={
              selfTrackerHidden
                ? '你最近任務（遊戲結束才揭曉）'
                : lastQuestParticipation === 'success'
                ? '最近任務成功'
                : '最近任務失敗'
            }
          >
            <img
              src={selfTrackerHidden ? getRoleBackUrl() : getMissionShieldUrl()}
              alt=""
              aria-hidden="true"
              className="w-6 h-6 sm:w-7 sm:h-7 object-contain"
              loading="lazy"
              draggable={false}
              onError={(e) => {
                // eslint-disable-next-line no-console
                console.warn('[asset miss] mission-shield(result)', (e.target as HTMLImageElement).src);
              }}
            />
          </motion.div>
        )}

        {/*
          Bottom-left — vote token (黑白球). Edward 2026-04-25 21:59「常態保留」
          仔細看清楚 #190 撤回: 球在這裡 *常態顯示*, 規則:
            A. `room.state === 'voting'` (in-flight): 由 `hasVoted` + `voted` 決定
               - hasVoted=true, voted=undefined → 紫色背面 (private vote)
               - hasVoted=true, voted=true       → 白球 (vote-yes)
               - hasVoted=true, voted=false      → 黑球 (vote-no)
               - hasVoted=false                  → 不渲染 (尚未投票)
            B. 其他 phase (quest / lady_of_the_lake / team-select / ended): 由
               `lastVoteApproved` 決定
               - lastVoteApproved=true  → 白球 (上一輪投了贊成)
               - lastVoteApproved=false → 黑球 (上一輪投了反對)
               - lastVoteApproved=undefined → 不渲染 (這場還沒完成過任何投票)
          GameBoard 從 `room.voteHistory[len-1].votes[id]` 推導 `lastVoteApproved`,
          所以伺服器在 phase 切換時清掉 `room.votes` 不會影響持久顯示。
          Suppressed on role-hidden tiles per 20:12 rule.
        */}
        {(() => {
          // Edward 2026-04-25 22:38 GamePage 3-fix #3「你的投票/任務盾/湖中女神 都
          // 只有最後開牌才顯示, 遊戲過程中只有未知身分牌背」: when this is the
          // viewer's own tile and the game is mid-flight, swap the real
          // outcome (yes / no / undetermined) for a generic vote-back token
          // so a shoulder-surfer can't read off the local vote. The local
          // player still sees their own vote in the VotePanel button + chat
          // system feed — this just stops it leaking off the PlayerCard.
          // We render the back even when the player hasn't voted yet so the
          // self-tile keeps a stable visual placeholder (other rules still
          // apply: role-hidden tiles short-circuit before we get here).
          if (selfTrackerHidden) {
            return (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                className="absolute -bottom-1 -left-1 pointer-events-none z-10 rounded-full overflow-hidden border-2 border-white/70 shadow-md w-7 h-7 sm:w-8 sm:h-8 bg-black/40"
                aria-label="你的投票（遊戲結束才揭曉）"
              >
                <img
                  src={getVoteBackUrl()}
                  alt=""
                  aria-hidden="true"
                  className="w-full h-full object-cover"
                  loading="lazy"
                  draggable={false}
                  onError={(e) => {
                    // eslint-disable-next-line no-console
                    console.warn('[asset miss] vote-back(self)', (e.target as HTMLImageElement).src);
                  }}
                />
              </motion.div>
            );
          }
          // In-flight branch: voting phase + this player has voted in *this*
          // round. Picks the painted token by `voted` (ternary: face-down for
          // others, own actual outcome for self).
          if (hasVoted) {
            const inFlightSrc =
              voted === undefined
                ? getVoteBackUrl()
                : voted
                ? VOTE_IMAGES.yes
                : VOTE_IMAGES.no;
            return (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                className="absolute -bottom-1 -left-1 pointer-events-none z-10 rounded-full overflow-hidden border-2 border-white/80 shadow-md w-7 h-7 sm:w-8 sm:h-8 bg-black/40"
                aria-label={
                  voted === undefined ? '已投票' : voted ? '贊成' : '反對'
                }
              >
                <img
                  src={inFlightSrc}
                  alt=""
                  aria-hidden="true"
                  className="w-full h-full object-cover"
                  loading="lazy"
                  draggable={false}
                  onError={(e) => {
                    // eslint-disable-next-line no-console
                    console.warn('[asset miss] vote-inflight', (e.target as HTMLImageElement).src);
                  }}
                />
              </motion.div>
            );
          }
          // Persistent branch: no in-flight vote, but a previous round resolved
          // for this player → keep showing the last outcome until next vote.
          if (lastVoteApproved !== undefined) {
            return (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                className="absolute -bottom-1 -left-1 pointer-events-none z-10 rounded-full overflow-hidden border-2 border-white/70 shadow-md w-7 h-7 sm:w-8 sm:h-8 bg-black/40"
                aria-label={lastVoteApproved ? '上輪贊成' : '上輪反對'}
              >
                <img
                  src={lastVoteApproved ? VOTE_IMAGES.yes : VOTE_IMAGES.no}
                  alt=""
                  aria-hidden="true"
                  className="w-full h-full object-cover"
                  loading="lazy"
                  draggable={false}
                  onError={(e) => {
                    // eslint-disable-next-line no-console
                    console.warn('[asset miss] vote-persistent', (e.target as HTMLImageElement).src);
                  }}
                />
              </motion.div>
            );
          }
          return null;
        })()}

        {/*
          Bot icon — Edward's 4-corner spec doesn't reserve a slot, so we tuck
          the 🤖 chip just to the right of the seat-number badge in the
          top-left cluster. Suppressed on role-hidden tiles (the unknown card
          intentionally hides identity hints; the operator can still spot bots
          via the lobby roster).
        */}
        {player.isBot && (
          <div
            className="absolute top-0 left-9 sm:left-11 bg-slate-900/80 border border-slate-500 rounded-full w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center pointer-events-none z-10 shadow-sm"
            aria-label="AI 玩家"
          >
            <span className="text-[10px] sm:text-xs leading-none">🤖</span>
          </div>
        )}

        {/*
          Edward 2026-04-25 22:04 game-end role-label chip. After the inline
          reveal panel was cut, PlayerCard owns the role-name display directly:
          a slim chip stacked just above the bottom name strip so the painted
          portrait + 角色名 + 玩家名 all read in a single glance. Active only
          when `endGameRoleLabel` is provided (GameBoard passes it iff
          room.state === 'ended'); transparent during normal gameplay so the
          square portrait stays uncluttered. Tinted by team — blue/red bg lets
          the rail summarise camp distribution at a glance.
        */}
        {endGameRoleLabel && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className={`absolute bottom-5 inset-x-1 pointer-events-none flex justify-center z-10`}
          >
            <span
              className={`max-w-full truncate rounded-md px-1.5 py-0.5 text-[10px] sm:text-[11px] font-bold leading-tight border ${
                effectiveTeam === 'evil'
                  ? 'bg-red-900/80 border-red-400 text-red-100'
                  : effectiveTeam === 'good'
                  ? 'bg-blue-900/80 border-blue-400 text-blue-100'
                  : 'bg-gray-900/80 border-gray-400 text-gray-100'
              }`}
              style={{ textShadow: '0 1px 2px rgba(0,0,0,0.85)' }}
            >
              {endGameRoleLabel}
            </span>
          </motion.div>
        )}

        {/*
          Edward 2026-04-25 22:04 game-end assassinated marker — painted card
          can't carry the dagger inside its portrait, so we stamp a red 🗡️
          chip in the top-right (overrides the lake disc since lady-of-the-lake
          phase is over by the time the game ends). Only renders when
          `assassinated` is true — purely informational.
        */}
        {assassinated && (
          <motion.div
            initial={{ scale: 0, rotate: -10 }}
            animate={{ scale: 1, rotate: 0 }}
            className="absolute -top-1 -right-1 bg-red-700 border-2 border-red-300 rounded-full w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center pointer-events-none shadow-md z-20"
            aria-label="被刺殺"
          >
            <span className="text-[14px] sm:text-base leading-none">🗡️</span>
          </motion.div>
        )}

        {/* Disconnected marker — overlays the seat row top-left so a dropped
            player flags as offline regardless of role-back state. Disconnected
            is a system status (not a corner indicator), so we deliberately
            keep it visible even when corner indicators are suppressed. Stays
            inside the tile (no spill) so it doesn't fight the lake disc when
            both happen on the same seat. */}
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
