import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Copy, ExternalLink, Sparkles } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import '../i18n/collab';
import { COLLAB_NS, GUIDE_URL, ISSUE_FORM_URL, REPO_URL } from '../i18n/collab';

/**
 * 用你的 AI 一起改百科（#collab；站長 2026-11-26：「所有人都可以開自己的 AI 下 prompt 協作」「網站上好像還沒有提供 GitHub 說明或連結」）。
 * 不用登入。說明文件：docs/ai/EXTERNAL_AI_COLLABORATION.md（啟動提示同一份）。
 */
export default function CollabPage(): JSX.Element {
  const { t } = useTranslation(COLLAB_NS);
  const setGameState = useGameStore((s) => s.setGameState);
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');

  const copyPrompt = (): void => {
    const done = (ok: boolean): void => {
      setCopy(ok ? 'done' : 'failed');
      window.setTimeout(() => setCopy('idle'), 2000);
    };
    const clip = navigator.clipboard;
    if (!clip) { done(false); return; }
    clip.writeText(t('prompt')).then(() => done(true), () => done(false));
  };

  const linkCls = 'inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 hover:text-white';
  const cardCls = 'rounded-xl border border-zinc-800 bg-zinc-900/80 p-3 sm:p-4';

  return (
    <div className="relative z-10 mx-auto max-w-3xl space-y-4 overflow-x-hidden px-3 py-4 text-white sm:px-4" data-testid="collab-page">
      <header className="space-y-1">
        <button
          type="button"
          onClick={() => { setGameState('home'); window.scrollTo({ top: 0 }); }}
          className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-white"
        >
          <ArrowLeft size={14} />{t('back')}
        </button>
        <h1 className="flex items-center gap-2 text-lg font-bold"><Sparkles size={20} className="text-amber-300" />{t('title')}</h1>
        <p className="text-xs leading-relaxed text-zinc-300">{t('intro')}</p>
      </header>

      <section className={cardCls}>
        <h2 className="mb-2 text-sm font-bold">{t('howTitle')}</h2>
        <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-zinc-300">
          <li>{t('how1')}</li>
          <li>{t('how2')}</li>
          <li>{t('how3')}</li>
        </ol>
      </section>

      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-bold">{t('rulesTitle')}</h2>
        <p className="text-xs leading-relaxed text-zinc-300">{t('rulesBody')}</p>
      </section>

      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-bold">{t('nextTitle')}</h2>
        <p className="text-xs leading-relaxed text-zinc-300">{t('nextBody')}</p>
      </section>

      <section className={cardCls} aria-label={t('promptTitle')}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-bold">{t('promptTitle')}</h2>
            <p className="text-xs text-zinc-400">{t('promptHint')}</p>
          </div>
          <button
            type="button"
            onClick={copyPrompt}
            data-testid="collab-copy"
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-700"
          >
            {copy === 'done' ? <Check size={14} className="text-emerald-300" /> : <Copy size={14} />}
            {copy === 'done' ? t('copied') : copy === 'failed' ? t('copyFailed') : t('copy')}
          </button>
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-black/60 p-3 text-xs leading-relaxed text-zinc-200">
          <code>{t('prompt')}</code>
        </pre>
      </section>

      <section className={cardCls}>
        <h2 className="mb-2 text-sm font-bold">{t('linksTitle')}</h2>
        <div className="flex flex-wrap gap-2">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={linkCls}><ExternalLink size={13} />{t('linkRepo')}</a>
          <a href={ISSUE_FORM_URL} target="_blank" rel="noopener noreferrer" className={linkCls}><ExternalLink size={13} />{t('linkForm')}</a>
          <a href={GUIDE_URL} target="_blank" rel="noopener noreferrer" className={linkCls}><ExternalLink size={13} />{t('linkGuide')}</a>
        </div>
      </section>
    </div>
  );
}
