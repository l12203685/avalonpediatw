import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, ListOrdered, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { WikiArticle } from '../../data/wiki';
import { wikiCardExcerpt } from '../../utils/wikiMarkup';
import { relatedArticles } from '../../utils/wikiGraph';
import type { WikiGraph, WikiRelationKind } from '../../utils/wikiGraph';
import { DEFAULT_MIND_MAP_METRICS, fitMindMapToViewport, fitScale, layoutWikiMindMap } from '../../utils/wikiMindMapLayout';
import type { MindMapLayout, MindMapLeafNode, MindMapNode } from '../../utils/wikiMindMapLayout';
import { RELATION_CHIP_CLASS, RELATION_LABEL, RELATION_STROKE } from './relationStyle';

/**
 * 桌面版百科心智圖：SVG，根在中間、分類分左右（utils/wikiMindMapLayout.ts）。整張圖預設放進一個畫面：
 * 畫布高度填滿視窗，文章多的分類依畫面大小分欄（Edward 2026-10-30：預設心智圖、一張頁面裡呈現）。
 *   - 滑過文章 = 預覽關聯（工具列顯示完整標題），點一下 = 固定選取（浮動面板列出相關文章）；
 *     雙擊或面板上的標題 = 開文章；
 *   - 點分類 = 收合／展開；
 *   - 滾輪 = 上下捲動（到底就讓頁面捲）、Ctrl/⌘＋滾輪或按鈕 = 縮放、拖曳 = 移動。
 */

interface View {
  k: number;
  tx: number;
  ty: number;
}

const MIN_K = 0.3;
const MAX_K = 2.5;
const ROW = DEFAULT_MIND_MAP_METRICS.rowHeight;
const PILL_H = 26;

/** 「全覽」最多放大到這裡（大螢幕上字不要大得誇張）。 */
const FIT_MAX_K = 1.25;

const clampK = (k: number): number => Math.min(MAX_K, Math.max(MIN_K, k));

/** Keep the content on screen: it can't be pushed past the viewport edges (or, when it fits, out of it). */
function clampView(v: View, bounds: MindMapLayout['bounds'], w: number, h: number): View {
  const clampAxis = (t: number, min: number, max: number, size: number): number => {
    const a = size - max * v.k;
    const b = -min * v.k;
    return Math.min(Math.max(a, b), Math.max(Math.min(a, b), t));
  };
  return { k: v.k, tx: clampAxis(v.tx, bounds.minX, bounds.maxX, w), ty: clampAxis(v.ty, bounds.minY, bounds.maxY, h) };
}

/** Root/branch connector: a horizontal S-curve. */
const linkPath = (x1: number, y1: number, x2: number, y2: number): string => {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
};

/** A relation between two articles: through the middle when they are on opposite sides, else a bow towards the root. */
function relationPath(a: MindMapNode, b: MindMapNode): string {
  if (a.side !== 0 && a.side === b.side) {
    const bow = -a.side * (36 + Math.min(140, Math.abs(b.y - a.y) * 0.22));
    return `M${a.x},${a.y} C${a.x + bow},${a.y} ${b.x + bow},${b.y} ${b.x},${b.y}`;
  }
  return `M${a.x},${a.y} C${a.x * 0.35},${a.y} ${b.x * 0.35},${b.y} ${b.x},${b.y}`;
}

interface WikiMindMapCanvasProps {
  graph: WikiGraph;
  articlesById: ReadonlyMap<string, WikiArticle>;
  onOpen: (id: string) => void;
}

export default function WikiMindMapCanvas({ graph, articlesById, onOpen }: WikiMindMapCanvasProps): JSX.Element {
  const markerId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const frameRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** The frame fills the window below where it starts (one screen, no page scroll for the map). */
  const [frameH, setFrameH] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [showGuide, setShowGuide] = useState(false);
  const [rawView, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  /** The leaf hovered / clicked (an article can have two: its own and a reading-path shortcut); lines start there. */
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  /** What the view was last fitted to: the full article list arrives after the first render (API / bundle). */
  const fittedRef = useRef<{ graph: WikiGraph; maxRows: number; w: number; h: number } | null>(null);
  const draggedRef = useRef(false);

  // Column split for this viewport (from the fully expanded map, so collapsing doesn't reshuffle the others).
  const { maxRows, maxLeafLabel } = useMemo(
    () =>
      size.w && size.h
        ? fitMindMapToViewport(graph, size.w, size.h, {}, FIT_MAX_K)
        : { maxRows: Infinity, maxLeafLabel: DEFAULT_MIND_MAP_METRICS.maxLeafLabel },
    [graph, size.w, size.h],
  );
  const layout = useMemo(
    () => layoutWikiMindMap(graph, collapsed, { maxLeafLabel }, maxRows),
    [graph, collapsed, maxLeafLabel, maxRows],
  );
  const { bounds } = layout;
  // Collapsing / resizing changes the bounds: the shown view is always clamped onto the map.
  const view = useMemo(
    () => (size.w && size.h ? clampView(rawView, bounds, size.w, size.h) : rawView),
    [rawView, bounds, size],
  );
  const activeId = hoverId ?? pinnedId;
  const activeKey = hoverId ? hoverKey : pinnedKey;
  const hoverLeaf = useCallback((id: string | null, key: string | null = null): void => {
    setHoverId(id);
    setHoverKey(key);
  }, []);
  const pinLeaf = useCallback((id: string | null, key: string | null = null): void => {
    setPinnedId(id);
    setPinnedKey(key);
  }, []);
  const related = useMemo(() => (activeId ? relatedArticles(graph, activeId) : []), [graph, activeId]);
  const kindOf = useMemo(() => new Map(related.map((r) => [r.id, r.kind])), [related]);

  // ── viewport ──────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const measure = (): void => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      setFrameH(Math.max(480, Math.round(window.innerHeight - top - 12)));
    };
    measure();
    window.addEventListener('resize', measure);
    return (): void => window.removeEventListener('resize', measure);
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return (): void => ro.disconnect();
  }, []);

  const fitAll = useCallback((): void => {
    if (!size.w || !size.h) return;
    const k = clampK(Math.min(FIT_MAX_K, fitScale(bounds, size.w, size.h)));
    setView({
      k,
      tx: size.w / 2 - ((bounds.minX + bounds.maxX) / 2) * k,
      ty: size.h / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
    });
  }, [size, bounds]);

  // First real size / new articles: the whole map on one screen (Edward 2026-10-30「希望可以放在一張頁面裡呈現」).
  useEffect(() => {
    const f = fittedRef.current;
    if (!size.w || !size.h || (f && f.graph === graph && f.maxRows === maxRows && f.w === size.w && f.h === size.h)) return;
    fittedRef.current = { graph, maxRows, w: size.w, h: size.h };
    fitAll();
  }, [graph, maxRows, size, fitAll]);

  // Wheel / drag / zoom start from the shown (clamped) view.
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number): void => {
      const v = viewRef.current;
      const k = clampK(v.k * factor);
      const r = k / v.k;
      setView(clampView({ k, tx: cx - (cx - v.tx) * r, ty: cy - (cy - v.ty) * r }, bounds, size.w, size.h));
    },
    [bounds, size],
  );

  // Wheel: needs a non-passive listener to keep the page from scrolling while the map can still move.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      const rect = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(Math.exp(-e.deltaY * unit * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
        return;
      }
      const v = viewRef.current;
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
      const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
      const next = clampView({ k: v.k, tx: v.tx - dx, ty: v.ty - dy }, bounds, rect.width, rect.height);
      if (Math.abs(next.tx - v.tx) < 0.5 && Math.abs(next.ty - v.ty) < 0.5) return; // at the edge: let the page scroll
      e.preventDefault();
      setView(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return (): void => el.removeEventListener('wheel', onWheel);
  }, [bounds, zoomAt]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    draggedRef.current = false;
    const onNode = (e.target as Element).closest('[data-node]') !== null;
    const start = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, k: view.k };
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!draggedRef.current && Math.hypot(dx, dy) < 4) return;
      draggedRef.current = true;
      setView(clampView({ k: start.k, tx: start.tx + dx, ty: start.ty + dy }, bounds, size.w, size.h));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!draggedRef.current && !onNode) pinLeaf(null); // a click on empty space clears the selection
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // ── selection ─────────────────────────────────────────────────────────────
  /** Pin an article and bring it on screen (opening its branch if it is hidden). */
  const focusArticle = useCallback(
    (id: string): void => {
      pinLeaf(id);
      hoverLeaf(null);
      let next = layout;
      const home = graph.articles[id]?.category;
      if (layout.byKey[layout.anchorOf[id]]?.kind === 'branch' && home) {
        const opened = new Set([...collapsed].filter((b) => b !== home));
        setCollapsed(opened);
        next = layoutWikiMindMap(graph, opened, { maxLeafLabel }, maxRows);
      }
      const node = next.byKey[next.anchorOf[id]];
      if (!node || !size.w) return;
      const v = viewRef.current;
      const sx = node.x * v.k + v.tx;
      const sy = node.y * v.k + v.ty;
      const margin = 80;
      if (next === layout && sx > margin && sx < size.w - margin && sy > margin && sy < size.h - margin) return;
      setView(clampView({ k: v.k, tx: size.w / 2 - node.x * v.k, ty: size.h / 2 - node.y * v.k }, next.bounds, size.w, size.h));
    },
    [graph, layout, collapsed, maxLeafLabel, maxRows, size, pinLeaf, hoverLeaf],
  );

  const toggleBranch = useCallback((id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allCollapsed = graph.branches.every((b) => collapsed.has(b.id));

  // ── drawing ───────────────────────────────────────────────────────────────
  const leavesOf = useMemo(() => {
    const map = new Map<string, MindMapLeafNode[]>();
    for (const l of layout.leaves) map.set(l.leaf.articleId, [...(map.get(l.leaf.articleId) ?? []), l]);
    return map;
  }, [layout]);

  const highlightedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!activeId) return keys;
    for (const l of layout.leaves) if (l.leaf.articleId === activeId || kindOf.has(l.leaf.articleId)) keys.add(l.key);
    return keys;
  }, [activeId, kindOf, layout]);

  const treeLayer = useMemo(() => {
    const litBranches = new Set(layout.leaves.filter((n) => highlightedKeys.has(n.key)).map((n) => n.branchKey));
    return (
      <g>
        {layout.boxes.map((box) => (
          <rect
            key={box.branchKey}
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            rx={10}
            fill="rgba(24,24,27,0.6)"
            stroke={litBranches.has(box.branchKey) ? '#52525b' : '#27272a'}
            opacity={activeId === null || litBranches.has(box.branchKey) ? 1 : 0.5}
          />
        ))}
        {layout.links.map((l) => {
          const lit = activeId !== null && litBranches.has(l.from === 'root' ? l.to : l.from);
          return (
            <path
              key={`${l.from}>${l.to}`}
              d={linkPath(l.x1, l.y1, l.x2, l.y2)}
              fill="none"
              stroke={l.from === 'root' ? '#a16207' : '#3f3f46'}
              strokeWidth={l.from === 'root' ? 2.5 : 1.25}
              opacity={activeId === null || lit ? 1 : 0.3}
            />
          );
        })}
      </g>
    );
  }, [layout, activeId, highlightedKeys]);

  const relationLayer = useMemo(() => {
    if (!activeId) return null;
    const from = (activeKey ? layout.byKey[activeKey] : undefined) ?? layout.byKey[layout.anchorOf[activeId]];
    if (!from) return null;
    // Each related article: the nearest of its visible leaves (own / shortcut), else its collapsed branch.
    const target = (id: string): MindMapNode | undefined => {
      let best: MindMapNode | undefined;
      let bestD = Infinity;
      for (const n of leavesOf.get(id) ?? []) {
        const d = Math.hypot(n.x - from.x, n.y - from.y);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      return best ?? layout.byKey[layout.anchorOf[id]];
    };
    return (
      <g>
        {related.map((r) => {
          const to = target(r.id);
          if (!to || to.key === from.key) return null;
          const [a, b] = r.kind === 'in' ? [to, from] : [from, to];
          return (
            <path
              key={r.id}
              d={relationPath(a, b)}
              fill="none"
              stroke={RELATION_STROKE[r.kind]}
              strokeWidth={1.6}
              opacity={0.9}
              markerEnd={`url(#${markerId}-${r.kind})`}
              markerStart={r.kind === 'both' ? `url(#${markerId}-${r.kind})` : undefined}
            />
          );
        })}
      </g>
    );
  }, [activeId, activeKey, related, layout, leavesOf, markerId]);

  const nodeLayer = useMemo(() => {
    const fs = DEFAULT_MIND_MAP_METRICS;
    const dim = (on: boolean): number => (activeId === null || on ? 1 : 0.28);
    return (
      <g>
        {/* root */}
        <g transform={`translate(${layout.root.x},${layout.root.y})`}>
          <rect x={-layout.root.width / 2} y={-17} width={layout.root.width} height={34} rx={17} fill="#eab308" />
          <text textAnchor="middle" dominantBaseline="central" fontSize={fs.rootFont} fontWeight={700} fill="#000">
            {layout.root.label}
          </text>
        </g>

        {/* branches */}
        {layout.branches.map((b) => {
          const lit = layout.leaves.some((n) => n.branchKey === b.key && highlightedKeys.has(n.key)) ||
            (activeId !== null && b.collapsed && b.branch.leaves.some((l) => kindOf.has(l.articleId) || l.articleId === activeId));
          return (
            <g
              key={b.key}
              data-node
              transform={`translate(${b.x},${b.y})`}
              className="cursor-pointer"
              opacity={dim(lit)}
              onClick={() => {
                if (!draggedRef.current) toggleBranch(b.branch.id);
              }}
              role="button"
              aria-expanded={!b.collapsed}
              aria-label={`${b.branch.name}（${b.branch.articleCount} 篇）${b.collapsed ? '，已收合' : ''}`}
            >
              <title>{b.collapsed ? '點一下展開' : '點一下收合'}</title>
              <rect
                x={-b.width / 2}
                y={-PILL_H / 2}
                width={b.width}
                height={PILL_H}
                rx={PILL_H / 2}
                fill="#18181b"
                stroke={b.collapsed ? '#71717a' : '#ca8a04'}
                strokeWidth={1.5}
                strokeDasharray={b.collapsed ? '4 3' : undefined}
              />
              <text textAnchor="middle" dominantBaseline="central" fontSize={fs.branchFont} fontWeight={600} fill="#f4f4f5">
                {b.label}
              </text>
              {/* collapse handle on the outer side */}
              <g transform={`translate(${b.side * (b.width / 2 + 9)},0)`}>
                <circle r={7} fill="#27272a" stroke="#52525b" />
                <text textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700} fill="#d4d4d8">
                  {b.collapsed ? '+' : '−'}
                </text>
              </g>
            </g>
          );
        })}

        {/* articles */}
        {layout.leaves.map((n) => (
          <LeafNode
            key={n.key}
            node={n}
            isActive={n.leaf.articleId === activeId}
            isPinned={n.leaf.articleId === pinnedId}
            kind={kindOf.get(n.leaf.articleId)}
            opacity={dim(highlightedKeys.has(n.key))}
            homeIcon={n.leaf.alias ? graph.branches.find((b) => b.id === n.leaf.homeCategory)?.icon ?? '↗' : undefined}
            onHover={hoverLeaf}
            onClick={(id, key) => {
              if (!draggedRef.current) pinLeaf(id, key);
            }}
            onOpen={onOpen}
          />
        ))}
      </g>
    );
  }, [layout, activeId, pinnedId, kindOf, highlightedKeys, graph, toggleBranch, onOpen, hoverLeaf, pinLeaf]);

  const hovered = hoverId ? graph.articles[hoverId] : undefined;
  const panelOpen = pinnedId !== null || showGuide;
  // The panel goes over the other half of the map than the pinned article (the reading order lives on the right).
  const pinnedNode = pinnedId ? layout.byKey[pinnedKey ?? ''] ?? layout.byKey[layout.anchorOf[pinnedId]] : undefined;
  const panelLeft = !pinnedNode || pinnedNode.side === 1;

  return (
    <div
      ref={frameRef}
      className="flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-black"
      style={{ height: frameH ?? 'calc(100vh - 8rem)' }}
      data-testid="wiki-mindmap-canvas"
    >
      {/* controls */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-zinc-800 bg-zinc-950">
        <CanvasButton label="放大" onClick={() => zoomAt(1.2, size.w / 2, size.h / 2)}>
          <ZoomIn size={15} />
        </CanvasButton>
        <CanvasButton label="縮小" onClick={() => zoomAt(1 / 1.2, size.w / 2, size.h / 2)}>
          <ZoomOut size={15} />
        </CanvasButton>
        <CanvasButton label="全覽（整張圖）" onClick={fitAll}>
          <Maximize size={15} />
        </CanvasButton>
        <CanvasButton
          label={allCollapsed ? '展開全部分類' : '收合全部分類'}
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(graph.branches.map((b) => b.id)))}
        >
          {allCollapsed ? <ChevronsUpDown size={15} /> : <ChevronsDownUp size={15} />}
        </CanvasButton>
        <CanvasButton
          label="新手建議閱讀順序"
          active={showGuide && pinnedId === null}
          onClick={() => {
            const open = !(showGuide && pinnedId === null);
            pinLeaf(null);
            setShowGuide(open);
          }}
        >
          <ListOrdered size={15} />
        </CanvasButton>
        <span className="ml-1 text-[11px] text-zinc-500 tabular-nums">{Math.round(view.k * 100)}%</span>
        <span className="ml-auto min-w-0 truncate pl-2 text-[12px]" data-testid="wiki-mindmap-hover">
          {hovered ? (
            <>
              <span className="text-zinc-100 font-semibold">{hovered.title}</span>
              <span className="text-zinc-500">
                {'　'}引用 {graph.outgoing[hovered.id]?.length ?? 0}・被引用 {graph.incoming[hovered.id]?.length ?? 0}・點一下看相關文章、雙擊開啟
              </span>
            </>
          ) : (
            <span className="text-zinc-500">滑過文章看關聯・點一下固定・雙擊開啟・點分類收合・滾輪捲動・Ctrl／⌘＋滾輪縮放・拖曳移動</span>
          )}
        </span>
      </div>
      <div className="relative flex-1 min-h-0">
        <div
          ref={containerRef}
          onPointerDown={onPointerDown}
          onMouseLeave={() => hoverLeaf(null)}
          className="absolute inset-0 overflow-hidden select-none cursor-grab active:cursor-grabbing"
          style={{
            touchAction: 'none',
            backgroundImage: 'radial-gradient(circle, rgba(63,63,70,0.45) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        >
          <svg width={size.w} height={size.h} className="block" role="group" aria-label={`${graph.rootLabel}心智圖`}>
            <defs>
              {(['out', 'in', 'both'] as WikiRelationKind[]).map((kind) => (
                <marker
                  key={kind}
                  id={`${markerId}-${kind}`}
                  viewBox="0 0 10 10"
                  refX={17}
                  refY={5}
                  markerWidth={7}
                  markerHeight={7}
                  markerUnits="userSpaceOnUse"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill={RELATION_STROKE[kind]} />
                </marker>
              ))}
            </defs>
            <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
              {treeLayer}
              {relationLayer}
              {nodeLayer}
            </g>
          </svg>
        </div>

        {/* floating panel: only for a pinned article or the reading order, so the map keeps the full width */}
        {panelOpen && (
          <MapPanel
            left={panelLeft}
            graph={graph}
            articlesById={articlesById}
            activeId={pinnedId}
            onSelect={focusArticle}
            onOpen={onOpen}
            onClose={() => {
              pinLeaf(null);
              setShowGuide(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function CanvasButton({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`w-7 h-7 inline-flex items-center justify-center rounded-md border transition-colors ${
        active
          ? 'border-yellow-500 bg-yellow-500 text-black'
          : 'border-zinc-700 bg-zinc-900/90 text-zinc-300 hover:text-white hover:border-yellow-500'
      }`}
    >
      {children}
    </button>
  );
}

interface LeafNodeProps {
  node: MindMapLeafNode;
  isActive: boolean;
  isPinned: boolean;
  kind?: WikiRelationKind;
  opacity: number;
  homeIcon?: string;
  onHover: (id: string | null, key?: string | null) => void;
  onClick: (id: string, key: string) => void;
  onOpen: (id: string) => void;
}

function LeafNode({ node, isActive, isPinned, kind, opacity, homeIcon, onHover, onClick, onOpen }: LeafNodeProps): JSX.Element {
  const { leaf, side, x, y, labelX, width } = node;
  const m = DEFAULT_MIND_MAP_METRICS;
  const hitX = side === 1 ? x - 6 : labelX - width - 6;
  const hitW = Math.abs(labelX - x) + width + 12;
  const fill = isActive ? '#ffffff' : kind ? RELATION_STROKE[kind] : leaf.pending ? '#a1a1aa' : leaf.alias ? '#d4d4d8' : '#e4e4e7';
  const id = leaf.articleId;

  return (
    <g
      data-node
      opacity={opacity}
      className="cursor-pointer"
      onMouseEnter={() => onHover(id, node.key)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onClick(id, node.key)}
      onDoubleClick={() => onOpen(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(id);
        else if (e.key === ' ') {
          e.preventDefault();
          onClick(id, node.key);
        }
      }}
      onFocus={() => onHover(id, node.key)}
      onBlur={() => onHover(null)}
      tabIndex={0}
      role="button"
      aria-label={`${leaf.title}${leaf.pending ? '（待完成）' : ''}`}
    >
      <title>{`${leaf.title}${leaf.pending ? '（待完成）' : ''}${leaf.alias ? '（新手閱讀順序捷徑）' : ''}\n點一下固定・雙擊開啟`}</title>
      <rect
        x={hitX}
        y={y - ROW / 2 + 1}
        width={hitW}
        height={ROW - 2}
        rx={6}
        fill={isActive ? 'rgba(234,179,8,0.16)' : 'transparent'}
        stroke={isPinned ? 'rgba(234,179,8,0.7)' : 'none'}
      />
      {leaf.pending ? (
        <circle cx={x} cy={y} r={3.5} fill="#000" stroke="#71717a" strokeDasharray="2 1.5" />
      ) : (
        <circle cx={x} cy={y} r={leaf.guide ? 5 : 3.5} fill={leaf.guide ? '#eab308' : kind ? RELATION_STROKE[kind] : '#71717a'} />
      )}
      {leaf.readingStep !== undefined && (
        <g transform={`translate(${x + side * 14},${y})`}>
          <circle r={8} fill="rgba(245,158,11,0.18)" stroke="#f59e0b" strokeWidth={1} />
          <text textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight={700} fill="#fde68a">
            {leaf.readingStep}
          </text>
        </g>
      )}
      <text
        x={labelX}
        y={y}
        textAnchor={side === 1 ? 'start' : 'end'}
        dominantBaseline="central"
        fontSize={m.leafFont}
        fontWeight={isActive ? 700 : 400}
        fontStyle={leaf.pending ? 'italic' : undefined}
        fill={fill}
      >
        {side === -1 && homeIcon && <tspan fontSize={m.leafFont - 2}>{homeIcon} </tspan>}
        {node.label}
        {side === 1 && homeIcon && <tspan fontSize={m.leafFont - 2}> {homeIcon}</tspan>}
      </text>
    </g>
  );
}

interface MapPanelProps {
  graph: WikiGraph;
  articlesById: ReadonlyMap<string, WikiArticle>;
  /** The pinned article; none = the reading order. */
  activeId: string | null;
  /** Float over the left edge of the map instead of the right. */
  left: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}

function MapPanel({ graph, articlesById, activeId, left, onSelect, onOpen, onClose }: MapPanelProps): JSX.Element {
  const info = activeId ? graph.articles[activeId] : undefined;
  const article = activeId ? articlesById.get(activeId) : undefined;
  const branch = info ? graph.branches.find((b) => b.id === info.category) : undefined;
  const step = activeId ? graph.readingOrder.indexOf(activeId) : -1;
  const out = activeId ? graph.outgoing[activeId] ?? [] : [];
  const inc = activeId ? graph.incoming[activeId] ?? [] : [];

  return (
    <aside
      className={`absolute top-2 bottom-2 ${left ? 'left-2' : 'right-2'} w-72 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950/95 p-3 pt-2 text-sm shadow-2xl shadow-black/60 backdrop-blur-sm`}
      data-testid="wiki-mindmap-panel"
    >
      <div className="flex justify-end -mb-1">
        <button type="button" onClick={onClose} aria-label="關閉面板" title="關閉（取消選取）" className="p-1 text-zinc-500 hover:text-white">
          <X size={16} />
        </button>
      </div>
      {info ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            <span>
              {branch?.icon} {branch?.name ?? info.category}
            </span>
            {info.pending && <span className="text-amber-300 border border-amber-500/40 rounded px-1">待完成</span>}
          </div>
          <button
            type="button"
            onClick={() => onOpen(info.id)}
            className="block text-left text-base font-bold text-white leading-snug hover:text-yellow-300 hover:underline"
          >
            {info.title}
          </button>
          {article && <p className="text-xs text-zinc-400 leading-relaxed line-clamp-4">{wikiCardExcerpt(article.excerpt, article.content)}</p>}
          <button
            type="button"
            onClick={() => onOpen(info.id)}
            className="inline-flex items-center gap-1.5 rounded-md bg-yellow-500 hover:bg-yellow-400 text-black text-xs font-bold px-3 py-1.5"
          >
            <BookOpen size={14} />
            閱讀全文
          </button>

          {step >= 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
              <div className="text-[11px] text-amber-200">
                建議閱讀順序 第 {step + 1} / {graph.readingOrder.length} 篇
              </div>
              <div className="mt-1 flex gap-1">
                <button
                  type="button"
                  disabled={step === 0}
                  onClick={() => onSelect(graph.readingOrder[step - 1])}
                  className="flex-1 min-w-0 inline-flex items-center gap-0.5 text-[11px] text-zinc-300 hover:text-white disabled:opacity-30 truncate"
                >
                  <ChevronLeft size={12} className="shrink-0" />
                  <span className="truncate">{step > 0 ? graph.articles[graph.readingOrder[step - 1]].title : '—'}</span>
                </button>
                <button
                  type="button"
                  disabled={step === graph.readingOrder.length - 1}
                  onClick={() => onSelect(graph.readingOrder[step + 1])}
                  className="flex-1 min-w-0 inline-flex items-center justify-end gap-0.5 text-[11px] text-zinc-300 hover:text-white disabled:opacity-30"
                >
                  <span className="truncate">
                    {step < graph.readingOrder.length - 1 ? graph.articles[graph.readingOrder[step + 1]].title : '—'}
                  </span>
                  <ChevronRight size={12} className="shrink-0" />
                </button>
              </div>
            </div>
          )}

          <div className="pt-1 border-t border-zinc-800 space-y-2.5">
            <div className="text-xs font-semibold text-zinc-300">相關文章</div>
            {out.length === 0 && inc.length === 0 && <p className="text-xs text-zinc-500">這篇還沒有和其他文章互相連結。</p>}
            <PanelChips title={RELATION_LABEL.out} ids={out} kindOf={(id) => (inc.includes(id) ? 'both' : 'out')} graph={graph} onSelect={onSelect} onOpen={onOpen} />
            <PanelChips title={RELATION_LABEL.in} ids={inc} kindOf={(id) => (out.includes(id) ? 'both' : 'in')} graph={graph} onSelect={onSelect} onOpen={onOpen} />
          </div>
          <Legend />
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="text-sm font-bold text-white">{graph.rootLabel}心智圖</div>
            <p className="text-xs text-zinc-400 leading-relaxed mt-1">
              {Object.keys(graph.articles).length} 篇文章、{graph.edges.length} 條互相引用。滑過或點一篇文章，會標出它引用的與引用它的文章；雙擊或在這裡點標題開啟。
            </p>
          </div>
          {graph.readingOrder.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-amber-200 mb-1">新手建議閱讀順序</div>
              <ol className="space-y-0.5">
                {graph.readingOrder.map((id, i) => (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => onSelect(id)}
                      className="w-full flex items-start gap-1.5 text-left text-xs text-zinc-300 hover:text-white rounded px-1 py-0.5 hover:bg-zinc-900"
                    >
                      <span className="shrink-0 w-4 text-right text-amber-300 tabular-nums">{i + 1}</span>
                      <span className="min-w-0 break-words">{graph.articles[id].title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <Legend />
        </div>
      )}
    </aside>
  );
}

function PanelChips({
  title,
  ids,
  kindOf,
  graph,
  onSelect,
  onOpen,
}: {
  title: string;
  ids: string[];
  kindOf: (id: string) => WikiRelationKind;
  graph: WikiGraph;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}): JSX.Element | null {
  if (ids.length === 0) return null;
  return (
    <div>
      <div className="text-[11px] text-zinc-500 mb-1">
        {title}（{ids.length}）
      </div>
      <div className="flex flex-wrap gap-1">
        {ids.map((id) => (
          <span key={id} className={`inline-flex max-w-full items-stretch rounded border text-[11px] leading-snug ${RELATION_CHIP_CLASS[kindOf(id)]}`}>
            <button type="button" onClick={() => onSelect(id)} title="在圖上選取" className="min-w-0 text-left break-words px-1.5 py-0.5">
              {graph.articles[id]?.title ?? id}
            </button>
            <button
              type="button"
              onClick={() => onOpen(id)}
              title="開啟文章"
              aria-label={`開啟〈${graph.articles[id]?.title ?? id}〉`}
              className="shrink-0 px-1 border-l border-white/10 opacity-70 hover:opacity-100"
            >
              <BookOpen size={11} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function Legend(): JSX.Element {
  return (
    <div className="pt-2 border-t border-zinc-800 space-y-1 text-[11px] text-zinc-400">
      {(['out', 'in', 'both'] as WikiRelationKind[]).map((kind) => (
        <div key={kind} className="flex items-center gap-2">
          <span className="w-5 h-0.5 rounded" style={{ background: RELATION_STROKE[kind] }} />
          {RELATION_LABEL[kind]}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <span className="w-4 h-4 rounded-full border border-amber-500 bg-amber-500/20 text-[9px] text-amber-200 flex items-center justify-center">1</span>
        新手建議閱讀順序
      </div>
      <div className="flex items-center gap-2">
        <span className="w-5 text-center">📋</span>
        標在新手分支的捷徑，原文在該分類
      </div>
      <div className="flex items-center gap-2">
        <span className="w-2.5 h-2.5 mx-[5px] rounded-full border border-dashed border-zinc-500" />
        待完成的文章
      </div>
    </div>
  );
}
