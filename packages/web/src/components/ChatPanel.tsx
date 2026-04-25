import { useState, useEffect, useRef, useMemo } from 'react';
import { Send, MessageSquare, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Room } from '@avalon/shared';
import { sendChatMessage, getSocket } from '../services/socket';
import { displaySeatNumber, seatOf } from '../utils/seatDisplay';
import { useChatStore } from '../store/chatStore';

interface ChatMessage {
  id: string;
  roomId: string;
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
  isSystem?: boolean;
}

/**
 * Unified merged-feed entry. Combines system events (synthesised from
 * `room.voteHistory` + `room.questHistory` + `room.ladyOfTheLakeHistory`) and
 * live player chat messages into a single chronological timeline so the
 * player no longer needs two side-by-side panels (#107 follow-up — Edward
 * 2026-04-25「兩個對話紀錄窗還是分開的」).
 */
interface UnifiedEntry {
  id: string;
  timestamp: number;
  kind: 'system' | 'player';
  text: string;
  /** Player-only — sender id (for self vs other styling). */
  playerId?: string;
  /** Player-only — display name shown above the bubble. */
  playerName?: string;
  /** Player-only — true when the sender is the local player. */
  isMe?: boolean;
}

interface ChatPanelProps {
  roomId: string;
  currentPlayerId: string;
  /**
   * Layout mode.
   * - `floating` (default): fixed bottom-right toggleable bubble — preserves the
   *   original behavior so non-game pages (lobby) keep the chat launcher.
   * - `inline`: fills its parent flex container (no fixed positioning, no toggle,
   *   no header close button). Used inside GameBoard's center column for #83
   *   Phase 5 so chat docks alongside the scoresheet.
   */
  variant?: 'floating' | 'inline';
  /**
   * Optional room snapshot. When provided, ChatPanel synthesises system
   * entries (vote summaries, quest results, lake events) from history fields
   * and merges them into the same timeline as live chat messages, producing
   * a single unified panel. When omitted (e.g. lobby launcher), only live
   * chat messages render — preserving backward compatibility.
   */
  room?: Room;
}

/**
 * Sort seats in canonical Avalon order — 1..9 ascending, with seat 10 last
 * (rendered as "0"). Returns the concatenated digit string. Mirrors the
 * helper that previously lived in FullScoresheetLayout.
 */
function formatSeatsDigitString(seats: number[]): string {
  const sorted = [...seats].sort((a, b) => a - b);
  return sorted.map(displaySeatNumber).join('');
}

/**
 * Format anomaly votes for the chat log. "Inner black" = team members who
 * voted reject; "outer white" = non-team members who voted approve. Both lists
 * render as a digit string + sign, separated by a space.
 */
function formatAnomalyVotes(innerBlack: number[], outerWhite: number[]): string {
  const parts: string[] = [];
  if (innerBlack.length > 0) parts.push(`${formatSeatsDigitString(innerBlack)}-`);
  if (outerWhite.length > 0) parts.push(`${formatSeatsDigitString(outerWhite)}+`);
  return parts.join(' ');
}

export default function ChatPanel({
  roomId,
  currentPlayerId,
  variant = 'floating',
  room,
}: ChatPanelProps): JSX.Element {
  const { t } = useTranslation(['game']);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  // Floating: panel toggles open/closed. Inline: always "open" — we render the
  // body unconditionally so unread tracking is unnecessary.
  const [isOpen, setIsOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  // Edward 2026-04-25 GamePage 4-revamp:「對話紀錄最新顯示在最上面」.
  // Newest messages render at the TOP of the list. We sort the merged feed
  // descending and use `topRef` to anchor scroll-to-top whenever a new entry
  // arrives (mirrors the pre-revamp scroll-to-bottom UX, but flipped).
  const topRef = useRef<HTMLDivElement>(null);
  const isInline = variant === 'inline';

  useEffect(() => {
    let socket: ReturnType<typeof getSocket> | null = null;
    try {
      socket = getSocket();
    } catch {
      return;
    }

    const handler = (msg: ChatMessage) => {
      setMessages(prev => [...prev, msg]);
      // Edward 2026-04-25 19:40: mirror non-system messages into chatStore so
      // PlayerCard can render a transient chat-bubble overlay below the
      // avatar. System messages skipped so synthesised vote/quest/lake
      // narration doesn't pop up on individual seats.
      if (!msg.isSystem && msg.playerId) {
        useChatStore.getState().setLatestMessage(msg.playerId, msg.message, msg.timestamp);
      }
      // Inline panel is always visible → don't accumulate unread badges.
      if (!isInline && !isOpen) setUnread(n => n + 1);
    };

    socket.on('chat:message-received', handler);
    return () => { socket!.off('chat:message-received', handler); };
  }, [isOpen, isInline]);

  // Synthesise system entries from room state. Compact Sheets-style format
  // (Edward 2026-04-25 14:57「系統: 3-2, 2: 2580, 5-, 9+」). Drops verbose
  // wording (隊長/派/贊成 K/N/通過-否決/異常)。Pure left-aligned row in render.
  //
  // Edward 2026-04-26 00:40 fix (Bug 6): all system events must render in
  // chronological round order — `R1 votes → R1 quest → R1 lake → R2 votes …`
  // — instead of grouping all votes first, then all quests, then all lake
  // events. Synthetic timestamps are derived from each record's `round` /
  // `attempt` so the merge sort lays them out as the round actually played
  // (not by their array index in `voteHistory` / `questHistory` /
  // `ladyOfTheLakeHistory`). The resulting key order per-round is:
  //   round*BASE + 0..50  → vote attempts (1..5)
  //   round*BASE + 60     → quest result (after the final vote attempt)
  //   round*BASE + 80     → lake declaration (between rounds)
  // BASE = 100 keeps a wide margin for future per-round events.
  const ROUND_BASE_MS = 100;
  const systemEntries = useMemo<UnifiedEntry[]>(() => {
    if (!room) return [];
    const out: UnifiedEntry[] = [];

    // Vote attempts → "系統: R-A, L: TEAM, IB-, OW+"
    room.voteHistory.forEach((v, idx) => {
      const teamSeats = v.team
        .map((pid) => seatOf(pid, room.players))
        .filter((s) => s > 0);
      const teamDigits = formatSeatsDigitString(teamSeats);

      const teamSet = new Set(v.team);
      const innerBlackSeats: number[] = [];
      const outerWhiteSeats: number[] = [];
      Object.entries(v.votes).forEach(([pid, approve]) => {
        const seat = seatOf(pid, room.players);
        if (seat <= 0) return;
        const onTeam = teamSet.has(pid);
        if (onTeam && !approve) innerBlackSeats.push(seat);
        else if (!onTeam && approve) outerWhiteSeats.push(seat);
      });
      const anomaly = formatAnomalyVotes(innerBlackSeats, outerWhiteSeats);

      const leaderSeat = seatOf(v.leader, room.players);
      const leaderLabel = leaderSeat > 0 ? displaySeatNumber(leaderSeat) : '?';

      const parts: string[] = [
        `${v.round}-${v.attempt}`,
        `${leaderLabel}: ${teamDigits}`,
      ];
      if (anomaly) parts.push(anomaly);

      // Slot vote attempts within their round (1..5 → +10..+50).
      out.push({
        id: `sys-vote-${v.round}-${v.attempt}-${idx}`,
        timestamp: room.createdAt + v.round * ROUND_BASE_MS + v.attempt * 10,
        kind: 'system',
        text: `系統: ${parts.join(', ')}`,
      });
    });

    // Quest outcomes → "系統: R1 任務 245 ooo" or "系統: R1 任務 245 oox" (per-card)
    room.questHistory.forEach((q, idx) => {
      const teamSeats = q.team
        .map((pid) => seatOf(pid, room.players))
        .filter((s) => s > 0);
      const teamDigits = formatSeatsDigitString(teamSeats);
      const successCount = Math.max(0, q.team.length - q.failCount);
      const cards = 'o'.repeat(successCount) + 'x'.repeat(q.failCount);
      // Quest sits after the final vote attempt for this round (+60).
      out.push({
        id: `sys-quest-${q.round}-${idx}`,
        timestamp: room.createdAt + q.round * ROUND_BASE_MS + 60,
        kind: 'system',
        text: `系統: R${q.round} 任務 ${teamDigits} ${cards}`,
      });
    });

    // Lady-of-the-Lake inspections → "系統: 湖 H>T o" (good) / "x" (evil) / "?" (undeclared)
    // Edward 2026-04-26 00:40 fix (Bug 5): show declared claim ('o'/'x') when
    // the holder has publicly declared. Backend `LadyOfTheLakeRecord.declared`
    // / `declaredClaim` are populated by `GameEngine.declareLakeResult`; the
    // server-side sanitise step preserves both fields for non-holders too
    // (only `result` is masked). When `declared` is false (e.g. holder
    // skipped or AFK timeout fired) we render '?' so the absence of an
    // explicit claim is still legible.
    (room.ladyOfTheLakeHistory ?? []).forEach((l, idx) => {
      const holderSeat = seatOf(l.holderId, room.players);
      const targetSeat = seatOf(l.targetId, room.players);
      const holderLabel = holderSeat > 0 ? displaySeatNumber(holderSeat) : '?';
      const targetLabel = targetSeat > 0 ? displaySeatNumber(targetSeat) : '?';
      const claim = l.declared
        ? (l.declaredClaim === 'good' ? 'o' : 'x')
        : '?';
      // Lake events happen between rounds — slot after the round's quest (+80).
      out.push({
        id: `sys-lake-${l.round}-${idx}`,
        timestamp: room.createdAt + l.round * ROUND_BASE_MS + 80,
        kind: 'system',
        text: `系統: 湖 ${holderLabel}>${targetLabel} ${claim}`,
      });
    });

    return out;
  }, [room]);

  // Merge system entries + live player messages into a single chronological
  // feed. Sort is stable for system entries (synthetic timestamps already
  // monotonic) and respects real timestamps for player messages.
  const merged = useMemo<UnifiedEntry[]>(() => {
    const playerEntries: UnifiedEntry[] = messages.map((m) => ({
      id: m.id,
      timestamp: m.timestamp,
      // Server-tagged system messages keep their classification too.
      kind: m.isSystem ? 'system' : 'player',
      text: m.message,
      playerId: m.isSystem ? undefined : m.playerId,
      playerName: m.isSystem ? undefined : m.playerName,
      isMe: m.isSystem ? false : m.playerId === currentPlayerId,
    }));
    // Newest first — Edward 2026-04-25 4-revamp #3「對話紀錄最新顯示在最上面」.
    // Sort descending so merged[0] is the most recent entry; render order in
    // the messageList JSX walks merged top-down, so newest sits at the top
    // of the column.
    return [...systemEntries, ...playerEntries].sort((a, b) => b.timestamp - a.timestamp);
  }, [systemEntries, messages, currentPlayerId]);

  // Scroll-to-top whenever the merged feed changes (newest is at the top now).
  // For floating variant, only when the panel is open; inline is always open
  // so it always scrolls.
  useEffect(() => {
    if (isInline || isOpen) {
      if (!isInline) setUnread(0);
      topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isOpen, merged, isInline]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > 200) return;
    sendChatMessage(roomId, trimmed);
    setInput('');
  };

  // Unified message list — Edward 2026-04-25 14:57 chat layout spec:
  //   • 自己發言：靠右 (blue bubble)
  //   • 其他玩家：靠左 (gray bubble)
  //   • 系統訊息：靠左 (compact lime chip, no bubble) — Sheets-style row
  // 2026-04-25 4-revamp #3: newest renders at TOP — `topRef` anchor sits
  // before the merged map so auto-scroll lands on the newest entry.
  const messageList = (
    <>
      <div ref={topRef} />
      {merged.length === 0 && (
        <p className="text-center text-gray-600 text-[11px] py-4">{t('game:chat.noMessages')}</p>
      )}
      {merged.map(entry => {
        if (entry.kind === 'system') {
          return (
            <div key={entry.id} className="flex justify-start">
              <span className="text-[10px] text-lime-300/80 italic max-w-full break-words pl-1">
                {entry.text}
              </span>
            </div>
          );
        }
        const isMe = entry.isMe === true;
        return (
          <div key={entry.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
            {!isMe && entry.playerName && (
              <span className="text-[10px] text-gray-500 mb-0.5 ml-1">{entry.playerName}</span>
            )}
            <div className={`max-w-[85%] px-3 py-1.5 rounded-2xl text-xs break-words ${
              isMe
                ? 'bg-blue-600 text-white rounded-tr-sm'
                : 'bg-gray-700 text-gray-100 rounded-tl-sm'
            }`}>
              {entry.text}
            </div>
          </div>
        );
      })}
    </>
  );

  // Edward 2026-04-25 22:38 GamePage 3-fix #1「發言送出按鈕被擋住」: chat input
  // form was visually colliding with the sticky-bottom action toolbars
  // (QuestTeamToolbar/VotePanel/QuestPanel, all z-40 fixed bottom-0). The
  // GameBoard wrapper reserves `pb-[32dvh]` for those toolbars, but on tall
  // QuestPanel renders or after iOS safe-area inset the chat input could end
  // up behind the toolbar. Defensive fix: anchor the input to the bottom of
  // its own scroll container (sticky bottom-0) and give it a positioned
  // z-stacking context (z-10) so it stays clickable inside the chat box even
  // when the surrounding feed scrolls. The opaque bg ensures messages
  // scrolling behind don't bleed through.
  const inputForm = (placeholder: string) => (
    <div className="sticky bottom-0 z-10 flex gap-2 p-2 border-t border-gray-700 bg-slate-900/95 backdrop-blur-sm">
      <input
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleSend()}
        maxLength={200}
        placeholder={placeholder}
        className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
      />
      <button
        onClick={handleSend}
        disabled={!input.trim()}
        className="p-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg text-white transition-colors"
      >
        <Send size={14} />
      </button>
    </div>
  );

  // Inline variant — docks into a flex container (e.g. GameBoard center column).
  // No fixed positioning, no open/close toggle, no unread badge. Fills parent
  // height and uses a translucent background so it blends with the board chrome.
  if (isInline) {
    return (
      <div className="h-full min-h-0 flex flex-col bg-slate-800/50 border border-gray-700/60 rounded-xl overflow-hidden">
        {/* Header — shorter than floating, no close button */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700/60 bg-black/20">
          <span className="text-[11px] font-bold text-gray-300 uppercase tracking-wider">
            {t('game:chat.inlineTitle')}
          </span>
          <span className="text-[10px] text-gray-500">{merged.length}</span>
        </div>

        {/* Messages — flex-1 so the input sticks to the bottom */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
          {messageList}
        </div>

        {inputForm(t('game:chat.inlinePlaceholder'))}
      </div>
    );
  }

  // Floating variant — default, fixed bottom-right bubble with toggle.
  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      {/* Chat window */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="bg-avalon-card border border-gray-600 rounded-xl shadow-2xl w-80 flex flex-col overflow-hidden"
            style={{ maxHeight: '380px' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-black/30">
              <span className="text-sm font-bold text-white">{t('game:chat.title')}</span>
              <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-white">
                <ChevronDown size={16} />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0" style={{ maxHeight: '280px' }}>
              {messageList}
            </div>

            {inputForm(t('game:chat.inputPlaceholder'))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toggle button */}
      <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(v => !v)}
        className="relative bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-full shadow-lg transition-colors"
      >
        <MessageSquare size={20} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </motion.button>
    </div>
  );
}
