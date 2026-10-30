import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Filter, Link2, Loader, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import {
  addDays,
  ALL_ROLES,
  METRICS,
  PRESETS,
  canonicalFilterKey,
  presetFilter,
  sanitizeFilter,
  type CategoryValue,
  type Clause,
  type ExcludePlayersClause,
  type FilterMeta,
  type GameFilter,
  type MetricId,
  type PlayerSelector,
  type Role,
  type WithPlayerClause,
} from '@avalon/shared/stats';
import { useStatsFilter } from '../../../stats/statsFilter';
import { shareUrl } from '../../../stats/sharedFilter';
import { loadFilterVocab } from '../../../stats/statsEngine';
import type { FilterVocab } from '../../../stats/statsCompute';
import {
  CATEGORY_VALUES,
  EMPTY_FILTER,
  METRIC_GROUPS,
  OUTCOME_VALUES,
  WEEKDAYS,
  categoryClause,
  clausesOf,
  completeFilter,
  defaultExcludeRule,
  defaultWithPlayer,
  hasPreset,
  listClause,
  listSelection,
  otherClauses,
  removeClauseAt,
  selectedCategories,
  splitNames,
  switchSelector,
  togglePreset,
  withClauses,
} from '../../../stats/filterDraft';
import { useRoleLabel } from '../roleLabels';
import { OUTCOME_LABEL_KEYS } from '../ui';
import { useClauseLabel, useMetricLabel } from './filterLabels';
import { useFilterResult, useFilterVocab, type FilterStatus } from './useFilterResult';

/**
 * 數據分析的篩選列 (Edward 2026-10-14「我希望所有數據都有可以複合篩選的功能 最基本的是 比如 線瓦/面瓦、娛樂局、
 * 排除某些條件玩家（角色理論勝率/位置理論勝率/整體理論勝率 大於 小於 PR XX）… 能的話盡可能客製化」；
 * 四季 2026-10-26 轉達：篩選畫面由 Claude 直接做、加分享連結、接 /api/analysis/games、不隨篩選變動的區塊要標明、
 * 強硬度三個指標也要能篩)。
 *
 *  - 快速篩選 (預設集) 點一下就套用 / 取消；目前的條件列成標籤，各自可以移除，旁邊是這條單獨會丟掉的局數。
 *  - 自訂篩選：對局 (分類、來源、結果、日期、星期、地點、賽季、10 人全寫)、包含玩家 (角色／陣營／勝負)、
 *    排除玩家 (依指標的值或 PR、依名字；整局排除或只是不上榜)、進階 (排行的近期出賽規則、直接編輯篩選 JSON：
 *    任務、湖、角色座位等全部條件)。改完按「套用」才重算。
 *  - 分享：網址列就是目前的篩選 (#stats?f=…)；按鈕複製完整連結。
 */
export default function StatsFilterBar(): JSX.Element {
  const { t } = useTranslation('common');
  const filter = useStatsFilter((s) => s.filter);
  const key = useStatsFilter((s) => s.key);
  const linkWarnings = useStatsFilter((s) => s.warnings);
  const setFilter = useStatsFilter((s) => s.setFilter);
  const [open, setOpen] = useState(false);
  // 選項 (名單、地點…、基準日) 要下載整份資料集：有篩選或打開面板時才載入
  const vocab = useFilterVocab(open || key !== '');
  const { status, retry } = useFilterResult();
  const label = useClauseLabel();
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

  const asOf = vocab?.asOf ?? new Date().toISOString().slice(0, 10);
  // 近一年在下方的「期間」列 (2026-10-26)
  const presets = useMemo(() => PRESETS.filter((p) => p.id !== 'lastYear')
    .map((p) => ({ preset: p, filter: presetFilter(p.id, asOf) as GameFilter })), [asOf]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shareUrl());
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
    window.setTimeout(() => setCopied('idle'), 2500);
  };

  const meta = status.state === 'ready' ? status.meta : null;

  return (
    <section className="mb-4 rounded-xl border border-zinc-800 bg-zinc-950/70 p-3" data-testid="stats-filter" aria-label={t('analytics.filter.title')}>
      {/* 2026-10-30 Edward：期間放在篩選最一開始；只看線瓦／面瓦／排除娛樂局／只看 10 人全寫收進「更多篩選」。 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-sm font-bold text-zinc-200 mr-1">
          <Filter size={14} />
          {t('analytics.filter.title')}
        </span>
        <PeriodRow filter={filter} vocabAsOf={vocab?.asOf} onChange={(f) => setFilter(f)} />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-lg border border-zinc-600 px-2.5 py-1 text-xs font-semibold text-zinc-200 hover:border-white"
          data-testid="filter-edit"
        >
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {open ? t('analytics.filter.collapse') : t('analytics.filter.more', { defaultValue: '更多篩選' })}
        </button>
        {key && (
          <>
            <button type="button" onClick={() => { void copy(); }} className="inline-flex items-center gap-1 rounded-lg border border-zinc-600 px-2.5 py-1 text-xs text-zinc-200 hover:border-white" data-testid="filter-share">
              <Link2 size={12} />
              {copied === 'ok' ? t('analytics.filter.copied') : copied === 'fail' ? t('analytics.filter.copyFailed') : t('analytics.filter.share')}
            </button>
            <button type="button" onClick={() => setFilter(null)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-400 hover:text-white" data-testid="filter-clear">
              <X size={12} />
              {t('analytics.filter.clearAll')}
            </button>
          </>
        )}
      </div>
      {/* 常用條件仍可一鍵套用（收在更多篩選裡）；已套用的會出現在下面的條件標籤 */}
      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="filter-presets">
        {presets.map(({ preset, filter: pf }) => {
          const on = hasPreset(filter, pf);
          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={on}
              onClick={() => {
                if (vocab || preset.id !== 'lastYear') setFilter(togglePreset(filter, pf));
                // 「近一年」依資料集的基準日展開：先載入
                else void loadFilterVocab().then((v) => setFilter(togglePreset(useStatsFilter.getState().filter, presetFilter(preset.id, v.asOf) as GameFilter)), () => setFilter(togglePreset(filter, pf)));
              }}
              className={chipClass(on)}
              data-testid={`filter-preset-${preset.id}`}
            >
              {on && <Check size={12} />}
              {t(`analytics.filter.presetLabels.${preset.id}`, { defaultValue: preset.label })}
            </button>
          );
        })}
        </div>
      )}
      <StatusLine status={status} total={vocab?.totalGames} retry={retry} />
      {linkWarnings.length > 0 && (
        <p className="mt-1 text-xs text-amber-300">{t('analytics.filter.linkWarnings', { count: linkWarnings.length })}</p>
      )}

      {filter?.options?.leaderboard && (
        <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-950/50 border border-amber-800 pl-2.5 pr-1 py-0.5 text-xs text-amber-100" data-testid="filter-leaderboard-rules">
          {t('analytics.boards.rules.chip')}
          <button
            type="button"
            aria-label={t('analytics.filter.remove')}
            title={t('analytics.filter.remove')}
            onClick={() => {
              const options = { ...(filter.options ?? {}) };
              delete options.leaderboard;
              const next: GameFilter = { ...filter, options };
              if (!Object.keys(options).length) delete next.options;
              setFilter(next.clauses.length || next.options ? next : null);
            }}
            className="rounded-full p-0.5 hover:bg-amber-800"
          >
            <X size={11} />
          </button>
        </p>
      )}

      {filter && filter.clauses.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="filter-active">
          {filter.clauses.map((c, i) => (
            <li key={`${i}-${c.kind}`} className="inline-flex items-center gap-1 rounded-full bg-blue-950/60 border border-blue-800 pl-2.5 pr-1 py-0.5 text-xs text-blue-100">
              <span>{label(c)}</span>
              <ClauseEffect meta={meta} index={i} />
              <button type="button" aria-label={t('analytics.filter.remove')} title={t('analytics.filter.remove')} onClick={() => setFilter(removeClauseAt(filter, i))} className="rounded-full p-0.5 hover:bg-blue-800">
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && <FilterEditor applied={filter} vocab={vocab} onApply={(f) => setFilter(f)} />}
    </section>
  );
}

/** 期間的快速選項 (天數，含基準日；0 = 全部)。 */
const PERIOD_DAYS = [7, 30, 90, 365, 0] as const;

/**
 * 期間 (2026-10-26 玩家回饋：「我想要看近期的玩家勝率就好 … 例如這颱風天我就想要看這四天」「以前是可以篩選日期?」)：
 * 篩選列上直接選近 7 / 30 / 90 天、近一年、全部，或填起訖日；點了就套用 (換掉日期條件，其餘條件不動)。
 * 「近 N 天」以資料的基準日 (每日更新的日期) 往回算，含基準日。
 * 選了期間時，排行的「新人」「近期有出賽」改看全部對局 (activity 'all')：只看期間內的局時，每個人的首次出賽
 * 都會變成期間第一天、人人都像新人。榜上的數字仍只算期間內的局。選「全部」時拿掉這個設定。
 */
function PeriodRow({ filter, vocabAsOf, onChange }: {
  filter: GameFilter | null; vocabAsOf?: string; onChange: (f: GameFilter) => void;
}): JSX.Element {
  const { t } = useTranslation('common');
  const date = clausesOf(filter, 'date').find((c) => !c.not);
  const range = (days: number, asOf: string): { from: string; to: string } => ({ from: addDays(asOf, -(days - 1)), to: asOf });
  const isOn = (days: number): boolean => {
    if (days === 0) return !date;
    if (!date || !vocabAsOf) return false;
    const r = range(days, vocabAsOf);
    return date.from === r.from && date.to === r.to && date.undated !== 'include';
  };
  const withActivity = (f: GameFilter, hasDate: boolean): GameFilter => {
    const options = { ...(f.options ?? {}) };
    if (hasDate) options.activity = 'all';
    else if (options.activity === 'all') delete options.activity;
    const next: GameFilter = { ...f, options };
    if (!Object.keys(options).length) delete next.options;
    return next;
  };
  const pick = (days: number): void => {
    if (days === 0) {
      onChange(withActivity(withClauses(filter, 'date', null), false));
      return;
    }
    const apply = (asOf: string): void => onChange(withActivity(
      withClauses(useStatsFilter.getState().filter, 'date', { kind: 'date', ...range(days, asOf) }), true,
    ));
    if (vocabAsOf) apply(vocabAsOf);
    else void loadFilterVocab().then((v) => apply(v.asOf), () => apply(new Date().toISOString().slice(0, 10)));
  };
  const setEnd = (patch: { from?: string; to?: string }): void => {
    const next = { ...(date ?? {}), ...patch };
    const clean = { kind: 'date' as const, ...(next.from ? { from: next.from } : {}), ...(next.to ? { to: next.to } : {}) };
    const hasDate = Boolean(clean.from || clean.to);
    onChange(withActivity(withClauses(filter, 'date', hasDate ? clean : null), hasDate));
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="filter-period">
      <span className="mr-1 text-xs font-semibold text-zinc-400">{t('analytics.filter.period.title')}</span>
      {PERIOD_DAYS.map((d) => (
        <button key={d} type="button" aria-pressed={isOn(d)} onClick={() => pick(d)} className={chipClass(isOn(d))} data-testid={`filter-period-${d}`}>
          {d === 0 ? t('analytics.filter.period.all') : d === 365 ? t('analytics.filter.period.year') : t('analytics.filter.period.days', { count: d })}
        </button>
      ))}
      <input type="date" className={inputClass} value={date?.from ?? ''} onChange={(e) => setEnd({ from: e.target.value })}
        aria-label={t('analytics.filter.fields.from')} data-testid="filter-period-from" />
      <span className="text-xs text-zinc-500">～</span>
      <input type="date" className={inputClass} value={date?.to ?? ''} onChange={(e) => setEnd({ to: e.target.value })}
        aria-label={t('analytics.filter.fields.to')} data-testid="filter-period-to" />
    </div>
  );
}

function chipClass(on: boolean): string {
  return `inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
    on ? 'bg-blue-600 text-white' : 'bg-zinc-900 border border-zinc-700 text-zinc-300 hover:border-white hover:text-white'
  }`;
}

function StatusLine({ status, total, retry }: { status: FilterStatus; total?: number; retry: () => void }): JSX.Element | null {
  const { t } = useTranslation('common');
  if (status.state === 'idle') {
    return typeof total === 'number'
      ? <p className="mt-1.5 text-xs text-zinc-500">{t('analytics.filter.none', { total: total.toLocaleString() })}</p>
      : null;
  }
  if (status.state === 'computing') {
    return (
      <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-zinc-400" data-testid="filter-computing">
        <Loader size={12} className="animate-spin" />
        {t('analytics.filter.computing')}
      </p>
    );
  }
  if (status.state === 'error') {
    return (
      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-amber-300" data-testid="filter-unavailable">
        <AlertTriangle size={12} />
        {t('analytics.filter.unavailable')}
        <button type="button" onClick={retry} className="underline hover:text-white">{t('analytics.filter.retry')}</button>
      </p>
    );
  }
  const m = status.meta;
  const parts = [t('analytics.filter.summary', { games: m.games.toLocaleString(), total: m.totalGames.toLocaleString() })];
  if (m.gamesAfterClauses !== m.games) parts[0] += t('analytics.filter.afterClauses', { games: m.gamesAfterClauses.toLocaleString() });
  if (m.droppedPlayers) parts.push(t('analytics.filter.dropped', { count: m.droppedPlayers }));
  if (m.hiddenPlayers) parts.push(t('analytics.filter.hidden', { count: m.hiddenPlayers }));
  const notes: string[] = [];
  if (m.warnings.includes('smallSample')) notes.push(t('analytics.filter.smallSample'));
  if (m.warnings.includes('smallPopulation')) notes.push(t('analytics.filter.smallPopulation'));
  if (m.unresolvedNames.length) notes.push(t('analytics.filter.unresolved', { names: [...new Set(m.unresolvedNames)].join('、') }));
  for (const c of m.clauses) {
    if (c.inactive && !c.unresolved) notes.push(t('analytics.filter.inactive', { index: c.index + 1, reason: c.inactive }));
  }
  return (
    <div className="mt-1.5 text-xs" data-testid="filter-summary">
      <p className="text-zinc-300">{parts.join(' · ')}</p>
      {notes.map((n) => <p key={n} className="text-amber-300">{n}</p>)}
    </div>
  );
}

/** 標籤旁的小字：局條件單獨會丟掉的局數；排除玩家條件選中的人數／有資格的人數。 */
function ClauseEffect({ meta, index }: { meta: FilterMeta | null; index: number }): JSX.Element | null {
  const r = meta?.clauses.find((c) => c.index === index);
  if (!r) return null;
  if (r.inactive) return <span className="text-amber-300">!</span>;
  if (typeof r.failing === 'number') return <span className="text-blue-300/70">−{r.failing.toLocaleString()}</span>;
  if (typeof r.selected === 'number') {
    return <span className="text-blue-300/70">{r.selected}{r.eligible ? `／${r.eligible}` : ''}</span>;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────
// 自訂篩選
// ──────────────────────────────────────────────────────────────

function FilterEditor({ applied, vocab, onApply }: {
  applied: GameFilter | null; vocab: FilterVocab | null; onApply: (f: GameFilter | null) => void;
}): JSX.Element {
  const { t } = useTranslation('common');
  const [draft, setDraft] = useState<GameFilter>(applied ?? EMPTY_FILTER);
  const appliedKey = canonicalFilterKey(applied);
  // 外面改了篩選 (預設集、移除標籤、分享連結) → 草稿跟著換 (React 的 "adjust state on prop change")
  const [seenKey, setSeenKey] = useState(appliedKey);
  if (seenKey !== appliedKey) {
    setSeenKey(appliedKey);
    setDraft(applied ?? EMPTY_FILTER);
  }
  const ready = completeFilter(draft);
  const dirty = canonicalFilterKey(ready) !== appliedKey;

  return (
    <div className="mt-3 space-y-3 border-t border-zinc-800 pt-3" data-testid="filter-editor">
      <GamesSection draft={draft} setDraft={setDraft} vocab={vocab} />
      <PlayersSection draft={draft} setDraft={setDraft} vocab={vocab} />
      <ExcludeSection draft={draft} setDraft={setDraft} vocab={vocab} />
      <OtherSection draft={draft} setDraft={setDraft} />
      <AdvancedSection draft={draft} setDraft={setDraft} />
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 bg-zinc-950/95 py-2">
        <button
          type="button"
          disabled={!dirty}
          onClick={() => onApply(ready)}
          className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-bold text-white disabled:opacity-40"
          data-testid="filter-apply"
        >
          <Check size={14} />
          {dirty ? t('analytics.filter.apply') : t('analytics.filter.applied')}
        </button>
        {dirty && (
          <>
            <button type="button" onClick={() => setDraft(applied ?? EMPTY_FILTER)} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-white">
              <RotateCcw size={12} />
              {t('analytics.filter.discard')}
            </button>
            <span className="text-xs text-amber-300">{t('analytics.filter.pending')}</span>
          </>
        )}
      </div>
    </div>
  );
}

interface SectionProps {
  draft: GameFilter;
  setDraft: (f: GameFilter) => void;
  vocab?: FilterVocab | null;
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <fieldset className="rounded-lg border border-zinc-800 p-2.5">
      <legend className="px-1 text-xs font-bold text-zinc-400">{title}</legend>
      <div className="space-y-2">{children}</div>
    </fieldset>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
      <span className="w-24 shrink-0 pt-1 text-xs text-zinc-500">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function Toggle({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: ReactNode; testId?: string }): JSX.Element {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={chipClass(on)} data-testid={testId}>
      {children}
    </button>
  );
}

const inputClass = 'rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 focus:border-blue-500 focus:outline-none';

function toggled<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function GamesSection({ draft, setDraft, vocab }: SectionProps): JSX.Element {
  const { t } = useTranslation('common');
  const categories = selectedCategories(draft);
  const date = clausesOf(draft, 'date')[0];
  const fullNames = clausesOf(draft, 'namedSeats').some((c) => c.min === 10 && c.max === undefined && !c.not);
  const multi = (kind: 'source' | 'weekday' | 'venue' | 'season' | 'outcome', all: ReadonlyArray<string | number>, render: (v: string | number) => string): JSX.Element => {
    const selected = listSelection(draft, kind);
    return (
      <>
        {all.map((v) => (
          <Toggle key={String(v)} on={selected.includes(v)} onClick={() => setDraft(withClauses(draft, kind, listClause(kind, toggled(selected, v), all)))}>
            {render(v)}
          </Toggle>
        ))}
      </>
    );
  };
  const setDate = (patch: { from?: string; to?: string; undated?: 'exclude' | 'include' }): void => {
    const next = { ...(date ?? { kind: 'date' as const }), ...patch };
    const clean = {
      kind: 'date' as const,
      ...(next.from ? { from: next.from } : {}),
      ...(next.to ? { to: next.to } : {}),
      ...(next.undated === 'include' ? { undated: 'include' as const } : {}),
    };
    setDraft(withClauses(draft, 'date', clean.from || clean.to ? clean : null));
  };
  return (
    <Section title={t('analytics.filter.sections.games')}>
      <Row label={t('analytics.filter.fields.category')}>
        {CATEGORY_VALUES.map((c) => (
          <Toggle key={c} on={categories.includes(c)} testId={`filter-category-${c}`} onClick={() => setDraft(withClauses(draft, 'category', categoryClause(toggled<CategoryValue>(categories, c))))}>
            {t(`analytics.filter.categories.${c}`)}
          </Toggle>
        ))}
      </Row>
      <Row label={t('analytics.filter.fields.outcome')}>
        {multi('outcome', OUTCOME_VALUES, (o) => t(OUTCOME_LABEL_KEYS[o as '三紅'] ?? String(o)))}
      </Row>
      <Row label={t('analytics.filter.fields.source')}>
        {multi('source', ['sheet', 'discord'], (s) => t(`analytics.filter.sources.${s}`))}
      </Row>
      <Row label={t('analytics.filter.fields.date')}>
        <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
          {t('analytics.filter.fields.from')}
          <input type="date" className={inputClass} value={date?.from ?? ''} onChange={(e) => setDate({ from: e.target.value })} data-testid="filter-date-from" />
        </label>
        <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
          {t('analytics.filter.fields.to')}
          <input type="date" className={inputClass} value={date?.to ?? ''} onChange={(e) => setDate({ to: e.target.value })} data-testid="filter-date-to" />
        </label>
        {date && (
          <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
            <input type="checkbox" checked={date.undated === 'include'} onChange={(e) => setDate({ undated: e.target.checked ? 'include' : 'exclude' })} />
            {t('analytics.filter.fields.undated')}
          </label>
        )}
      </Row>
      <Row label={t('analytics.filter.fields.weekday')}>
        {multi('weekday', WEEKDAYS, (d) => t(`analytics.filter.weekdays.${d}`))}
      </Row>
      {vocab && vocab.venues.length > 0 && (
        <Row label={t('analytics.filter.fields.venue')}>
          {multi('venue', vocab.venues, String)}
        </Row>
      )}
      {vocab && vocab.seasons.length > 0 && (
        <Row label={t('analytics.filter.fields.season')}>
          {multi('season', vocab.seasons, String)}
        </Row>
      )}
      <Row label="">
        <label className="inline-flex items-center gap-1.5 text-xs text-zinc-300">
          <input type="checkbox" checked={fullNames} onChange={(e) => setDraft(withClauses(draft, 'namedSeats', e.target.checked ? { kind: 'namedSeats', min: 10 } : null))} />
          {t('analytics.filter.fields.fullNames')}
        </label>
      </Row>
    </Section>
  );
}

function PlayerNames({ vocab }: { vocab?: FilterVocab | null }): JSX.Element | null {
  if (!vocab) return null;
  return (
    <datalist id="stats-filter-players">
      {vocab.players.map((n) => <option key={n} value={n} />)}
    </datalist>
  );
}

function PlayersSection({ draft, setDraft, vocab }: SectionProps): JSX.Element {
  const { t } = useTranslation('common');
  const role = useRoleLabel();
  const rules = clausesOf(draft, 'withPlayer');
  const update = (i: number, next: WithPlayerClause | null): void => {
    const list = rules.flatMap((r, j) => (j === i ? (next ? [next] : []) : [r]));
    setDraft(withClauses(draft, 'withPlayer', list));
  };
  return (
    <Section title={t('analytics.filter.sections.players')}>
      <PlayerNames vocab={vocab} />
      {rules.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5" data-testid="filter-with-player">
          {r.not && <span className="text-xs text-amber-300">{t('analytics.filter.invert')}</span>}
          <input
            className={`${inputClass} w-36`}
            list="stats-filter-players"
            placeholder={t('analytics.filter.fields.playerPlaceholder')}
            value={r.player}
            onChange={(e) => update(i, { ...r, player: e.target.value })}
            aria-label={t('analytics.filter.fields.player')}
          />
          <select className={inputClass} value={r.role?.[0] ?? ''} aria-label={t('analytics.filter.fields.role')}
            onChange={(e) => update(i, withOptional(r, 'role', e.target.value ? [e.target.value as Role] : undefined))}>
            <option value="">{t('analytics.filter.fields.anyRole')}</option>
            {ALL_ROLES.map((x) => <option key={x} value={x}>{role(x)}</option>)}
          </select>
          <select className={inputClass} value={r.side ?? ''} aria-label={t('analytics.filter.fields.side')}
            onChange={(e) => update(i, withOptional(r, 'side', (e.target.value || undefined) as WithPlayerClause['side']))}>
            <option value="">{t('analytics.filter.fields.anySide')}</option>
            <option value="red">{t('analytics.filter.sideValues.red')}</option>
            <option value="blue">{t('analytics.filter.sideValues.blue')}</option>
          </select>
          <select className={inputClass} value={r.result ?? ''} aria-label={t('analytics.filter.fields.result')}
            onChange={(e) => update(i, withOptional(r, 'result', (e.target.value || undefined) as WithPlayerClause['result']))}>
            <option value="">{t('analytics.filter.fields.anyResult')}</option>
            <option value="win">{t('analytics.filter.fields.win')}</option>
            <option value="loss">{t('analytics.filter.fields.loss')}</option>
          </select>
          <IconButton label={t('analytics.filter.remove')} onClick={() => update(i, null)}><Trash2 size={13} /></IconButton>
        </div>
      ))}
      <AddButton onClick={() => setDraft(withClauses(draft, 'withPlayer', [...rules, defaultWithPlayer()]))} testId="filter-add-player">
        {t('analytics.filter.fields.addPlayer')}
      </AddButton>
    </Section>
  );
}

/** 選填欄位：undefined = 拿掉這個鍵 (分享連結不留空欄位)。 */
function withOptional<T extends object, K extends keyof T>(obj: T, k: K, v: T[K] | undefined): T {
  const out = { ...obj };
  if (v === undefined) delete out[k];
  else out[k] = v;
  return out;
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white">
      {children}
    </button>
  );
}

function AddButton({ onClick, children, testId }: { onClick: () => void; children: ReactNode; testId?: string }): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded-md border border-dashed border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:border-white hover:text-white" data-testid={testId}>
      <Plus size={12} />
      {children}
    </button>
  );
}

function ExcludeSection({ draft, setDraft, vocab }: SectionProps): JSX.Element {
  const { t } = useTranslation('common');
  const rules = clausesOf(draft, 'excludePlayers');
  const update = (i: number, next: ExcludePlayersClause | null): void => {
    const list = rules.flatMap((r, j) => (j === i ? (next ? [next] : []) : [r]));
    setDraft(withClauses(draft, 'excludePlayers', list));
  };
  return (
    <Section title={t('analytics.filter.sections.exclude')}>
      {rules.map((r, i) => (
        <ExcludeRule key={i} rule={r} vocab={vocab} onChange={(n) => update(i, n)} onRemove={() => update(i, null)} />
      ))}
      <AddButton onClick={() => setDraft(withClauses(draft, 'excludePlayers', [...rules, defaultExcludeRule()]))} testId="filter-add-exclude">
        {t('analytics.filter.fields.addRule')}
      </AddButton>
    </Section>
  );
}

function ExcludeRule({ rule, vocab, onChange, onRemove }: {
  rule: ExcludePlayersClause; vocab?: FilterVocab | null; onChange: (r: ExcludePlayersClause) => void; onRemove: () => void;
}): JSX.Element {
  const { t } = useTranslation('common');
  const role = useRoleLabel();
  const metricLabel = useMetricLabel();
  const who = rule.who;
  // 和 PR 比 (預設) 或和數值比：有 value 鍵就是數值 (欄位暫時清空時鍵還在，不會跳成另一種)
  const byPr = who.by === 'metric' && !('value' in who);
  const names = who.by === 'names' ? who.names.join('、') : '';
  const [namesText, setNamesText] = useState(names);
  // 草稿換了名字 (還原、刪掉前一條、套用 JSON、外面改了篩選) → 欄位跟著換；自己打到一半的分隔符號不動
  if (splitNames(namesText).join('、') !== names) setNamesText(names);
  const setWho = (next: PlayerSelector): void => onChange({ ...rule, who: next });
  const f = 'analytics.filter.fields';
  return (
    <div className="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 p-2" data-testid="filter-exclude-rule">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-zinc-500">{t(`${f}.by`)}</span>
        <Toggle on={who.by === 'metric'} onClick={() => onChange(switchSelector(rule, 'metric'))}>{t(`${f}.byMetric`)}</Toggle>
        <Toggle on={who.by === 'names'} onClick={() => onChange(switchSelector(rule, 'names'))}>{t(`${f}.byNames`)}</Toggle>
        <span className="flex-1" />
        <IconButton label={t('analytics.filter.remove')} onClick={onRemove}><Trash2 size={13} /></IconButton>
      </div>
      {who.by === 'metric' ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <select className={inputClass} value={who.metric} aria-label={t(`${f}.metric`)}
              onChange={(e) => {
                const metric = e.target.value as MetricId;
                const next: PlayerSelector = { ...who, metric };
                if (METRICS[metric].needsRole) next.role = who.role ?? '梅林';
                else delete next.role;
                setWho(next);
              }}>
              {METRIC_GROUPS.map((g) => (
                <optgroup key={g.id} label={t(`analytics.filter.metricGroups.${g.id}`)}>
                  {g.metrics.map((m) => <option key={m} value={m}>{metricLabel(m)}</option>)}
                </optgroup>
              ))}
            </select>
            {METRICS[who.metric].needsRole && (
              <select className={inputClass} value={who.role ?? '梅林'} aria-label={t(`${f}.role`)}
                onChange={(e) => setWho({ ...who, role: e.target.value as Role })}>
                {ALL_ROLES.map((x) => <option key={x} value={x}>{role(x)}</option>)}
              </select>
            )}
            <select className={inputClass} value={who.op} aria-label={t(`${f}.op`)} onChange={(e) => setWho({ ...who, op: e.target.value as typeof who.op })}>
              {(['gt', 'ge', 'lt', 'le'] as const).map((op) => <option key={op} value={op}>{t(`analytics.filter.ops.${op}`)}</option>)}
            </select>
            <select className={inputClass} value={byPr ? 'pr' : 'value'} aria-label={t(`${f}.compareWith`)}
              onChange={(e) => {
                const current = (byPr ? who.pr : who.value) ?? 0;
                const rest = { ...who };
                delete rest.pr;
                delete rest.value;
                setWho(e.target.value === 'pr' ? { ...rest, pr: current } : { ...rest, value: current });
              }}>
              <option value="pr">{t(`${f}.pr`)}</option>
              <option value="value">{t(`${f}.value`)}</option>
            </select>
            <NumberInput
              value={byPr ? who.pr : who.value}
              onChange={(n) => setWho(byPr
                ? { ...who, pr: n === undefined ? undefined : Math.min(100, Math.max(0, n)) }
                : { ...who, value: n })}
              label={byPr ? t(`${f}.pr`) : t(`${f}.value`)}
              min={byPr ? 0 : undefined}
              max={byPr ? 100 : undefined}
            />
          </div>
          {vocab && (
            <p className="text-[11px] text-zinc-500">
              {t(`${f}.eligibility`, {
                text: t(`analytics.filter.eligibility.${isToughness(who.metric) ? 'voting' : who.metric}`, vocab.thresholds),
              })}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <LabeledSelect label={t(`${f}.evaluatedOn`)} value={who.evaluatedOn ?? 'unfiltered'}
              options={[['unfiltered', t(`${f}.unfiltered`)], ['filtered', t(`${f}.filtered`)]]}
              onChange={(v) => setWho(withOptional(who, 'evaluatedOn', v === 'filtered' ? 'filtered' : undefined))} />
            <LabeledSelect label={t(`${f}.ineligible`)} value={who.ineligible ?? 'keep'}
              options={[['keep', t(`${f}.keepIneligible`)], ['select', t(`${f}.selectIneligible`)]]}
              onChange={(v) => setWho(withOptional(who, 'ineligible', v === 'select' ? 'select' : undefined))} />
            <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
              {t(`${f}.minGames`)}
              <NumberInput value={who.minGames} placeholder={t(`${f}.minGamesHint`)} label={t(`${f}.minGames`)} min={0} wide
                onChange={(n) => setWho(withOptional(who, 'minGames', n === undefined ? undefined : Math.min(999999, Math.max(0, Math.round(n)))))} />
            </label>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <PlayerNames vocab={vocab} />
          <input
            className={`${inputClass} min-w-[12rem] flex-1`}
            list="stats-filter-players"
            placeholder={t(`${f}.names`)}
            value={namesText}
            onChange={(e) => {
              setNamesText(e.target.value);
              setWho({ ...who, names: splitNames(e.target.value) });
            }}
            aria-label={t(`${f}.names`)}
          />
          <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
            <input type="checkbox" checked={who.invert === true} onChange={(e) => setWho(withOptional(who, 'invert', e.target.checked ? true : undefined))} />
            {t(`${f}.exceptNames`)}
          </label>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <LabeledSelect label={t(`${f}.scope`)} value={rule.scope}
          options={[['dropGames', t(`${f}.dropGames`)], ['hideFromLists', t(`${f}.hideFromLists`)]]}
          onChange={(v) => onChange(v === 'hideFromLists'
            ? withOptional({ ...rule, scope: 'hideFromLists' }, 'dropIncompleteGames', undefined)
            : { ...rule, scope: 'dropGames' })} />
        {rule.scope === 'dropGames' && (
          <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
            <input type="checkbox" checked={rule.dropIncompleteGames === true}
              onChange={(e) => onChange(withOptional(rule, 'dropIncompleteGames', e.target.checked ? true : undefined))} />
            {t(`${f}.dropIncomplete`)}
          </label>
        )}
      </div>
    </div>
  );
}

/** 強硬度指標 (資格都是「該項至少 10 票」)。 */
function isToughness(metric: MetricId): boolean {
  return METRIC_GROUPS.some((g) => g.id === 'toughness' && g.metrics.includes(metric));
}

function LabeledSelect({ label, value, options, onChange }: {
  label: string; value: string; options: Array<[string, string]>; onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="inline-flex flex-wrap items-center gap-1 text-xs text-zinc-400">
      {label}
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

/** 數字欄：可以暫時是空的 (undefined)，打字中不跳回 0。 */
function NumberInput({ value, onChange, label, min, max, placeholder, wide = false }: {
  value: number | undefined; onChange: (n: number | undefined) => void; label: string; min?: number; max?: number;
  placeholder?: string; wide?: boolean;
}): JSX.Element {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  // 外面換了值 (例：切換 PR／數值) → 欄位跟著換；自己打的字 (例："8." 還沒打完) 不動
  const typed = text.trim() === '' ? undefined : Number(text);
  const same = typed === value || (value === undefined && typed !== undefined && Number.isNaN(typed));
  if (!same) setText(value === undefined ? '' : String(value));
  return (
    <input
      type="number"
      inputMode="decimal"
      step="0.1"
      min={min}
      max={max}
      className={`${inputClass} ${wide ? 'w-32' : 'w-20'}`}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value);
        const n = e.target.value.trim() === '' ? undefined : Number(e.target.value);
        onChange(n === undefined || Number.isFinite(n) ? n : undefined);
      }}
    />
  );
}

function OtherSection({ draft, setDraft }: SectionProps): JSX.Element | null {
  const { t } = useTranslation('common');
  const label = useClauseLabel();
  const others = otherClauses(draft);
  if (!others.length) return null;
  return (
    <Section title={t('analytics.filter.sections.other')}>
      <ul className="flex flex-wrap gap-1.5">
        {others.map((c) => {
          const index = draft.clauses.indexOf(c);
          return (
            <li key={index} className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 pl-2.5 pr-1 py-0.5 text-xs text-zinc-200">
              {label(c)}
              <button type="button" title={t('analytics.filter.invert')} aria-label={t('analytics.filter.invert')}
                onClick={() => setDraft({ ...draft, clauses: draft.clauses.map((x, i) => (i === index ? invertClause(x) : x)) })}
                className="rounded px-1 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-white">
                ¬
              </button>
              <button type="button" aria-label={t('analytics.filter.remove')} onClick={() => setDraft(removeClauseAt(draft, index))} className="rounded-full p-0.5 hover:bg-zinc-800">
                <X size={11} />
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function invertClause(c: Clause): Clause {
  if (c.kind === 'excludePlayers') return c;
  const out = { ...c } as Clause & { not?: boolean };
  if (out.not) delete out.not;
  else out.not = true;
  return out;
}

function AdvancedSection({ draft, setDraft }: SectionProps): JSX.Element {
  const { t } = useTranslation('common');
  const f = 'analytics.filter.fields';
  const pretty = JSON.stringify(draft, null, 1);
  const [text, setText] = useState(pretty);
  const [note, setNote] = useState<string | null>(null);
  const [seen, setSeen] = useState(pretty);
  if (seen !== pretty) {
    setSeen(pretty);
    setText(pretty);
  }
  const activity = draft.options?.activity ?? 'filtered';
  const applyJson = (): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      setNote(t(`${f}.jsonInvalid`));
      return;
    }
    const { filter, warnings } = sanitizeFilter(raw);
    if (!filter) {
      setNote(t(`${f}.jsonInvalid`));
      return;
    }
    setNote(warnings.length ? t(`${f}.jsonDropped`, { count: warnings.length }) : null);
    setDraft(filter);
  };
  return (
    <Section title={t('analytics.filter.sections.advanced')}>
      <LabeledSelect label={t(`${f}.activity`)} value={activity}
        options={[['filtered', t(`${f}.activityFiltered`)], ['all', t(`${f}.activityAll`)], ['none', t(`${f}.activityNone`)]]}
        onChange={(v) => {
          const options = { ...(draft.options ?? {}) };
          if (v === 'filtered') delete options.activity;
          else options.activity = v as 'all' | 'none';
          const next: GameFilter = { ...draft, options };
          if (!Object.keys(options).length) delete next.options;
          setDraft(next);
        }} />
      <label className="block text-xs text-zinc-500">
        {t(`${f}.json`)}
        <textarea
          className={`${inputClass} mt-1 block h-32 w-full font-mono`}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="filter-json"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={applyJson} className="rounded-md border border-zinc-600 px-2.5 py-1 text-xs text-zinc-200 hover:border-white" data-testid="filter-json-apply">
          {t(`${f}.applyJson`)}
        </button>
        {note && <span className="text-xs text-amber-300">{note}</span>}
      </div>
    </Section>
  );
}
