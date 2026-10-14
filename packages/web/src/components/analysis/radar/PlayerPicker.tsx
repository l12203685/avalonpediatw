import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cleanNameQuery, compactName, normalizeName, type NameMatch } from '@avalon/shared';
import type { AnalysisPlayerStats } from '../../../services/api';

/**
 * 玩家雷達的選人框 (2026-10-14 Edward：「頁面不要拉太長」— 原本搜尋框下面一整片名字按鈕把內容往下推)。
 * 改成搜尋框 + 浮在內容上面的下拉名單 (combobox)：點框或打字才展開，名單在自己的容器裡捲，
 * 不佔版面。比對規則不變 (與機器人 /戰績 同一套 @avalon/shared)：名字含搜尋字的全部列出、
 * 場次多的在前；一個都沒有時列「你是不是要找」。↑↓ 選、Enter 開 (沒選就開第一位)、Esc 收起。
 */

/**
 * 搜尋框下的名字：名字含搜尋字 (不分大小寫、全半形，也忽略空白與 ._-·) 的全部列出，
 * 場次多的在前；一個都沒有時列「你是不是要找」的建議。沒打字 = 全部。
 */
export function filterPlayers(players: AnalysisPlayerStats[], search: string, match: NameMatch | null): AnalysisPlayerStats[] {
  const cleaned = cleanNameQuery(search);
  if (!cleaned) return players;
  const nq = normalizeName(cleaned);
  const cq = compactName(cleaned);
  const hits = players.filter(p => normalizeName(p.name).includes(nq) || (cq !== '' && compactName(p.name).includes(cq)));
  if (hits.length > 0) return hits;
  const suggested = match?.kind === 'none' ? match.suggestions ?? [] : [];
  return players.filter(p => suggested.includes(p.name));
}

export interface PlayerPickerProps {
  /** 已篩選的名單 (filterPlayers)。 */
  options: AnalysisPlayerStats[];
  /** 全部玩家數 (沒打字時的提示)。 */
  total: number;
  selectedName: string;
  search: string;
  onSearchChange: (value: string) => void;
  match: NameMatch | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 選定一位 (父元件負責清空搜尋、收起名單)。 */
  onPick: (name: string) => void;
}

export default function PlayerPicker({
  options, total, selectedName, search, onSearchChange, match, open, onOpenChange, onPick,
}: PlayerPickerProps): JSX.Element {
  const { t } = useTranslation('common');
  const uid = useId();
  const listId = `${uid}-list`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [active, setActive] = useState(-1);
  // 名單換了 (打字、重新展開) 就從頭選起 (React「依 props 調整 state」，不用 effect)。
  const [seenOptions, setSeenOptions] = useState(options);
  const [seenOpen, setSeenOpen] = useState(open);
  if (seenOptions !== options || seenOpen !== open) {
    setSeenOptions(options);
    setSeenOpen(open);
    setActive(-1);
  }

  // 點到選人框外面就收起 (從排行帶名字進來時名單是自動展開的，輸入框沒有焦點，不能只靠 blur)。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return (): void => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open, onOpenChange]);

  // ↑↓ 移動時把目前那一位捲進名單的可視範圍 (只捲名單自己)。
  useEffect(() => {
    if (!open || active < 0) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const pick = (name: string | undefined): void => {
    if (name) onPick(name);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) { onOpenChange(true); return; }
        setActive(i => Math.min(options.length - 1, i + 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive(i => Math.max(-1, i - 1));
        return;
      case 'Enter':
        e.preventDefault();
        if (open && active >= 0) pick(options[active]?.name);
        else pick(match?.kind === 'found' ? match.name : options[0]?.name);
        return;
      case 'Escape':
        if (open) { e.preventDefault(); onOpenChange(false); }
        return;
      default:
    }
  };

  const status = match && match.kind !== 'found'
    ? match.kind === 'ambiguous'
      ? t('analytics.deep.radar.searchMany', { count: match.total })
      : match.suggestions && match.suggestions.length > 0
        ? t('analytics.deep.radar.searchSuggest', { query: cleanNameQuery(match.query) })
        : t('analytics.deep.radar.searchNone', { query: cleanNameQuery(match.query) })
    : null;

  const optionId = (i: number): string => `${uid}-opt-${i}`;

  return (
    <div ref={rootRef} className="relative z-30 w-full sm:w-72 shrink-0">
      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" aria-hidden />
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open && options.length > 0 ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-label={t('analytics.r6.radar.picker.label')}
        placeholder={t('analytics.deep.radar.search')}
        value={search}
        onChange={e => { onSearchChange(e.target.value); onOpenChange(true); }}
        onFocus={() => onOpenChange(true)}
        onClick={() => { if (!open) onOpenChange(true); }}
        onKeyDown={onKeyDown}
        onBlur={e => {
          if (!rootRef.current?.contains(e.relatedTarget as Node | null)) onOpenChange(false);
        }}
        data-testid="radar-search"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-1.5 pl-8 pr-8 text-sm text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('analytics.r6.radar.picker.toggle')}
        onMouseDown={e => e.preventDefault()}
        onClick={() => onOpenChange(!open)}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 hover:text-white"
      >
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 shadow-xl shadow-black/50 sm:right-auto sm:w-80">
          <p
            data-testid={status ? 'radar-search-status' : undefined}
            className="border-b border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-400"
          >
            {status ?? (search.trim()
              ? t('analytics.r6.radar.picker.matches', { count: options.length })
              : t('analytics.r6.radar.picker.all', { count: total }))}
          </p>
          {options.length === 0 ? (
            !status && <p className="px-3 py-3 text-xs text-zinc-500">{t('analytics.r6.radar.picker.none')}</p>
          ) : (
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={t('analytics.r6.radar.picker.list')}
              className="max-h-72 overflow-y-auto overscroll-contain py-1"
            >
              {options.map((p, i) => {
                const selected = p.name === selectedName;
                return (
                  <li
                    key={p.name}
                    id={optionId(i)}
                    role="option"
                    aria-selected={selected}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => pick(p.name)}
                    onMouseEnter={() => setActive(i)}
                    className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-1 text-xs ${
                      i === active ? 'bg-zinc-800' : ''
                    } ${selected ? 'font-bold text-blue-300' : 'text-zinc-300'}`}
                  >
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0 tabular-nums text-[10px] text-zinc-500">
                      {t('analytics.r6.radar.picker.games', { count: p.totalGames })}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
