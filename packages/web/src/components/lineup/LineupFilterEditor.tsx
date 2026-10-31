import {
  ROLE_CONDITIONS, lineupFilterActive, sanitizeLineupState, type LineupFilterState,
} from '../../utils/lineupFilter';

/**
 * 陣容強度篩選（Edward 2026-10-31）：「S ≥ __」「PR __ 以上至少 __ 人」與角色條件（梅林／派西 PR、紅方／忠臣最低 PR、
 * 紅方平均 − 藍方平均 PR）各自可開關，兩個以上都開時選且／或，另可「包含未評分」。牌譜紀錄頁籤與統計頁「更多篩選」
 * 共用；數字框直接打，超出範圍會被夾回去（PR 0–100、人數 1–10、紅藍差 −100–100）。
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
  const enabled = (value.sOn ? 1 : 0) + (value.countOn ? 1 : 0) + ROLE_CONDITIONS.filter((r) => value.roleOn[r.key]).length;
  return (
    <div className="flex flex-col gap-1 text-xs text-zinc-300" data-testid={`${testIdPrefix}-filter`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" checked={value.sOn} onChange={(e) => set({ sOn: e.target.checked })} data-testid={`${testIdPrefix}-s-on`} />
          <span title="S = 桌上 10 人開打前 PR 的平均">S ≥</span>
          <NumberBox value={value.sMin} min={0} max={100} label="S 下限" disabled={!value.sOn} onChange={(v) => set({ sMin: v })} testId={`${testIdPrefix}-s-min`} />
        </label>
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" checked={value.countOn} onChange={(e) => set({ countOn: e.target.checked })} data-testid={`${testIdPrefix}-count-on`} />
          <span>PR</span>
          <NumberBox value={value.strongPr} min={0} max={100} label="PR 門檻" disabled={!value.countOn} onChange={(v) => set({ strongPr: v })} testId={`${testIdPrefix}-pr`} />
          <span>以上至少</span>
          <NumberBox value={value.strongCount} min={1} max={10} label="人數" disabled={!value.countOn} onChange={(v) => set({ strongCount: v })} testId={`${testIdPrefix}-count`} />
          <span>人</span>
        </label>
        <div className="inline-flex overflow-hidden rounded border border-zinc-700" role="group" aria-label="條件怎麼結合" title="兩個以上條件都開時：全部符合（且）或任一符合（或）">
          {(['and', 'or'] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={value.combine === c}
              disabled={enabled < 2}
              onClick={() => set({ combine: c })}
              data-testid={`${testIdPrefix}-combine-${c}`}
              className={`px-1.5 py-0.5 text-xs disabled:opacity-40 ${value.combine === c ? 'bg-amber-400 font-bold text-black' : 'text-zinc-300 hover:bg-zinc-800'}`}
            >
              {c === 'and' ? '且' : '或'}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1 text-zinc-400">
          <input
            type="checkbox"
            checked={value.includeUnscored}
            disabled={!lineupFilterActive(value)}
            onChange={(e) => set({ includeUnscored: e.target.checked })}
            data-testid={`${testIdPrefix}-unscored`}
          />
          包含未評分
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid={`${testIdPrefix}-roles`}>
        <span className="text-zinc-500" title="依角色看開打前 PR；藍方 = 忠臣＋派西＋梅林。需要的座位沒寫名字的局，這個條件不成立">角色</span>
        {ROLE_CONDITIONS.map((r) => (
          <label key={r.key} className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={value.roleOn[r.key]}
              onChange={(e) => set({ roleOn: { ...value.roleOn, [r.key]: e.target.checked } })}
              data-testid={`${testIdPrefix}-${r.key}-on`}
            />
            <span>{r.label}</span>
            <NumberBox
              value={value.roleValue[r.key]}
              min={r.min}
              max={r.max}
              label={r.label}
              disabled={!value.roleOn[r.key]}
              onChange={(v) => set({ roleValue: { ...value.roleValue, [r.key]: v } })}
              testId={`${testIdPrefix}-${r.key}`}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
