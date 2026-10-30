import { useMemo, useState } from 'react';
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, Link2, Network } from 'lucide-react';
import { WIKI_READING_CATEGORY, relatedArticles } from '../../utils/wikiGraph';
import type { WikiGraph, WikiRelationKind, WikiTreeLeaf } from '../../utils/wikiGraph';
import { RELATION_CHIP_CLASS, RELATION_LABEL, RELATION_TEXT_CLASS } from './relationStyle';

/**
 * 手機／窄螢幕的心智圖：可收合的縮排樹（不畫大 SVG、不橫向捲動）。點標題開文章；點「🔗 n」選取那篇：
 * 列出相關文章（可點開），同時標亮樹上引用它與被它引用的文章、淡化其他。
 */

interface WikiMindMapTreeProps {
  graph: WikiGraph;
  onOpen: (id: string) => void;
}

export default function WikiMindMapTree({ graph, onOpen }: WikiMindMapTreeProps): JSX.Element {
  // 新手入門 starts open (the article list arrives after the first render, so not "the first branch").
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([WIKI_READING_CATEGORY]));
  /** The leaf whose relations are listed (a reading-path shortcut and the article's own leaf are different rows). */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const selectedId = useMemo(() => {
    if (!selectedKey) return null;
    for (const b of graph.branches) for (const l of b.leaves) if (l.key === selectedKey) return l.articleId;
    return null;
  }, [graph, selectedKey]);
  const related = useMemo(() => (selectedId ? relatedArticles(graph, selectedId) : []), [graph, selectedId]);
  const kindOf = useMemo(() => new Map(related.map((r) => [r.id, r.kind])), [related]);

  const allOpen = graph.branches.every((b) => expanded.has(b.id));
  const toggleBranch = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const categoryName = (id: string): string => graph.branches.find((b) => b.id === id)?.name ?? id;
  const categoryIcon = (id: string): string => graph.branches.find((b) => b.id === id)?.icon ?? '';

  return (
    <div className="rounded-lg border border-zinc-800 bg-black/40 p-2" data-testid="wiki-mindmap-tree">
      <div className="flex items-center gap-2 px-1 pb-2 border-b border-zinc-800">
        <Network size={16} className="text-yellow-400 shrink-0" />
        <span className="font-bold text-white text-sm">{graph.rootLabel}</span>
        <span className="text-[11px] text-zinc-500 tabular-nums">
          {Object.keys(graph.articles).length} 篇・{graph.edges.length} 條關聯
        </span>
        <button
          type="button"
          onClick={() => setExpanded(allOpen ? new Set() : new Set(graph.branches.map((b) => b.id)))}
          className="ml-auto shrink-0 inline-flex items-center gap-1 text-[11px] text-zinc-300 hover:text-white border border-zinc-700 rounded px-1.5 py-0.5"
        >
          {allOpen ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
          {allOpen ? '全部收合' : '全部展開'}
        </button>
      </div>
      <p className="px-1 pt-1.5 pb-1 text-[11px] text-zinc-500 leading-snug">
        點標題開文章；點 <Link2 size={11} className="inline -mt-0.5" /> 看這篇和哪些文章互相引用。
      </p>

      <ul className="space-y-0.5">
        {graph.branches.map((branch) => {
          const isOpen = expanded.has(branch.id);
          const relatedHere = selectedId
            ? new Set(branch.leaves.filter((l) => kindOf.has(l.articleId)).map((l) => l.articleId)).size
            : 0;
          return (
            <li key={branch.id}>
              <button
                type="button"
                onClick={() => toggleBranch(branch.id)}
                aria-expanded={isOpen}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-zinc-900"
              >
                <span className="shrink-0">{branch.icon}</span>
                <span className="font-semibold text-sm text-zinc-100">{branch.name}</span>
                <span className="text-[11px] text-zinc-500 tabular-nums">{branch.articleCount}</span>
                {relatedHere > 0 && (
                  <span className="text-[10px] text-amber-300 border border-amber-500/40 rounded px-1 leading-4">{relatedHere} 篇相關</span>
                )}
                <ChevronDown size={16} className={`ml-auto shrink-0 text-zinc-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
              </button>
              {isOpen && (
                <ul className="ml-3 pl-2 border-l border-zinc-700">
                  {branch.leaves.map((leaf) => (
                    <TreeLeaf
                      key={leaf.key}
                      leaf={leaf}
                      graph={graph}
                      selected={leaf.key === selectedKey}
                      isActive={leaf.articleId === selectedId}
                      kind={kindOf.get(leaf.articleId)}
                      dimmed={selectedId !== null && leaf.articleId !== selectedId && !kindOf.has(leaf.articleId)}
                      homeLabel={leaf.alias ? `${categoryIcon(leaf.homeCategory)} ${categoryName(leaf.homeCategory)}` : undefined}
                      onToggle={() => setSelectedKey((k) => (k === leaf.key ? null : leaf.key))}
                      onOpen={onOpen}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface TreeLeafProps {
  leaf: WikiTreeLeaf;
  graph: WikiGraph;
  selected: boolean;
  isActive: boolean;
  kind?: WikiRelationKind;
  dimmed: boolean;
  homeLabel?: string;
  onToggle: () => void;
  onOpen: (id: string) => void;
}

function TreeLeaf({ leaf, graph, selected, isActive, kind, dimmed, homeLabel, onToggle, onOpen }: TreeLeafProps): JSX.Element {
  const out = graph.outgoing[leaf.articleId] ?? [];
  const inc = graph.incoming[leaf.articleId] ?? [];
  const count = new Set([...out, ...inc]).size;
  const titleClass = isActive
    ? 'text-white font-semibold'
    : kind
      ? RELATION_TEXT_CLASS[kind]
      : leaf.pending
        ? 'text-zinc-400'
        : 'text-zinc-200';

  return (
    <li className={`relative transition-opacity ${dimmed ? 'opacity-40' : ''}`}>
      {/* tree tick from the branch line */}
      <span aria-hidden className="absolute -left-2 top-[15px] w-2 border-t border-zinc-700" />
      <div className={`flex items-start gap-1.5 py-1 pl-1 pr-0.5 rounded ${isActive ? 'bg-yellow-500/10' : ''}`}>
        {leaf.readingStep !== undefined ? (
          <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full border border-amber-500/70 bg-amber-500/15 text-amber-200 text-[10px] font-bold flex items-center justify-center tabular-nums">
            {leaf.readingStep}
          </span>
        ) : (
          <span
            aria-hidden
            className={`shrink-0 mt-[9px] mx-[6px] w-2 h-2 rounded-full ${leaf.guide ? 'bg-yellow-400' : leaf.pending ? 'border border-dashed border-zinc-500' : 'bg-zinc-500'}`}
          />
        )}
        <button
          type="button"
          onClick={() => onOpen(leaf.articleId)}
          className={`flex-1 min-w-0 text-left text-sm leading-snug break-words hover:underline ${titleClass}`}
        >
          {leaf.title}
          {homeLabel && <span className="ml-1 text-[10px] text-zinc-500 whitespace-nowrap">→ {homeLabel}</span>}
          {leaf.pending && (
            <span className="ml-1 text-[10px] text-amber-300/80 border border-amber-500/40 rounded px-1 whitespace-nowrap">待完成</span>
          )}
        </button>
        {count > 0 && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={selected}
            aria-label={`${leaf.title} 的相關文章（${count}）`}
            className={`shrink-0 inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[11px] tabular-nums transition-colors ${
              selected ? 'border-yellow-400 bg-yellow-500 text-black' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
            }`}
          >
            <Link2 size={12} />
            {count}
          </button>
        )}
      </div>
      {selected && (
        <div className="ml-6 mb-1.5 mt-0.5 space-y-1.5" data-testid="wiki-mindmap-related">
          <RelatedChips title={RELATION_LABEL.out} ids={out} kindOfId={(id) => (inc.includes(id) ? 'both' : 'out')} graph={graph} onOpen={onOpen} />
          <RelatedChips title={RELATION_LABEL.in} ids={inc} kindOfId={(id) => (out.includes(id) ? 'both' : 'in')} graph={graph} onOpen={onOpen} />
        </div>
      )}
    </li>
  );
}

function RelatedChips({
  title,
  ids,
  kindOfId,
  graph,
  onOpen,
}: {
  title: string;
  ids: string[];
  kindOfId: (id: string) => WikiRelationKind;
  graph: WikiGraph;
  onOpen: (id: string) => void;
}): JSX.Element | null {
  if (ids.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] text-zinc-500 mb-0.5">
        {title}（{ids.length}）
      </div>
      <div className="flex flex-wrap gap-1">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onOpen(id)}
            className={`max-w-full text-left break-words rounded border px-1.5 py-0.5 text-[11px] leading-snug transition-colors ${RELATION_CHIP_CLASS[kindOfId(id)]}`}
          >
            {graph.articles[id]?.title ?? id}
          </button>
        ))}
      </div>
    </div>
  );
}
