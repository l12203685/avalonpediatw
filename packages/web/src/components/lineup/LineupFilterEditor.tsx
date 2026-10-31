import { sanitizeLineupState, type LineupFilterState } from '../../utils/lineupFilter';

/**
 * 陣容強度篩選（Edward 2026-10-31）：「S ≥ __」「PR __ 以上至少 __ 人」各自可開關，兩個都開時選且／或，
 * 另可「包含未評分」。牌譜紀錄頁籤與統計頁「更多篩選」共用；數字框直接打，超出範圍會被夾回 0–100（人數 1–10）。
 */

const numberClass =
  'w-12 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-center text-xs text-white focus:border-amber-400 focus:outline-none disabled:opacity-50';

function NumberBox({ value, min, max, label, disabled, onChange, testId }: {
  value: number; min: number; max: number; label: string; disabled?: boolean; onChange: (v: number) => void; testId?: string;
}): JSX.Element {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={value}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
      onChange={(e) => onChange(Number(e.target.value))}
      className={numberClass}
    />
  );
}

export default function LineupFilterEditor({ value, onChange, testIdPrefix = 'lineup' }: {
  value: LineupFilterState; onChange: (next: LineupFilterState) => void; testIdPrefix?: string;
}): JSX.Element {
  const set = (patch: Partial<LineupFilterState>): void => onChange(sanitizeLineupState({ ...value, ...patch }));
  const both = value.sOn && value.countOn;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-300" data-testid={`${testIdPrefix}-filter`}>
      <label className="inline-flex items-center gap-1">
        <input type="checkbox" checked={value.sOn} onChange={(e) => set({ sOn: e.target.checked })} data-testid={`${testIdPrefix}-s-on`} />
        <span title="S = 桌上 10 人開打前 PR 的平均">S ≥</span>
        <NumberBox value={value.sMin} min={0} max={100} label="S 下限" disabled={!value.sOn} onChange={(v) => set({ sMin: v })} testId={`${testIdPrefix}-s-min`} />
      </label>
      <div className="inline-flex overflow-hidden rounded border border-zinc-700" role="group" aria-label="兩個條件怎麼結合">
        {(['and', 'or'] as const).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={value.combine === c}
            disabled={!both}
            onClick={() => set({ combine: c })}
            data-testid={`${testIdPrefix}-combine-${c}`}
            className={`px-1.5 py-0.5 text-xs disabled:opacity-40 ${value.combine === c ? 'bg-amber-400 font-bold text-black' : 'text-zinc-300 hover:bg-zinc-800'}`}
          >
            {c === 'and' ? '且' : '或'}
          </button>
        ))}
      </div>
      <label className="inline-flex items-center gap-1">
        <input type="checkbox" checked={value.countOn} onChange={(e) => set({ countOn: e.target.checked })} data-testid={`${testIdPrefix}-count-on`} />
        <span>PR</span>
        <NumberBox value={value.strongPr} min={0} max={100} label="PR 門檻" disabled={!value.countOn} onChange={(v) => set({ strongPr: v })} testId={`${testIdPrefix}-pr`} />
        <span>以上至少</span>
        <NumberBox value={value.strongCount} min={1} max={10} label="人數" disabled={!value.countOn} onChange={(v) => set({ strongCount: v })} testId={`${testIdPrefix}-count`} />
        <span>人</span>
      </label>
      <label className="inline-flex items-center gap-1 text-zinc-400">
        <input
          type="checkbox"
          checked={value.includeUnscored}
          disabled={!value.sOn && !value.countOn}
          onChange={(e) => set({ includeUnscored: e.target.checked })}
          data-testid={`${testIdPrefix}-unscored`}
        />
        包含未評分
      </label>
    </div>
  );
}
