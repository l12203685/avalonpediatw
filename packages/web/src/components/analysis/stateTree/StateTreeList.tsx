import { ChevronDown, ChevronRight } from 'lucide-react';
import NodeDetail, { OutcomeStrip, pct } from './NodeDetail';
import { chartLabel } from './StateTreeChart';
import { branchOfNode } from './recordBranch';
import {
  divergingColor, metricRate, outcomeRate, type ColorMetric, type OutcomeMix, type StateNode,
} from './stateTree';

export interface StateTreeListProps {
  root: StateNode;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  metric: ColorMetric;
  mid: number | null;
  baseline: OutcomeMix;
  onApply: (node: StateNode) => void;
  onRecords: (node: StateNode) => void;
}

/** 手機版：縮排的展開清單，數字與桌機版相同；點一列展開子分支並在下面顯示細節。 */
export default function StateTreeList({
  root, expanded, onToggle, selectedId, onSelect, metric, mid, baseline, onApply, onRecords,
}: StateTreeListProps): JSX.Element {
  const rows: JSX.Element[] = [];
  const walk = (node: StateNode, chain: StateNode[]): void => {
    const here = [...chain, node];
    const open = expanded.has(node.id) && node.children.length > 0;
    const parent = chain[chain.length - 1];
    const selected = node.id === selectedId;
    const other = node.kind === 'other';
    const label = node.kind === 'lake' ? node.label : chartLabel(node);
    rows.push(
      <li key={node.id}>
        <button
          type="button"
          onClick={() => {
            if (selected) {
              onSelect(null);
              if (open) onToggle(node.id);
            } else {
              onSelect(node.id);
              if (!open && node.children.length) onToggle(node.id);
            }
          }}
          className={`flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left ${selected ? 'bg-zinc-800 ring-1 ring-amber-400/60' : 'hover:bg-zinc-800/60'}`}
          style={{ paddingLeft: 4 + node.depth * 12 }}
          aria-expanded={node.children.length ? open : undefined}
        >
          <span className="w-3.5 shrink-0 text-zinc-500">
            {node.children.length ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
          </span>
          <span
            className={`h-3 w-3 shrink-0 rounded-sm ${other ? 'border border-dashed border-zinc-500' : ''}`}
            style={{ background: other ? 'transparent' : divergingColor(metricRate(node.outcomes, metric), mid, metric) }}
            aria-hidden
          />
          <span className={`min-w-0 flex-1 truncate text-[13px] ${other ? 'text-zinc-500' : 'font-semibold text-zinc-100'}`}>
            {label}
            {node.decided && <span className="ml-1 text-[10px] font-normal text-zinc-500">{node.decided === '三紅' ? '→三紅' : '→刺殺'}</span>}
          </span>
          <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-zinc-300">{node.n}</span>
          <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-zinc-500">{parent ? pct(node.n / parent.n) : ''}</span>
          <span className="w-16 shrink-0">
            <OutcomeStrip outcomes={node.outcomes} height={5} />
            <span className="block text-right text-[10px] tabular-nums text-zinc-400">藍 {pct(outcomeRate(node.outcomes, '三藍活'))}</span>
          </span>
        </button>
        {selected && (
          <div className="my-1 rounded-lg border border-zinc-700/70 bg-zinc-900/70 p-3" style={{ marginLeft: Math.min(4 + node.depth * 12, 48) }}>
            <NodeDetail
              node={node} chain={here} rootN={root.n} baseline={baseline} onApply={onApply}
              onRecords={branchOfNode(node) ? onRecords : null} compact
            />
          </div>
        )}
      </li>,
    );
    if (open) node.children.forEach((c) => walk(c, here));
  };
  walk(root, []);
  return (
    <div>
      <div className="flex items-center gap-1.5 px-1 pb-1 text-[10px] text-zinc-500">
        <span className="flex-1 pl-5">分支</span>
        <span className="w-11 text-right">局數</span>
        <span className="w-9 text-right">佔比</span>
        <span className="w-16 text-right">結果／藍勝</span>
      </div>
      <ul className="space-y-0.5">{rows}</ul>
    </div>
  );
}
