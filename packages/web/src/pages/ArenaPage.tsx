import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, ExternalLink, Loader2, RefreshCw, Swords, Trophy } from 'lucide-react';
import '../i18n/arena';
import { ARENA_NS } from '../i18n/arena';
import {
  BOTS_FOLDER_URL, BOTS_README_URL, TEMPLATE_URL, fetchLeaderboard, fmtInterval, fmtPct, fmtRating, knobLines,
  type ArenaBot, type ArenaLeaderboard,
} from '../utils/arena';

/**
 * AI 擂台（#arena；站長 2026-11-26「提供個人AI的雛形 … 以後就可以是一堆自建AI對戰」）。不用登入。
 * 排行榜在瀏覽器裡讀 GitHub main 上的 arena/leaderboard.json（每週由 arena-tournament workflow 產生）。
 * 說明文件：community-bots/README.md、docs/BOTS.md〈AI 擂台〉。
 */
export default function ArenaPage(): JSX.Element {
  const { t, i18n } = useTranslation(ARENA_NS);
  const lang: 'zh' | 'en' = i18n.language?.startsWith('en') ? 'en' : 'zh';
  const [board, setBoard] = useState<ArenaLeaderboard | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');

  const load = useCallback((signal?: AbortSignal) => {
    fetchLeaderboard(signal).then(
      (b) => { if (signal?.aborted) return; setBoard(b); setStatus(b ? 'ok' : 'failed'); },
      () => { if (!signal?.aborted) setStatus('failed'); },
    );
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return (): void => ctrl.abort();
  }, [load]);

  const knobs = knobLines(board?.knobCatalog, lang);
  const promptText = knobs ? `${t('prompt')}\n${knobs}` : t('prompt');

  const copyPrompt = (): void => {
    const done = (ok: boolean): void => {
      setCopy(ok ? 'done' : 'failed');
      window.setTimeout(() => setCopy('idle'), 2000);
    };
    const clip = navigator.clipboard;
    if (!clip) { done(false); return; }
    clip.writeText(promptText).then(() => done(true), () => done(false));
  };

  const linkCls = 'inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 hover:text-white';
  const cardCls = 'rounded-xl border border-zinc-800 bg-zinc-900/80 p-3 sm:p-4';

  return (
    <div className="relative z-10 mx-auto max-w-4xl space-y-4 overflow-x-hidden px-3 py-4 text-white sm:px-4" data-testid="arena-page">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-bold"><Swords size={20} className="text-rose-300" />{t('title')}</h1>
        <p className="text-xs leading-relaxed text-zinc-300">{t('intro')}</p>
      </header>

      <section className={cardCls} aria-label={t('boardTitle')} data-testid="arena-board">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-bold"><Trophy size={16} className="text-amber-300" />{t('boardTitle')}</h2>
          {status !== 'loading' && (
            <button type="button" onClick={() => { setStatus('loading'); load(); }} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-white">
              <RefreshCw size={12} />{t('retry')}
            </button>
          )}
        </div>
        <p className="mb-2 text-xs leading-relaxed text-zinc-400">{t('boardHint')}</p>
        {status === 'loading' && <p className="flex items-center gap-2 text-xs text-zinc-400"><Loader2 size={14} className="animate-spin" />{t('loading')}</p>}
        {status === 'failed' && <p className="text-xs text-zinc-400">{t('loadFailed')}</p>}
        {status === 'ok' && board && (
          <>
            <p className="mb-2 text-[11px] text-zinc-500">
              {t('updated', { date: board.generatedAt.slice(0, 10), games: board.games, sizes: board.sizes.join('/') })}
            </p>
            <BoardTable bots={board.bots} />
            <ul className="space-y-2 md:hidden">
              {board.bots.map((b) => <BotCard key={b.id} bot={b} />)}
            </ul>
          </>
        )}
      </section>

      <section className={cardCls}>
        <h2 className="mb-2 text-sm font-bold">{t('howTitle')}</h2>
        <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-zinc-300">
          <li>{t('how1')}</li>
          <li>{t('how2')}</li>
          <li className="break-words">{t('how3')}</li>
          <li>{t('how4')}</li>
        </ol>
      </section>

      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-bold">{t('rulesTitle')}</h2>
        <p className="text-xs leading-relaxed text-zinc-300">{t('rulesBody')}</p>
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
            data-testid="arena-copy"
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-700"
          >
            {copy === 'done' ? <Check size={14} className="text-emerald-300" /> : <Copy size={14} />}
            {copy === 'done' ? t('copied') : copy === 'failed' ? t('copyFailed') : t('copy')}
          </button>
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-black/60 p-3 text-xs leading-relaxed text-zinc-200">
          <code>{promptText}</code>
        </pre>
      </section>

      <section className={cardCls}>
        <h2 className="mb-2 text-sm font-bold">{t('linksTitle')}</h2>
        <div className="flex flex-wrap gap-2">
          <a href={BOTS_README_URL} target="_blank" rel="noopener noreferrer" className={linkCls}><ExternalLink size={13} />{t('linkReadme')}</a>
          <a href={TEMPLATE_URL} target="_blank" rel="noopener noreferrer" className={linkCls}><ExternalLink size={13} />{t('linkTemplate')}</a>
          <a href={BOTS_FOLDER_URL} target="_blank" rel="noopener noreferrer" className={linkCls}><ExternalLink size={13} />{t('linkFolder')}</a>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">{t('phase2')}</p>
      </section>
    </div>
  );
}

function BotName({ bot }: { bot: ArenaBot }): JSX.Element {
  const { t } = useTranslation(ARENA_NS);
  const tag = bot.source === 'reference' ? t('reference') : bot.source === 'example' ? t('example') : bot.title;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="font-semibold text-white">{bot.name}</span>
      {tag && <span className="rounded border border-zinc-700 px-1 text-[10px] text-zinc-400">{tag}</span>}
      {bot.author && (
        <a href={`https://github.com/${encodeURIComponent(bot.author)}`} target="_blank" rel="noopener noreferrer" className="text-[11px] text-sky-300 hover:underline">
          {t('by')} {bot.author}
        </a>
      )}
    </span>
  );
}

function BoardTable({ bots }: { bots: ArenaBot[] }): JSX.Element {
  const { t } = useTranslation(ARENA_NS);
  const th = 'px-2 py-1.5 text-left font-semibold text-zinc-400 whitespace-nowrap';
  const td = 'px-2 py-1.5 align-top whitespace-nowrap tabular-nums';
  return (
    <div className="hidden md:block">
      <table className="w-full border-collapse text-xs" data-testid="arena-table">
        <thead>
          <tr className="border-b border-zinc-800">
            <th className={th}>{t('colRank')}</th>
            <th className={th}>{t('colBot')}</th>
            <th className={th} title={t('ci')}>{t('colRating')}</th>
            <th className={th}>{t('colRed')}</th>
            <th className={th}>{t('colBlue')}</th>
            <th className={th}>{t('colRedWin')}</th>
            <th className={th}>{t('colBlueWin')}</th>
            <th className={th}>{t('colSeats')}</th>
          </tr>
        </thead>
        <tbody>
          {bots.map((b) => (
            <tr key={b.id} className="border-b border-zinc-800/60">
              <td className={td}>{b.rank}</td>
              <td className="px-2 py-1.5 align-top">
                <BotName bot={b} />
                <p className="mt-0.5 max-w-md text-[11px] leading-relaxed text-zinc-400">{b.source === 'reference' ? t('referenceStyle') : b.style}</p>
                <p className="mt-0.5 max-w-md break-words text-[10px] text-zinc-500">{b.knobs.length ? b.knobs.join('、') : t('noKnobs')}</p>
              </td>
              <td className={td}>
                <span className="font-semibold text-white">{fmtRating(b.rating.overall)}</span>
                {b.source !== 'reference' && <span className="block text-[10px] text-zinc-500">{fmtInterval(b.rating.overall)}</span>}
              </td>
              <td className={`${td} text-rose-200`}>{fmtRating(b.rating.red)}</td>
              <td className={`${td} text-sky-200`}>{fmtRating(b.rating.blue)}</td>
              <td className={td}>{fmtPct(b.red.winRate)}</td>
              <td className={td}>{fmtPct(b.blue.winRate)}</td>
              <td className={td}>{b.seats}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BotCard({ bot: b }: { bot: ArenaBot }): JSX.Element {
  const { t } = useTranslation(ARENA_NS);
  return (
    <li className="rounded-lg border border-zinc-800 bg-black/30 p-2.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="mr-1.5 text-zinc-500">#{b.rank}</span>
          <BotName bot={b} />
        </div>
        <div className="flex-shrink-0 text-right">
          <span className="text-base font-bold tabular-nums">{fmtRating(b.rating.overall)}</span>
          {b.source !== 'reference' && <span className="block text-[10px] text-zinc-500 tabular-nums">{fmtInterval(b.rating.overall)}</span>}
        </div>
      </div>
      <p className="mt-1 leading-relaxed text-zinc-400">{b.source === 'reference' ? t('referenceStyle') : b.style}</p>
      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums text-zinc-300">
        <span>{t('colRed')} <span className="text-rose-200">{fmtRating(b.rating.red)}</span></span>
        <span>{t('colBlue')} <span className="text-sky-200">{fmtRating(b.rating.blue)}</span></span>
        <span>{t('colRedWin')} {fmtPct(b.red.winRate)}</span>
        <span>{t('colBlueWin')} {fmtPct(b.blue.winRate)}</span>
        <span>{t('colSeats')} {b.seats}</span>
      </div>
      <p className="mt-1 break-words text-[10px] text-zinc-500">{t('knobs')}：{b.knobs.length ? b.knobs.join('、') : t('noKnobs')}</p>
    </li>
  );
}
