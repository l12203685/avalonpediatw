import { useTranslation } from 'react-i18next';
import { Bot, ChevronRight, Shield, Swords } from 'lucide-react';
import '../i18n/aiKnights';
import { AI_KNIGHTS_NS } from '../i18n/aiKnights';
import { openAiKnightsTab } from '../components/aiKnights/AiKnightsHub';

/**
 * 我的騎士（AI騎士團的分頁，#my-knight）。代理騎士（站長 2026-11-26：登入後用文字描述／回饋調自己的 AI騎士）還在做，
 * 這裡先說明會有什麼，並連到現在就能用的擂台與練習。
 */
export default function MyKnightPage(): JSX.Element {
  const { t } = useTranslation(AI_KNIGHTS_NS);
  const linkCls = 'flex w-full items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800';
  return (
    <div className="relative z-10 mx-auto max-w-4xl space-y-3 px-3 py-4 text-white sm:px-4" data-testid="my-knight-page">
      <section className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/80 p-3 sm:p-4">
        <h1 className="flex flex-wrap items-center gap-2 text-lg font-bold">
          <Shield size={20} className="text-amber-300" />{t('mine.title')}
          <span className="rounded-full border border-amber-400/60 px-2 py-0.5 text-[11px] font-semibold text-amber-200">{t('mine.soon')}</span>
        </h1>
        <p className="text-sm leading-relaxed text-zinc-200">{t('mine.body')}</p>
        <p className="text-xs leading-relaxed text-zinc-400">{t('mine.titles')}</p>
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-bold text-zinc-200">{t('mine.nowTitle')}</h2>
        <button type="button" className={linkCls} onClick={() => openAiKnightsTab('arena')} data-testid="my-knight-arena">
          <Swords size={16} className="flex-shrink-0 text-rose-300" /><span className="min-w-0 flex-1">{t('mine.nowArena')}</span>
          <ChevronRight size={16} className="flex-shrink-0 text-zinc-500" />
        </button>
        <button type="button" className={linkCls} onClick={() => openAiKnightsTab('practice')} data-testid="my-knight-practice">
          <Bot size={16} className="flex-shrink-0 text-sky-300" /><span className="min-w-0 flex-1">{t('mine.nowPractice')}</span>
          <ChevronRight size={16} className="flex-shrink-0 text-zinc-500" />
        </button>
      </section>
    </div>
  );
}
