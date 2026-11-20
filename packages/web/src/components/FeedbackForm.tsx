import { useState } from 'react';
import { Bug, BookOpen, Lightbulb, Loader, Send } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { submitFeedback } from '../services/api';
import { getStoredToken } from '../services/socket';
import { feedbackPage, rememberMyReport } from '../utils/reports';

/**
 * 問題回報的表單（右下角「問題回報」與「回報與修正」頁共用；站長 2026-11-19 把回報頁做成留言板）。
 * 送出 → POST /api/feedback → 伺服器貼到 LINE 群組和 DC #同步閒聊（「【百科回報・錯誤】#編號 …」），
 * 也會出現在網站「回報與修正」頁（不顯示暱稱）。編號記在這個瀏覽器，清單上標「你送的」。
 */

export type FeedbackType = 'bug' | 'suggestion' | 'content';

export const FEEDBACK_TYPES: { id: FeedbackType; label: string; Icon: typeof Bug; on: string; placeholder: string }[] = [
  { id: 'bug', label: '錯誤', Icon: Bug, on: 'bg-red-900/50 border-red-600 text-red-200', placeholder: '哪一頁、做了什麼、看到什麼，例如：牌譜紀錄在手機上表格超出畫面' },
  { id: 'content', label: '文章內容', Icon: BookOpen, on: 'bg-sky-900/50 border-sky-600 text-sky-200', placeholder: '哪篇文章、哪一段有誤或需要補充' },
  { id: 'suggestion', label: '建議', Icon: Lightbulb, on: 'bg-yellow-900/50 border-yellow-600 text-yellow-200', placeholder: '想看到什麼功能或改法' },
];

export default function FeedbackForm({ onSent, extra }: {
  /** 送出成功（id＝伺服器給的編號，沒貼到 DC 時 null）。 */
  onSent?: (id: string | null) => void;
  /** 說明文字上面要多放的東西（例如右下角的「ID 認領」連結）。 */
  extra?: JSX.Element;
}): JSX.Element {
  const addToast = useGameStore((s) => s.addToast);
  const gameState = useGameStore((s) => s.gameState);
  const [type, setType] = useState<FeedbackType>('bug');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const current = FEEDBACK_TYPES.find((t) => t.id === type) ?? FEEDBACK_TYPES[0];

  const handleSubmit = async (): Promise<void> => {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      const page = feedbackPage(window.location.pathname, window.location.hash, gameState);
      const { id } = await submitFeedback({ type, message: message.trim(), name: name.trim() || undefined, page }, getStoredToken() ?? undefined);
      if (id) rememberMyReport(id);
      addToast(id ? `已送出（編號 #${id}），謝謝！處理進度會寫在「回報與修正」頁` : '已送出，謝謝！管理者每天處理', 'success');
      setMessage('');
      onSent?.(id);
    } catch {
      addToast('送出失敗，請稍後再試，或在 LINE／DC 打 /回報 內容', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="feedback-form">
      <div className="flex gap-1.5">
        {FEEDBACK_TYPES.map(({ id, label, Icon, on }) => (
          <button
            key={id}
            type="button"
            onClick={() => setType(id)}
            aria-pressed={type === id}
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
        aria-label="回報內容"
        className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 p-2.5 text-sm text-white placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="暱稱（選填，只貼到 LINE／DC，網站上不顯示）"
        maxLength={32}
        aria-label="暱稱（選填）"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-white placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
      />
      {extra}
      <p className="text-xs leading-relaxed text-zinc-500">
        內容會貼到 LINE 群組和 DC 的「同步閒聊」（群組成員看得到暱稱），也會公開在網站「回報與修正」頁（不顯示暱稱）。
        請不要寫別人的名字或個人資料。管理者每天處理，修好會在那頁寫怎麼改的。也可以在 LINE 或 DC 打 /回報 內容。
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
    </div>
  );
}
