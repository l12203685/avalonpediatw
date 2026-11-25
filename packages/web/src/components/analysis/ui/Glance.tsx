import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * 「一眼看懂」用的小零件（站長 2026-11-25：數據分析要更直觀、一目瞭然）。跟資料無關，數字由呼叫端從 core/glance.ts 拿：
 *  - SplitBar：一條分成兩段的比例條（藍方贏｜紅方贏、成功｜失敗、反對｜贊成），數字直接寫在色塊上；
 *    色塊太窄放不下數字時不硬塞（不裁字），改寫在長條下面一行小字（色塊＋名字＋數字）。
 *  - GlanceLegend：色塊是什麼（一張卡一次，放在長條上面）。
 *  - GlanceRow：一列＝標題＋小字樣本數（「共 N 局」）＋長條。
 *  - KeyNumber：一張卡一個大數字，下面一行小字說它是什麼。
 *  - Advanced：「進階：…」收合區，原本的完整表格收在裡面，打開才掛載。
 * 顏色全站一致：藍＝藍方（好人）得利，紅＝紅方（壞人）得利；投票用黑白球：深灰＝反對、白＝贊成。
 * 字一律用文字色（白／灰），不拿陣營色當字色——陣營靠旁邊的色塊認。
 */
export type GlanceTone = 'blue' | 'red' | 'no' | 'yes';

const SEGMENT_CLASS: Readonly<Record<GlanceTone, string>> = {
  blue: 'bg-blue-600 text-white',
  red: 'bg-red-600 text-white',
  no: 'bg-zinc-600 text-white',
  yes: 'bg-zinc-200 text-zinc-900',
};

const SWATCH_CLASS: Readonly<Record<GlanceTone, string>> = {
  blue: 'bg-blue-600',
  red: 'bg-red-600',
  no: 'bg-zinc-600',
  yes: 'bg-zinc-200',
};

export interface SplitSegment {
  /** 0–100，沒有四捨五入（寬度用）。 */
  pct: number;
  /** 顯示的字（例：「31%」）。 */
  text: string;
  /** 這一段是什麼（例：「藍方贏」）：圖例、提示、無障礙名稱用；showNames 時也寫在色塊上。 */
  name: string;
  tone: GlanceTone;
}

/** 色塊寬到這個比例才把數字寫進去（手機上長條約 300px：14% ≈ 42px，放得下「24%」）。 */
const TEXT_MIN_PCT = 14;
/** 色塊寬到這個比例才連名字一起寫（「藍方贏 31%」）。 */
const NAME_MIN_PCT = 30;

export function SplitBar({ segments, size = 'md', showNames = false, sample }: {
  segments: readonly SplitSegment[];
  size?: 'md' | 'lg';
  showNames?: boolean;
  /** 樣本數的字（「共 982 局」），放進提示與無障礙名稱。 */
  sample?: string;
}): JSX.Element {
  const shown = segments.filter(s => s.pct > 0);
  // 放不進色塊的數字（太窄或 0%）：寫在長條下面
  const outside = segments.filter(s => s.pct < TEXT_MIN_PCT);
  const label = `${segments.map(s => `${s.name} ${s.text}`).join('，')}${sample ? `（${sample}）` : ''}`;
  return (
    <div role="img" aria-label={label} data-testid="split-bar-wrap">
      <div className={`flex w-full gap-0.5 ${size === 'lg' ? 'h-8 text-sm sm:text-base' : 'h-6 text-xs'}`} data-testid="split-bar">
        {shown.map((s, i) => (
          <div
            key={s.name}
            title={`${s.name} ${s.text}${sample ? `（${sample}）` : ''}`}
            style={{ flexGrow: s.pct, flexBasis: 0 }}
            className={`flex min-w-0 items-center whitespace-nowrap font-bold tabular-nums ${s.pct >= TEXT_MIN_PCT ? 'px-2' : ''} ${SEGMENT_CLASS[s.tone]} ${i === 0 ? 'rounded-l' : ''} ${i === shown.length - 1 ? 'justify-end rounded-r' : ''}`}
          >
            {s.pct >= TEXT_MIN_PCT && (
              <span>{showNames && s.pct >= NAME_MIN_PCT ? `${s.name} ${s.text}` : s.text}</span>
            )}
          </div>
        ))}
      </div>
      {outside.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] tabular-nums text-zinc-300" data-testid="split-bar-outside">
          {outside.map(s => (
            <span key={s.name} className="inline-flex items-center gap-1">
              <span className={`inline-block h-2 w-2 rounded-sm ${SWATCH_CLASS[s.tone]}`} aria-hidden />
              {s.name} <b className="text-zinc-100">{s.text}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function GlanceLegend({ items, className = '' }: { items: ReadonlyArray<{ name: string; tone: GlanceTone }>; className?: string }): JSX.Element {
  return (
    <ul className={`flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-400 ${className}`} data-testid="glance-legend">
      {items.map(item => (
        <li key={item.name} className="inline-flex items-center gap-1">
          <span className={`inline-block h-2.5 w-2.5 rounded-sm ${SWATCH_CLASS[item.tone]}`} aria-hidden />
          {item.name}
        </li>
      ))}
    </ul>
  );
}

export function GlanceRow({ label, sample, thin, tag, children }: {
  label: ReactNode;
  /** 樣本數小字（「共 982 局」）。 */
  sample?: ReactNode;
  /** 樣本少時接在樣本數後面的小標（「樣本少」）；沒給就不標。 */
  thin?: ReactNode;
  /** 標題旁的小標（例：「最難」）。 */
  tag?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="min-w-0" data-testid="glance-row">
      <div className="mb-0.5 flex items-baseline gap-2 text-xs">
        <span className="min-w-0 font-semibold text-zinc-200">{label}</span>
        {tag && <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-200">{tag}</span>}
        {sample && (
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-500">
            {sample}
            {thin && <span className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-200" data-testid="glance-thin">{thin}</span>}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export function KeyNumber({ value, label, tone }: { value: string; label: ReactNode; tone?: GlanceTone }): JSX.Element {
  return (
    <div className="flex items-center gap-2.5" data-testid="key-number">
      {tone && <span className={`h-9 w-1.5 shrink-0 rounded-full ${SWATCH_CLASS[tone]}`} aria-hidden />}
      <span className="text-4xl font-black leading-none tabular-nums text-white">{value}</span>
      <span className="min-w-0 text-xs leading-snug text-zinc-400">{label}</span>
    </div>
  );
}

/** 「進階：…」收合區：預設收起，打開才掛載（原本的完整表格、細的統計放這裡）。 */
export function Advanced({ title, children, testId }: { title: ReactNode; children: () => ReactNode; testId?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40" data-testid={testId ?? 'glance-advanced'}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-zinc-400 hover:text-white"
      >
        <ChevronRight size={14} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        {title}
      </button>
      {open && <div className="border-t border-zinc-800 p-2">{children()}</div>}
    </section>
  );
}
