import { AnimatePresence, motion } from 'framer-motion';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { useToastStore, Toast } from '../store/toastStore';

const TOAST_STYLES: Record<Toast['type'], { bg: string; border: string; icon: JSX.Element }> = {
  success: {
    bg: 'bg-green-900/90',
    border: 'border-green-500',
    icon: <CheckCircle size={18} className="text-green-400 shrink-0" />,
  },
  error: {
    bg: 'bg-red-900/90',
    border: 'border-red-500',
    icon: <AlertCircle size={18} className="text-red-400 shrink-0" />,
  },
  info: {
    bg: 'bg-blue-900/90',
    border: 'border-blue-500',
    icon: <Info size={18} className="text-blue-400 shrink-0" />,
  },
  warning: {
    bg: 'bg-yellow-900/90',
    border: 'border-yellow-500',
    icon: <AlertTriangle size={18} className="text-yellow-400 shrink-0" />,
  },
};

export default function ToastContainer(): JSX.Element {
  const { toasts, removeToast } = useToastStore();

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-sm w-full">
      <AnimatePresence>
        {toasts.map((toast) => {
          const style = TOAST_STYLES[toast.type];
          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 80, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 80, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-lg border backdrop-blur-sm shadow-lg ${style.bg} ${style.border}`}
            >
              {style.icon}
              <p className="text-white text-sm flex-1 leading-snug">{toast.message}</p>
              <button
                onClick={() => removeToast(toast.id)}
                className="text-gray-400 hover:text-white transition-colors shrink-0 mt-0.5"
              >
                <X size={16} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
