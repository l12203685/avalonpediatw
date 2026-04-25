import { useState, useEffect, useRef, useMemo } from 'react';
import { Send, MessageSquare, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Room } from '@avalon/shared';
import { sendChatMessage, getSocket } from '../services/socket';
import { displaySeatNumber, seatOf } from '../utils/seatDisplay';

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
  const bottomRef = useRef<HTMLDivElement>(null);
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
      // Inline panel is always visible → don't accumulate unread badges.
      if (!isInline && !isOpen) setUnread(n => n + 1);
    };

    socket.on('chat:message-received', handler);
    return () => { socket!.off('chat:message-received', handler); };
  }, [isOpen, isInline]);

  // Synthesise system entries from room state. Compact Sheets-style format
  // (Edward 2026-04-25 14:57「系統: 3-2, 2: 2580, 5-, 9+」). Drops verbose
  // wording (隊長/派/贊成 K/N/通過-否決/異常)。Pure left-aligned row in render.
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

      out.push({
        id: `sys-vote-${v.round}-${v.attempt}-${idx}`,
        timestamp: room.createdAt + idx * 1000,
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
      out.push({
        id: `sys-quest-${q.round}-${idx}`,
        // Slot quest result just after that round's last vote attempt.
        timestamp: room.createdAt + (room.voteHistory.length + idx) * 1000 + 500,
        kind: 'system',
        text: `系統: R${q.round} 任務 ${teamDigits} ${cards}`,
      });
    });

    // Lady-of-the-Lake inspections → "系統: 湖 H>T o" (good) / "x" (evil) / "?" (undeclared)
    (room.ladyOfTheLakeHistory ?? []).forEach((l, idx) => {
      const holderSeat = seatOf(l.holderId, room.players);
      const targetSeat = seatOf(l.targetId, room.players);
      const holderLabel = holderSeat > 0 ? displaySeatNumber(holderSeat) : '?';
      const targetLabel = targetSeat > 0 ? displaySeatNumber(targetSeat) : '?';
      const claim = l.declared
        ? (l.declaredClaim === 'good' ? 'o' : 'x')
        : '?';
      out.push({
        id: `sys-lake-${l.round}-${idx}`,
        // Lake events happen between rounds — slot after quest results.
        timestamp: room.createdAt + (room.voteHistory.length + room.questHistory.length + idx) * 1000 + 800,
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
    return [...systemEntries, ...playerEntries].sort((a, b) => a.timestamp - b.timestamp);
  }, [systemEntries, messages, currentPlayerId]);

  // Scroll-to-bottom whenever the merged feed changes. For floating variant,
  // only when the panel is open; inline is always open so it always scrolls.
  useEffect(() => {
    if (isInline || isOpen) {
      if (!isInline) setUnread(0);
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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
  const messageList = (
    <>
      {merged.length === 0 && (
        <p className="text-center text-gray-600 text-xs py-4">{t('game:chat.noMessages')}</p>
      )}
      {merged.map(entry => {
        if (entry.kind === 'system') {
          return (
            <div key={entry.id} className="flex justify-start">
              <span className="text-[11px] text-lime-300/80 italic max-w-full break-words pl-1">
                {entry.text}
              </span>
            </div>
          );
        }
        const isMe = entry.isMe === true;
        return (
          <div key={entry.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
            {!isMe && entry.playerName && (
              <span className="text-xs text-gray-500 mb-0.5 ml-1">{entry.playerName}</span>
            )}
            <div className={`max-w-[85%] px-3 py-1.5 rounded-2xl text-sm break-words ${
              isMe
                ? 'bg-blue-600 text-white rounded-tr-sm'
                : 'bg-gray-700 text-gray-100 rounded-tl-sm'
            }`}>
              {entry.text}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </>
  );

  const inputForm = (placeholder: string) => (
    <div className="flex gap-2 p-2 border-t border-gray-700">
      <input
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleSend()}
        maxLength={200}
        placeholder={placeholder}
        className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
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
          <span className="text-xs font-bold text-gray-300 uppercase tracking-wider">
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
