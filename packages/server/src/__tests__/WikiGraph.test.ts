/**
 * 百科心智圖 (packages/web/src/utils/wikiGraph.ts + wikiMindMapLayout.ts; the web package has no test runner, so its
 * pure helpers are tested here): the tree (根 → 分類 → 文章) and the article links are computed from the article
 * contents, and the 新手 branch follows 〈關於阿瓦隆百科〉's 建議閱讀順序.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildWikiEdges,
  buildWikiGraph,
  cleanWikiTitle,
  extractReadingOrder,
  extractWikiLinks,
  relatedArticles,
  type WikiGraphArticle,
} from '../../../web/src/utils/wikiGraph';
import {
  DEFAULT_MIND_MAP_METRICS,
  assignSides,
  estimateTextWidth,
  fitMindMapToViewport,
  fitScale,
  layoutWikiMindMap,
  truncateMiddle,
  truncateToWidth,
  type MindMapLayout,
} from '../../../web/src/utils/wikiMindMapLayout';

const art = (id: string, category: string, content = '', status?: string): WikiGraphArticle => ({
  id,
  title: `Title ${id}`,
  category,
  content,
  status,
});

const CATS = [
  { id: 'beginner', name: '新手入門', icon: '🎯' },
  { id: 'rules', name: '遊戲規則', icon: '📋' },
  { id: 'roles', name: '角色指南', icon: '👥' },
  { id: 'faq', name: '常見問題', icon: '❓' },
];

describe('extractWikiLinks', () => {
  it('returns each wiki: target once, in order of first appearance', () => {
    const md = '見 [A](wiki:wiki-48)、[B](wiki:wiki-7) 與 [A again](wiki:wiki-48)；[外部](https://example.com/wiki:no)';
    expect(extractWikiLinks(md)).toEqual(['wiki-48', 'wiki-7', 'no']);
  });

  it('is empty without links', () => {
    expect(extractWikiLinks('沒有連結 [x](https://a.b)')).toEqual([]);
  });
});

describe('extractReadingOrder', () => {
  const guide = [
    '# 關於',
    '[外部](wiki:wiki-1)',
    '# 建議閱讀順序',
    '1. [甲](wiki:wiki-3)',
    '2. [乙](wiki:wiki-2)',
    '## 子標題仍算在內',
    '3. [丙](wiki:wiki-4)',
    '# 下一節',
    '[不算](wiki:wiki-9)',
  ].join('\n');

  it('takes the links of the section only, in order', () => {
    expect(extractReadingOrder(guide)).toEqual(['wiki-3', 'wiki-2', 'wiki-4']);
  });

  it('is empty when the heading is missing', () => {
    expect(extractReadingOrder('# 其他\n[x](wiki:wiki-1)')).toEqual([]);
  });
});

describe('buildWikiEdges', () => {
  it('drops self links, links to missing articles and duplicates', () => {
    const edges = buildWikiEdges([
      art('a', 'rules', '[b](wiki:b) [b](wiki:b) [self](wiki:a) [gone](wiki:zzz)'),
      art('b', 'rules', '[a](wiki:a)'),
      art('c', 'rules'),
    ]);
    expect(edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ]);
  });
});

describe('buildWikiGraph', () => {
  const guideContent = '# 關於\n# 建議閱讀順序\n1. [r](wiki:r1)\n2. [b](wiki:b2)\n3. [x](wiki:missing)\n4. [o](wiki:o1)';
  const articles = [
    art('b1', 'beginner', '[r1](wiki:r1)'),
    art('b2', 'beginner', '', '待完成'),
    art('g', 'beginner', guideContent),
    art('b3', 'beginner'),
    art('r1', 'rules', '[b1](wiki:b1) [o1](wiki:o1)'),
    art('r2', 'rules', '', '待完成'),
    art('r3', 'rules'),
    art('o1', 'other-cat'),
  ];
  const graph = buildWikiGraph(articles, CATS, { guideId: 'g' });

  it('orders branches as given, appends unknown categories and skips empty ones', () => {
    expect(graph.branches.map((b) => b.id)).toEqual(['beginner', 'rules', 'other-cat']);
    expect(graph.branches[2].name).toBe('other-cat');
    expect(graph.rootLabel).toBe('阿瓦隆百科');
  });

  it('puts the guide and the reading order first in the beginner branch, with shortcuts for other categories', () => {
    const beginner = graph.branches[0];
    expect(beginner.leaves.map((l) => l.articleId)).toEqual(['g', 'r1', 'b2', 'o1', 'b1', 'b3']);
    expect(beginner.leaves.map((l) => l.readingStep)).toEqual([undefined, 1, 2, 3, undefined, undefined]);
    expect(beginner.leaves.filter((l) => l.alias).map((l) => l.articleId)).toEqual(['r1', 'o1']);
    expect(beginner.leaves[0].guide).toBe(true);
    expect(beginner.articleCount).toBe(4);
    expect(graph.readingOrder).toEqual(['r1', 'b2', 'o1']);
  });

  it('keeps every article once under its own category, finished ones before 待完成', () => {
    const rules = graph.branches[1];
    expect(rules.leaves.map((l) => l.articleId)).toEqual(['r1', 'r3', 'r2']);
    expect(rules.leaves[0].readingStep).toBe(1);
    expect(rules.leaves.every((l) => !l.alias)).toBe(true);
    const own = graph.branches.flatMap((b) => b.leaves.filter((l) => !l.alias).map((l) => l.articleId));
    expect([...own].sort()).toEqual(articles.map((a) => a.id).sort());
    expect(new Set(graph.branches.flatMap((b) => b.leaves.map((l) => l.key))).size).toBe(own.length + 2);
  });

  it('indexes the links both ways', () => {
    expect(graph.outgoing.r1).toEqual(['b1', 'o1']);
    expect(graph.incoming.r1).toEqual(['b1', 'g']);
    expect(graph.incoming.o1).toEqual(['g', 'r1']);
    expect(relatedArticles(graph, 'r1')).toEqual([
      { id: 'b1', kind: 'both' },
      { id: 'o1', kind: 'out' },
      { id: 'g', kind: 'in' },
    ]);
    expect(relatedArticles(graph, 'b3')).toEqual([]);
  });

  it('works without the guide (no reading order) and ignores duplicate ids', () => {
    const g = buildWikiGraph([art('b1', 'beginner'), art('b1', 'rules'), art('b2', 'beginner')], CATS);
    expect(g.guideId).toBeNull();
    expect(g.readingOrder).toEqual([]);
    expect(g.branches.map((b) => [b.id, b.leaves.map((l) => l.articleId)])).toEqual([['beginner', ['b1', 'b2']]]);
  });

  it('cleans titles', () => {
    expect(cleanWikiTitle('  入門行動方針  -  遊戲開始該做什麼？ ')).toBe('入門行動方針 - 遊戲開始該做什麼？');
  });
});

describe('the real wiki_data.json', () => {
  const data: WikiGraphArticle[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../wiki_data.json'), 'utf8'));
  const cats = ['beginner', 'rules', 'roles', 'glossary', 'strategies', 'replays', 'events', 'faq'].map((id) => ({ id, name: id }));
  const graph = buildWikiGraph(data, cats);

  it('has every article under its category and all the links', () => {
    expect(graph.branches.map((b) => [b.id, b.articleCount])).toEqual([
      ['beginner', 16], ['rules', 4], ['roles', 13], ['glossary', 5], ['strategies', 33], ['replays', 8], ['events', 13], ['faq', 1],
    ]);
    const unique = new Set(data.flatMap((a) => [...a.content.matchAll(/wiki:([\w-]+)/g)].filter((m) => m[1] !== a.id).map((m) => `${a.id}>${m[1]}`)));
    expect(graph.edges).toHaveLength(unique.size);
    expect(graph.edges.length).toBeGreaterThan(150);
  });

  it('starts the beginner branch with 關於阿瓦隆百科 and its 17-article reading order', () => {
    const leaves = graph.branches[0].leaves;
    expect(leaves[0].articleId).toBe('wiki-153');
    expect(graph.readingOrder).toHaveLength(17);
    expect(graph.readingOrder.slice(0, 3)).toEqual(['wiki-71', 'wiki-63', 'wiki-165']);
    expect(graph.readingOrder[16]).toBe('wiki-26');
    expect(leaves.slice(1, 18).map((l) => l.articleId)).toEqual(graph.readingOrder);
    expect(leaves.slice(1, 18).map((l) => l.readingStep)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(leaves).toHaveLength(1 + 17 + (16 - 1 - 5)); // guide + reading order + beginner articles not in it
  });

  /** No two article rows (dot + label) overlap, every row sits inside its branch box. */
  const expectNoOverlap = (layout: MindMapLayout) => {
    const row = DEFAULT_MIND_MAP_METRICS.rowHeight;
    const rects = layout.leaves.map((l) => {
      const ends = [l.x, l.labelX + l.side * l.width];
      return { l, x1: Math.min(...ends), x2: Math.max(...ends), y1: l.y - row / 2, y2: l.y + row / 2 };
    });
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i];
      expect(Math.sign(a.l.x)).toBe(a.l.side);
      expect(Math.abs(a.l.labelX)).toBeGreaterThan(Math.abs(a.l.x));
      const box = layout.boxes.find((b) => b.branchKey === a.l.branchKey)!;
      expect(a.x1).toBeGreaterThanOrEqual(box.x - 0.01);
      expect(a.x2).toBeLessThanOrEqual(box.x + box.width + 0.01);
      expect(a.y1).toBeGreaterThanOrEqual(box.y - 0.01);
      expect(a.y2).toBeLessThanOrEqual(box.y + box.height + 0.01);
      for (let j = i + 1; j < rects.length; j++) {
        const b = rects[j];
        const overlap = a.x1 < b.x2 - 0.01 && b.x1 < a.x2 - 0.01 && a.y1 < b.y2 - 0.01 && b.y1 < a.y2 - 0.01;
        expect(overlap, `${a.l.key} / ${b.l.key}`).toBe(false);
      }
    }
  };

  it('lays out without overlaps, balanced left / right', () => {
    const layout = layoutWikiMindMap(graph);
    expectNoOverlap(layout);
    const right = layout.leaves.filter((l) => l.side === 1).length;
    const left = layout.leaves.filter((l) => l.side === -1).length;
    expect(Math.abs(right - left)).toBeLessThanOrEqual(15);
    // the beginner branch reads left-to-right
    expect(layout.byKey['branch/beginner'].side).toBe(1);
    for (const n of [...layout.branches, ...layout.leaves]) {
      expect(n.x).toBeGreaterThanOrEqual(layout.bounds.minX);
      expect(n.x).toBeLessThanOrEqual(layout.bounds.maxX);
      expect(n.y).toBeGreaterThan(layout.bounds.minY);
      expect(n.y).toBeLessThan(layout.bounds.maxY);
    }
    expect(layout.anchorOf['wiki-63']).toBe('rules/wiki-63');
  });

  it('splits big branches into columns, top to bottom then the next column, without overlaps', () => {
    const layout = layoutWikiMindMap(graph, new Set(), {}, 12);
    expectNoOverlap(layout);
    expect(layout.maxRows).toBeLessThanOrEqual(12);
    const strategies = layout.leaves.filter((l) => l.branchKey === 'branch/strategies');
    expect(new Set(strategies.map((l) => l.column)).size).toBe(3); // 33 articles → 3 columns of 11
    expect(strategies.map((l) => l.leaf.articleId)).toEqual(graph.branches.find((b) => b.id === 'strategies')!.leaves.map((l) => l.articleId));
    expect(strategies.slice(0, 11).every((l) => l.column === 0)).toBe(true);
    // the reading path still reads down the first column of 新手入門
    const beginner = layout.leaves.filter((l) => l.branchKey === 'branch/beginner');
    const firstColumn = beginner.filter((l) => l.column === 0);
    expect(firstColumn[0].leaf.guide).toBe(true);
    expect(firstColumn.slice(1).map((l) => l.leaf.readingStep)).toEqual(firstColumn.slice(1).map((_, i) => i + 1));
    expect(layout.bounds.maxY - layout.bounds.minY).toBeLessThan(layoutWikiMindMap(graph).bounds.maxY - layoutWikiMindMap(graph).bounds.minY);
  });

  it('fits the whole map on a laptop screen with readable titles', () => {
    // 1280×900 window: canvas ≈ 1254 × 730. Titles are 13px at scale 1, so ≥ 0.85 keeps them ≥ 11px.
    for (const [w, h] of [[1254, 730], [1414, 730], [1894, 910]]) {
      const fit = fitMindMapToViewport(graph, w, h);
      const layout = layoutWikiMindMap(graph, new Set(), { maxLeafLabel: fit.maxLeafLabel }, fit.maxRows);
      expect(fitScale(layout.bounds, w, h)).toBeGreaterThanOrEqual(fit.scale - 1e-9);
      expect(fit.scale * DEFAULT_MIND_MAP_METRICS.leafFont, `${w}×${h}`).toBeGreaterThanOrEqual(11);
      expectNoOverlap(layout);
    }
    // one column everywhere would be far smaller
    const single = layoutWikiMindMap(graph);
    expect(fitScale(single.bounds, 1254, 730) * DEFAULT_MIND_MAP_METRICS.leafFont).toBeLessThan(9);
  });
});

describe('layoutWikiMindMap', () => {
  const graph = buildWikiGraph(
    [
      art('g', 'beginner', '# 建議閱讀順序\n[r](wiki:r1)'),
      art('b1', 'beginner'),
      art('r1', 'rules'),
      art('r2', 'rules'),
      art('l1', 'roles'),
    ],
    CATS,
    { guideId: 'g' },
  );

  it('hides a collapsed branch and anchors its articles to the shortcut or the branch node', () => {
    const open = layoutWikiMindMap(graph);
    expect(open.leaves.map((l) => l.key)).toContain('rules/r2');
    expect(open.anchorOf.r1).toBe('rules/r1');

    const shut = layoutWikiMindMap(graph, new Set(['rules']));
    expect(shut.leaves.map((l) => l.key)).not.toContain('rules/r2');
    expect(shut.anchorOf.r1).toBe('beginner/r1'); // the reading-path shortcut is still visible
    expect(shut.anchorOf.r2).toBe('branch/rules');
    expect((shut.byKey['branch/rules'] as { collapsed: boolean }).collapsed).toBe(true);
    // sides don't move when collapsing
    expect(shut.byKey['branch/rules'].side).toBe(open.byKey['branch/rules'].side);
  });

  it('connects root → branches → article boxes', () => {
    const layout = layoutWikiMindMap(graph);
    expect(layout.links.filter((l) => l.from === 'root')).toHaveLength(layout.branches.length);
    expect(layout.links.filter((l) => l.from !== 'root')).toHaveLength(layout.boxes.length);
    expect(layout.boxes).toHaveLength(layout.branches.length);
    const shut = layoutWikiMindMap(graph, new Set(['rules']));
    expect(shut.boxes.map((b) => b.branchKey)).not.toContain('branch/rules');
  });
});

describe('text helpers', () => {
  it('counts CJK and emoji as full width, latin as about half', () => {
    expect(estimateTextWidth('阿瓦隆', 10)).toBe(30);
    expect(estimateTextWidth('ab', 10)).toBeCloseTo(11.2);
    expect(estimateTextWidth('⚫', 10)).toBe(10);
  });

  it('cuts long series titles in the middle so they stay distinguishable', () => {
    const a = truncateMiddle('S1 新人挑戰賽 - 第 3 集回顧（2023-09-01）', 120, 10);
    const b = truncateMiddle('S1 新人挑戰賽 - 第 4 集回顧（2023-09-07）', 120, 10);
    expect(a).toContain('…');
    expect(a.startsWith('S1 新人挑戰賽')).toBe(true);
    expect(a.endsWith('09-01）')).toBe(true);
    expect(a).not.toBe(b);
    expect(estimateTextWidth(a, 10)).toBeLessThanOrEqual(120);
    expect(truncateMiddle('短', 60, 10)).toBe('短');
  });

  it('truncates to the width with an ellipsis', () => {
    const t = truncateToWidth('阿瓦隆百科線上實戰比賽第一季', 60, 10);
    expect(t.endsWith('…')).toBe(true);
    expect(estimateTextWidth(t, 10)).toBeLessThanOrEqual(60);
    expect(truncateToWidth('短', 60, 10)).toBe('短');
  });

  it('balances sides greedily, first branch on the right', () => {
    const b = (id: string, n: number) => ({ id, name: id, leaves: Array.from({ length: n }) as never[], articleCount: n });
    expect(assignSides([b('a', 10), b('b', 4), b('c', 4), b('d', 3)])).toEqual({ a: 1, b: -1, c: -1, d: -1 });
  });
});
