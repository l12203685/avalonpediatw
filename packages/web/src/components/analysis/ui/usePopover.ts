import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent, type MouseEvent } from 'react';

/**
 * 滑鼠提示／點一下打開的小視窗共用邏輯 (Term 名詞說明、InfoTip 表格說明 ⓘ)。
 *
 *  - 桌面：滑鼠移上去或鍵盤 focus 打開、移開關；手機：點一下打開 (釘住)，再點一下、點外面、Esc 關。
 *  - 小視窗畫在 body (portal + fixed)：表格在可捲動的容器裡，畫在裡面會被切掉。
 *  - 下方空間不夠時往上開；內容太長在小視窗裡捲 (捲小視窗本身不會關掉它)。
 */
export interface PopoverPosition {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

const GUTTER = 8;
const MIN_BELOW = 220;

export function usePopover<T extends HTMLElement>(width: number) {
  const id = useId();
  const anchor = useRef<T>(null);
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const [pinned, setPinned] = useState(false);

  const open = useCallback((): void => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(width, window.innerWidth - GUTTER * 2);
    const left = Math.max(GUTTER, Math.min(r.left, window.innerWidth - w - GUTTER));
    const below = window.innerHeight - r.bottom - GUTTER - 4;
    const above = r.top - GUTTER - 4;
    setPos(below < MIN_BELOW && above > below
      ? { left, width: w, bottom: window.innerHeight - r.top + 4, maxHeight: above }
      : { left, width: w, top: r.bottom + 4, maxHeight: Math.max(below, 120) });
  }, [width]);

  const close = useCallback((): void => {
    setPos(null);
    setPinned(false);
  }, []);

  useEffect(() => {
    if (!pos) return;
    const inside = (target: EventTarget | null): boolean => {
      const node = target as Node | null;
      return Boolean(node && (anchor.current?.contains(node) || document.getElementById(id)?.contains(node)));
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    const onDown = (e: PointerEvent): void => { if (!inside(e.target)) close(); };
    const onScroll = (e: Event): void => { if (!inside(e.target)) close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return (): void => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [pos, id, close]);

  /** 觸發元件 (名詞、ⓘ) 的事件。 */
  const triggerProps = {
    ref: anchor,
    'aria-describedby': pos ? id : undefined,
    'aria-expanded': pos !== null,
    onMouseEnter: open,
    onMouseLeave: (): void => { if (!pinned) setPos(null); },
    onFocus: open,
    onBlur: (e: FocusEvent): void => {
      if (!pinned && !document.getElementById(id)?.contains(e.relatedTarget as Node | null)) setPos(null);
    },
    onClick: (e: MouseEvent): void => {
      e.stopPropagation(); // 表頭、可點的列：只打開說明
      if (pinned) close();
      else { open(); setPinned(true); }
    },
  };

  /** 小視窗本身的屬性 (滑鼠移進去就釘住，可以點裡面的連結)。 */
  const panelProps = {
    id,
    style: {
      left: pos?.left,
      top: pos?.top,
      bottom: pos?.bottom,
      width: pos?.width,
      maxHeight: pos?.maxHeight,
    } satisfies CSSProperties,
    onMouseEnter: (): void => setPinned(true),
    onMouseLeave: close,
  };

  return { pos, close, triggerProps, panelProps };
}

/** 小視窗的外框樣式 (Term、InfoTip 共用)。 */
export const POPOVER_CLASS =
  'fixed z-[100] overflow-y-auto overscroll-contain rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-left text-xs font-normal leading-relaxed text-zinc-300 shadow-xl whitespace-normal';
