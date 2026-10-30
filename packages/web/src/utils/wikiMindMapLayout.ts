/**
 * 百科心智圖（桌面版 SVG）的佈局：根在中間，分類分成左右兩邊（依文章數平衡，像 XMind），每個分類的文章排在一個
 * 框裡，文章多的分類分成幾欄（先往下排、再換欄），讓整張圖放得進一個畫面（Edward 2026-10-30：預設心智圖、
 * 一張頁面裡呈現）。fitMindMapToViewport 依畫面大小挑每欄最多幾行，讓整張圖縮放後的字最大。
 * 自己算、不靠圖形套件；文字寬度用估的（中日韓字、emoji ≈ 1 個字高，其餘 ≈ 0.56 個字高）。
 *
 * 純函式：packages/server/src/__tests__/WikiGraph.test.ts 測。
 */
import type { WikiGraph, WikiTreeBranch, WikiTreeLeaf } from './wikiGraph';

export type MindMapSide = -1 | 1;

export interface MindMapMetrics {
  rowHeight: number;
  branchGap: number;
  leafFont: number;
  branchFont: number;
  rootFont: number;
  /** Leaf labels longer than this are cut in the middle (the full title is in the tooltip / panel). */
  maxLeafLabel: number;
  /** Horizontal gap between root → branch and branch → article box. */
  levelGap: number;
  /** Space between a leaf's dot and its label when the column has reading-step badges. */
  leafLabelOffset: number;
  /** … and when it has none. */
  leafLabelOffsetPlain: number;
  /** Space between two article columns of a branch. */
  columnGap: number;
  /** Inner padding of a branch's article box. */
  boxPadding: number;
  padding: number;
}

export const DEFAULT_MIND_MAP_METRICS: MindMapMetrics = {
  rowHeight: 18,
  branchGap: 10,
  leafFont: 13,
  branchFont: 14,
  rootFont: 16,
  maxLeafLabel: 160,
  levelGap: 26,
  leafLabelOffset: 24,
  leafLabelOffsetPlain: 10,
  columnGap: 18,
  boxPadding: 8,
  padding: 16,
};

interface BaseNode {
  key: string;
  x: number;
  y: number;
  /** Pill / label width estimate. */
  width: number;
  label: string;
}

export interface MindMapRootNode extends BaseNode {
  kind: 'root';
  side: 0;
}

export interface MindMapBranchNode extends BaseNode {
  kind: 'branch';
  side: MindMapSide;
  branch: WikiTreeBranch;
  collapsed: boolean;
  /** Article columns (0 when collapsed). */
  columns: number;
}

export interface MindMapLeafNode extends BaseNode {
  kind: 'leaf';
  side: MindMapSide;
  branchKey: string;
  leaf: WikiTreeLeaf;
  column: number;
  /** Label text start (text-anchor start on the right, end on the left). */
  labelX: number;
}

export type MindMapNode = MindMapRootNode | MindMapBranchNode | MindMapLeafNode;

/** The frame around an expanded branch's articles. */
export interface MindMapBox {
  branchKey: string;
  side: MindMapSide;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MindMapLayout {
  root: MindMapRootNode;
  branches: MindMapBranchNode[];
  leaves: MindMapLeafNode[];
  boxes: MindMapBox[];
  /** Where relation lines of an article end: its own leaf, else its reading-path shortcut, else its (collapsed) branch. */
  anchorOf: Record<string, string>;
  byKey: Record<string, MindMapNode>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** Root → branch and branch → article box connector endpoints. */
  links: { from: string; to: string; x1: number; y1: number; x2: number; y2: number }[];
  /** Most rows in one article column. */
  maxRows: number;
}

const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u2600-\u27bf]|\p{Extended_Pictographic}/u;

/** Rough rendered width of a text in the site's sans-serif font. */
export function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    if (ch === '\u200d' || ch === '\ufe0f') continue; // emoji joiner / variation selector
    w += WIDE_CHAR.test(ch) ? fontSize : fontSize * 0.56;
  }
  return w;
}

/** The text, cut with … at the end so it fits maxWidth. */
export function truncateToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const chars = [...text];
  const ell = estimateTextWidth('…', fontSize);
  let w = 0;
  let i = 0;
  for (; i < chars.length; i++) {
    const cw = estimateTextWidth(chars[i], fontSize);
    if (w + cw + ell > maxWidth) break;
    w += cw;
  }
  return `${chars.slice(0, i).join('').trimEnd()}…`;
}

/**
 * The text, cut with … in the middle so it fits maxWidth: series titles keep what tells them apart
 * (「S1 新人挑戰賽 - 第 3 集回顧（2023-09-01）」→「S1 新人挑戰賽…09-01）」).
 */
export function truncateMiddle(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const chars = [...text];
  const budget = maxWidth - estimateTextWidth('…', fontSize);
  const tailBudget = budget * 0.38;
  let tw = 0;
  let t = chars.length;
  while (t > 0 && tw + estimateTextWidth(chars[t - 1], fontSize) <= tailBudget) tw += estimateTextWidth(chars[--t], fontSize);
  let hw = 0;
  let h = 0;
  while (h < t && hw + estimateTextWidth(chars[h], fontSize) <= budget - tw) hw += estimateTextWidth(chars[h++], fontSize);
  return `${chars.slice(0, h).join('').trimEnd()}…${chars.slice(t).join('').trimStart()}`;
}

/** truncateMiddle + its width, memoised: fitMindMapToViewport lays the map out ~100 times per viewport size. */
const labelCache = new Map<string, { label: string; width: number }>();
function cutLabel(text: string, maxWidth: number, fontSize: number): { label: string; width: number } {
  const key = `${maxWidth}|${fontSize}|${text}`;
  let hit = labelCache.get(key);
  if (!hit) {
    if (labelCache.size > 20000) labelCache.clear();
    const label = truncateMiddle(text, maxWidth, fontSize);
    hit = { label, width: estimateTextWidth(label, fontSize) };
    labelCache.set(key, hit);
  }
  return hit;
}

/**
 * Left / right side of each branch, from the fully expanded sizes (so collapsing a branch never moves the others to
 * the other side). Greedy in branch order: each goes to the lighter side, ties to the right.
 */
export function assignSides(branches: readonly WikiTreeBranch[]): Record<string, MindMapSide> {
  const load = { [-1]: 0, [1]: 0 } as Record<MindMapSide, number>;
  const sides: Record<string, MindMapSide> = {};
  for (const b of branches) {
    const side: MindMapSide = load[1] <= load[-1] ? 1 : -1;
    sides[b.id] = side;
    load[side] += Math.max(1, b.leaves.length);
  }
  return sides;
}

export const branchLabel = (b: WikiTreeBranch): string => `${b.icon ? `${b.icon} ` : ''}${b.name}`;

/** The branch label plus its count, as the pill shows it. */
export const branchPillText = (b: WikiTreeBranch): string => `${branchLabel(b)}  ${b.articleCount}`;

/**
 * @param maxRows most articles in one column of a branch; a bigger branch is split into balanced columns
 *   (Infinity = one column each).
 */
export function layoutWikiMindMap(
  graph: Pick<WikiGraph, 'rootLabel' | 'branches'>,
  collapsed: ReadonlySet<string> = new Set(),
  metrics: Partial<MindMapMetrics> = {},
  maxRows: number = Infinity,
): MindMapLayout {
  const m = { ...DEFAULT_MIND_MAP_METRICS, ...metrics };
  const rowsCap = Number.isFinite(maxRows) ? Math.max(1, Math.floor(maxRows)) : Infinity;
  const sides = assignSides(graph.branches);

  const rootWidth = estimateTextWidth(graph.rootLabel, m.rootFont) + 32;
  const pillWidth = (b: WikiTreeBranch): number => estimateTextWidth(branchPillText(b), m.branchFont) + 24;
  const maxPill = Math.max(0, ...graph.branches.map(pillWidth));
  const branchX = rootWidth / 2 + m.levelGap + maxPill / 2;
  /** Inner edge of the article boxes. */
  const boxX = branchX + maxPill / 2 + 12 + m.levelGap;
  const firstDotX = boxX + m.boxPadding + 4;

  const root: MindMapRootNode = { key: 'root', kind: 'root', side: 0, x: 0, y: 0, width: rootWidth, label: graph.rootLabel };
  const branches: MindMapBranchNode[] = [];
  const leaves: MindMapLeafNode[] = [];
  const boxes: MindMapBox[] = [];
  let usedRows = 0;

  const aliasMark = m.leafFont * 1.4;
  const split = (b: WikiTreeBranch): { columns: number; rows: number } => {
    const columns = Math.max(1, Math.ceil(b.leaves.length / rowsCap));
    return { columns, rows: Math.ceil(b.leaves.length / columns) };
  };
  const leafLabel = (leaf: WikiTreeLeaf, cap: number): { label: string; width: number } => {
    const fitted = cutLabel(leaf.title, cap - (leaf.alias ? aliasMark : 0), m.leafFont);
    return { label: fitted.label, width: fitted.width + (leaf.alias ? aliasMark : 0) };
  };
  const columnOffset = (col: WikiTreeLeaf[]): number =>
    col.some((l) => l.readingStep !== undefined) ? m.leafLabelOffset : m.leafLabelOffsetPlain;
  /** First dot → end of the last label of a branch's columns, titles cut at `cap`. */
  const columnsWidth = (b: WikiTreeBranch, cap: number): number => {
    const { columns, rows } = split(b);
    let w = (columns - 1) * m.columnGap;
    for (let c = 0; c < columns; c++) {
      const col = b.leaves.slice(c * rows, (c + 1) * rows);
      w += columnOffset(col) + Math.max(0, ...col.map((l) => leafLabel(l, cap).width));
    }
    return w;
  };

  for (const side of [1, -1] as const) {
    const sideBranches = graph.branches.filter((b) => sides[b.id] === side);
    // The widest branch of this side (titles at the base cap) sets the room; branches with fewer columns spend it
    // on longer titles instead of cutting them (from the expanded sizes, so collapsing changes no label).
    const room = Math.max(0, ...sideBranches.map((b) => columnsWidth(b, m.maxLeafLabel)));
    const capOf = (b: WikiTreeBranch): number => {
      const { columns } = split(b);
      return Math.max(m.maxLeafLabel, (room - (columns - 1) * m.columnGap) / columns - m.leafLabelOffset);
    };
    const placedBranches: MindMapBranchNode[] = [];
    const placedLeaves: MindMapLeafNode[] = [];
    const placedBoxes: MindMapBox[] = [];
    let cursor = 0;
    sideBranches.forEach((b, bi) => {
      if (bi > 0) cursor += m.branchGap;
      const isCollapsed = collapsed.has(b.id);
      const key = `branch/${b.id}`;
      let y: number;
      let columns = 0;
      if (isCollapsed || b.leaves.length === 0) {
        y = cursor + m.rowHeight / 2;
        cursor += m.rowHeight;
      } else {
        const parts = split(b);
        columns = parts.columns;
        const rows = parts.rows;
        const cap = capOf(b);
        usedRows = Math.max(usedRows, rows);
        const top = cursor + m.boxPadding / 2;
        let dotX = firstDotX;
        let right = firstDotX;
        for (let c = 0; c < columns; c++) {
          const col = b.leaves.slice(c * rows, (c + 1) * rows);
          const offset = columnOffset(col);
          let colWidth = 0;
          col.forEach((leaf, i) => {
            const { label, width } = leafLabel(leaf, cap);
            colWidth = Math.max(colWidth, width);
            placedLeaves.push({
              key: leaf.key,
              kind: 'leaf',
              side,
              x: side * dotX,
              y: top + m.rowHeight / 2 + i * m.rowHeight,
              labelX: side * (dotX + offset),
              width,
              label,
              branchKey: key,
              leaf,
              column: c,
            });
          });
          right = dotX + offset + colWidth;
          dotX = right + m.columnGap;
        }
        const height = rows * m.rowHeight + m.boxPadding;
        const boxRight = right + m.boxPadding;
        placedBoxes.push({
          branchKey: key,
          side,
          x: side === 1 ? boxX : -boxRight,
          y: cursor,
          width: boxRight - boxX,
          height,
        });
        y = cursor + height / 2;
        cursor += height;
      }
      placedBranches.push({
        key,
        kind: 'branch',
        side,
        x: side * branchX,
        y,
        width: pillWidth(b),
        label: branchPillText(b),
        branch: b,
        collapsed: isCollapsed,
        columns,
      });
    });
    // Centre this side on the root.
    const shift = -cursor / 2;
    for (const n of [...placedBranches, ...placedLeaves, ...placedBoxes]) n.y += shift;
    branches.push(...placedBranches);
    leaves.push(...placedLeaves);
    boxes.push(...placedBoxes);
  }

  const byKey: Record<string, MindMapNode> = { root };
  for (const n of [...branches, ...leaves]) byKey[n.key] = n;

  const anchorOf: Record<string, string> = {};
  for (const b of branches) {
    for (const leaf of b.branch.leaves) {
      const visible = byKey[leaf.key] !== undefined;
      if (!leaf.alias) {
        if (visible) anchorOf[leaf.articleId] = leaf.key;
        else if (!anchorOf[leaf.articleId]) anchorOf[leaf.articleId] = b.key;
      }
    }
  }
  // A collapsed home branch: point at the visible reading-path shortcut instead, when there is one.
  for (const leaf of leaves) {
    const current = anchorOf[leaf.leaf.articleId];
    if (leaf.leaf.alias && (current === undefined || byKey[current]?.kind === 'branch')) {
      anchorOf[leaf.leaf.articleId] = leaf.key;
    }
  }

  const links: MindMapLayout['links'] = [];
  for (const b of branches) {
    links.push({ from: 'root', to: b.key, x1: b.side * (rootWidth / 2), y1: 0, x2: b.x - b.side * (b.width / 2), y2: b.y });
  }
  for (const box of boxes) {
    const b = byKey[box.branchKey] as MindMapBranchNode;
    links.push({ from: b.key, to: `box/${b.branch.id}`, x1: b.x + b.side * (b.width / 2), y1: b.y, x2: box.side * boxX, y2: b.y });
  }

  let minX = -rootWidth / 2;
  let maxX = rootWidth / 2;
  let minY = -m.rowHeight / 2;
  let maxY = m.rowHeight / 2;
  for (const b of branches) {
    minX = Math.min(minX, b.x - b.width / 2);
    maxX = Math.max(maxX, b.x + b.width / 2);
    minY = Math.min(minY, b.y - m.rowHeight / 2);
    maxY = Math.max(maxY, b.y + m.rowHeight / 2);
  }
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    maxX = Math.max(maxX, box.x + box.width);
    minY = Math.min(minY, box.y);
    maxY = Math.max(maxY, box.y + box.height);
  }

  return {
    root,
    branches,
    leaves,
    boxes,
    anchorOf,
    byKey,
    links,
    maxRows: usedRows,
    bounds: { minX: minX - m.padding, maxX: maxX + m.padding, minY: minY - m.padding, maxY: maxY + m.padding },
  };
}

/** The scale at which a layout fills a viewport. */
export function fitScale(bounds: MindMapLayout['bounds'], width: number, height: number): number {
  return Math.min(width / (bounds.maxX - bounds.minX), height / (bounds.maxY - bounds.minY));
}

/**
 * Title caps fitMindMapToViewport tries (content px at leafFont 13: 160 ≈ 12 CJK characters).
 * 112 added 2026-10-30 (Edward 裁定後百科 100 篇): at 1254 × 730 the 136 cap no longer keeps titles ≥ 11px;
 * a shorter cap (titles cut in the middle, full title in the hover tooltip) is preferred over smaller text.
 */
const LABEL_CAPS = [112, 136, 160, 184, 208, 232];

/**
 * The column split and title cap that show the whole (fully expanded) map in a width × height viewport with the
 * biggest text: tries every "most rows per column" × title cap and keeps the best scale (up to maxScale); among
 * splits within half a percent of it, the longest titles, then the fewest columns. Returns the rows cap and title
 * cap for layoutWikiMindMap (`maxRows`, metrics `maxLeafLabel`) and the scale it fits at.
 */
export function fitMindMapToViewport(
  graph: Pick<WikiGraph, 'rootLabel' | 'branches'>,
  width: number,
  height: number,
  metrics: Partial<MindMapMetrics> = {},
  maxScale = 1.25,
): { maxRows: number; maxLeafLabel: number; scale: number } {
  const most = Math.max(1, ...graph.branches.map((b) => b.leaves.length));
  const tried: { maxRows: number; maxLeafLabel: number; scale: number }[] = [];
  for (const cap of LABEL_CAPS) {
    for (let rows = most; rows >= 3; rows--) {
      const layout = layoutWikiMindMap(graph, new Set(), { ...metrics, maxLeafLabel: cap }, rows);
      if (layout.maxRows !== rows && rows !== most) continue; // same split as a bigger rows cap
      tried.push({ maxRows: rows, maxLeafLabel: cap, scale: Math.min(maxScale, fitScale(layout.bounds, width, height)) });
    }
  }
  const top = Math.max(...tried.map((t) => t.scale));
  return tried
    .filter((t) => t.scale >= top - 0.005)
    .sort((a, b) => b.maxLeafLabel - a.maxLeafLabel || b.maxRows - a.maxRows)[0];
}
