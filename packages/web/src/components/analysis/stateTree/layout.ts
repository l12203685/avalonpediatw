/**
 * 局勢樹桌機版的位置（純函式）：橫向整齊樹，一層一欄；看得到的葉子由上往下排，父節點在第一個與最後一個
 * 看得到的子節點中間。收合的節點不畫子樹。
 */
import type { StateNode } from './stateTree';

export interface PlacedNode {
  node: StateNode;
  /** 左上角。 */
  x: number;
  y: number;
  parent: PlacedNode | null;
  /** 有子節點但收合著。 */
  collapsed: boolean;
}

export interface TreeLayout {
  nodes: PlacedNode[];
  width: number;
  height: number;
  /** 看得到的最深一層。 */
  maxDepth: number;
}

export interface LayoutOptions {
  colWidth: number;
  rowHeight: number;
  boxWidth: number;
  boxHeight: number;
}

/** 看得到的最深一層（決定欄寬用）。 */
export function visibleDepth(root: StateNode, expanded: ReadonlySet<string>): number {
  let max = 0;
  const walk = (n: StateNode): void => {
    max = Math.max(max, n.depth);
    if (expanded.has(n.id)) n.children.forEach(walk);
  };
  walk(root);
  return max;
}

export function layoutTree(root: StateNode, expanded: ReadonlySet<string>, opt: LayoutOptions): TreeLayout {
  const nodes: PlacedNode[] = [];
  let row = 0;
  let maxDepth = 0;
  const place = (n: StateNode, parent: PlacedNode | null): PlacedNode => {
    maxDepth = Math.max(maxDepth, n.depth);
    const open = expanded.has(n.id) && n.children.length > 0;
    const placed: PlacedNode = { node: n, x: n.depth * opt.colWidth, y: 0, parent, collapsed: !open && n.children.length > 0 };
    nodes.push(placed);
    if (open) {
      const kids = n.children.map((c) => place(c, placed));
      placed.y = (kids[0].y + kids[kids.length - 1].y) / 2;
    } else {
      placed.y = row * opt.rowHeight;
      row += 1;
    }
    return placed;
  };
  place(root, null);
  return {
    nodes,
    width: maxDepth * opt.colWidth + opt.boxWidth,
    height: Math.max(1, row) * opt.rowHeight - (opt.rowHeight - opt.boxHeight),
    maxDepth,
  };
}

/** 全部展開／收合時用：所有有子節點的節點 id。 */
export function allExpandable(root: StateNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: StateNode): void => {
    if (n.children.length) out.add(n.id);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** 依 id 找節點。 */
export function findNode(root: StateNode, id: string | null): StateNode | null {
  if (!id) return null;
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

/** 從根到這個節點的路徑（含兩端）。 */
export function ancestry(root: StateNode, id: string): StateNode[] {
  if (root.id === id) return [root];
  for (const c of root.children) {
    const sub = ancestry(c, id);
    if (sub.length) return [root, ...sub];
  }
  return [];
}
