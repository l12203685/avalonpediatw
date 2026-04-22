import { useState, useEffect, useRef } from 'react';
import { Send, MessageSquare, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { sendChatMessage, getSocket } from '../services/socket';

interface ChatMessage {
  id: string;
  roomId: string;
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
  isSystem?: boolean;
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
}

export default function ChatPanel({
  roomId,
  currentPlayerId,
  variant = 'floating',
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

  // Scroll-to-bottom whenever new messages arrive. For floating variant, only
  // when the panel is open; inline is always open so it always scrolls.
  useEffect(() => {
    if (isInline || isOpen) {
      if (!isInline) setUnread(0);
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isOpen, messages, isInline]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > 200) return;
    sendChatMessage(roomId, trimmed);
    setInput('');
  };

  // Message list + quick reactions + input form — shared between both variants so
  // the two render paths below only differ in their outer chrome.
  const messageList = (
    <>
      {messages.length === 0 && (
        <p className="text-center text-gray-600 text-xs py-4">{t('game:chat.noMessages')}</p>
      )}
      {messages.map(msg => {
        if (msg.isSystem) {
          return (
            <div key={msg.id} className="flex justify-center">
              <span className="text-xs text-gray-500 bg-gray-800/60 px-2 py-0.5 rounded-full italic">
                {msg.message}
              </span>
            </div>
          );
        }
        const isMe = msg.playerId === currentPlayerId;
        return (
          <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
            {!isMe && (
              <span className="text-xs text-gray-500 mb-0.5 ml-1">{msg.playerName}</span>
            )}
            <div className={`max-w-[85%] px-3 py-1.5 rounded-2xl text-sm break-words ${
              isMe
                ? 'bg-blue-600 text-white rounded-tr-sm'
                : 'bg-gray-700 text-gray-100 rounded-tl-sm'
            }`}>
              {msg.message}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </>
  );

  const quickReactions = (
    <div className="flex gap-1.5 px-2 pt-2 pb-1 border-t border-gray-700/50 flex-wrap">
      {['👍', '👎', '🤔', '😱', '🎭', '🗡️'].map(emoji => (
        <button
          key={emoji}
          onClick={() => sendChatMessage(roomId, emoji)}
          className="text-base hover:scale-125 transition-transform leading-none px-1 py-0.5 rounded hover:bg-gray-700"
          title={emoji}
        >
          {emoji}
        </button>
      ))}
    </div>
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
      <div className="h-full min-h-0 flex flex-col bg-avalon-card/50 border border-gray-700 rounded-lg overflow-hidden">
        {/* Header — aligned with CompactScoresheet header chrome (#83 polish): same
            px-3 py-2 padding, same border-b tone, same text-sm font-bold so the two
            slots read as a matched pair in the center column 2-col block. */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700/50 bg-black/20">
          <span className="text-sm font-bold text-gray-300 flex items-center gap-1.5">
            <MessageSquare size={14} className="-mt-0.5" />
            {t('game:chat.inlineTitle')}
          </span>
          <span className="text-[10px] text-gray-500">{messages.length}</span>
        </div>

        {/* Messages — flex-1 so the input sticks to the bottom */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
          {messageList}
        </div>

        {quickReactions}
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

            {quickReactions}
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
