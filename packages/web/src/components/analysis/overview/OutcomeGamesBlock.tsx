import { useId } from 'react';
import { PieChart as PieIcon, Table2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Donut, SectionTabs, StatTable, useSectionTab,
  OUTCOME_LABEL_KEYS, OUTCOME_ORDER, formatInt, formatRate, outcomeTotal,
  type OutcomeKey, type SectionTabItem, type StatColumn, type Tone,
} from '../ui';
import type { AnalysisOverview, OutcomeCounts } from '../../../services/api';

/**
 * 三種結果 × 場次排行 (2026-10-14 Edward：「三種結果 & 場次排行是不是可以結合？變成大圓餅的小圓餅」)。
 *
 *  - 圓餅：大圓 = 全體三種結果 (圖例附場數與 %)；下面十個小圓 = 場次前 10 名，各自全部場次 (不分陣營) 的
 *    三種結果，圓心 = 場數、下面 = 名字。這裡留圖不改表格，因為「每個人的組成跟全體比起來偏哪邊」一眼看
 *    十個圓的顏色比例最快；同樣的數字在「表格」切換裡。
 *  - 表格：全體 + 前 10 名，每列 場次、三紅、三藍死、三藍活 (% = 占這一列全部場次，括號 = 場數)。
 *  - schemaVersion 3 的快取沒有 topPlayersByGames[].outcomes：圓餅改列名字 + 場數，表格的三種結果顯示「—」，
 *    並註明下次每日更新後提供 (不畫成 0%)。
 */

type View = 'donut' | 'table';

interface PlayerGames {
  name: string;
  games: number;
  outcomes: OutcomeCounts | null;
}

interface OutcomeRow {
  key: string;
  name: string;
  games: number;
  counts: OutcomeCounts | null;
  overall: boolean;
}

/** 三種結果的欄位顏色 (同 OUTCOME_COLORS：三紅 紅、三藍死 琥珀、三藍活 藍)。 */
const OUTCOME_TONE: Record<OutcomeKey, Tone> = { 三紅: 'red', 三藍死: 'amber', 三藍活: 'blue' };

/** 小圓的格子：一列最多 5 格 (每格 ≥ 19%)，每格至少 4rem (= 小圓 64px)；太窄就少放幾格、換行，不會重疊。 */
const SMALL_GRID = 'grid-cols-[repeat(auto-fill,minmax(max(4rem,19%),1fr))]';

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** 快取列的 outcomes 三個鍵都是數字才算有 (舊快取沒有 → null，不當成 0 場)。 */
function validOutcomes(o: Partial<OutcomeCounts> | null | undefined): OutcomeCounts | null {
  if (!o || typeof o !== 'object') return null;
  return OUTCOME_ORDER.every(k => isCount(o[k])) ? { 三紅: o.三紅 as number, 三藍死: o.三藍死 as number, 三藍活: o.三藍活 as number } : null;
}

function share(counts: OutcomeCounts | null, key: OutcomeKey): number | null {
  const total = outcomeTotal(counts);
  return counts && total > 0 ? (counts[key] / total) * 100 : null;
}

function OutcomeTable({ rows, pending }: { rows: OutcomeRow[]; pending: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const columns: StatColumn<OutcomeRow>[] = [
    { key: 'name', label: t('analytics.boards.col.name') },
    { key: 'games', label: t('analytics.deep.overview.gamesColumn'), format: 'int' },
    ...OUTCOME_ORDER.map((key): StatColumn<OutcomeRow> => ({
      key,
      label: t(OUTCOME_LABEL_KEYS[key]),
      value: row => share(row.counts, key),
      format: (v, row) => (
        <>
          {formatRate(v)}
          {/* 手機上省略場數 (分母在「場次」欄)，表格才放得下不必橫捲 */}
          {row.counts && <span className="ml-1 hidden text-[10px] font-normal text-zinc-500 sm:inline">({formatInt(row.counts[key])})</span>}
        </>
      ),
      align: 'right',
      tone: OUTCOME_TONE[key],
      bar: { max: 100 },
    })),
  ];
  return (
    <StatTable
      columns={columns}
      rows={rows}
      rowKey={row => row.key}
      highlightRow={row => row.overall}
      // 舊快取每人三種結果都是「—」，只留「下次每日更新後提供」一行 (說明 % 的那行用不到)。
      footnote={pending ? t('analytics.r6.overview.outcomes.playersPending') : t('analytics.r6.overview.outcomes.tableNote')}
    />
  );
}

function DonutView({ overall, players }: { overall: OutcomeCounts; players: PlayerGames[] }): JSX.Element {
  const { t } = useTranslation('common');
  const withOutcomes = players.length > 0 && players.every(p => p.outcomes !== null);
  const note = withOutcomes
    ? t('analytics.r6.overview.outcomes.topPlayers', { count: players.length })
    : t('analytics.r6.overview.outcomes.topPlayersGames', { count: players.length });
  return (
    <div>
      {/* 第一列：大圓 + 圖例，旁邊的空位放小圓的說明 (放不下就換到下一行) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Donut counts={overall} size="lg" />
        {players.length > 0 && <p className="min-w-[6rem] flex-1 text-[10px] leading-snug text-zinc-500">{note}</p>}
      </div>
      {/* 第二列：場次前 10 名，一列最多 5 個 */}
      {withOutcomes ? (
        <ol className={`mt-2 grid ${SMALL_GRID} gap-y-1.5`}>
          {players.map(p => (
            <li key={p.name} className="flex min-w-0 justify-center">
              <Donut
                size="sm"
                counts={p.outcomes}
                caption={p.name}
                title={t('analytics.r6.overview.outcomes.playerDonut', { name: p.name, games: formatInt(p.games) })}
              />
            </li>
          ))}
        </ol>
      ) : (
        <>
          <ol className={`mt-2 grid ${SMALL_GRID} gap-1`}>
            {players.map((p, i) => (
              <li key={p.name} className="min-w-0 rounded-md border border-zinc-800 bg-zinc-950 px-1 py-1 text-center">
                <p className="truncate text-[11px] font-semibold text-zinc-200">
                  <span className="mr-0.5 font-normal text-zinc-500 tabular-nums">{i + 1}</span>
                  {p.name}
                </p>
                <p className="text-[10px] text-zinc-500 tabular-nums">
                  {t('analytics.ui.donut.games', { value: formatInt(p.games) })}
                </p>
              </li>
            ))}
          </ol>
          {players.length > 0 && (
            <p className="mt-1.5 text-[10px] text-zinc-500">{t('analytics.r6.overview.outcomes.playersPending')}</p>
          )}
        </>
      )}
    </div>
  );
}

export default function OutcomeGamesBlock({ overview }: { overview: AnalysisOverview }): JSX.Element {
  const { t } = useTranslation('common');
  const titleId = useId();
  const items: SectionTabItem<View>[] = [
    { id: 'donut', label: t('analytics.r6.overview.outcomes.viewDonut'), icon: PieIcon },
    { id: 'table', label: t('analytics.r6.overview.outcomes.viewTable'), icon: Table2 },
  ];
  const [view, setView] = useSectionTab(items, { persistKey: 'analysis.overview.outcomes' });

  const ob = overview.outcomeBreakdown;
  const overall: OutcomeCounts = {
    三紅: isCount(ob?.threeRed) ? ob.threeRed : 0,
    三藍死: isCount(ob?.threeBlueDead) ? ob.threeBlueDead : 0,
    三藍活: isCount(ob?.threeBlueAlive) ? ob.threeBlueAlive : 0,
  };
  const players: PlayerGames[] = (overview.topPlayersByGames ?? [])
    .filter(p => p && typeof p.name === 'string' && isCount(p.games))
    .slice(0, 10)
    .map(p => ({ name: p.name, games: p.games, outcomes: validOutcomes(p.outcomes) }));
  const pending = players.some(p => p.outcomes === null);
  const rows: OutcomeRow[] = [
    { key: '__overall__', name: t('analytics.r6.overview.outcomes.overall'), games: outcomeTotal(overall), counts: overall, overall: true },
    ...players.map(p => ({ key: p.name, name: p.name, games: p.games, counts: p.outcomes, overall: false })),
  ];

  return (
    <section aria-labelledby={titleId} className="h-full min-w-0 rounded-xl border border-gray-700 bg-avalon-card/30 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 id={titleId} className="text-sm font-bold text-zinc-300">
          {t('analytics.r6.overview.outcomes.title')}
        </h3>
        <SectionTabs
          items={items}
          value={view}
          onChange={setView}
          ariaLabel={t('analytics.r6.overview.outcomes.viewLabel')}
        />
      </div>
      {view === 'table' ? <OutcomeTable rows={rows} pending={pending} /> : <DonutView overall={overall} players={players} />}
    </section>
  );
}
