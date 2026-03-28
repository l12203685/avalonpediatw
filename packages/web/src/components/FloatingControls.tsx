import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Volume2, VolumeX, Moon, Sun, Settings } from 'lucide-react';
import audioService from '../services/audio';
import themeService from '../services/theme';

export default function FloatingControls(): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(audioService.isEnabled());
  const [volume, setVolume] = useState(audioService.getVolume());
  const [theme, setTheme] = useState(themeService.getTheme());

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

  return (
    <div className="fixed bottom-6 right-6 z-50">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="absolute bottom-16 right-0 bg-avalon-card border border-gray-600 rounded-lg p-4 w-64 space-y-4 shadow-2xl"
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

            {/* Info */}
            <div className="text-xs text-gray-400 border-t border-gray-700 pt-2">
              <p>音效：{audioEnabled ? '開啟' : '關閉'}</p>
              <p>主題：{theme === 'dark' ? '深色' : '淺色'}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main button */}
      <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(!isOpen)}
        className="w-14 h-14 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-lg flex items-center justify-center transition-all relative"
      >
        <motion.div
          animate={{ rotate: isOpen ? 90 : 0 }}
          transition={{ type: 'spring', stiffness: 200 }}
        >
          <Settings size={24} />
        </motion.div>

        {/* Pulse animation when closed */}
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
