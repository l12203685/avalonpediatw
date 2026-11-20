import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ClipboardList, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import FeedbackForm from '../components/FeedbackForm';
import { fetchReports, reportsErrorText } from '../services/reports';
import {
  REPORT_STATUS_HINT, REPORT_STATUS_ORDER, REPORT_STATUS_STYLE, SOURCE_LABEL, countByStatus, filterCount, filterReports, loadMyReports,
  pageLabel, reportDateText, reportLinkText, sortNewest, type PublicReport, type StatusFilter,
} from '../utils/reports';

/**
 * 回報與修正（站長 2026-11-19：「bug 修正可以直接呈現在百科網站上嗎? (留言功能)」）。
 *
 * 上面是問題回報表單（同右下角「問題回報」），下面是最近的回報（網站＋LINE／DC 的 /回報），新的在前：狀態、管理者寫的
 * 處理說明與連結（例如修正的 PR）。資料來自伺服器 GET /api/reports（DC #同步閒聊 裡 bot 貼的【百科回報】與每日例行作業加的
 * 狀態行；伺服器快取 5 分鐘，剛送出的會馬上重讀）。不顯示暱稱。網址 #reports。不用登入。
 */

type ListState =
  | { state: 'loading' }
  | { state: 'ready'; reports: PublicReport[]; stale: boolean }
  | { state: 'failed'; error: string };

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'open', label: '還沒處理完' },
  ...REPORT_STATUS_ORDER.map((s) => ({ id: s as StatusFilter, label: s })),
];

export default function ReportsPage(): JSX.Element {
  const [list, setList] = useState<ListState>({ state: 'loading' });
  const [reload, setReload] = useState<{ n: number; fresh: boolean }>({ n: 0, fresh: false });
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [mine, setMine] = useState<string[]>(() => loadMyReports());
  const [justSent, setJustSent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchReports(reload.fresh)
      .then((r) => { if (!cancelled) setList({ state: 'ready', reports: sortNewest(r.reports), stale: r.stale }); })
      .catch((err: unknown) => { if (!cancelled) setList({ state: 'failed', error: reportsErrorText(err) }); });
    return (): void => { cancelled = true; };
  }, [reload]);

  const counts = useMemo(() => (list.state === 'ready' ? countByStatus(list.reports) : null), [list]);
  const shown = useMemo(() => (list.state === 'ready' ? filterReports(list.reports, filter) : []), [list, filter]);
  const mineSet = useMemo(() => new Set(mine), [mine]);
  const justSentMissing = justSent !== null && list.state === 'ready' && !list.reports.some((r) => r.id === justSent);

  return (
    <div className="relative z-10 mx-auto max-w-3xl space-y-4 px-3 py-4 text-white sm:px-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-bold"><ClipboardList size={20} className="text-sky-300" />回報與修正</h1>
        <p className="text-xs leading-relaxed text-zinc-300">
          網站哪裡壞了、文章哪裡有誤、想要什麼功能，都可以在這裡留言。管理者每天看，處理完會在下面寫狀態和怎麼改的。
          LINE 或 DC 打 /回報 的也會列在這裡。網站上不顯示暱稱。
        </p>
      </header>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-3 sm:p-4" aria-label="回報表單">
        <h2 className="mb-2 text-sm font-bold">我要回報</h2>
        <FeedbackForm
          onSent={(id) => {
            setJustSent(id);
            setMine(loadMyReports());
            setList({ state: 'loading' });
            setReload((r) => ({ n: r.n + 1, fresh: true }));
          }}
        />
      </section>

      <section className="space-y-2" aria-label="回報清單">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="依狀態篩選">
          {FILTERS.map(({ id, label }) => {
            const n = counts ? filterCount(counts, id) : null;
            if (id === '已處理' && n === 0) return null; // 舊標記沒有就不顯示這顆
            return (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                aria-pressed={filter === id}
                className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                  filter === id ? 'border-white bg-white text-black' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white'
                }`}
              >
                {label}{n !== null ? <span className="ml-1 opacity-70">{n}</span> : null}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => { setList({ state: 'loading' }); setReload((r) => ({ n: r.n + 1, fresh: true })); }}
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            aria-label="重新讀取"
          >
            <RefreshCw size={12} />重新讀取
          </button>
        </div>

        {list.state === 'loading' && (
          <p className="inline-flex items-center gap-2 py-8 text-sm text-zinc-300"><Loader2 size={16} className="animate-spin" />讀取中…（伺服器剛喚醒時要等 30–60 秒）</p>
        )}
        {list.state === 'failed' && (
          <div className="space-y-2 py-6 text-sm">
            <p className="inline-flex items-center gap-1.5 text-rose-300"><AlertTriangle size={15} />{list.error}</p>
          </div>
        )}
        {list.state === 'ready' && (
          <>
            {list.stale && <p className="text-[11px] text-amber-300/90">DC 暫時讀不到，顯示的是稍早的清單</p>}
            {justSentMissing && (
              <p className="text-[11px] text-zinc-400">你剛送的 #{justSent} 還沒出現，過幾分鐘再按「重新讀取」。</p>
            )}
            {shown.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-400">{filter === 'all' ? '最近還沒有回報' : '這個狀態目前沒有回報'}</p>
            ) : (
              <ul data-testid="reports-list" className="space-y-2">
                {shown.map((r) => <ReportItem key={`${r.id}-${r.createdAt}`} report={r} mine={mineSet.has(r.id)} />)}
              </ul>
            )}
            <p className="pt-1 text-[11px] leading-relaxed text-zinc-500">
              列出最近約 60 天的回報。內容照回報者寫的顯示，@提及與暱稱已隱藏成「○○」；不想公開的內容請跟管理者說，可以從這頁拿掉。
            </p>
          </>
        )}
      </section>
    </div>
  );
}

function ReportItem({ report: r, mine }: { report: PublicReport; mine: boolean }): JSX.Element {
  const where = pageLabel(r.page);
  const meta = [reportDateText(r.createdAt), r.kindLabel, r.source ? `來自${SOURCE_LABEL[r.source]}` : '', where ? `頁面：${where}` : ''].filter(Boolean);
  const updated = r.updatedAt ? reportDateText(r.updatedAt) : '';
  return (
    <li className={`rounded-lg border bg-zinc-900/70 p-3 ${mine ? 'border-sky-700' : 'border-zinc-800'}`} data-testid="report-item">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-400">
        <span
          title={REPORT_STATUS_HINT[r.status]}
          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${REPORT_STATUS_STYLE[r.status]}`}
        >
          {r.status}
        </span>
        <span className="font-mono text-zinc-500">#{r.id}</span>
        {mine && <span className="rounded bg-sky-900/70 px-1.5 py-0.5 text-sky-200">你送的</span>}
        <span>{meta.join('・')}</span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-100">{r.text}</p>
      {(r.note || r.link) && (
        <div className="mt-2 rounded-md border-l-2 border-emerald-600 bg-emerald-950/30 px-2.5 py-1.5 text-xs leading-relaxed text-emerald-100">
          <span className="font-semibold">管理者：</span>
          {r.note && <span className="whitespace-pre-wrap break-words">{r.note}</span>}
          {r.link && (
            <a href={r.link} target="_blank" rel="noopener noreferrer nofollow" className="ml-1 inline-flex items-center gap-0.5 break-all text-sky-300 underline underline-offset-2 hover:text-sky-200">
              {reportLinkText(r.link)} <ExternalLink size={10} />
            </a>
          )}
          {updated && <span className="ml-1 text-emerald-300/60">（{updated}）</span>}
        </div>
      )}
    </li>
  );
}

