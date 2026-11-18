import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Check, Link2, Search, X } from 'lucide-react';
import {
  CONCEPT_PHASES,
  CONCEPT_ROLE_TAGS,
  EMPTY_CONCEPT_FILTER,
  conceptAnchorId,
  conceptPhase,
  conceptsHash,
  evidenceLabel,
  filterConcepts,
  groupConceptsByPhase,
  roundLabel,
  type ConceptCard,
  type ConceptFilter,
  type ConceptPhase,
} from '../utils/concepts';
import { openWikiArticle } from './wikiLink';

/**
 * 百科觀念卡（2026-11-18，站長：「百科觀念卡 我希望能公開出去」）：百科攻略的第三個檢視（心智圖／列表／觀念卡）。
 * 每張卡三句（情境／觀念／應用）、證據標籤、文章那一節的連結；可以搜尋、照階段和角色篩選。
 * 階段（2026-11-18 站長：「派票總共80張 好像有點太多了 … 或是直接區分成 [第一局派隊] [第二局派隊] [第三~五局派隊] 這樣呢?」）：
 * 沒選階段時照階段分組列出，站長的三個派隊分組在最前面；角色（站長：「能力者的文章跟觀念好像完全沒看到?」）篩出講某個角色的卡。
 * #concepts=<id> 捲到那一張並標出來（每日小觀念的「觀念卡:」連結）。卡庫打包成獨立的 chunk（'@concepts-bundle'）。
 */

const EVIDENCE_STYLE: Record<string, string> = {
  邏輯: 'border-sky-500/60 text-sky-300',
  經驗: 'border-emerald-500/60 text-emerald-300',
  '判斷／待驗證': 'border-amber-500/60 text-amber-300',
  未標: 'border-gray-600 text-gray-400',
};

function CopyLink({ id }: { id: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        const url = `${window.location.origin}${window.location.pathname}${conceptsHash(id)}`;
        void navigator.clipboard?.writeText(url).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => undefined);
      }}
      className="inline-flex items-center gap-1 rounded-md border border-gray-600 px-2 py-1 text-[11px] text-gray-300 hover:border-yellow-400 hover:text-white"
      title="複製這張卡的連結"
    >
      {copied ? <Check size={12} /> : <Link2 size={12} />}
      {copied ? '已複製' : '連結'}
    </button>
  );
}

function Card({ card, highlighted }: { card: ConceptCard; highlighted: boolean }): JSX.Element {
  const ev = evidenceLabel(card.evidence);
  return (
    <article
      id={conceptAnchorId(card.id)}
      data-testid="concept-card"
      className={`scroll-mt-20 rounded-lg border-2 p-3 transition-colors bg-avalon-card/30 ${
        highlighted ? 'border-yellow-400 bg-avalon-card/60 shadow-lg shadow-yellow-500/10' : 'border-gray-600'
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0 text-[11px] leading-snug text-gray-400">
          <span className="text-gray-300">{card.article.title}</span>
          {card.article.section && <span> · {card.article.section.replace(/-/g, ' ')}</span>}
        </div>
        <span
          title={`證據：${ev.hint}`}
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${EVIDENCE_STYLE[ev.label] ?? EVIDENCE_STYLE.未標}`}
        >
          {ev.label}
        </span>
      </div>
      <dl className="space-y-1.5 text-sm leading-relaxed">
        {(['情境', '觀念', '應用'] as const).map((part) => (
          <div key={part} className="flex gap-2">
            <dt className={`shrink-0 font-bold ${part === '觀念' ? 'text-yellow-400' : 'text-gray-400'}`}>{part}</dt>
            <dd className={part === '觀念' ? 'text-white' : 'text-gray-200'}>{card[part]}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-gray-700 pt-2">
        <span className="rounded bg-gray-700/50 px-1.5 py-0.5 text-[10px] text-gray-200">{conceptPhase(card)}</span>
        {(card.tags.role ?? []).map((r) => (
          <span key={r} className="rounded border border-yellow-500/40 px-1.5 py-0.5 text-[10px] text-yellow-300">{r}</span>
        ))}
        {card.tags.round.filter((r) => r !== 'any' && r !== 'A').map((r) => (
          <span key={r} className="rounded bg-gray-700/30 px-1.5 py-0.5 text-[10px] text-gray-400">{roundLabel(r)}</span>
        ))}
        <span className="flex-1" />
        <CopyLink id={card.id} />
        <button
          type="button"
          onClick={() => openWikiArticle(card.article.slug, card.article.section)}
          className="inline-flex items-center gap-1 rounded-md bg-yellow-500 px-2 py-1 text-[11px] font-semibold text-black hover:bg-yellow-400"
        >
          <BookOpen size={12} />讀這一節
        </button>
      </div>
    </article>
  );
}

export default function ConceptCards({ targetId }: { targetId: string | null }): JSX.Element {
  const [cards, setCards] = useState<ConceptCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<ConceptFilter>(EMPTY_CONCEPT_FILTER);

  useEffect(() => {
    let cancelled = false;
    import('@concepts-bundle')
      .then((m) => { if (!cancelled) setCards(m.default.concepts); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return (): void => { cancelled = true; };
  }, []);

  // 連到某一張：清掉會把它藏起來的篩選，捲過去。
  useEffect(() => {
    if (!cards || !targetId) return;
    if (!cards.some((c) => c.id === targetId)) return;
    setFilter(EMPTY_CONCEPT_FILTER);
    const t = window.setTimeout(() => {
      document.getElementById(conceptAnchorId(targetId))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    return (): void => window.clearTimeout(t);
  }, [cards, targetId]);

  const shown = useMemo(() => (cards ? filterConcepts(cards, filter) : []), [cards, filter]);
  // 階段按鈕上的張數：其他篩選（搜尋、角色）照套，只是不限階段。
  const phaseCounts = useMemo(() => {
    const counts = new Map<ConceptPhase, number>();
    for (const c of cards ? filterConcepts(cards, { ...filter, phase: '' }) : []) counts.set(conceptPhase(c), (counts.get(conceptPhase(c)) ?? 0) + 1);
    return counts;
  }, [cards, filter]);
  const groups = useMemo(() => (filter.phase ? null : groupConceptsByPhase(shown)), [shown, filter.phase]);
  const chip = (active: boolean): string => `px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
    active ? 'bg-yellow-500 text-black shadow' : 'bg-avalon-card/50 text-gray-300 hover:bg-avalon-card border border-gray-600'
  }`;

  return (
    <div className="space-y-3" data-testid="concept-cards">
      <p className="text-xs leading-relaxed text-gray-400">
        每張卡把百科文章的一個觀念濃縮成三句：在什麼情境、觀念是什麼、怎麼用。右上角是文章在這句上標的證據類型；
        「讀這一節」打開完整文章。群組每天早上的「阿瓦隆百科小觀念」也從這裡出。
      </p>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="搜尋觀念卡..."
          value={filter.query}
          onChange={(e) => setFilter({ ...filter, query: e.target.value })}
          className="w-full rounded-lg border border-gray-600 bg-avalon-card/50 py-2 pl-9 pr-9 text-sm text-white placeholder-gray-400 transition-all focus:border-yellow-400 focus:outline-none"
        />
        {filter.query && (
          <button type="button" onClick={() => setFilter({ ...filter, query: '' })} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white" aria-label="清除搜尋">
            <X size={16} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="階段">
        <span className="mr-1 text-[11px] text-gray-500">階段</span>
        <button type="button" className={chip(!filter.phase)} onClick={() => setFilter({ ...filter, phase: '' })}>全部</button>
        {CONCEPT_PHASES.map((p) => (
          <button key={p} type="button" className={chip(filter.phase === p)} onClick={() => setFilter({ ...filter, phase: p })}>
            {p}<span className="ml-1 opacity-70">{phaseCounts.get(p) ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="角色">
        <span className="mr-1 text-[11px] text-gray-500">角色</span>
        <button type="button" className={chip(!filter.role)} onClick={() => setFilter({ ...filter, role: '' })}>全部</button>
        {CONCEPT_ROLE_TAGS.map((r) => (
          <button key={r} type="button" className={chip(filter.role === r)} onClick={() => setFilter({ ...filter, role: r })}>{r}</button>
        ))}
      </div>
      {failed && <p className="text-sm text-gray-400">觀念卡載入失敗，請重新整理。</p>}
      {!cards && !failed && <p className="text-sm text-gray-400">載入觀念卡中…</p>}
      {cards && (
        <p className="text-sm text-gray-400">
          共 <span className="font-bold text-yellow-400">{shown.length}</span> 張{shown.length !== cards.length ? `（全部 ${cards.length} 張）` : ''}
        </p>
      )}
      {cards && shown.length === 0 && (
        <div className="py-8 text-center">
          <p className="text-base text-gray-400">沒有符合的觀念卡</p>
          <p className="mt-1 text-xs text-gray-500">換個關鍵字，或把篩選改回「全部」</p>
        </div>
      )}
      {groups
        ? groups.map((g) => (
          <section key={g.phase} className="space-y-2" aria-label={g.phase}>
            <h3 className="border-b border-gray-700 pb-1 text-sm font-bold text-yellow-400">
              {g.phase}<span className="ml-2 text-xs font-normal text-gray-400">{g.cards.length} 張</span>
            </h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {g.cards.map((c) => <Card key={c.id} card={c} highlighted={c.id === targetId} />)}
            </div>
          </section>
        ))
        : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {shown.map((c) => <Card key={c.id} card={c} highlighted={c.id === targetId} />)}
          </div>
        )}
    </div>
  );
}
