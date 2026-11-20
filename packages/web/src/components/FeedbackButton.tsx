import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, ClipboardList, ExternalLink, Flag, UserCheck, X } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import FeedbackForm from './FeedbackForm';

/**
 * 問題回報（Edward 2026-11-02：「DC + 百科網站上用個類似錯誤或是反映問題回報專區」）。
 * 內容頁右下角的按鈕；送出後伺服器貼到 LINE 群組和 DC #同步閒聊（「【百科回報・錯誤】#編號 …」，2026-11-09 起；
 * 舊的 DC 論壇 #百科問題回報 已刪除），管理者每天處理。也可以直接在 LINE／DC 打 /回報。
 * 兩邊都公開，所以表單上講清楚，暱稱選填（不帶登入帳號名稱）；頁面欄自動帶目前網址的路徑與 #（沒有 # 時帶現在的頁面）。
 * 2026-11-19（站長：「bug 修正可以直接呈現在百科網站上嗎? (留言功能)」）：表單抽成 FeedbackForm，送出後顯示編號與
 * 「回報與修正」頁的連結（#reports；處理狀態、怎麼修的都在那裡）。
 */

/** DC #同步閒聊（跟 LINE 群組同步的頻道；回報與 ID 認領都貼在這裡）。 */
export const SYNC_CHANNEL_URL = 'https://discord.com/channels/1132682489840812113/1132901301802504242';

export default function FeedbackButton(): JSX.Element {
  const setGameState = useGameStore((s) => s.setGameState);
  const [isOpen, setIsOpen] = useState(false);
  /** 剛送出：undefined＝還在填，null＝送出了但沒有編號，字串＝編號。 */
  const [sent, setSent] = useState<string | null | undefined>(undefined);

  const openReports = (): void => {
    setIsOpen(false);
    setSent(undefined);
    setGameState('reports');
    window.scrollTo({ top: 0 });
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
            className="absolute bottom-14 right-0 max-h-[calc(100dvh-6rem)] w-[min(20rem,calc(100vw-2rem))] space-y-3 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">問題回報</h3>
              <button type="button" onClick={() => { setIsOpen(false); setSent(undefined); }} aria-label="關閉" className="text-zinc-500 hover:text-white">
                <X size={16} />
              </button>
            </div>

            {sent !== undefined ? (
              <div className="space-y-3" data-testid="feedback-sent">
                <p className="flex items-start gap-1.5 text-sm text-emerald-200">
                  <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
                  <span>已送出，謝謝！{sent ? <>編號 <span className="font-mono">#{sent}</span>。</> : null}管理者每天處理，修好會寫在「回報與修正」頁。</span>
                </p>
                <button
                  type="button"
                  onClick={openReports}
                  data-testid="feedback-open-reports"
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600"
                >
                  <ClipboardList size={14} /> 看「回報與修正」的處理進度
                </button>
                <button type="button" onClick={() => setSent(undefined)} className="w-full text-center text-xs text-zinc-400 hover:text-white">
                  再回報一則
                </button>
              </div>
            ) : (
              <FeedbackForm
                onSent={(id) => setSent(id)}
                extra={(
                  <div className="space-y-1.5">
                    <button
                      type="button"
                      onClick={openReports}
                      data-testid="feedback-reports-link"
                      className="flex w-full items-center gap-1 text-left text-xs text-sky-300 hover:text-sky-200"
                    >
                      <ClipboardList size={12} className="flex-shrink-0" /> 看大家回報了什麼、修好了沒：「回報與修正」
                    </button>
                    <button
                      type="button"
                      onClick={() => { setIsOpen(false); setGameState('idClaim'); window.scrollTo({ top: 0 }); }}
                      data-testid="feedback-id-claim"
                      className="flex w-full items-center gap-1 text-left text-xs text-emerald-300 hover:text-emerald-200"
                    >
                      <UserCheck size={12} className="flex-shrink-0" /> 紀錄裡你用過好幾個 ID？用「ID 認領」請管理者合併
                    </button>
                    <a href={SYNC_CHANNEL_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-xs text-zinc-400 hover:text-zinc-200">
                      到 DC 同步閒聊 <ExternalLink size={10} />
                    </a>
                  </div>
                )}
              />
            )}
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
