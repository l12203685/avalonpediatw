import { ArrowRight, Filter, Lightbulb } from 'lucide-react';
import { UNIT_LABELS, type DiscoveryFinding } from '@avalon/shared/stats';
import { useStatsFilter } from '../../../stats/statsFilter';
import { withClauses } from '../../../stats/filterDraft';
import { useDiscoveryNav } from './discoveryNav';
import {
  findingClause, findingClusters, findingGrouping, findingLink, findingNotes, findingSentence, findingStrategy, formatCi, formatDiff, formatValue,
} from './discoveryText';
import { openDiscoveryLink } from './openDiscoveryLink';

/**
 * 一項發現：一句話、兩組的小長條、差距與信賴區間、樣本數，能套用時附連結。新資料（兩紅派隊、關鍵票、全部投票）另有
 * 「可能的策略」（假設；不給時寫原因）與「看數字」（數字所在的分頁）。
 */
export default function DiscoveryCard({ finding: f }: { finding: DiscoveryFinding }): JSX.Element {
  const setFilter = useStatsFilter((s) => s.setFilter);
  const filter = useStatsFilter((s) => s.filter);
  const openGrouping = useDiscoveryNav((s) => s.openGrouping);
  const k = f.metric.kind;
  const max = Math.max(f.a.value, f.b.value, k === 'rate' ? 1 : 0.0001);
  const clause = findingClause(f);
  const grouping = findingGrouping(f);
  const link = findingLink(f);
  const strategy = findingStrategy(f);
  const clusters = findingClusters(f);
  const bar = (value: number, tone: string): JSX.Element => (
    <span className="relative inline-block h-1.5 w-20 overflow-hidden rounded bg-zinc-800 align-middle sm:w-24">
      <span className={`absolute inset-y-0 left-0 rounded ${tone}`} style={{ width: `${Math.max(2, (100 * value) / max)}%` }} />
    </span>
  );
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-300" data-testid="discovery-card">
      <p className="text-[13px] leading-snug text-zinc-100" title={`${f.dimension.help}；${f.metric.help}`}>{findingSentence(f)}</p>
      <div className="mt-1.5 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-0.5 tabular-nums">
        <span className="truncate text-zinc-400">{f.a.label}</span>
        <span>{bar(f.a.value, 'bg-amber-400')} <b className="ml-1 text-zinc-100">{formatValue(f.a.value, k)}</b> <span className="text-zinc-500">n={f.a.n}</span></span>
        <span className="truncate text-zinc-400">{f.b.label}</span>
        <span>{bar(f.b.value, 'bg-zinc-400')} <b className="ml-1 text-zinc-100">{formatValue(f.b.value, k)}</b> <span className="text-zinc-500">n={f.b.n}</span></span>
      </div>
      <p className="mt-1 text-[11px] text-zinc-400">
        差 <b className={f.diff > 0 ? 'text-amber-300' : 'text-sky-300'}>{formatDiff(f.diff, k)}</b>（{formatCi(f)}，q {f.q < 0.001 ? '< 0.001' : `= ${f.q.toFixed(3)}`}）
        · 單位：{UNIT_LABELS[f.unit]}
      </p>
      {clusters && <p className="text-[11px] text-zinc-500">樣本：{clusters}</p>}
      {findingNotes(f).map((n) => <p key={n} className="text-[11px] text-zinc-500">※ {n}</p>)}
      {strategy && (
        <p className="mt-1.5 flex gap-1.5 rounded-md border border-amber-800/40 bg-amber-950/30 px-2 py-1 text-[12px] leading-snug text-amber-100" data-testid="discovery-strategy">
          <Lightbulb size={13} className="mt-0.5 shrink-0 text-amber-300" />
          <span>{strategy}</span>
        </p>
      )}
      {f.strategy && !strategy && f.strategy.reason && (
        <p className="mt-1 text-[11px] text-zinc-500" data-testid="discovery-strategy-suppressed">不給策略：{f.strategy.reason}</p>
      )}
      {(clause || grouping || link) && (
        <div className="mt-1 flex flex-wrap gap-2">
          {link && (
            <button type="button" onClick={() => openDiscoveryLink(link)} className="inline-flex items-center gap-1 text-[11px] text-blue-300 hover:text-blue-200" data-testid="discovery-open-link">
              {link.label}<ArrowRight size={11} />
            </button>
          )}
          {grouping && (
            <button type="button" onClick={() => openGrouping(grouping)} className="inline-flex items-center gap-1 text-[11px] text-blue-300 hover:text-blue-200" data-testid="discovery-open-grouping">
              在組成比較打開<ArrowRight size={11} />
            </button>
          )}
          {clause && (
            <button type="button" onClick={() => setFilter(withClauses(filter, clause.kind, clause as never))} className="inline-flex items-center gap-1 text-[11px] text-blue-300 hover:text-blue-200" data-testid="discovery-apply-filter">
              <Filter size={11} />只看「{f.a.label}」的局
            </button>
          )}
        </div>
      )}
    </li>
  );
}
