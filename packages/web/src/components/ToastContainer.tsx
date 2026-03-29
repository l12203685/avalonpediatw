import { AnimatePresence, motion } from 'framer-motion';
import { X, AlertCircle, Info, CheckCircle } from 'lucide-react';
import { useGameStore, Toast } from '../store/gameStore';

function ToastItem({ toast }: { toast: Toast }): JSX.Element {
  const { removeToast } = useGameStore();

  const styles = {
    error:   { bg: 'bg-red-900/90 border-red-500',     icon: <AlertCircle size={18} className="text-red-400 shrink-0" /> },
    info:    { bg: 'bg-blue-900/90 border-blue-500',   icon: <Info         size={18} className="text-blue-400 shrink-0" /> },
    success: { bg: 'bg-green-900/90 border-green-500', icon: <CheckCircle  size={18} className="text-green-400 shrink-0" /> },
  }[toast.type];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 40, scale: 0.9 }}
      animate={{ opacity: 1, y: 0,  scale: 1   }}
      exit={{    opacity: 0, y: 20, scale: 0.9 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      className={`flex items-start gap-3 px-4 py-3 rounded-lg border backdrop-blur-sm shadow-xl max-w-sm w-full ${styles.bg}`}
    >
      {styles.icon}
      <p className="text-sm text-white flex-1 leading-snug">{toast.message}</p>
      <button
        onClick={() => removeToast(toast.id)}
        className="text-gray-400 hover:text-white transition-colors shrink-0"
        aria-label="關閉"
      >
        <X size={16} />
      </button>
    </motion.div>
  );
}

export default function ToastContainer(): JSX.Element {
  const { toasts } = useGameStore();

  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <ToastItem toast={toast} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
