import { ArrowRight, Loader, Sparkles } from 'lucide-react';
import type { DiscoveryPage } from '@avalon/shared/stats';
import DiscoveryCard from './DiscoveryCard';
import DiscoveryHelp from './DiscoveryHelp';
import { useDiscovery } from './useDiscovery';
import { useDiscoveryNav } from './discoveryNav';
import { PAGE_LABELS, queryFindings, topForPage, EMPTY_DISCOVERY_QUERY } from './discoveryText';

/**
 * 每個分析分頁下方的「自動發現」（Edward 2026-10-31：「所有數據分析頁面…對上不同維度，都應該要有辦法做到自動發現」）：
 * 跟這頁指標有關、最明顯的幾項差異，「看全部」打開陣容強度的完整清單（已篩這一頁）。
 */
export default function DiscoveryBlock({ page, count = 3 }: { page: DiscoveryPage; count?: number }): JSX.Element {
  const state = useDiscovery();
  const openList = useDiscoveryNav((s) => s.openList);
  return (
    <section className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3" data-testid={`discovery-block-${page}`}>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Sparkles size={14} className="text-amber-300" />
        <h3 className="text-sm font-bold text-zinc-200">自動發現 · {PAGE_LABELS[page]}</h3>
        <DiscoveryHelp tests={state.status === 'ok' ? state.result.tests : undefined} />
        {state.status === 'ok' && (
          <button type="button" onClick={() => openList(page)} className="ml-auto inline-flex items-center gap-1 text-xs text-blue-300 hover:text-blue-200" data-testid="discovery-see-all">
            看全部 {queryFindings(state.result.findings, { ...EMPTY_DISCOVERY_QUERY, page }).length} 項<ArrowRight size={12} />
          </button>
        )}
      </div>
      {state.status === 'loading' && <p className="flex items-center gap-2 text-xs text-zinc-500"><Loader size={13} className="animate-spin" />掃描中（約幾秒）…</p>}
      {state.status === 'error' && <p className="text-xs text-zinc-500">自動發現暫時算不出來（每局資料集還沒載入）。</p>}
      {state.status === 'ok' && ((): JSX.Element => {
        const top = topForPage(state.result.findings, page, count);
        if (top.length === 0) return <p className="text-xs text-zinc-500">目前的篩選下，這頁的指標沒有明顯（q ≤ 0.05）的差異。</p>;
        return <ul className="grid gap-2 lg:grid-cols-3">{top.map((f) => <DiscoveryCard key={f.id} finding={f} />)}</ul>;
      })()}
      <p className="mt-1.5 text-[10px] text-zinc-500">相關不等於因果；跟著上方的篩選重算。</p>
    </section>
  );
}
