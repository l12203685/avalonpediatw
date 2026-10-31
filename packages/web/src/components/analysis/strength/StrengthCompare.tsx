import { useState } from 'react';
import { METRIC_SECTIONS, type StrengthMetricValue, type StrengthReport } from '@avalon/shared/stats';
import { StatTable, Takeaway, type StatColumn } from '../ui';
import { GROUPING_OPTIONS, LOW_SAMPLE, formatDelta, formatMetric, type GroupingKind } from './compareFormat';

export { buildGrouping, type GroupingKind } from './compareFormat';

/**
 * 不同組成、不同強度的遊戲過程比較（Edward 2026-10-31：「針對不同組成、不同強度去分析遊戲過程跟內容（包含策略、
 * 任務組合、黑白球、湖中女神等等的）」「紅方／忠臣各自的最高／最低、派西／梅林的 ELO & PR 也可以是分析維度」）。
 * 選分組方式 → 每組一欄、最後一欄是全部（只算分得進組的局），每格是比率或平均，旁邊的小字是跟全部的差。
 */

const numberClass = 'w-12 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-center text-xs text-white focus:border-blue-500 focus:outline-none';

interface Row {
  id: string;
  label: string;
  help: string;
  kind: 'rate' | 'avg';
  values: StrengthMetricValue[];
  all: StrengthMetricValue;
}

export default function StrengthCompare({ report, kind, setKind, pr, setPr, count, setCount, weak, setWeak }: {
  report: StrengthReport;
  kind: GroupingKind; setKind: (k: GroupingKind) => void;
  pr: number; setPr: (v: number) => void;
  count: number; setCount: (v: number) => void;
  weak: number; setWeak: (v: number) => void;
}): JSX.Element {
  const [section, setSection] = useState<string>('結果');
  const cmp = report.comparison;
  const rows: Row[] = cmp.metrics.filter((m) => m.section === section);
  const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo);
  const cell = (i: number | 'all') => (value: unknown, r: Row): JSX.Element => {
    const v = i === 'all' ? r.all : r.values[i];
    const delta = i === 'all' ? null : formatDelta(v.value, r.all.value, r.kind);
    return (
      <span className="whitespace-nowrap">
        {formatMetric(v.value, r.kind)}
        {delta && (
          <span className={`ml-1 text-[10px] ${delta.tone === 'up' ? 'text-emerald-300' : delta.tone === 'down' ? 'text-rose-300' : 'text-zinc-500'}`}>
            {delta.text}
          </span>
        )}
      </span>
    );
  };
  const columns: StatColumn<Row>[] = [
    {
      key: 'label', label: '指標', className: 'whitespace-normal min-w-[8.5rem]',
      format: (_, r) => <span title={r.help} className="cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2">{r.label}</span>,
    },
    ...cmp.groups.map((g, i): StatColumn<Row> => ({
      key: `g${i}`,
      label: <span title={g.help}>{g.label}<span className="block text-[10px] font-normal text-zinc-500">{g.games} 局</span></span>,
      align: 'right',
      format: cell(i),
      n: (r) => r.values[i].n,
      lowSample: LOW_SAMPLE,
    })),
    {
      key: 'all', label: <span title="分得進上面任一組的全部局">全部<span className="block text-[10px] font-normal text-zinc-500">{cmp.groups.reduce((a, g) => a + g.games, 0)} 局</span></span>,
      align: 'right', format: cell('all'), n: (r) => r.all.n, lowSample: LOW_SAMPLE, emphasis: true,
    },
  ];
  const hit = cmp.metrics.find((m) => m.id === 'hit');
  const red = cmp.metrics.find((m) => m.id === 'threeRed');
  return (
    <div className="space-y-2" data-testid="strength-compare">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-300">
        <label className="inline-flex items-center gap-1">
          <span className="text-zinc-500">分組</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as GroupingKind)}
            data-testid="strength-grouping"
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 focus:border-blue-500 focus:outline-none"
          >
            {GROUPING_OPTIONS.map((o) => <option key={o.kind} value={o.kind} title={o.help}>{o.label}</option>)}
          </select>
        </label>
        {kind === 'count' && (
          <span className="inline-flex items-center gap-1">
            PR <input type="number" className={numberClass} value={pr} min={0} max={100} aria-label="PR 門檻" onChange={(e) => setPr(clamp(Number(e.target.value), 0, 100))} />
            以上至少 <input type="number" className={numberClass} value={count} min={1} max={10} aria-label="人數" onChange={(e) => setCount(clamp(Number(e.target.value), 1, 10))} /> 人
          </span>
        )}
        {(kind === 'weakRed' || kind === 'weakLoyal') && (
          <span className="inline-flex items-center gap-1">
            X = <input type="number" className={numberClass} value={weak} min={0} max={100} aria-label="PR 門檻" onChange={(e) => setWeak(clamp(Number(e.target.value), 0, 100))} />
          </span>
        )}
        <span className="text-[11px] text-zinc-500">{GROUPING_OPTIONS.find((o) => o.kind === kind)?.help}</span>
      </div>
      {hit && red && (
        <Takeaway>
          {cmp.groups.map((g, i) => (
            <span key={g.id} className="mr-3 inline-block">
              <b>{g.label}</b>：三紅 {formatMetric(red.values[i].value, 'rate')}、刺中 {formatMetric(hit.values[i].value, 'rate')}
              <span className="text-zinc-500">（{g.games} 局）</span>
            </span>
          ))}
        </Takeaway>
      )}
      <div className="flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="指標分類">
        {METRIC_SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={section === s}
            onClick={() => setSection(s)}
            data-testid={`strength-section-${s}`}
            className={`whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors ${
              section === s ? 'border-blue-500 bg-blue-600 text-white' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <StatTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        maxHeight="26rem"
        footnote={`每格是這組的比率或平均，小字是跟「全部」的差（綠 = 高、紅 = 低；比率差 3 個百分點以上才上色）。n 是分母（局、提議、票或湖的次數），不到 ${LOW_SAMPLE} 的格子變淡。${cmp.excluded ? `分不進任何一組的 ${cmp.excluded} 局（沒有陣容強度、需要的角色沒寫名字…）不算。` : ''}滑過指標名稱看定義。`}
      />
    </div>
  );
}
