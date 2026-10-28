import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, Loader, Table2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  SectionTabs, StatTable, Term, useSectionTab,
  OUTCOME_COLORS, OUTCOME_LABEL_KEYS, OUTCOME_ORDER, formatInt, formatRate,
  type SectionTabItem, type StatColumn, type Tone,
} from '../ui';
import type { AnalysisOverview, OutcomeCounts } from '../../../services/api';
import { useAnalysisPlayerRows } from '../seatRoleBlocks';
import {
  hasRawOutcomes, playerOutcomeShares, sumRawOutcomes,
  type PlayerOutcomeShares, type ShareOutcome, type WinPart,
} from './playerOutcomeShares';

/**
 * 三種結果與場次排行 (Edward 2026-10-28：「我希望能用比例的方式呈現 那三種結果下 再切分贏的跟輸的…
 * 感覺表格+比例圖比較直觀 可以每列有幾條? 一條呈現遊戲結果比例 一條呈現任務輸贏 一條呈現刺殺輸贏 一條呈現最終輸贏」)。
 *
 * 取代 2026-10-14 的「大圓餅 + 十個小圓餅」。設計決定：
 *  - 一列一位玩家、一列四條，四條排成四欄 (遊戲結果 | 任務 | 刺殺 | 最終)：同一欄上下對齊，比較兩位玩家
 *    只要往下看同一欄；一列只佔一行高，前 10 名加全體在桌機左半邊一屏放得下。
 *  - 遊戲結果：三紅 | 三藍死 | 三藍活 (結果顏色)，每段再切成他贏的 (實色) 和輸的 (斜線淡色) —— 比例中的比例；
 *    實色加起來就是最終勝率。上面一行小字是三段各佔幾成。
 *  - 任務 / 刺殺 / 最終：同一套「實色 = 贏、斜線淡色 = 輸」(綠色，不跟陣營色混)，數字 = 贏的比例；
 *    刺殺只算三藍局，桌機附 n。圖例只在最上面放一次。
 *  - 全部從玩家自己那一方看 (playerOutcomeShares)。滑鼠移到 (手機點) 任何一段顯示場數與 %。
 *  - 第一列「全體玩家」= 所有玩家每場各算一次 (平均一位玩家的基準，跟下面每一列同一套算法、可以直接比)；
 *    整體三種結果 (以「局」為單位) 放在圖例那一行。
 *  - 前 10 / 20 / 全部可切 (多的在框內捲，不拉長頁面)；「表格」看同樣的數字。
 *  - 資料：/api/analysis/players 的原始計數 (useAnalysisPlayerRows)，篩選時瀏覽器重算，跟著篩選變。
 */

type View = 'bars' | 'table';
type TopN = '10' | '20' | 'all';

interface ShareRow {
  key: string;
  name: string;
  overall: boolean;
  shares: PlayerOutcomeShares | null;
}

/** 贏輸的顏色：綠色 (不跟紅藍陣營、琥珀刺中混)。 */
const WIN_COLOR = '#10b981';
const OUTCOME_TONE: Record<ShareOutcome, Tone> = { 三紅: 'red', 三藍死: 'amber', 三藍活: 'blue' };
/** i18n 鍵 (analytics.r7.mix.side.*)。 */
const OUTCOME_KEY: Record<ShareOutcome, string> = { 三紅: 'threeRed', 三藍死: 'threeBlueDead', 三藍活: 'threeBlueAlive' };

/** 輸 = 同色系斜線淡色 (色盲也分得出實色／斜線)。 */
function lostStyle(hex: string): CSSProperties {
  return { backgroundImage: `repeating-linear-gradient(135deg, ${hex}80 0 2px, ${hex}2e 2px 5px)` };
}

function pctOf(part: number, total: number): string {
  return formatRate(total > 0 ? (part / total) * 100 : null);
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// ── 滑鼠移上去／點一下的小提示 (整塊共用一個，畫在 body，不被捲動容器切掉) ─────────────────

interface Tip { text: string; left: number; top: number }

function useSegmentTip(): {
  tip: Tip | null;
  handlers: {
    onPointerOver: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: (e: PointerEvent<HTMLElement>) => void;
    onClick: (e: MouseEvent<HTMLElement>) => void;
  };
} {
  const [tip, setTip] = useState<Tip | null>(null);
  const pinned = useRef(false);
  const show = useCallback((el: HTMLElement | null): boolean => {
    const seg = el?.closest<HTMLElement>('[data-tip]');
    if (!seg) return false;
    const r = seg.getBoundingClientRect();
    const width = 240;
    setTip({
      text: seg.dataset.tip ?? '',
      left: Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8)),
      top: r.bottom + 6,
    });
    return true;
  }, []);
  useEffect(() => {
    if (!tip) return undefined;
    const hide = (): void => { pinned.current = false; setTip(null); };
    const onDown = (e: globalThis.PointerEvent): void => {
      if (!(e.target as HTMLElement | null)?.closest?.('[data-tip]')) hide();
    };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('pointerdown', onDown);
    return (): void => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [tip]);
  return {
    tip,
    handlers: {
      onPointerOver: (e): void => { if (e.pointerType === 'mouse' && !pinned.current) show(e.target as HTMLElement); },
      onPointerLeave: (e): void => { if (e.pointerType === 'mouse' && !pinned.current) setTip(null); },
      onClick: (e): void => { pinned.current = show(e.target as HTMLElement); if (!pinned.current) setTip(null); },
    },
  };
}

function TipBubble({ tip }: { tip: Tip | null }): JSX.Element | null {
  if (!tip) return null;
  return createPortal(
    <div
      role="tooltip"
      style={{ left: tip.left, top: tip.top, width: 240 }}
      className="pointer-events-none fixed z-[100] rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] leading-snug text-zinc-200 shadow-xl"
    >
      {tip.text}
    </div>,
    document.body,
  );
}

// ── 一列的四條 ─────────────────────────────────────────────────────────────────

function OutcomeMixBar({ row }: { row: ShareRow }): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.r7.mix';
  const s = row.shares;
  if (!s || s.games === 0) return <span className="text-zinc-600">—</span>;
  const tips: string[] = [];
  const segments = OUTCOME_ORDER.flatMap((o) => {
    const { won, lost } = s.outcomes[o];
    const label = t(OUTCOME_LABEL_KEYS[o]);
    const wonTip = t(`${k}.tipWon`, { name: row.name, outcome: label, side: t(`${k}.side.${OUTCOME_KEY[o]}.won`), games: formatInt(won), pct: pctOf(won, s.games) });
    const lostTip = t(`${k}.tipLost`, { name: row.name, outcome: label, side: t(`${k}.side.${OUTCOME_KEY[o]}.lost`), games: formatInt(lost), pct: pctOf(lost, s.games) });
    tips.push(wonTip, lostTip);
    return [
      won > 0 && <span key={`${o}-w`} data-tip={wonTip} className="h-full cursor-help" style={{ flexGrow: won, flexBasis: 0, backgroundColor: OUTCOME_COLORS[o] }} />,
      lost > 0 && <span key={`${o}-l`} data-tip={lostTip} className="h-full cursor-help" style={{ flexGrow: lost, flexBasis: 0, ...lostStyle(OUTCOME_COLORS[o]) }} />,
    ].filter(Boolean);
  });
  return (
    <div className="min-w-0">
      <div className="flex gap-1.5 text-[10px] leading-tight tabular-nums">
        {OUTCOME_ORDER.map(o => {
          const total = s.outcomes[o].won + s.outcomes[o].lost;
          return (
            <span key={o} style={{ color: OUTCOME_COLORS[o] }}>
              {Math.round((total / s.games) * 100)}%
            </span>
          );
        })}
      </div>
      <div role="img" aria-label={tips.join('；')} className="mt-0.5 flex h-2.5 w-full gap-px overflow-hidden rounded-sm bg-zinc-950">
        {segments}
      </div>
    </div>
  );
}

function WinBar({ row, part, kind }: { row: ShareRow; part: WinPart | undefined; kind: 'mission' | 'assassination' | 'final' }): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.r7.mix';
  if (!part || part.n === 0 || part.rate === null) return <span className="text-zinc-600">—</span>;
  const lose = part.n - part.win;
  const unit = t(kind === 'assassination' ? `${k}.unitThreeBlue` : `${k}.unitGames`);
  const winTip = t(`${k}.tipWin.${kind}`, { name: row.name, win: formatInt(part.win), n: formatInt(part.n), unit, pct: formatRate(part.rate) });
  const loseTip = t(`${k}.tipLose.${kind}`, { name: row.name, win: formatInt(lose), n: formatInt(part.n), unit, pct: pctOf(lose, part.n) });
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-end gap-1 text-[11px] leading-tight tabular-nums text-zinc-200">
        <span className={row.overall ? 'font-semibold' : ''}>{formatRate(part.rate)}</span>
        {kind === 'assassination' && (
          <span className="hidden text-[9px] text-zinc-500 sm:inline">{t('analytics.ui.table.n', { n: formatInt(part.n) })}</span>
        )}
      </div>
      <div role="img" aria-label={`${winTip}；${loseTip}`} className="mt-0.5 flex h-2.5 w-full gap-px overflow-hidden rounded-sm bg-zinc-950">
        {part.win > 0 && <span data-tip={winTip} className="h-full cursor-help" style={{ flexGrow: part.win, flexBasis: 0, backgroundColor: WIN_COLOR }} />}
        {lose > 0 && <span data-tip={loseTip} className="h-full cursor-help" style={{ flexGrow: lose, flexBasis: 0, ...lostStyle(WIN_COLOR) }} />}
      </div>
    </div>
  );
}

/** 玩家 | 遊戲結果 | 任務 | 刺殺 | 最終；桌機的刺殺欄寬一點 (多放 n)，手機省略 n。 */
const GRID = 'grid grid-cols-[minmax(3.5rem,5rem)_minmax(4.5rem,1.4fr)_repeat(3,minmax(2.75rem,1fr))] sm:grid-cols-[minmax(3.75rem,5rem)_minmax(5rem,2fr)_minmax(2.9rem,1fr)_minmax(4.25rem,1.3fr)_minmax(2.9rem,1fr)] items-end gap-x-2';

function ShareBars({ rows }: { rows: ShareRow[] }): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.r7.mix';
  const { tip, handlers } = useSegmentTip();
  return (
    <div className="max-w-full overflow-x-auto overscroll-x-contain">
      <div className="min-w-[17.5rem]">
        <div className={`${GRID} border-b border-zinc-800 px-2 pb-1 text-[10px] font-semibold text-zinc-500`}>
          <span>{t(`${k}.colPlayer`)}</span>
          <span><Term term="outcomeMix">{t(`${k}.colMix`)}</Term></span>
          <span className="text-right"><Term term="missionWinRate">{t(`${k}.colMission`)}</Term></span>
          <span className="text-right"><Term term="assassinWinRate">{t(`${k}.colAssassination`)}</Term></span>
          <span className="text-right"><Term term="finalWinRate">{t(`${k}.colFinal`)}</Term></span>
        </div>
        <ol className="max-h-[23.5rem] overflow-y-auto overscroll-contain" {...handlers}>
          {rows.map(row => (
            <li
              key={row.key}
              className={`${GRID} border-b border-zinc-900 px-2 py-0.5 ${row.overall ? 'sticky top-0 z-10 bg-zinc-800' : 'odd:bg-zinc-950 even:bg-zinc-900/60'}`}
            >
              <div className="min-w-0 self-center leading-tight">
                <p className={`truncate text-[12px] font-semibold leading-[14px] ${row.overall ? 'text-amber-200' : 'text-zinc-100'}`} title={row.name}>{row.name}</p>
                <p className="truncate text-[10px] leading-3 text-zinc-500 tabular-nums">
                  {row.overall ? t(`${k}.overallSub`) : row.shares ? t('analytics.ui.donut.games', { value: formatInt(row.shares.games) }) : '—'}
                </p>
              </div>
              <OutcomeMixBar row={row} />
              <WinBar row={row} part={row.shares?.mission} kind="mission" />
              <WinBar row={row} part={row.shares?.assassination} kind="assassination" />
              <WinBar row={row} part={row.shares?.final} kind="final" />
            </li>
          ))}
        </ol>
      </div>
      <TipBubble tip={tip} />
    </div>
  );
}

function ShareTable({ rows }: { rows: ShareRow[] }): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.r7.mix';
  const outcomeShare = (row: ShareRow, o: ShareOutcome): number | null => {
    const s = row.shares;
    return s && s.games > 0 ? ((s.outcomes[o].won + s.outcomes[o].lost) / s.games) * 100 : null;
  };
  const columns: StatColumn<ShareRow>[] = [
    { key: 'name', label: t('analytics.boards.col.name'), format: (_v, row) => <span className={row.overall ? 'text-amber-200' : ''}>{row.name}</span> },
    { key: 'games', label: t('analytics.deep.overview.gamesColumn'), format: 'int', value: row => row.shares?.games ?? null, className: 'text-zinc-400' },
    ...OUTCOME_ORDER.map((o): StatColumn<ShareRow> => ({
      key: o,
      label: t(OUTCOME_LABEL_KEYS[o]),
      format: 'pct',
      value: row => outcomeShare(row, o),
      tone: OUTCOME_TONE[o],
      className: 'hidden sm:table-cell',
    })),
    { key: 'mission', label: t(`${k}.colMission`), term: 'missionWinRate', format: 'pct', value: row => row.shares?.mission.rate ?? null },
    {
      key: 'assassination', label: t(`${k}.colAssassination`), term: 'assassinWinRate', format: 'pct',
      value: row => row.shares?.assassination.rate ?? null, n: row => row.shares?.assassination.n ?? null,
    },
    { key: 'final', label: t(`${k}.colFinal`), term: 'finalWinRate', format: 'pct', value: row => row.shares?.final.rate ?? null, emphasis: true },
  ];
  return (
    <StatTable
      columns={columns}
      rows={rows}
      rowKey={row => row.key}
      highlightRow={row => row.overall}
      maxHeight="25rem"
      footnote={t(`${k}.tableNote`)}
    />
  );
}

/** 圖例 (只放一次)：整體三種結果 (以局為單位，跟著篩選) + 「實色 = 贏、斜線淡色 = 輸」。 */
function Legend({ overall }: { overall: OutcomeCounts }): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.r7.mix';
  const total = OUTCOME_ORDER.reduce((sum, o) => sum + overall[o], 0);
  return (
    <div className="mb-2 space-y-1 text-[11px] leading-snug text-zinc-400">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums">
        <span className="text-zinc-500">{t(`${k}.allGames`, { value: formatInt(total) })}</span>
        {OUTCOME_ORDER.map(o => (
          <span key={o} className="inline-flex items-center gap-1" title={t('analytics.ui.donut.games', { value: formatInt(overall[o]) })}>
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: OUTCOME_COLORS[o] }} />
            <span style={{ color: OUTCOME_COLORS[o] }}>{t(OUTCOME_LABEL_KEYS[o])}</span>
            <span className="text-zinc-300">{pctOf(overall[o], total)}</span>
          </span>
        ))}
      </p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: WIN_COLOR }} />
          <span aria-hidden className="-ml-0.5 inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: OUTCOME_COLORS.三紅 }} />
          {t(`${k}.legendWon`)}
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={lostStyle(WIN_COLOR)} />
          <span aria-hidden className="-ml-0.5 inline-block h-2.5 w-2.5 rounded-sm" style={lostStyle(OUTCOME_COLORS.三紅)} />
          {t(`${k}.legendLost`)}
        </span>
        <span className="text-zinc-500">{t(`${k}.legendSide`)}</span>
      </p>
    </div>
  );
}

export default function OutcomeGamesBlock({ overview }: { overview: AnalysisOverview }): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.r7.mix';
  const titleId = useId();
  const { players, loading, error } = useAnalysisPlayerRows();

  const viewItems: SectionTabItem<View>[] = [
    { id: 'bars', label: t(`${k}.viewBars`), icon: BarChart3 },
    { id: 'table', label: t('analytics.r6.overview.outcomes.viewTable'), icon: Table2 },
  ];
  const nItems: SectionTabItem<TopN>[] = [
    { id: '10', label: t(`${k}.top`, { count: 10 }) },
    { id: '20', label: t(`${k}.top`, { count: 20 }) },
    { id: 'all', label: t(`${k}.all`) },
  ];
  const [view, setView] = useSectionTab(viewItems, { persistKey: 'analysis.overview.outcomes.v2' });
  const [topN, setTopN] = useSectionTab(nItems, { persistKey: 'analysis.overview.outcomes.n' });

  const ob = overview.outcomeBreakdown;
  const overall: OutcomeCounts = {
    三紅: isCount(ob?.threeRed) ? ob.threeRed : 0,
    三藍死: isCount(ob?.threeBlueDead) ? ob.threeBlueDead : 0,
    三藍活: isCount(ob?.threeBlueAlive) ? ob.threeBlueAlive : 0,
  };

  const { rows, pending } = useMemo(() => {
    const list = players ?? [];
    const pooled = sumRawOutcomes(list);
    const ranked = list
      .filter(p => p && typeof p.name === 'string')
      .map(p => ({ name: p.name, shares: hasRawOutcomes(p) ? playerOutcomeShares(p) : null, games: p.totalGames }))
      .map(p => ({ ...p, games: p.shares?.games ?? (isCount(p.games) ? p.games : 0) }))
      .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
    const limit = topN === 'all' ? ranked.length : Number(topN ?? 10);
    const out: ShareRow[] = [
      { key: '__overall__', name: t(`${k}.overall`), overall: true, shares: pooled ? playerOutcomeShares(pooled) : null },
      ...ranked.slice(0, limit).map(p => ({ key: p.name, name: p.name, overall: false, shares: p.shares })),
    ];
    return { rows: out, pending: list.length > 0 && !pooled };
  }, [players, topN, t]);

  return (
    <section aria-labelledby={titleId} className="h-full min-w-0 rounded-xl border border-gray-700 bg-avalon-card/30 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 id={titleId} className="text-sm font-bold text-zinc-300">
          {t('analytics.r6.overview.outcomes.title')}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <SectionTabs items={nItems} value={topN} onChange={setTopN} ariaLabel={t(`${k}.nLabel`)} />
          <SectionTabs items={viewItems} value={view} onChange={setView} ariaLabel={t('analytics.r6.overview.outcomes.viewLabel')} />
        </div>
      </div>
      <Legend overall={overall} />
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-zinc-500">
          <Loader size={14} className="animate-spin" /> {t('analytics.deep.loading')}
        </div>
      ) : error ? (
        <p className="py-6 text-center text-xs text-red-400">{error}</p>
      ) : view === 'table' ? (
        <ShareTable rows={rows} />
      ) : (
        <>
          <ShareBars rows={rows} />
          <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">
            {pending ? t('analytics.r6.overview.outcomes.playersPending') : t(`${k}.note`)}
          </p>
        </>
      )}
    </section>
  );
}
