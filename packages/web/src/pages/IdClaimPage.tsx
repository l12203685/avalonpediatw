import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, ExternalLink, Info, Loader, Plus, Search, Send, UserCheck, X,
} from 'lucide-react';
import { loadClaimData } from '../stats/statsEngine';
import { submitIdClaim, IdClaimError } from '../services/api';
import { SYNC_CHANNEL_URL } from '../components/FeedbackButton';
import {
  buildIdIndex, dateRange, gameLabel, idGameRow, mergedInto, nameKey, sameGameConflicts, searchIds,
  type ClaimData, type IdSummary, type SearchHit,
} from '../components/idClaim/claimIndex';
import { displaySeatNumber } from '../utils/seatDisplay';

/**
 * ID 認領（Edward 2026-11-03：紀錄裡同一個人有時用好幾個 ID — 慣用暱稱、一次性的玩笑名字；讓玩家在網站上說
 * 「這幾個 ID 是我」，不要登入頁，他逐筆核准）。
 *
 * 選主 ID（正式名字）＋其他 ID；每個 ID 顯示場數、日期範圍，可展開看那個 ID 的對局（認得出是不是自己）。
 * 送出 → POST /api/feedback/claim → 貼到 LINE 群組和 DC #同步閒聊（「【ID認領】#編號 主ID ← 其他ID…」，公開；2026-11-09 起，
 * 同 LINE／DC 的 /認領 指令）；管理者在 DC 那則按 ✅ 核准後由每日例行作業
 * 寫進 player_aliases.json，下一次每日資料更新生效。資料 = 數據分析已在用的每局資料集（Worker），載入不到時
 * 仍可手打 ID 送出（沒有場數，管理者自己核對）。
 */

const MAX_OTHERS = 10;
const NAME_MAX = 40;
const GAMES_PAGE = 20;

type Load = { state: 'loading' } | { state: 'ready'; data: ClaimData; index: Map<string, IdSummary> } | { state: 'failed' };

export default function IdClaimPage(): JSX.Element {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [main, setMain] = useState<string | null>(null);
  const [others, setOthers] = useState<string[]>([]);
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ main: string; others: string[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadClaimData()
      .then((data) => { if (!cancelled) setLoad({ state: 'ready', data, index: buildIdIndex(data) }); })
      .catch(() => { if (!cancelled) setLoad({ state: 'failed' }); });
    return (): void => { cancelled = true; };
  }, []);

  const ready = load.state === 'ready' ? load : null;
  const chosen = useMemo(() => new Set([main, ...others].filter((n): n is string => n !== null)), [main, others]);
  const conflicts = useMemo(
    () => (ready && chosen.size >= 2 ? sameGameConflicts([...chosen], ready.data, ready.index) : []),
    [ready, chosen],
  );

  const othersProblem = others.length === 0
    ? '至少選一個其他 ID'
    : main && others.some((o) => nameKey(o) === nameKey(main)) ? '其他 ID 不能跟主 ID 相同' : '';
  const canSubmit = main !== null && !othersProblem && !sending;

  const gamesOf = (name: string): number | undefined => ready?.index.get(name)?.games;

  const submit = async (): Promise<void> => {
    if (!main || othersProblem) return;
    setSending(true);
    setError('');
    try {
      await submitIdClaim({
        main: { name: main, games: gamesOf(main) },
        others: others.map((name) => ({ name, games: gamesOf(name) })),
        contact: contact.trim() || undefined,
        note: note.trim() || undefined,
        page: '/#id-claim',
      });
      setSent({ main, others });
      setMain(null);
      setOthers([]);
      setNote('');
      window.scrollTo({ top: 0 });
    } catch (err) {
      const status = err instanceof IdClaimError ? err.status : 0;
      setError(
        status === 429 ? '送出太頻繁了，請過幾分鐘再試。'
          : status === 400 ? '內容格式不對（名字太長或重複？），請檢查後再送。'
            : '送出失敗，請稍後再試，或在 LINE／DC 打「/認領 主ID 其他ID」。',
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative mx-auto max-w-3xl px-4 pb-16 pt-4" data-testid="id-claim-page">
      <h1 className="flex items-center gap-2 text-xl font-bold text-white">
        <UserCheck size={22} className="text-emerald-400" /> ID 認領
      </h1>
      <p className="mt-1 text-sm leading-relaxed text-zinc-300">
        紀錄裡同一個人用過好幾個 ID（慣用暱稱、一次性的玩笑名字）？選出你的主 ID 和其他 ID，管理者核准後，
        其他 ID 的戰績會併到主 ID。
      </p>

      <div className="mt-3 space-y-1 rounded-lg border border-sky-800/70 bg-sky-950/60 p-3 text-xs leading-relaxed text-sky-100" data-testid="id-claim-notice">
        <p className="flex items-start gap-1.5"><Info size={14} className="mt-0.5 flex-shrink-0" /><span><b>不用登入。</b>送出的內容會<b>公開</b>貼到 LINE 群組和 DC「同步閒聊」（群組成員都看得到）；也可以直接在 LINE／DC 打「/認領 主ID 其他ID」。</span></p>
        <p className="pl-5">管理者核准前不會改任何資料；核准後在<b>下一次每日資料更新</b>生效，不核准會在那則回覆原因。</p>
        <p className="pl-5">
          <a href={SYNC_CHANNEL_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-sky-300 underline-offset-2 hover:underline">
            到 DC 同步閒聊看認領進度 <ExternalLink size={11} />
          </a>
        </p>
      </div>

      {sent && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-700 bg-emerald-950/70 p-3 text-sm text-emerald-100" data-testid="id-claim-sent">
          <CheckCircle2 size={18} className="mt-0.5 flex-shrink-0 text-emerald-400" />
          <div className="min-w-0">
            <p className="font-semibold">已送出：{sent.main} ← {sent.others.join('、')}</p>
            <p className="mt-0.5 text-xs text-emerald-200/90">管理者核准後，會在下一次每日資料更新生效。還有別的 ID 可以再送一筆。</p>
          </div>
          <button type="button" onClick={() => setSent(null)} aria-label="關閉" className="ml-auto text-emerald-300 hover:text-white"><X size={16} /></button>
        </div>
      )}

      {load.state === 'loading' && (
        <p className="mt-3 flex items-center gap-2 text-xs text-zinc-400"><Loader size={13} className="animate-spin" /> 載入對局資料…</p>
      )}
      {load.state === 'failed' && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-700/70 bg-amber-950/60 p-3 text-xs leading-relaxed text-amber-100" data-testid="id-claim-data-failed">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>對局資料暫時載入不到，看不到場數與對局。仍然可以直接輸入 ID 送出（名字要跟紀錄裡寫的一樣），管理者會再核對。</span>
        </p>
      )}

      <Section title="主 ID（正式名字）" hint="合併後戰績顯示的名字">
        {main ? (
          <IdCard name={main} load={load} onRemove={() => setMain(null)} role="main" />
        ) : (
          <IdSearch load={load} exclude={chosen} placeholder="搜尋你的主 ID" onPick={setMain} testId="id-claim-main-search" />
        )}
      </Section>

      <Section title="其他 ID（同一個人）" hint={`最多 ${MAX_OTHERS} 個`}>
        <div className="space-y-2">
          {others.map((name) => (
            <IdCard key={name} name={name} load={load} onRemove={() => setOthers(others.filter((o) => o !== name))} role="other" />
          ))}
          {others.length < MAX_OTHERS && (
            <IdSearch
              load={load}
              exclude={chosen}
              placeholder={others.length === 0 ? '搜尋你用過的其他 ID' : '再加一個'}
              onPick={(name) => setOthers([...others, name])}
              testId="id-claim-other-search"
            />
          )}
        </div>
        {conflicts.length > 0 && (
          <div className="mt-2 rounded-lg border border-amber-600/80 bg-amber-950/70 p-3 text-xs leading-relaxed text-amber-100" data-testid="id-claim-conflict">
            <p className="flex items-start gap-1.5 font-semibold">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              這些 ID 曾經同一局都在桌上，照理不會是同一個人（還是可以送出，請在備註說明）：
            </p>
            <ul className="mt-1 space-y-0.5 pl-5">
              {conflicts.slice(0, 5).map((c) => (
                <li key={c.game.seq}>{gameLabel(c.game)}：{c.seats.map((s) => `${s.name}（${displaySeatNumber(s.seat)} 家）`).join('、')}</li>
              ))}
              {conflicts.length > 5 && <li>…還有 {conflicts.length - 5} 局</li>}
            </ul>
          </div>
        )}
      </Section>

      <Section title="聯絡與備註" hint="選填">
        <label className="block text-xs text-zinc-400">
          暱稱／DC 名稱（方便聯絡）
          <input
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={32}
            placeholder="例如 DC 上的名字"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-white placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
          />
        </label>
        <label className="mt-2 block text-xs text-zinc-400">
          備註
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="例如：哪幾場用了玩笑名字、為什麼換 ID"
            className="mt-1 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 p-2.5 text-sm text-white placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
          />
        </label>
      </Section>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-zinc-400" data-testid="id-claim-status">
          {!main ? '先選主 ID' : othersProblem || `${main} ← ${others.join('、')}`}
        </p>
        <button
          type="button"
          onClick={() => { void submit(); }}
          disabled={!canSubmit}
          data-testid="id-claim-submit"
          className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? <Loader size={15} className="animate-spin" /> : <Send size={15} />}
          送出認領
        </button>
      </div>
      {error && <p className="mt-2 text-right text-xs text-red-300" role="alert">{error}</p>}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/85 p-3 sm:p-4">
      <h2 className="mb-2 flex items-baseline gap-2 text-sm font-bold text-white">
        {title}
        {hint && <span className="text-[11px] font-normal text-zinc-500">{hint}</span>}
      </h2>
      {children}
    </section>
  );
}

function IdSearch({ load, exclude, placeholder, onPick, testId }: {
  load: Load;
  exclude: ReadonlySet<string>;
  placeholder: string;
  onPick: (name: string) => void;
  testId: string;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const ready = load.state === 'ready' ? load : null;
  const typed = query.replace(/\s+/g, ' ').trim();
  const hits: SearchHit[] = useMemo(
    () => (ready ? searchIds(typed, ready.data, ready.index, exclude) : []),
    [ready, typed, exclude],
  );
  // 資料載入不到（或還在載入）時：手打的名字直接用。
  const freeText = !ready && typed.length > 0 && [...typed].length <= NAME_MAX && ![...exclude].some((n) => nameKey(n) === nameKey(typed));

  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return (): void => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (name: string): void => {
    onPick(name);
    setQuery('');
    setOpen(false);
  };
  const first = hits.find((h) => !h.aliasOf);

  return (
    <div ref={box} className="relative">
      <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 focus-within:border-sky-500">
        <Search size={15} className="flex-shrink-0 text-zinc-500" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (first) pick(first.name);
              else if (freeText) pick(typed);
            } else if (e.key === 'Escape') setOpen(false);
          }}
          maxLength={NAME_MAX}
          placeholder={placeholder}
          data-testid={testId}
          className="w-full bg-transparent py-2 text-sm text-white placeholder-zinc-500 focus:outline-none"
        />
      </div>
      {open && typed && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-2xl">
          {hits.map((h) => (
            <li key={h.name}>
              {h.aliasOf ? (
                <div className="px-3 py-1.5 text-sm text-zinc-500">
                  {h.name} <span className="text-xs">— 已併入「{h.aliasOf}」</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => pick(h.name)}
                  className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-sm text-white hover:bg-zinc-800"
                >
                  <span className="min-w-0 break-all">{h.name}</span>
                  <span className="flex-shrink-0 text-xs text-zinc-400">{h.games} 場{h.last ? `・最近 ${h.last}` : ''}</span>
                </button>
              )}
            </li>
          ))}
          {freeText && (
            <li>
              <button type="button" onClick={() => pick(typed)} className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm text-white hover:bg-zinc-800">
                <Plus size={14} /> 用「{typed}」
              </button>
            </li>
          )}
          {ready && hits.length === 0 && (
            <li className="px-3 py-1.5 text-xs text-zinc-500">紀錄裡沒有這個 ID（要跟紀錄裡寫的一樣）</li>
          )}
        </ul>
      )}
    </div>
  );
}

function IdCard({ name, load, onRemove, role }: { name: string; load: Load; onRemove: () => void; role: 'main' | 'other' }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [shown, setShown] = useState(GAMES_PAGE);
  const ready = load.state === 'ready' ? load : null;
  const summary = ready?.index.get(name);
  const merged = ready ? mergedInto(name, ready.data.aliases) : [];
  const rows = useMemo(
    () => (expanded && ready && summary ? summary.gameIdx.slice(0, shown).map((i) => idGameRow(ready.data.games[i], name)) : []),
    [expanded, ready, summary, shown, name],
  );

  return (
    <div className={`rounded-lg border p-2.5 ${role === 'main' ? 'border-emerald-700/80 bg-emerald-950/40' : 'border-zinc-700 bg-zinc-800/60'}`} data-testid="id-claim-card">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-all text-sm font-bold text-white">{name}</p>
          <p className="mt-0.5 text-xs text-zinc-400">
            {summary ? `${summary.games} 場・${dateRange(summary)}` : ready ? '紀錄裡沒有這個 ID' : load.state === 'loading' ? '載入中…' : '場數不明'}
          </p>
          {merged.length > 0 && (
            <p className="mt-0.5 text-[11px] text-sky-300">
              已合併：{merged.join('、')}{role === 'other' ? '（核准後也一起歸到主 ID）' : ''}
            </p>
          )}
        </div>
        <button type="button" onClick={onRemove} aria-label={`移除 ${name}`} className="flex-shrink-0 rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-white">
          <X size={16} />
        </button>
      </div>
      {summary && summary.games > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1.5 flex items-center gap-0.5 text-xs text-sky-300 hover:text-sky-200"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? '收起對局' : '看這個 ID 的對局'}
        </button>
      )}
      {expanded && summary && (
        <ul className="mt-1.5 divide-y divide-zinc-700/70 rounded-md border border-zinc-700/70 bg-black/30" data-testid="id-claim-games">
          {rows.map((r) => r && (
            <li key={r.game.seq} className="px-2 py-1.5 text-xs">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-mono text-zinc-300">{gameLabel(r.game)}</span>
                <span className="text-zinc-400">{displaySeatNumber(r.seat)} 家</span>
                <span className="text-white">{r.role || '角色不明'}</span>
                {r.result && <span className={r.result === '勝' ? 'text-emerald-400' : 'text-red-400'}>{r.result}</span>}
              </div>
              <p className="mt-0.5 break-words text-[11px] text-zinc-500">同桌：{r.mates.join('、') || '—'}</p>
            </li>
          ))}
          {summary.games > shown && (
            <li>
              <button type="button" onClick={() => setShown(shown + GAMES_PAGE * 2)} className="w-full px-2 py-1.5 text-center text-xs text-sky-300 hover:text-sky-200">
                再顯示（還有 {summary.games - shown} 局）
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
