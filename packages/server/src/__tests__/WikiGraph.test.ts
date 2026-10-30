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
  assignSides,
  estimateTextWidth,
  layoutWikiMindMap,
  truncateToWidth,
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
    expect(cleanWikiTitle('  新手常見疑問 - 遊戲開始該做什麼  入門行動方針 ')).toBe('新手常見疑問 - 遊戲開始該做什麼 入門行動方針');
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

  it('lays out without overlaps, balanced left / right', () => {
    const layout = layoutWikiMindMap(graph);
    for (const side of [1, -1]) {
      const ys = layout.leaves.filter((l) => l.side === side).map((l) => l.y).sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(24);
      for (const l of layout.leaves.filter((n) => n.side === side)) {
        expect(Math.sign(l.x)).toBe(side);
        expect(Math.abs(l.labelX)).toBeGreaterThan(Math.abs(l.x));
      }
    }
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

  it('connects root → branches → leaves', () => {
    const layout = layoutWikiMindMap(graph);
    expect(layout.links.filter((l) => l.from === 'root')).toHaveLength(layout.branches.length);
    expect(layout.links.filter((l) => l.from !== 'root')).toHaveLength(layout.leaves.length);
  });
});

describe('text helpers', () => {
  it('counts CJK and emoji as full width, latin as about half', () => {
    expect(estimateTextWidth('阿瓦隆', 10)).toBe(30);
    expect(estimateTextWidth('ab', 10)).toBeCloseTo(11.2);
    expect(estimateTextWidth('⚫', 10)).toBe(10);
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
