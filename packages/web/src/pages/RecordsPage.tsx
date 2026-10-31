import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ExternalLink, RotateCw, ScrollText, Search, X } from 'lucide-react';
import { fetchRecordsList, isAnalysisNotGenerated, isAnalysisRouteMissing } from '../services/api';
import RecordsGameView, { OUTCOME_STYLE } from '../components/records/RecordsGameView';
import { closeRecords, openRecords, useOpenRecords } from '../components/records/recordsLink';
import { useRecordsPrefs } from '../components/records/recordsPrefs';
import LineupFilterEditor from '../components/lineup/LineupFilterEditor';
import { LineupBadge, MistakeChips } from '../components/records/RecordsLineup';
import {
  EMPTY_RECORDS_FILTER,
  RECORDS_FILTER_KEY,
  RECORD_MISTAKE_TAGS,
  RESULT_TAGS,
  matchesRecords,
  matchingSeats,
  outcomeOf,
  parseRecordsFilter,
  recordsFilterActive,
  seatLabel,
  type RecordDisplayPrefs,
  type RecordFilter,
  type RecordList,
  type RecordPost,
  type RecordResultFilter,
} from '../utils/records';

/**
 * 牌譜紀錄頁籤（Edward 2026-10-30：「百科網站可以直接多一個頁籤是『牌譜紀錄與覆盤』，功能跟現在 DC 相同嗎
 * （或是直接同步現在 DC 的牌譜紀錄與覆盤頻道）」）。
 *
 * 第一階段：唯讀同步 DC 論壇 #牌譜紀錄與覆盤。清單（新到舊、依結果／日期／暱稱篩選）每天凌晨跟戰績快取一起更新；
 * 點一篇看整局（components/records/RecordsGameView），討論串回覆由伺服器即時讀 DC。發文、留言仍在 DC。
 */

const PAGE_SIZE = 30;
const RESULT_CHIPS: { id: RecordResultFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: '三紅', label: '三紅' },
  { id: '三藍死', label: '三藍被刀' },
  { id: '三藍活', label: '三藍躲刺' },
  { id: 'unreadable', label: '格式待修正' },
];

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: RecordList };

let listPromise: Promise<RecordList> | null = null;

/** 同一次瀏覽只抓一次（切頁籤回來不用重抓）；失敗了下次再抓。 */
function loadList(force = false): Promise<RecordList> {
  if (!listPromise || force) {
    listPromise = fetchRecordsList().catch((err: unknown) => {
      listPromise = null;
      throw err;
    });
  }
  return listPromise;
}

function errorMessage(err: unknown): string {
  if (isAnalysisNotGenerated(err)) return '牌譜紀錄清單還沒產生（每天凌晨從 DC 同步一次），請晚點再來看。';
  if (isAnalysisRouteMissing(err)) return '伺服器還沒更新到有牌譜紀錄的版本，請稍後重新整理。';
  return '載入失敗，請檢查網路後重試（伺服器剛睡醒時可能要等半分鐘）。';
}

/** 記住的篩選（localStorage；無痕或封鎖儲存時只是不記住）。 */
function storedFilter(): RecordFilter {
  try {
    return parseRecordsFilter(window.localStorage.getItem(RECORDS_FILTER_KEY));
  } catch {
    return EMPTY_RECORDS_FILTER;
  }
}

function saveFilter(filter: RecordFilter): void {
  try {
    window.localStorage.setItem(RECORDS_FILTER_KEY, JSON.stringify(filter));
  } catch { /* 無痕／封鎖儲存：只是不記住 */ }
}

function shortDate(date: string): string {
  const [y, m, d] = date.split('-');
  return y && m && d ? `${y}/${m}/${d}` : date;
}

function PostRow({ post, query, prefs, onOpen }: {
  post: RecordPost; query: string; prefs: RecordDisplayPrefs; onOpen: () => void;
}): JSX.Element {
  const outcome = outcomeOf(post);
  const seats = matchingSeats(post, query);
  const extraTags = post.tags.filter((t) => !Object.values(RESULT_TAGS).includes(t));
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-testid="records-row"
        className="flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-left transition-colors hover:border-amber-400/70 hover:bg-zinc-800/80"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[11px] font-mono text-zinc-400">{shortDate(post.date)}</span>
            <span className="min-w-0 break-words text-sm font-bold text-white">{post.title || '（沒有標題）'}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {outcome && (
              <span className={`rounded border px-1.5 py-px text-[11px] font-semibold ${OUTCOME_STYLE[outcome]}`}>
                {RESULT_TAGS[outcome]}
              </span>
            )}
            {!post.game && (
              <span className="rounded border border-zinc-600 bg-zinc-800 px-1.5 py-px text-[11px] text-zinc-300">格式待修正</span>
            )}
            {post.game && <LineupBadge post={post} />}
            <MistakeChips post={post} />
            {extraTags.map((t) => (
              <span key={t} className="rounded border border-zinc-700 px-1.5 py-px text-[11px] text-zinc-400">{t}</span>
            ))}
          </div>
          {seats.length > 0 && post.game && (
            <div className="mt-1 truncate text-[11px] text-amber-200">
              {seats.map((s) => (post.game ? seatLabel(post.game, s, prefs) : '')).join('、')}
            </div>
          )}
        </div>
        <ChevronRight size={16} className="flex-shrink-0 text-zinc-500" />
      </button>
    </li>
  );
}

export default function RecordsPage(): JSX.Element {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [filter, setFilter] = useState<RecordFilter>(storedFilter);
  const [shown, setShown] = useState(PAGE_SIZE);
  const openId = useOpenRecords();
  const [prefs] = useRecordsPrefs();

  const fetchList = (force: boolean): void => {
    loadList(force)
      .then((data) => setState({ status: 'ok', data }))
      .catch((err: unknown) => setState({ status: 'error', message: errorMessage(err) }));
  };
  const retry = (): void => {
    setState({ status: 'loading' });
    fetchList(true);
  };
  /** 換篩選時從頭顯示。 */
  const updateFilter = (change: (f: RecordFilter) => RecordFilter): void => {
    setFilter(change);
    setShown(PAGE_SIZE);
  };

  useEffect(() => {
    fetchList(false);
  }, []);

  useEffect(() => { window.scrollTo({ top: 0 }); }, [openId]);
  useEffect(() => { saveFilter(filter); }, [filter]);

  const posts = useMemo(() => (state.status === 'ok' ? state.data.posts : []), [state]);
  const filtered = useMemo(() => posts.filter((p) => matchesRecords(p, filter)), [posts, filter]);
  const filterActive = recordsFilterActive(filter);
  const forumUrl = state.status === 'ok'
    ? `https://discord.com/channels/${state.data.guildId}/${state.data.forumId}`
    : 'https://discord.com/invite/mBqFqM2TXs';

  if (openId && state.status === 'ok') {
    const post = posts.find((p) => p.id === openId);
    return (
      <div className="mx-auto max-w-7xl px-3 pb-10 pt-2 sm:px-4 lg:pb-0">
        {post ? (
          <RecordsGameView post={post} guildId={state.data.guildId} onBack={closeRecords} />
        ) : (
          <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/80 p-4 text-sm text-zinc-300">
            <p>找不到這篇牌譜（可能已刪除、標成模擬，或是今天剛發還沒同步）。</p>
            <button type="button" onClick={closeRecords} className="text-amber-300 underline">回到牌譜列表</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-3 pb-10 pt-3 sm:px-4" data-testid="records-page">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-1.5">
          <ScrollText size={20} className="text-amber-300" />
          <h2 className="text-lg font-bold text-white">牌譜紀錄</h2>
          {state.status === 'ok' && <span className="text-xs text-zinc-400">· {state.data.counts.posts} 局</span>}
        </div>
        <a
          href={forumUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
        >
          DC #牌譜紀錄與覆盤<ExternalLink size={12} />
        </a>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-zinc-400">
        同步自 Discord 論壇 #牌譜紀錄與覆盤（每天凌晨更新，模擬局不列）。點一局看座位、角色、每次提議的投票與湖；發牌譜、留言請到 DC。
      </p>

      <div className="mb-3 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/80 p-2">
        <div className="relative">
          <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            value={filter.query}
            onChange={(e) => updateFilter((f) => ({ ...f, query: e.target.value }))}
            placeholder="搜尋玩家暱稱或標題"
            data-testid="records-search"
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 py-1.5 pl-8 pr-8 text-sm text-white placeholder-zinc-500 focus:border-amber-400 focus:outline-none"
          />
          {filter.query && (
            <button
              type="button"
              aria-label="清除搜尋"
              onClick={() => updateFilter((f) => ({ ...f, query: '' }))}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
            >
              <X size={15} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="結果">
          {RESULT_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              aria-pressed={filter.result === chip.id}
              onClick={() => updateFilter((f) => ({ ...f, result: chip.id }))}
              className={`rounded-md border px-2 py-1 text-xs font-semibold transition-colors ${
                filter.result === chip.id
                  ? 'border-amber-400 bg-amber-400 text-black'
                  : 'border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
          <span>日期</span>
          <input
            type="date"
            value={filter.from}
            max={filter.to || undefined}
            onChange={(e) => updateFilter((f) => ({ ...f, from: e.target.value }))}
            aria-label="從"
            className="w-[8.5rem] rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs text-white [color-scheme:dark]"
          />
          <span>到</span>
          <input
            type="date"
            value={filter.to}
            min={filter.from || undefined}
            onChange={(e) => updateFilter((f) => ({ ...f, to: e.target.value }))}
            aria-label="到"
            className="w-[8.5rem] rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs text-white [color-scheme:dark]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-400" data-testid="records-lineup-row">
          <span className="mr-0.5" title="開打前每個座位在「生涯已 ≥30 場」的玩家池裡的 PR；S = 10 人平均">陣容強度</span>
          <LineupFilterEditor
            value={filter.lineup}
            onChange={(lineup) => updateFilter((f) => ({ ...f, lineup }))}
            testIdPrefix="records-lineup"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1 text-xs text-zinc-400" role="group" aria-label="失誤標籤" data-testid="records-mistake-row">
          <span className="mr-0.5">失誤</span>
          {RECORD_MISTAKE_TAGS.map(({ tag, serious, help }) => {
            const on = filter.mistakes.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={on}
                title={help}
                onClick={() => updateFilter((f) => ({ ...f, mistakes: on ? f.mistakes.filter((t) => t !== tag) : [...f.mistakes, tag] }))}
                className={`rounded-md border px-1.5 py-0.5 text-[11px] transition-colors ${
                  on
                    ? serious ? 'border-red-400 bg-red-500 font-semibold text-white' : 'border-amber-400 bg-amber-400 font-semibold text-black'
                    : serious ? 'border-red-500/50 text-red-200 hover:border-red-400' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
                }`}
              >
                {tag}
              </button>
            );
          })}
          {filterActive && (
            <button
              type="button"
              onClick={() => updateFilter(() => EMPTY_RECORDS_FILTER)}
              className="ml-auto rounded-md px-1.5 py-1 text-xs text-amber-300 hover:bg-zinc-800"
            >
              清除篩選
            </button>
          )}
        </div>
      </div>

      {state.status === 'loading' && <p className="py-8 text-center text-sm text-zinc-400">載入牌譜紀錄中…</p>}
      {state.status === 'error' && (
        <div className="space-y-2 py-8 text-center text-sm text-zinc-300">
          <p>{state.message}</p>
          <button
            type="button"
            onClick={retry}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            <RotateCw size={13} />重試
          </button>
        </div>
      )}
      {state.status === 'ok' && (
        <>
          <p className="mb-1.5 text-xs text-zinc-500">
            {filterActive ? `符合 ${filtered.length} 局（共 ${posts.length} 局）` : `共 ${posts.length} 局，新的在上面`}
          </p>
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-400">沒有符合的牌譜</p>
          ) : (
            <ol className="space-y-1.5" data-testid="records-list">
              {filtered.slice(0, shown).map((post) => (
                <PostRow key={post.id} post={post} query={filter.query} prefs={prefs} onOpen={() => openRecords(post.id)} />
              ))}
            </ol>
          )}
          {filtered.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE_SIZE)}
              className="mt-2 w-full rounded-lg border border-zinc-700 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white"
            >
              顯示更多（還有 {filtered.length - shown} 局）
            </button>
          )}
        </>
      )}
    </div>
  );
}
