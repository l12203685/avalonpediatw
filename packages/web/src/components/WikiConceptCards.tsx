import { useEffect, useMemo, useState } from 'react';
import { Lightbulb, CornerDownRight, Layers } from 'lucide-react';
import { conceptsHash, type ConceptCard } from '../utils/concepts';
import { articleConceptGroups, articleConceptAnchorId } from '../utils/conceptLinks';
import { openWikiArticle } from './wikiLink';

/**
 * 百科文章的「本篇觀念卡」（2026-11-18，站長：「全部的觀念卡應該要放主控台啊 並且跟百科網站的文章完全連動」；docs/CONCEPTS.md）：
 * 文末列出這篇文章的觀念卡（情境／觀念／應用），依章節在文章裡的順序分組；每張卡可以跳回原文那一節，或打開公開觀念卡頁的那一張
 * （#concepts=<id>，components/ConceptCards.tsx 捲到 concept-<id> 並標出來）。卡片內容和 Threads 知識卡、主控台是同一份 concepts.json，
 * 載入方式同觀念卡頁（'@concepts-bundle' 的獨立 chunk，第一次打開文章時才下載）。
 */

/** 觀念卡庫（第一次 active 時才下載）。 */
export function useConceptCards(active: boolean): ConceptCard[] {
  const [cards, setCards] = useState<ConceptCard[]>([]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    import('@concepts-bundle')
      .then((m) => {
        if (!cancelled) setCards(m.default.concepts);
      })
      .catch(() => undefined); // chunk failed to load: the article just shows no cards
    return (): void => {
      cancelled = true;
    };
  }, [active]);
  return cards;
}

/** 標題旁的小連結：捲到文末這一節的第一張卡。 */
export function ConceptSectionChip({ cards }: { cards: readonly ConceptCard[] }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => document.getElementById(articleConceptAnchorId(cards[0].id))?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
      className="ml-2 inline-flex items-center gap-0.5 align-middle rounded-full border border-yellow-500/40 bg-yellow-500/10 px-1.5 py-px text-[10px] font-normal leading-4 text-yellow-300 hover:bg-yellow-500/20"
      aria-label={`本節有 ${cards.length} 張觀念卡`}
      title="看本節的觀念卡"
    >
      <Lightbulb size={10} aria-hidden="true" />
      {cards.length}
    </button>
  );
}

const PARTS = ['情境', '觀念', '應用'] as const;

interface WikiConceptCardsProps {
  articleId: string;
  /** 文章的 Markdown（依章節排序、取章節標題用）。 */
  content: string;
  cards: readonly ConceptCard[];
}

export default function WikiConceptCards({ articleId, content, cards }: WikiConceptCardsProps): JSX.Element | null {
  const groups = useMemo(() => articleConceptGroups(cards, articleId, content), [cards, articleId, content]);
  const total = groups.reduce((n, g) => n + g.cards.length, 0);
  if (!total) return null;
  return (
    <section aria-labelledby="wiki-concepts-heading" className="mt-8 rounded-lg border border-yellow-500/30 bg-black/20">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700/50">
        <Lightbulb size={16} className="text-yellow-400 shrink-0" aria-hidden="true" />
        <h3 id="wiki-concepts-heading" className="text-sm font-bold text-white flex-1">
          本篇觀念卡
        </h3>
        <span className="text-[11px] text-gray-400">{total} 張</span>
        <a href={conceptsHash()} className="text-[11px] text-yellow-400 hover:text-yellow-300 underline underline-offset-2">
          全部觀念卡
        </a>
      </div>
      <div className="px-4 py-3 space-y-4">
        {groups.map((g) => (
          <div key={g.section ?? ''}>
            {g.section ? (
              <button
                type="button"
                onClick={() => openWikiArticle(articleId, g.section ?? undefined)}
                className="mb-2 inline-flex items-start gap-1 text-left text-xs text-sky-300 hover:text-sky-200"
                title="回到原文這一節"
              >
                <CornerDownRight size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                {g.heading ?? g.section}
              </button>
            ) : (
              <p className="mb-2 text-xs text-gray-400">整篇</p>
            )}
            <ul className="space-y-2">
              {g.cards.map((c) => (
                <li key={c.id} id={articleConceptAnchorId(c.id)} className="scroll-mt-20 rounded-md border border-gray-700 bg-avalon-card/60 px-3 py-2.5">
                  <dl className="space-y-1 text-[13px] leading-relaxed">
                    {PARTS.map((p) => (
                      <div key={p} className="flex gap-2">
                        <dt className={`shrink-0 font-semibold ${p === '觀念' ? 'text-yellow-300' : 'text-gray-400'}`}>{p}</dt>
                        <dd className={p === '觀念' ? 'text-white' : 'text-gray-200'}>{c[p]}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    {c.evidence && <span className="rounded border border-gray-600 px-1.5 text-gray-300">證據：{c.evidence}</span>}
                    <a href={conceptsHash(c.id)} className="inline-flex items-center gap-1 text-yellow-400 hover:text-yellow-300">
                      <Layers size={11} aria-hidden="true" />
                      觀念卡頁
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
