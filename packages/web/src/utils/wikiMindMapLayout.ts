/**
 * 百科心智圖（桌面版 SVG）的佈局：根在中間，分類分成左右兩邊（依文章數平衡，像 XMind），文章一行一個往外排。
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
  /** Leaf labels longer than this are cut with an ellipsis (the full title is in the tooltip / panel). */
  maxLeafLabel: number;
  /** Horizontal gap between root → branch and branch → leaf. */
  levelGap: number;
  /** Space between a leaf's dot and its label (the reading-step badge sits in it). */
  leafLabelOffset: number;
  padding: number;
}

export const DEFAULT_MIND_MAP_METRICS: MindMapMetrics = {
  rowHeight: 24,
  branchGap: 14,
  leafFont: 13,
  branchFont: 14,
  rootFont: 16,
  maxLeafLabel: 200,
  levelGap: 44,
  leafLabelOffset: 26,
  padding: 24,
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
}

export interface MindMapLeafNode extends BaseNode {
  kind: 'leaf';
  side: MindMapSide;
  branchKey: string;
  leaf: WikiTreeLeaf;
  /** Label text start (text-anchor start on the right, end on the left). */
  labelX: number;
}

export type MindMapNode = MindMapRootNode | MindMapBranchNode | MindMapLeafNode;

export interface MindMapLayout {
  root: MindMapRootNode;
  branches: MindMapBranchNode[];
  leaves: MindMapLeafNode[];
  /** Where relation lines of an article end: its own leaf, else its reading-path shortcut, else its (collapsed) branch. */
  anchorOf: Record<string, string>;
  byKey: Record<string, MindMapNode>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** Root → branch and branch → leaf connector endpoints. */
  links: { from: string; to: string; x1: number; y1: number; x2: number; y2: number }[];
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

/** The text, cut with … so it fits maxWidth. */
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

export function layoutWikiMindMap(
  graph: Pick<WikiGraph, 'rootLabel' | 'branches'>,
  collapsed: ReadonlySet<string> = new Set(),
  metrics: Partial<MindMapMetrics> = {},
): MindMapLayout {
  const m = { ...DEFAULT_MIND_MAP_METRICS, ...metrics };
  const sides = assignSides(graph.branches);

  const rootWidth = estimateTextWidth(graph.rootLabel, m.rootFont) + 32;
  const pillWidth = (b: WikiTreeBranch): number => estimateTextWidth(branchPillText(b), m.branchFont) + 24;
  const maxPill = Math.max(0, ...graph.branches.map(pillWidth));
  const branchX = rootWidth / 2 + m.levelGap + maxPill / 2;
  const leafX = branchX + maxPill / 2 + m.levelGap;

  const root: MindMapRootNode = { key: 'root', kind: 'root', side: 0, x: 0, y: 0, width: rootWidth, label: graph.rootLabel };
  const branches: MindMapBranchNode[] = [];
  const leaves: MindMapLeafNode[] = [];

  for (const side of [1, -1] as const) {
    const sideBranches = graph.branches.filter((b) => sides[b.id] === side);
    const placedBranches: MindMapBranchNode[] = [];
    const placedLeaves: MindMapLeafNode[] = [];
    let cursor = 0;
    sideBranches.forEach((b, bi) => {
      if (bi > 0) cursor += m.branchGap;
      const isCollapsed = collapsed.has(b.id);
      const key = `branch/${b.id}`;
      let y: number;
      if (isCollapsed || b.leaves.length === 0) {
        y = cursor + m.rowHeight / 2;
        cursor += m.rowHeight;
      } else {
        const first = cursor + m.rowHeight / 2;
        b.leaves.forEach((leaf, i) => {
          const label = truncateToWidth(leaf.title, m.maxLeafLabel, m.leafFont);
          placedLeaves.push({
            key: leaf.key,
            kind: 'leaf',
            side,
            x: side * leafX,
            y: first + i * m.rowHeight,
            labelX: side * (leafX + m.leafLabelOffset),
            width: estimateTextWidth(label, m.leafFont) + (leaf.alias ? m.leafFont * 1.6 : 0),
            label,
            branchKey: key,
            leaf,
          });
        });
        y = (first + first + (b.leaves.length - 1) * m.rowHeight) / 2;
        cursor += b.leaves.length * m.rowHeight;
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
      });
    });
    // Centre this side on the root.
    const shift = -cursor / 2;
    for (const n of [...placedBranches, ...placedLeaves]) n.y += shift;
    branches.push(...placedBranches);
    leaves.push(...placedLeaves);
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
  for (const l of leaves) {
    const b = byKey[l.branchKey] as MindMapBranchNode;
    links.push({ from: b.key, to: l.key, x1: b.x + b.side * (b.width / 2), y1: b.y, x2: l.x, y2: l.y });
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
  for (const l of leaves) {
    const end = l.labelX + l.side * l.width;
    minX = Math.min(minX, l.x, end);
    maxX = Math.max(maxX, l.x, end);
    minY = Math.min(minY, l.y - m.rowHeight / 2);
    maxY = Math.max(maxY, l.y + m.rowHeight / 2);
  }

  return {
    root,
    branches,
    leaves,
    anchorOf,
    byKey,
    links,
    bounds: { minX: minX - m.padding, maxX: maxX + m.padding, minY: minY - m.padding, maxY: maxY + m.padding },
  };
}
