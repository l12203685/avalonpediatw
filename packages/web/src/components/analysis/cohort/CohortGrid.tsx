import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PLAYER_TIERS, TABLE_TIERS,
  type CohortCell, type CohortGrid as CohortGridData, type PlayerTierKey,
} from '@avalon/shared/stats';
import { InfoTip } from '../ui';
import { COHORT_MIN_N, K, SHADE_FULL, SHADE_PRIOR, cohortPct, cohortShade, playerTierKey, tableTierKey } from './cohortFormat';

/**
 * 九宮格（玩家分層 × 桌分層）的共用元件（Edward 2026-11-11：「每一個討論的情境，只要樣本太小就合併成組；或切成
 * S × PR =（強者／一般人／新手）×（高端／普通／歡樂）的九宮格」）。資料是 @avalon/shared cohortGrid 的結果，
 * 這裡只負責畫：一個指標（呼叫端給的 measures 之一，可以切換）在 3×3 格、右邊一欄依玩家分層合計、下面一列依桌分層合計、
 * 右下角全體；每格是比率（只四捨五入一次）＋樣本數＋人數，樣本不到 minN 的格變淡；3×3 格依「跟全體差幾個百分點」上色
 * （固定刻度、樣本少的先往全體收縮，見 cohortShade）。未評分的玩家／局不在格子裡，
 * 只算在合計與全體，下面一行寫出有多少。
 *
 * 之後新的統計要分組：在 shared 把事件變成 CohortRecord 丟給 cohortGrid，這裡給 measures（比率的分子、分母）就好。
 */

/** 一個指標：比率 = k ÷ n（n 也是格子上寫的樣本數）。 */
export interface CohortMeasure {
  id: string;
  label: string;
  ratio: (cell: CohortCell) => { k: number; n: number };
}

export interface CohortGridProps {
  grid: CohortGridData;
  measures: readonly CohortMeasure[];
  measure: string;
  onMeasure?: (id: string) => void;
  /** 標題（例：「九宮格：第 3 局 · 忠臣 · 合計」）。 */
  caption?: ReactNode;
  /** 說明（InfoTip 的內容）。 */
  help?: ReactNode;
  /** 樣本的單位（例：「次」「張」）。 */
  unit: string;
  minN?: number;
  /** 其他選單（放在指標選單旁邊）。 */
  controls?: ReactNode;
  /** 強調的列（例：玩家自己的組）。 */
  highlight?: PlayerTierKey | null;
  testId?: string;
}

function Cell({
  cell, measure, unit, minN, strong = false, shade = null,
}: {
  cell: CohortCell; measure: CohortMeasure; unit: string; minN: number; strong?: boolean; shade?: number | null;
}): JSX.Element {
  const { t } = useTranslation('common');
  const { k, n } = measure.ratio(cell);
  const low = n < minN;
  const title = [
    t(`${K}.cellTitle`, { k, n, unit, players: cell.players, games: cell.games, pct: cohortPct(k, n, 1) }),
    low && n > 0 ? t(`${K}.lowSample`, { min: minN, unit }) : null,
  ].filter(Boolean).join(' · ');
  return (
    <div
      className={`flex flex-col items-end justify-center rounded px-1.5 py-1 leading-tight tabular-nums ${low ? 'opacity-45' : ''}`}
      style={shade !== null && !low && shade !== 0
        ? { backgroundColor: shade > 0 ? `rgba(251, 191, 36, ${(0.3 * shade).toFixed(3)})` : `rgba(56, 189, 248, ${(-0.3 * shade).toFixed(3)})` }
        : undefined}
      title={title}
      data-n={n}
    >
      <span className={strong ? 'text-sm font-bold text-zinc-100' : 'text-sm font-semibold text-zinc-100'}>{cohortPct(k, n)}</span>
      <span className="text-[10px] text-zinc-400">{t(`${K}.cellN`, { n, unit })}</span>
      <span className="text-[10px] text-zinc-500">{t(`${K}.cellPlayers`, { count: cell.players })}</span>
    </div>
  );
}

export default function CohortGrid({
  grid, measures, measure, onMeasure, caption, help, unit, minN = COHORT_MIN_N, controls, highlight = null, testId = 'cohort-grid',
}: CohortGridProps): JSX.Element {
  const { t } = useTranslation('common');
  const m = measures.find((x) => x.id === measure) ?? measures[0];
  const all = m.ratio(grid.all);
  const shadeOf = (cell: CohortCell): number | null => cohortShade(m.ratio(cell), all, minN);
  const unratedPlayers = grid.rows.unrated;
  const unratedGames = grid.cols.unrated;
  const head = 'px-1.5 py-1 text-[11px] font-semibold text-zinc-400';

  return (
    <section className="space-y-1.5" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {caption && <h5 className="text-xs font-bold text-zinc-200">{caption}</h5>}
        {help && <InfoTip title={caption}>{help}</InfoTip>}
        {measures.length > 1 && (
          <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
            {t(`${K}.measure`)}
            <select
              className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-100"
              value={m.id}
              onChange={(e) => onMeasure?.(e.target.value)}
              data-testid={`${testId}-measure`}
            >
              {measures.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
        )}
        {controls}
      </div>
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[300px] max-w-xl gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-1 text-xs"
          style={{ gridTemplateColumns: 'minmax(3.5rem, auto) repeat(3, minmax(0, 1fr)) minmax(0, 1fr)' }}
          role="table"
          aria-label={typeof caption === 'string' ? caption : t(`${K}.gridLabel`)}
        >
          <div className={head} role="columnheader">
            <span className="text-[10px] font-normal text-zinc-500">{t(`${K}.axis`)}</span>
          </div>
          {TABLE_TIERS.map((tt) => (
            <div key={tt} className={`${head} text-right`} role="columnheader" title={t(`${K}.tableRange.${tt}`, { hi: grid.cuts.sHi, lo: grid.cuts.sLo })}>
              <div>{t(tableTierKey(tt))}</div>
              <div className="text-[10px] font-normal text-zinc-500">{t(`${K}.tableRange.${tt}`, { hi: grid.cuts.sHi, lo: grid.cuts.sLo })}</div>
            </div>
          ))}
          <div className={`${head} text-right text-amber-200/90`} role="columnheader">{t(`${K}.rowTotal`)}</div>
          {PLAYER_TIERS.map((p) => (
            <div key={p} className="contents" role="row">
              <div
                className={`flex flex-col justify-center px-1.5 py-1 text-[11px] font-semibold ${highlight === p ? 'text-amber-300' : 'text-zinc-300'}`}
                role="rowheader"
                title={t(`${K}.playerRange.${p}`, { hi: grid.cuts.prHi, lo: grid.cuts.prLo, top: grid.cuts.prHi - 1 })}
              >
                <span>{t(playerTierKey(p))}{highlight === p ? ` ${t(`${K}.mine`)}` : ''}</span>
                <span className="text-[10px] font-normal text-zinc-500">{t(`${K}.playerRange.${p}`, { hi: grid.cuts.prHi, lo: grid.cuts.prLo, top: grid.cuts.prHi - 1 })}</span>
              </div>
              {TABLE_TIERS.map((tt) => (
                <Cell key={tt} cell={grid.cells[p][tt]} measure={m} unit={unit} minN={minN} shade={shadeOf(grid.cells[p][tt])} />
              ))}
              <div className="border-l border-zinc-800">
                <Cell cell={grid.rows[p]} measure={m} unit={unit} minN={minN} strong />
              </div>
            </div>
          ))}
          <div className="flex items-center px-1.5 py-1 text-[11px] font-semibold text-amber-200/90" role="rowheader">{t(`${K}.colTotal`)}</div>
          {TABLE_TIERS.map((tt) => (
            <div key={tt} className="border-t border-zinc-800">
              <Cell cell={grid.cols[tt]} measure={m} unit={unit} minN={minN} strong />
            </div>
          ))}
          <div className="border-l border-t border-zinc-800 bg-zinc-900/80" data-testid={`${testId}-all`}>
            <Cell cell={grid.all} measure={m} unit={unit} minN={minN} strong />
          </div>
        </div>
      </div>
      <p className="text-[11px] text-zinc-500" data-testid={`${testId}-shade`}>
        {t(`${K}.shadeNote`, { full: Math.round(SHADE_FULL * 100), prior: SHADE_PRIOR, unit })}
      </p>
      <p className="text-[11px] text-zinc-500" data-testid={`${testId}-unrated`}>
        {t(`${K}.unratedNote`, { pn: m.ratio(unratedPlayers).n, gn: m.ratio(unratedGames).n, unit })}
      </p>
    </section>
  );
}
