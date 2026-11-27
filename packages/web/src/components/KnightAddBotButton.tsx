/**
 * 房間大廳「加入 AI」：房主先選哪一位 AI騎士 再加（站長 2026-11-26「所以如果練習台想呼叫AI騎士_ED 有辦法嗎」）。
 * 座位名由伺服器給：AI騎士_ED_01，同房第二位 AI騎士_ED_02。名冊讀不到（舊版伺服器）時只列百科。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { addBot } from '../services/socket';
import { DEFAULT_KNIGHT_ID, knightBlurb, knightSamplesLine, useKnights } from '../services/knights';

export default function KnightAddBotButton({ roomId }: { roomId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { knights, ready } = useKnights(open);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 選單掛在 body 上（fixed）：房間頁下面幾排有自己的疊層，掛在按鈕旁邊會被蓋住。
  const [pos, setPos] = useState<CSSProperties>({});

  useEffect(() => {
    if (!open) return;
    const place = (): void => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(288, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
      setPos({ top: r.bottom + 4, left, width, maxHeight: Math.max(160, window.innerHeight - r.bottom - 16) });
    };
    place();
    const onDown = (e: MouseEvent | TouchEvent): void => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    return (): void => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  const pick = (knightId: string): void => {
    try {
      addBot(roomId, knightId);
    } catch {
      // not connected: the connection banner already says so
    }
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[clamp(0.5rem,1.5vw,0.62rem)] font-semibold bg-emerald-900/40 border-emerald-600 text-emerald-200 hover:bg-emerald-900/60 hover:text-white transition-colors whitespace-nowrap"
        title="加入 AI騎士"
        data-testid="lobby-add-ai-button"
      >
        加入 AI
        <ChevronDown size={9} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="選一位 AI騎士"
          data-testid="lobby-knight-menu"
          style={pos}
          className="fixed z-[1000] overflow-y-auto rounded-lg border border-emerald-700 bg-zinc-950 p-1 text-left shadow-2xl"
        >
          <p className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-zinc-400">
            選一位 AI騎士 加進房間。同一位可以加好幾個（座位名後面編號）。
            {!ready && ' 讀取名單中…'}
          </p>
          {knights.map((k) => (
            <button
              key={k.id}
              type="button"
              role="menuitem"
              onClick={() => pick(k.id)}
              data-testid={`lobby-knight-${k.id}`}
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-emerald-900/40 focus:bg-emerald-900/40 focus:outline-none"
            >
              <span className="flex flex-wrap items-center gap-1">
                <span className="text-sm font-semibold text-white">{k.name}</span>
                {k.id === DEFAULT_KNIGHT_ID && <span className="text-[10px] text-zinc-400">預設</span>}
                {k.tag && <span className="rounded border border-emerald-700/80 px-1 text-[10px] text-emerald-200">{k.tag}</span>}
                {knightSamplesLine(k) && <span className="text-[10px] text-zinc-400">{knightSamplesLine(k)}</span>}
              </span>
              <span className="block text-[11px] leading-snug text-zinc-400 line-clamp-2">{knightBlurb(k.style)}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
