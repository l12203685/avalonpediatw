import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bug, BookOpen, ExternalLink, Flag, Lightbulb, Loader, Send, UserCheck, X } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { submitFeedback } from '../services/api';
import { getStoredToken } from '../services/socket';

/**
 * 問題回報（Edward 2026-11-02：「DC + 百科網站上用個類似錯誤或是反映問題回報專區」）。
 * 內容頁右下角的按鈕；送出後伺服器在 DC 論壇 #百科問題回報 開一篇（標籤＝類型），管理者每天收一次、在討論串回覆處理結果。
 * 論壇在 DC 群組裡公開，所以表單上講清楚，暱稱選填（不帶登入帳號名稱）；頁面欄自動帶目前網址的路徑與 #。
 */

type FeedbackType = 'bug' | 'suggestion' | 'content';

export const FEEDBACK_FORUM_URL = 'https://discord.com/channels/1132682489840812113/1566833113248571514';

const TYPES: { id: FeedbackType; label: string; Icon: typeof Bug; on: string; placeholder: string }[] = [
  { id: 'bug', label: '錯誤', Icon: Bug, on: 'bg-red-900/50 border-red-600 text-red-200', placeholder: '哪一頁、做了什麼、看到什麼，例如：牌譜紀錄在手機上表格超出畫面' },
  { id: 'content', label: '文章內容', Icon: BookOpen, on: 'bg-sky-900/50 border-sky-600 text-sky-200', placeholder: '哪篇文章、哪一段有誤或需要補充' },
  { id: 'suggestion', label: '建議', Icon: Lightbulb, on: 'bg-yellow-900/50 border-yellow-600 text-yellow-200', placeholder: '想看到什麼功能或改法' },
];

export default function FeedbackButton(): JSX.Element {
  const addToast = useGameStore((s) => s.addToast);
  const setGameState = useGameStore((s) => s.setGameState);
  const [isOpen, setIsOpen] = useState(false);
  const [type, setType] = useState<FeedbackType>('bug');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const current = TYPES.find((t) => t.id === type) ?? TYPES[0];

  const handleSubmit = async (): Promise<void> => {
    if (!message.trim()) return;
    setSending(true);
    try {
      const page = `${window.location.pathname}${window.location.hash}`;
      await submitFeedback({ type, message: message.trim(), name: name.trim() || undefined, page }, getStoredToken() ?? undefined);
      addToast('已送出，謝謝！處理結果會回覆在 DC 的百科問題回報', 'success');
      setMessage('');
      setIsOpen(false);
    } catch {
      addToast('送出失敗，請稍後再試，或直接到 DC 的百科問題回報發文', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 pb-safe" data-testid="feedback">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 12 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="absolute bottom-14 right-0 w-[min(20rem,calc(100vw-2rem))] space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">問題回報</h3>
              <button type="button" onClick={() => setIsOpen(false)} aria-label="關閉" className="text-zinc-500 hover:text-white">
                <X size={16} />
              </button>
            </div>

            <div className="flex gap-1.5">
              {TYPES.map(({ id, label, Icon, on }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setType(id)}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-lg border py-1.5 text-xs font-semibold transition ${
                    type === id ? on : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white'
                  }`}
                >
                  <Icon size={12} /> {label}
                </button>
              ))}
            </div>

            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={current.placeholder}
              rows={4}
              maxLength={1000}
              className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 p-2.5 text-sm text-white placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="暱稱（選填，方便回覆你）"
              maxLength={32}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-white placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => { setIsOpen(false); setGameState('idClaim'); window.scrollTo({ top: 0 }); }}
              data-testid="feedback-id-claim"
              className="flex w-full items-center gap-1 text-left text-xs text-emerald-300 hover:text-emerald-200"
            >
              <UserCheck size={12} className="flex-shrink-0" /> 紀錄裡你用過好幾個 ID？用「ID 認領」請管理者合併
            </button>
            <p className="text-xs leading-relaxed text-zinc-500">
              會貼到 DC 的「百科問題回報」（群組成員都看得到），管理者每天處理並在那裡回覆。
              <a href={FEEDBACK_FORUM_URL} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-sky-400 hover:text-sky-300">
                到 DC 看回報 <ExternalLink size={10} />
              </a>
            </p>
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-600">{message.length}/1000</span>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!message.trim() || sending}
                className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-700 disabled:opacity-40"
              >
                {sending ? <Loader size={12} className="animate-spin" /> : <Send size={12} />}
                送出
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        title="問題回報"
        aria-label="問題回報"
        className={`flex h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-lg transition ${
          isOpen ? 'border-zinc-500 bg-zinc-700 text-white' : 'border-zinc-700 bg-zinc-900/90 text-zinc-300 hover:border-zinc-500 hover:text-white'
        }`}
      >
        <Flag size={16} />
        問題回報
      </button>
    </div>
  );
}
