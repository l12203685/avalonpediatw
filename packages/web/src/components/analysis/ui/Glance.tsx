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
 *  - MeterBar：單一比例的長條（刺中率、佔幾成的局），數字寫在長條右邊；可以加一條白線當對照（全體）。
 *  - RankRow：排行用的一列＝名字｜長條｜小字樣本數（手機上樣本數換到長條下面，不橫向捲）。
 * 顏色全站一致：藍＝藍方（好人）得利，紅＝紅方（壞人）得利；投票用黑白球：深灰＝反對、白＝贊成。
 * （第三批）跟陣營無關的個人數字用灰（plain），排行榜上比的數字用琥珀（rank）。
 * 字一律用文字色（白／灰），不拿陣營色當字色——陣營靠旁邊的色塊認。
 */
/** plain＝跟陣營無關的數字（個人的整體勝率、理論勝率）；rank＝排行榜上比的那個數字（琥珀：強調／名次）。 */
/** （第四批）kill＝梅林被刺中（三藍死，紫紅 #d1287a，同 tokens.ts OUTCOME_COLORS）：三種結局一起畫時用。 */
export type GlanceTone = 'blue' | 'red' | 'no' | 'yes' | 'plain' | 'rank' | 'kill';

const SEGMENT_CLASS: Readonly<Record<GlanceTone, string>> = {
  blue: 'bg-blue-600 text-white',
  red: 'bg-red-600 text-white',
  no: 'bg-zinc-600 text-white',
  yes: 'bg-zinc-200 text-zinc-900',
  plain: 'bg-zinc-500 text-white',
  rank: 'bg-amber-600 text-white',
  kill: 'bg-[#d1287a] text-white',
};

const SWATCH_CLASS: Readonly<Record<GlanceTone, string>> = {
  blue: 'bg-blue-600',
  red: 'bg-red-600',
  no: 'bg-zinc-600',
  yes: 'bg-zinc-200',
  plain: 'bg-zinc-500',
  rank: 'bg-amber-600',
  kill: 'bg-[#d1287a]',
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

/**
 * 單一比例的長條：填色寬度 = pct ÷ max；數字直接寫在右邊（固定寬度，上下對齊）。
 * refPct = 對照的白線（例：全體的刺中率），高於／低於一眼看得出來。
 */
export function MeterBar({ pct, text, tone, refPct, max = 100, label }: {
  /** 0–100，沒有四捨五入（寬度用）。 */
  pct: number;
  /** 顯示的字（例：「53%」）。 */
  text: string;
  tone: GlanceTone;
  refPct?: number | null;
  /** 長條滿格代表多少（預設 100）。 */
  max?: number;
  /** 無障礙名稱與提示（例：「2 家 53%（樣本 113）」）。 */
  label?: string;
}): JSX.Element {
  const width = (v: number): string => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  return (
    <div className="flex items-center gap-2" role="img" aria-label={label ?? text} title={label} data-testid="meter-bar">
      <div className="relative h-4 min-w-0 flex-1 overflow-hidden rounded bg-zinc-800">
        <div className={`absolute inset-y-0 left-0 rounded ${SWATCH_CLASS[tone]}`} style={{ width: width(pct) }} />
        {refPct !== null && refPct !== undefined && <div className="absolute inset-y-0 w-0.5 bg-white/80" style={{ left: width(refPct) }} />}
      </div>
      <span className="w-10 shrink-0 text-right text-xs font-bold tabular-nums text-white">{text}</span>
    </div>
  );
}

/**
 * 排行的一列：名字（可加色塊認陣營、小標）｜長條（children）｜樣本數小字。
 * 手機：名字和長條同一行，樣本數在長條下面；sm 以上三欄同一行。名字和小標一行放不下時，小標換到下一行。
 */
export function RankRow({ label, dot, tag, sample, thin, wide = false, children }: {
  label: ReactNode;
  /** 名字前的色塊（陣營）。 */
  dot?: GlanceTone;
  /** 名字後的小標（例：「最高」）。 */
  tag?: ReactNode;
  sample?: ReactNode;
  thin?: ReactNode;
  /** 名字比較長（例：五格的任務路徑）時給寬一點的第一欄。 */
  wide?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`grid items-center gap-x-2 ${wide ? 'grid-cols-[6.5rem_minmax(0,1fr)] sm:grid-cols-[7.5rem_minmax(0,1fr)_8.5rem]' : 'grid-cols-[5.25rem_minmax(0,1fr)] sm:grid-cols-[6.5rem_minmax(0,1fr)_6rem]'}`}
      data-testid="rank-row"
    >
      {/* 名字放不下小標時，小標換到名字下面一行（不裁掉名字、色塊） */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-semibold text-zinc-200">
        <span className="inline-flex max-w-full shrink-0 items-center gap-1.5">
          {dot && <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${SWATCH_CLASS[dot]}`} aria-hidden />}
          <span className="min-w-0 truncate">{label}</span>
        </span>
        {tag && <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-200">{tag}</span>}
      </div>
      <div className="min-w-0">{children}</div>
      {sample && (
        <div className="col-start-2 whitespace-nowrap text-[11px] tabular-nums text-zinc-500 sm:col-start-3 sm:text-right">
          {sample}
          {thin && <span className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-200" data-testid="glance-thin">{thin}</span>}
        </div>
      )}
    </div>
  );
}

/** 任務路徑（例「紅紅藍藍藍」）畫成一排色塊：由左到右是第 1 到第 5 個任務，紅＝任務失敗、藍＝任務成功。 */
export function PathChips({ path, label }: { path: string; label: string }): JSX.Element {
  return (
    <span role="img" className="inline-flex items-center gap-0.5 align-middle" title={path} aria-label={label}>
      {Array.from(path).map((c, i) => (
        <span key={i} aria-hidden className={`inline-block h-3 w-3 rounded-[3px] ${c === '紅' ? 'bg-red-600' : c === '藍' ? 'bg-blue-600' : 'bg-zinc-600'}`} />
      ))}
    </span>
  );
}

/** 「進階：…」收合區：預設收起，打開才掛載（原本的完整表格、細的統計放這裡）。 */
export function Advanced({ title, children, testId, defaultOpen = false }: {
  title: ReactNode;
  children: () => ReactNode;
  testId?: string;
  /** 一開始就打開（例：從別頁的「看各組」連過來，要看的就是裡面的表）。 */
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
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
