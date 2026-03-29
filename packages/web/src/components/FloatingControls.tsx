import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Volume2, VolumeX, Moon, Sun, Settings, Bug, Lightbulb, Send, Loader } from 'lucide-react';
import audioService from '../services/audio';
import themeService from '../services/theme';
import { useGameStore } from '../store/gameStore';
import { submitFeedback } from '../services/api';
import { getStoredToken } from '../services/socket';

type FeedbackType = 'bug' | 'suggestion';

export default function FloatingControls(): JSX.Element {
  const { addToast, gameState } = useGameStore();
  const [isOpen, setIsOpen]         = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(audioService.isEnabled());
  const [volume, setVolume]         = useState(audioService.getVolume());
  const [theme, setTheme]           = useState(themeService.getTheme());

  // Feedback form state
  const [feedbackOpen, setFeedbackOpen]   = useState(false);
  const [feedbackType, setFeedbackType]   = useState<FeedbackType>('bug');
  const [feedbackMsg, setFeedbackMsg]     = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);

  useEffect(() => {
    const unsubscribe = themeService.subscribe(() => {
      setTheme(themeService.getTheme());
    });
    return unsubscribe;
  }, []);

  const handleAudioToggle = () => {
    audioService.toggleAudio();
    setAudioEnabled(!audioEnabled);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    audioService.setVolume(newVolume);
    setVolume(newVolume);
  };

  const handleThemeToggle = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    themeService.setTheme(newTheme);
    setTheme(newTheme);
  };

  const handleFeedbackSubmit = async (): Promise<void> => {
    if (!feedbackMsg.trim()) return;
    setFeedbackSending(true);
    try {
      await submitFeedback(
        { type: feedbackType, message: feedbackMsg.trim(), gameState },
        getStoredToken() ?? undefined
      );
      addToast('感謝回報！我們會盡快處理', 'success');
      setFeedbackMsg('');
      setFeedbackOpen(false);
      setIsOpen(false);
    } catch {
      addToast('送出失敗，請稍後再試', 'error');
    } finally {
      setFeedbackSending(false);
    }
  };

  return (
    <div className="fixed bottom-6 left-6 z-50">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="absolute bottom-16 left-0 bg-avalon-card border border-gray-600 rounded-lg p-4 w-64 space-y-4 shadow-2xl"
          >
            {/* Audio Controls */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-white">音效</label>
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleAudioToggle}
                  className="p-1 rounded hover:bg-gray-700 transition-colors"
                >
                  {audioEnabled ? (
                    <Volume2 size={18} className="text-yellow-400" />
                  ) : (
                    <VolumeX size={18} className="text-gray-400" />
                  )}
                </motion.button>
              </div>

              {audioEnabled && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={volume}
                      onChange={handleVolumeChange}
                      className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-yellow-400"
                    />
                    <span className="text-xs text-gray-400 w-8 text-right">
                      {Math.round(volume * 100)}%
                    </span>
                  </div>
                </motion.div>
              )}
            </div>

            {/* Divider */}
            <div className="h-px bg-gray-700" />

            {/* Theme Controls */}
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold text-white">主題</label>
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleThemeToggle}
                className="p-1 rounded hover:bg-gray-700 transition-colors"
              >
                {theme === 'dark' ? (
                  <Moon size={18} className="text-blue-400" />
                ) : (
                  <Sun size={18} className="text-yellow-400" />
                )}
              </motion.button>
            </div>

            {/* Divider */}
            <div className="h-px bg-gray-700" />

            {/* Feedback section */}
            {!feedbackOpen ? (
              <button
                onClick={() => setFeedbackOpen(true)}
                className="w-full flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors py-0.5"
              >
                <Bug size={14} />
                回報問題 / 功能建議
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <button
                    onClick={() => setFeedbackType('bug')}
                    className={`flex-1 flex items-center justify-center gap-1 py-1 rounded text-xs font-semibold border transition-all ${
                      feedbackType === 'bug'
                        ? 'bg-red-900/50 border-red-600 text-red-300'
                        : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-white'
                    }`}
                  >
                    <Bug size={11} /> Bug
                  </button>
                  <button
                    onClick={() => setFeedbackType('suggestion')}
                    className={`flex-1 flex items-center justify-center gap-1 py-1 rounded text-xs font-semibold border transition-all ${
                      feedbackType === 'suggestion'
                        ? 'bg-yellow-900/50 border-yellow-600 text-yellow-300'
                        : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-white'
                    }`}
                  >
                    <Lightbulb size={11} /> 建議
                  </button>
                </div>
                <textarea
                  value={feedbackMsg}
                  onChange={e => setFeedbackMsg(e.target.value)}
                  placeholder={feedbackType === 'bug' ? '描述遇到的問題…' : '有什麼功能建議？'}
                  rows={3}
                  maxLength={500}
                  className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => { setFeedbackOpen(false); setFeedbackMsg(''); }}
                    className="flex-1 text-xs text-gray-500 hover:text-white py-1 transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleFeedbackSubmit}
                    disabled={!feedbackMsg.trim() || feedbackSending}
                    className="flex-1 flex items-center justify-center gap-1 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs font-semibold rounded transition-all"
                  >
                    {feedbackSending ? <Loader size={11} className="animate-spin" /> : <Send size={11} />}
                    送出
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main button */}
      <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => { setIsOpen(!isOpen); if (isOpen) { setFeedbackOpen(false); setFeedbackMsg(''); } }}
        className="w-14 h-14 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-lg flex items-center justify-center transition-all relative"
      >
        <motion.div
          animate={{ rotate: isOpen ? 90 : 0 }}
          transition={{ type: 'spring', stiffness: 200 }}
        >
          <Settings size={24} />
        </motion.div>

        {!isOpen && (
          <motion.div
            animate={{ scale: [1, 1.3, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="absolute inset-0 rounded-full border-2 border-blue-400 opacity-30"
          />
        )}
      </motion.button>
    </div>
  );
}
