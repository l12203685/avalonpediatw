import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, MessageCircle, X } from 'lucide-react';
import { ChatMessage } from '@avalon/shared';
import { sendChatMessage } from '../services/socket';
import { useGameStore } from '../store/gameStore';

interface ChatPanelProps {
  roomId: string;
  currentPlayerId: string;
  currentPlayerName: string;
}

export default function ChatPanel({
  roomId,
  currentPlayerId,
  currentPlayerName,
}: ChatPanelProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [unread, setUnread] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { chatMessages } = useGameStore();

  // Scroll to bottom on new messages
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setUnread(0);
    } else if (chatMessages.length > 0) {
      setUnread((n) => n + 1);
    }
  }, [chatMessages.length, isOpen]);

  const handleSend = () => {
    const msg = input.trim();
    if (!msg) return;
    try {
      sendChatMessage(roomId, msg);
    } catch {
      // Socket not connected in mock mode — silently ignore
    }
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  return (
    <>
      {/* Chat Toggle Button */}
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => { setIsOpen(true); setUnread(0); }}
        className="fixed bottom-6 right-6 z-30 bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-full shadow-lg flex items-center gap-2"
      >
        <MessageCircle size={20} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </motion.button>

      {/* Chat Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 40, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed bottom-20 right-6 z-30 w-80 bg-avalon-card border border-gray-600 rounded-xl shadow-2xl flex flex-col overflow-hidden"
            style={{ maxHeight: '420px' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-blue-900/50 border-b border-gray-600">
              <div className="flex items-center gap-2">
                <MessageCircle size={16} className="text-blue-400" />
                <span className="text-white font-semibold text-sm">聊天室</span>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0" style={{ maxHeight: '280px' }}>
              {chatMessages.length === 0 ? (
                <p className="text-gray-500 text-xs text-center py-4">尚無訊息</p>
              ) : (
                chatMessages.map((msg) => {
                  const isMe = msg.playerId === currentPlayerId;
                  return (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
                    >
                      {!isMe && (
                        <span className="text-xs text-gray-400 mb-1 ml-1">{msg.playerName}</span>
                      )}
                      <div
                        className={`max-w-[85%] px-3 py-2 rounded-xl text-sm ${
                          isMe
                            ? 'bg-blue-600 text-white rounded-br-sm'
                            : 'bg-gray-700 text-gray-100 rounded-bl-sm'
                        }`}
                      >
                        {msg.message}
                      </div>
                      <span className="text-xs text-gray-500 mt-0.5 mx-1">
                        {formatTime(msg.timestamp)}
                      </span>
                    </motion.div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="flex items-center gap-2 p-3 border-t border-gray-600">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="輸入訊息..."
                maxLength={200}
                className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-blue-500"
              />
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleSend}
                disabled={!input.trim()}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white p-2 rounded-lg transition-colors"
              >
                <Send size={16} />
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
