import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * SectionTabs — 分頁內的小分頁 (segmented control + 內容切換)。
 *
 * 2026-10-14 Edward：「頁面不要拉太長，最好分頁切過去一頁可以顯示全部該分頁的內容」。
 * 一個分析分頁的內容太多時，用這個切成幾頁，一次只掛一頁 (其他頁不渲染)。
 *
 *  - 受控 (value + onChange) 或非受控 (defaultValue)；非受控時可給 persistKey，
 *    記住上次看的小分頁 (localStorage，讀寫都包 try/catch，私密模式／封鎖儲存時只記在記憶體)。
 *    受控模式不碰 localStorage — 需要記住的話用 useSectionTab 取得 [value, setValue] 再傳進來。
 *  - 手機上標籤列在自己的容器裡橫向捲動，不會撐寬頁面；切換時把目前的標籤捲進可視範圍。
 *  - 無障礙：role=tablist / tab / tabpanel、aria-selected、aria-controls；
 *    ← → 切換 (自動啟用)，Home / End 跳到第一個／最後一個。
 *  - 內容：panels ({id: ReactNode}) 或 children (active => ReactNode)；兩者都沒給時只畫標籤列。
 */

export interface SectionTabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: LucideIcon;
  /** 標籤後面的小字 (例：場數)。 */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface SectionTabsProps<T extends string = string> {
  items: readonly SectionTabItem<T>[];
  /** 受控：目前的分頁 id。 */
  value?: T;
  onChange?: (id: T) => void;
  /** 非受控的初始分頁 (沒給 = 第一個可用的)。 */
  defaultValue?: T;
  /** 非受控時記住上次的分頁；同一個鍵在不同頁面要不同 (例：'analysis.teams')。 */
  persistKey?: string;
  /** tablist 的無障礙名稱 (預設「分頁」)。 */
  ariaLabel?: string;
  panels?: Partial<Record<T, ReactNode>>;
  children?: (active: T) => ReactNode;
  /** 切換時淡入 (預設 true；系統設定減少動態時一律關閉)。 */
  animate?: boolean;
  size?: 'sm' | 'md';
  /** 標籤平均撐滿整列 (項目少時好看；項目多時仍會橫捲)。 */
  stretch?: boolean;
  className?: string;
  /** 標籤列與內容之間的間距等，加在 tabpanel 上。 */
  panelClassName?: string;
}

const STORAGE_PREFIX = 'avalonpediatw-section-tab:';

function readStoredTab(key: string | undefined): string | null {
  if (!key) return null;
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null;
  }
}

function writeStoredTab(key: string | undefined, id: string): void {
  if (!key) return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, id);
  } catch {
    // 儲存不可用 (私密模式、封鎖網站資料) — 只記在記憶體
  }
}

function isSelectable<T extends string>(items: readonly SectionTabItem<T>[], id: unknown): id is T {
  return typeof id === 'string' && items.some(i => i.id === id && !i.disabled);
}

/** 依序取第一個可選的候選；都不行就第一個沒停用的項目。 */
function resolveActive<T extends string>(
  items: readonly SectionTabItem<T>[],
  ...candidates: unknown[]
): T | undefined {
  for (const c of candidates) {
    if (isSelectable(items, c)) return c;
  }
  return items.find(i => !i.disabled)?.id;
}

/**
 * 非受控狀態 + 記憶：回傳 [目前分頁, 切換]。目前分頁一定是 items 裡可選的 (或 undefined = 沒有項目)。
 * 給需要知道目前小分頁的父元件用 (例：依分頁換標題)，再把值以受控方式傳給 SectionTabs。
 */
export function useSectionTab<T extends string>(
  items: readonly SectionTabItem<T>[],
  opts: { defaultValue?: T; persistKey?: string } = {},
): [T | undefined, (id: T) => void] {
  const { defaultValue, persistKey } = opts;
  const [picked, setPicked] = useState<string | null>(() => readStoredTab(persistKey));
  const active = resolveActive(items, picked, defaultValue);
  const select = useCallback((id: T) => {
    setPicked(id);
    writeStoredTab(persistKey, id);
  }, [persistKey]);
  return [active, select];
}

export default function SectionTabs<T extends string = string>({
  items,
  value,
  onChange,
  defaultValue,
  persistKey,
  ariaLabel,
  panels,
  children,
  animate = true,
  size = 'sm',
  stretch = false,
  className = '',
  panelClassName = '',
}: SectionTabsProps<T>): JSX.Element {
  const { t } = useTranslation('common');
  const uid = useId();
  const reduceMotion = useReducedMotion();
  const controlled = value !== undefined;
  // 受控時不讀寫 localStorage (persistKey 只給非受控用)。
  const [innerActive, innerSelect] = useSectionTab(items, {
    defaultValue,
    persistKey: controlled ? undefined : persistKey,
  });
  const active = controlled ? resolveActive(items, value) : innerActive;

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = (id: T): void => {
    if (!controlled) innerSelect(id);
    if (id !== active) onChange?.(id);
  };

  const activeIndex = items.findIndex(i => i.id === active);

  // 把目前的標籤捲進標籤列的可視範圍 (只動標籤列自己的 scrollLeft，不捲整頁)。
  useEffect(() => {
    const scroller = scrollerRef.current;
    const el = tabRefs.current[activeIndex];
    if (!scroller || !el) return;
    const pad = 8;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < scroller.scrollLeft) {
      scroller.scrollLeft = Math.max(0, left - pad);
    } else if (right > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = right - scroller.clientWidth + pad;
    }
  }, [activeIndex]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter(i => i >= 0);
    if (enabled.length === 0) return;
    const pos = Math.max(0, enabled.indexOf(index));
    let next: number;
    switch (e.key) {
      case 'ArrowRight': next = enabled[(pos + 1) % enabled.length]; break;
      case 'ArrowLeft':  next = enabled[(pos - 1 + enabled.length) % enabled.length]; break;
      case 'Home':       next = enabled[0]; break;
      case 'End':        next = enabled[enabled.length - 1]; break;
      default: return;
    }
    e.preventDefault();
    select(items[next].id);
    tabRefs.current[next]?.focus();
  };

  const tabId = (i: number): string => `${uid}-tab-${i}`;
  const panelId = `${uid}-panel`;
  const hasPanel = children !== undefined || panels !== undefined;
  const content = active === undefined ? null : children ? children(active) : panels?.[active] ?? null;
  const motionOn = animate && !reduceMotion;

  const sizeClass = size === 'md' ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-1 text-xs';

  return (
    <div className={`min-w-0 ${className}`}>
      <div
        ref={scrollerRef}
        className="relative max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div
          role="tablist"
          aria-label={ariaLabel ?? t('analytics.ui.sectionTabs.label')}
          aria-orientation="horizontal"
          className={`${stretch ? 'flex w-full' : 'inline-flex'} gap-0.5 p-0.5 rounded-lg bg-zinc-900/80 border border-zinc-800`}
        >
          {items.map((item, i) => {
            const selected = item.id === active;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                ref={el => { tabRefs.current[i] = el; }}
                type="button"
                role="tab"
                id={tabId(i)}
                aria-selected={selected}
                aria-controls={selected && hasPanel ? panelId : undefined}
                tabIndex={selected ? 0 : -1}
                disabled={item.disabled}
                onClick={() => select(item.id)}
                onKeyDown={e => onKeyDown(e, i)}
                className={`relative ${stretch ? 'flex-1' : ''} shrink-0 inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 ${sizeClass} ${
                  selected
                    ? 'text-white'
                    : item.disabled
                      ? 'text-zinc-600 cursor-not-allowed'
                      : 'text-zinc-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {selected && (
                  motionOn ? (
                    <motion.span
                      layoutId={`${uid}-pill`}
                      className="absolute inset-0 rounded-md bg-zinc-700 ring-1 ring-zinc-600 shadow-sm"
                      transition={{ type: 'spring', bounce: 0.15, duration: 0.3 }}
                      aria-hidden
                    />
                  ) : (
                    <span className="absolute inset-0 rounded-md bg-zinc-700 ring-1 ring-zinc-600 shadow-sm" aria-hidden />
                  )
                )}
                <span className="relative inline-flex items-center gap-1.5">
                  {Icon && <Icon size={size === 'md' ? 14 : 12} className="shrink-0" aria-hidden />}
                  {item.label}
                  {item.badge !== undefined && item.badge !== null && (
                    <span className={`text-[10px] font-normal tabular-nums ${selected ? 'text-zinc-300' : 'text-zinc-500'}`}>
                      {item.badge}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {hasPanel && active !== undefined && activeIndex >= 0 && (
        motionOn ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={active}
              role="tabpanel"
              id={panelId}
              aria-labelledby={tabId(activeIndex)}
              tabIndex={0}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className={`min-w-0 mt-3 focus-visible:outline-none ${panelClassName}`}
            >
              {content}
            </motion.div>
          </AnimatePresence>
        ) : (
          <div
            role="tabpanel"
            id={panelId}
            aria-labelledby={tabId(activeIndex)}
            tabIndex={0}
            className={`min-w-0 mt-3 focus-visible:outline-none ${panelClassName}`}
          >
            {content}
          </div>
        )
      )}
    </div>
  );
}
