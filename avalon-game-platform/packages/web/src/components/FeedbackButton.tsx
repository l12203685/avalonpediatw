import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bug, Lightbulb, X, Send, Loader } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { submitFeedback } from '../services/api';
import { getStoredToken } from '../services/socket';

type FeedbackType = 'bug' | 'suggestion';

export default function FeedbackButton(): JSX.Element {
  const { addToast, gameState } = useGameStore();
  const [isOpen, setIsOpen]     = useState(false);
  const [type, setType]         = useState<FeedbackType>('bug');
  const [message, setMessage]   = useState('');
  const [sending, setSending]   = useState(false);

  const handleSubmit = async (): Promise<void> => {
    if (!message.trim()) return;
    setSending(true);
    try {
      await submitFeedback({ type, message: message.trim(), gameState }, getStoredToken() ?? undefined);
      addToast('感謝回報！我們會盡快處理', 'success');
      setMessage('');
      setIsOpen(false);
    } catch {
      addToast('送出失敗，請稍後再試', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed bottom-6 right-6 z-50">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.85, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.85, y: 16 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="absolute bottom-16 right-0 bg-avalon-card border border-gray-600 rounded-xl p-4 w-72 shadow-2xl space-y-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">問題回報 / 建議</h3>
              <button onClick={() => setIsOpen(false)} className="text-gray-500 hover:text-white">
                <X size={16} />
              </button>
            </div>

            {/* Type selector */}
            <div className="flex gap-2">
              <button
                onClick={() => setType('bug')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  type === 'bug'
                    ? 'bg-red-900/50 border-red-600 text-red-300'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
                }`}
              >
                <Bug size={12} /> Bug 回報
              </button>
              <button
                onClick={() => setType('suggestion')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  type === 'suggestion'
                    ? 'bg-yellow-900/50 border-yellow-600 text-yellow-300'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
                }`}
              >
                <Lightbulb size={12} /> 功能建議
              </button>
            </div>

            {/* Message */}
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder={type === 'bug' ? '描述遇到的問題，例如：點擊某按鈕後畫面凍結…' : '有什麼功能想要看到？'}
              rows={4}
              maxLength={500}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg p-2.5 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">{message.length}/500</span>
              <button
                onClick={handleSubmit}
                disabled={!message.trim() || sending}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-all"
              >
                {sending ? <Loader size={12} className="animate-spin" /> : <Send size={12} />}
                送出
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Trigger button */}
      <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(!isOpen)}
        title="回報問題 / 建議"
        className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all ${
          isOpen
            ? 'bg-gray-700 text-white'
            : 'bg-gray-800/80 border border-gray-600 text-gray-400 hover:text-white hover:border-gray-400'
        }`}
      >
        <Bug size={18} />
      </motion.button>
    </div>
  );
}
