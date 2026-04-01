import { useState, useEffect, useRef } from 'react';
import { Send, MessageSquare, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
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
}

export default function ChatPanel({ roomId, currentPlayerId }: ChatPanelProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let socket: ReturnType<typeof getSocket> | null = null;
    try {
      socket = getSocket();
    } catch {
      return;
    }

    const handler = (msg: ChatMessage) => {
      setMessages(prev => [...prev, msg]);
      if (!isOpen) setUnread(n => n + 1);
    };

    socket.on('chat:message-received', handler);
    return () => { socket!.off('chat:message-received', handler); };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setUnread(0);
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isOpen, messages]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > 200) return;
    sendChatMessage(roomId, trimmed);
    setInput('');
  };

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
              <span className="text-sm font-bold text-white">遊戲聊天</span>
              <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-white">
                <ChevronDown size={16} />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0" style={{ maxHeight: '280px' }}>
              {messages.length === 0 && (
                <p className="text-center text-gray-600 text-xs py-4">還沒有訊息</p>
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
            </div>

            {/* Quick reactions */}
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

            {/* Input */}
            <div className="flex gap-2 p-2 border-t border-gray-700">
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                maxLength={200}
                placeholder="輸入訊息…"
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
