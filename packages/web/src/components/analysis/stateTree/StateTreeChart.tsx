import { useEffect, useMemo, useRef, useState } from 'react';
import { OUTCOME_COLORS } from '../ui';
import { layoutTree, visibleDepth, type PlacedNode } from './layout';
import { pct } from './NodeDetail';
import {
  divergingColor, lakeKeyLabel, metricRate, type ColorMetric, type StateNode,
} from './stateTree';

const BOX_W = 98;
const BOX_H = 38;
const ROW_H = 46;
const HEADER_H = 22;
const MIN_COL = 112;
const MAX_COL = 156;
const PAD_RIGHT = 40; // 「→三紅」的位置

/** 節點在圖上的字：任務 = 順序；湖 = 宣告（欄標題寫第幾次湖）；其他 = 其他（幾支）。 */
export function chartLabel(node: StateNode): string {
  if (node.kind === 'root') return '全部';
  if (node.kind === 'other') return `其他（${node.folded ?? 0}）`;
  if (node.kind === 'lake') return lakeKeyLabel(node.path[node.path.length - 1].key);
  return node.seq;
}

/** 每一層的欄標題。 */
function columnTitles(nodes: PlacedNode[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const { node } of nodes) {
    if (out.has(node.depth) || node.kind === 'other') continue;
    if (node.kind === 'root') out.set(0, '起點');
    else if (node.kind === 'mission') out.set(node.depth, `第 ${node.round} 局`);
    else out.set(node.depth, `湖 ${node.round - 1}`);
  }
  return out;
}

export interface StateTreeChartProps {
  root: StateNode;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  metric: ColorMetric;
  mid: number | null;
}

/** 桌機版：橫向整齊樹（SVG），一層一欄；邊的粗細 ∝ 局數，節點顏色 = 發散色階（中點 = 全體）。 */
export default function StateTreeChart({
  root, expanded, onToggle, selectedId, onSelect, onHover, metric, mid,
}: StateTreeChartProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(800);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = (): void => setAvail(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return (): void => ro.disconnect();
  }, []);
  const depth = visibleDepth(root, expanded);
  const colWidth = depth ? Math.max(MIN_COL, Math.min(MAX_COL, (avail - BOX_W - PAD_RIGHT) / depth)) : MAX_COL;
  const layout = useMemo(
    () => layoutTree(root, expanded, { colWidth, rowHeight: ROW_H, boxWidth: BOX_W, boxHeight: BOX_H }),
    [root, expanded, colWidth],
  );
  const titles = columnTitles(layout.nodes);
  const selectedChain = useMemo(() => {
    const ids = new Set<string>();
    let p = layout.nodes.find((x) => x.node.id === selectedId) ?? null;
    while (p) {
      ids.add(p.node.id);
      p = p.parent;
    }
    return ids;
  }, [layout, selectedId]);
  const width = layout.width + PAD_RIGHT;
  const height = layout.height + HEADER_H + 4;

  return (
    <div ref={wrapRef} className="w-full overflow-x-auto">
      <svg width={width} height={height} role="img" aria-label="局勢樹" className="block select-none">
        {[...titles.entries()].map(([d, title]) => (
          <text key={d} x={d * colWidth + BOX_W / 2} y={14} textAnchor="middle" fontSize={11} fill="#a1a1aa">{title}</text>
        ))}
        <g transform={`translate(0, ${HEADER_H})`}>
          {layout.nodes.map((p) => {
            if (!p.parent) return null;
            const x1 = p.parent.x + BOX_W;
            const y1 = p.parent.y + BOX_H / 2;
            const x2 = p.x;
            const y2 = p.y + BOX_H / 2;
            const mx = (x1 + x2) / 2;
            const on = selectedChain.has(p.node.id);
            return (
              <path
                key={`e-${p.node.id}`}
                d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                fill="none"
                stroke={on ? '#fbbf24' : '#71717a'}
                strokeOpacity={on ? 0.85 : 0.4}
                strokeWidth={Math.max(1, (18 * p.node.n) / Math.max(1, root.n))}
              />
            );
          })}
          {layout.nodes.map((p) => {
            const { node } = p;
            const other = node.kind === 'other';
            const fill = other ? '#27272a' : divergingColor(metricRate(node.outcomes, metric), mid, metric);
            const selected = node.id === selectedId;
            const total = node.outcomes.三紅 + node.outcomes.三藍死 + node.outcomes.三藍活;
            const share = p.parent ? pct(node.n / p.parent.node.n) : '100%';
            let sx = 0;
            const canToggle = node.children.length > 0;
            return (
              <g
                key={node.id}
                transform={`translate(${p.x}, ${p.y})`}
                className="cursor-pointer"
                onMouseEnter={() => onHover(node.id)}
                onMouseLeave={() => onHover(null)}
                onClick={() => {
                  onSelect(node.id);
                  if (p.collapsed) onToggle(node.id);
                }}
              >
                <title>{`${chartLabel(node)}：${node.n} 局（${share}）・藍方最終勝率 ${pct(metricRate(node.outcomes, 'blueWin'))}・三紅 ${pct(metricRate(node.outcomes, 'threeRed'))}`}</title>
                <rect
                  width={BOX_W}
                  height={BOX_H}
                  rx={5}
                  fill={fill}
                  stroke={selected ? '#fbbf24' : other ? '#71717a' : '#18181b'}
                  strokeWidth={selected ? 2 : 1}
                  strokeDasharray={other ? '3 2' : undefined}
                />
                <text x={7} y={15} fontSize={12} fontWeight={700} fill={other ? '#a1a1aa' : '#fafafa'}>{chartLabel(node)}</text>
                <text x={7} y={28} fontSize={10} fill={other ? '#a1a1aa' : '#e4e4e7'}>{`${node.n} 局 · ${share}`}</text>
                {total > 0 && (['三紅', '三藍死', '三藍活'] as const).map((k) => {
                  const w = ((BOX_W - 10) * node.outcomes[k]) / total;
                  const rect = w > 0 ? <rect key={k} x={5 + sx} y={BOX_H - 6} width={Math.max(0, w - 1)} height={3} rx={1} fill={OUTCOME_COLORS[k]} /> : null;
                  sx += w;
                  return rect;
                })}
                {node.decided && (
                  <text x={BOX_W + 5} y={BOX_H / 2 + 4} fontSize={10} fill="#a1a1aa">{node.decided === '三紅' ? '→三紅' : '→刺殺'}</text>
                )}
                {canToggle && (
                  <g
                    transform={`translate(${BOX_W}, ${BOX_H / 2})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(node.id);
                    }}
                  >
                    <circle r={7} fill="#18181b" stroke="#a1a1aa" />
                    <text y={3.5} textAnchor="middle" fontSize={11} fill="#e4e4e7">{p.collapsed ? '+' : '−'}</text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
