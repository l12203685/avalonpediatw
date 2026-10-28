import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { StatTermKey } from './statTerms';

/**
 * Term — 統計名詞的說明 (Edward 2026-10-28：「超額勝率是什麼意思 你有辦法做成 滑鼠移過去 會顯示那個名詞的
 * 算法/定義/意義嗎」)。
 *
 *  - 名詞加虛線底線；滑鼠移上去、鍵盤 focus 或點一下 (手機) 打開小視窗：定義 / 算法 / 怎麼看。
 *  - 文字在 i18n `statTerms.<key>.{name,def,calc,meaning}` (statTerms.ts 列出全部名詞)。
 *  - 小視窗畫在 body (portal + fixed)：表格在可捲動的容器裡，畫在裡面會被切掉。
 *  - Esc、點外面、移開滑鼠都會關。
 */
export interface TermProps {
  term: StatTermKey;
  /** 顯示的文字；預設是名詞本身 (statTerms.<key>.name)。 */
  children?: ReactNode;
  className?: string;
}

const POPOVER_WIDTH = 288; // 18rem
const GUTTER = 8;

export default function Term({ term, children, className }: TermProps): JSX.Element {
  const { t } = useTranslation('common');
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [pinned, setPinned] = useState(false);
  const k = `statTerms.${term}`;

  const open = useCallback((): void => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(GUTTER, r.left), window.innerWidth - POPOVER_WIDTH - GUTTER);
    setPos({ left: Math.max(GUTTER, left), top: r.bottom + 4 });
  }, []);
  const close = useCallback((): void => {
    setPos(null);
    setPinned(false);
  }, []);

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    const onDown = (e: PointerEvent): void => {
      if (!anchor.current?.contains(e.target as Node) && !document.getElementById(id)?.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', close, true);
    return (): void => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [pos, id, close]);

  const rows: Array<[string, string]> = (['def', 'calc', 'meaning'] as const)
    .map((part): [string, string] => [t(`statTerms.label.${part}`), t(`${k}.${part}`, { defaultValue: '' })])
    .filter(([, text]) => text);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-describedby={pos ? id : undefined}
        aria-expanded={pos !== null}
        data-testid={`term-${term}`}
        className={`inline cursor-help border-b border-dotted border-current/60 text-inherit font-inherit leading-inherit ${className ?? ''}`}
        onMouseEnter={open}
        onMouseLeave={() => { if (!pinned) setPos(null); }}
        onFocus={open}
        onBlur={() => { if (!pinned) setPos(null); }}
        onClick={(e) => {
          e.stopPropagation(); // 表頭、可點的列：只打開說明
          if (pinned) close();
          else { open(); setPinned(true); }
        }}
      >
        {children ?? t(`${k}.name`)}
      </button>
      {pos && createPortal(
        <div
          id={id}
          role="tooltip"
          style={{ left: pos.left, top: pos.top, width: POPOVER_WIDTH }}
          className="fixed z-[100] rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-left text-xs font-normal leading-relaxed text-zinc-300 shadow-xl whitespace-normal"
          onMouseEnter={() => setPinned(true)}
          onMouseLeave={close}
        >
          <div className="mb-1 font-semibold text-white">{t(`${k}.name`)}</div>
          <dl className="space-y-1">
            {rows.map(([label, text]) => (
              <div key={label}>
                <dt className="inline font-semibold text-amber-300">{label}：</dt>
                <dd className="inline">{text}</dd>
              </div>
            ))}
          </dl>
        </div>,
        document.body,
      )}
    </>
  );
}

