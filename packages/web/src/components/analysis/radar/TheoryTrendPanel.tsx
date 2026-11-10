import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader } from 'lucide-react';
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AnalysisApiError,
  fetchPlayerTheoryTrend,
  fmtTheoryPct,
  getErrorMessage,
  isAnalysisNotGenerated,
  isAnalysisRouteMissing,
  type PlayerTheoryTrendData,
} from '../../../services/api';
import { useMediaQuery } from '../overview/useMediaQuery';

/**
 * 玩家雷達 > Elo／理論走勢的第二張圖（Edward 2026-11-10「除了歷史ELO 走勢 可以也建立每個玩家的 角色 位置 整體
 * 理論勝率 的走勢圖嗎」）。
 *
 * 讀 /api/analysis/theory-trend/:name（generate_cache.py compute_theory_trend）：每個出賽日最後一局後，只用到那天為止
 * 的局（補值用的全體勝率也只到那天）算出的排行榜數字。三條線：角色理論、位置理論、整體理論；圖表套件同陣容強度的
 * 河流圖（recharts）。視窗還沒滿的點畫虛線（不省略，看得到新玩家的早期數字但不跟滿視窗混在一起）：
 *   角色理論 = 不是每個角色都有 K_r 場（第 6 欄 0）；位置理論 = 生涯 < positionGames 場；整體理論 = 生涯 < overallMinGames 場。
 * 最後出賽之後別人的局仍會移動全體勝率，所以最後一點到資料日期之間畫一段細虛線接到目前的值（同 Elo 走勢）。
 */

const COLORS = { role: '#0b94d6', position: '#cf7a05', overall: '#ec4899' } as const;
type Key = keyof typeof COLORS;
const KEYS: Key[] = ['role', 'position', 'overall'];

interface Row {
  t: number;
  date: string;
  games: number;
  current?: boolean;
  values: Record<Key, number>;
  full: Record<Key, boolean>;
  [line: string]: unknown;
}

const dayValue = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** 時間軸刻度：跨兩年以上標年份，不然標月份；最多約 maxTicks 個（同 Elo 走勢）。 */
function timeTicks(t0: number, t1: number, maxTicks: number): number[] {
  const a = new Date(t0);
  const b = new Date(t1);
  const years = b.getUTCFullYear() - a.getUTCFullYear();
  const out: number[] = [];
  if (years >= 2) {
    const step = Math.max(1, Math.ceil((years + 1) / maxTicks));
    for (let y = a.getUTCFullYear() + 1; y <= b.getUTCFullYear(); y += step) out.push(Date.UTC(y, 0, 1));
    return out;
  }
  const months = years * 12 + b.getUTCMonth() - a.getUTCMonth();
  const step = Math.max(1, Math.ceil((months + 1) / maxTicks));
  for (let m = 1; m <= months; m += step) out.push(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + m, 1));
  return out;
}

function fmtTick(t: number, years: boolean): string {
  const d = new Date(t);
  return years ? String(d.getUTCFullYear()) : `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`;
}

/**
 * 每個點拆成三種線段的值（recharts 一條 Line 只能一種樣式）：`${k}Full` 視窗已滿（實線）、`${k}Part` 視窗未滿（虛線，
 * 多帶第一個已滿的點讓兩段接起來）、`${k}Tail` 最後一點到目前的值（細虛線）。視窗只會越來越滿，所以每條線最多兩段。
 */
export function buildRows(data: PlayerTheoryTrendData): Row[] {
  const { positionGames, overallMinGames } = data.config;
  const rows: Row[] = data.series.map(([date, games, role, position, overall, roleFull]) => ({
    t: dayValue(date),
    date,
    games,
    values: { role, position, overall },
    full: { role: roleFull === 1, position: games >= positionGames, overall: games >= overallMinGames },
  }));
  rows.forEach((r, i) => {
    for (const k of KEYS) {
      const v = r.values[k];
      r[`${k}Full`] = r.full[k] ? v : null;
      r[`${k}Part`] = !r.full[k] || (i > 0 && !rows[i - 1].full[k]) ? v : null;
    }
  });
  const last = rows[rows.length - 1];
  const cur = data.current;
  if (last && cur && data.dataThrough && data.dataThrough > last.date) {
    const values = { role: cur.roleTheory, position: cur.positionTheory, overall: cur.overallTheory };
    const now: Row = {
      t: dayValue(data.dataThrough), date: data.dataThrough, games: cur.games, current: true, values,
      full: { role: cur.roleFull, position: cur.games >= positionGames, overall: cur.games >= overallMinGames },
    };
    for (const k of KEYS) {
      last[`${k}Tail`] = last.values[k];
      now[`${k}Tail`] = values[k];
    }
    rows.push(now);
  }
  return rows;
}

function TrendTip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: Row }> }): JSX.Element | null {
  const { t } = useTranslation('common');
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 text-xs text-zinc-200 shadow-lg">
      <div className="font-mono text-zinc-400">
        {d.date}{d.current ? ` · ${t('analytics.theoryTrend.current')}` : ''} · {t('analytics.theoryTrend.gamesSoFar', { count: d.games })}
      </div>
      {KEYS.map((k) => (
        <div key={k} className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3" style={{ background: COLORS[k] }} aria-hidden />
          <span>{t(`analytics.theoryTrend.${k}`)}</span>
          <b className="ml-auto pl-2 tabular-nums text-white">{fmtTheoryPct(d.values[k])}</b>
          {!d.full[k] && <span className="text-[10px] text-amber-300">{t('analytics.theoryTrend.notFull')}</span>}
        </div>
      ))}
    </div>
  );
}

export default function TheoryTrendPanel({ name }: { name: string }): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<PlayerTheoryTrendData | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'notFound' | 'notGenerated' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!name) return;
    let stale = false;
    setState('loading');
    fetchPlayerTheoryTrend(name)
      .then((d) => { if (!stale) { setData(d); setState('ok'); } })
      .catch((err) => {
        if (stale) return;
        setData(null);
        if (err instanceof AnalysisApiError && err.status === 404 && /not found/i.test(err.serverError ?? '')) setState('notFound');
        else if (isAnalysisNotGenerated(err) || isAnalysisRouteMissing(err)) setState('notGenerated');
        else { setError(getErrorMessage(err)); setState('error'); }
      });
    return (): void => { stale = true; };
  }, [name]);

  if (state === 'loading' && !data) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.theoryTrend.loading')}
      </div>
    );
  }
  if (state === 'notFound' || state === 'notGenerated' || state === 'error' || !data) {
    return (
      <div className="flex items-center gap-3 px-4 py-4 rounded-xl border border-gray-700 bg-avalon-card/30 text-sm text-zinc-400">
        <AlertCircle size={18} className="flex-shrink-0" />
        <span>
          {state === 'error' ? `${t('analytics.theoryTrend.loadFailed')} ${error ?? ''}` : t(`analytics.theoryTrend.${state === 'notFound' ? 'notFound' : 'notGenerated'}`)}
        </span>
      </div>
    );
  }

  const cur = data.current;
  const windows = data.config.roleWindowGames;
  const special = Object.entries(windows).find(([role]) => role !== '忠臣')?.[1] ?? 10;
  return (
    <div className={state === 'loading' ? 'opacity-50 transition-opacity' : 'transition-opacity'} data-testid="theory-trend-panel">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2 text-xs text-zinc-400">
        <span className="font-semibold text-zinc-200">{t('analytics.theoryTrend.title')}</span>
        {cur && KEYS.map((k) => (
          <span key={k} className="whitespace-nowrap">
            {t(`analytics.theoryTrend.${k}`)}{' '}
            <b className="text-base font-black text-white tabular-nums">
              {fmtTheoryPct(k === 'role' ? cur.roleTheory : k === 'position' ? cur.positionTheory : cur.overallTheory)}
            </b>
          </span>
        ))}
      </div>
      <div className="rounded-xl border border-gray-700 bg-zinc-950/70 px-1 py-2">
        <TrendChart data={data} />
      </div>
      <p className="mt-1.5 text-[11px] text-zinc-500">
        {t('analytics.theoryTrend.chartNote', {
          role: special, loyal: windows['忠臣'] ?? 40, position: data.config.positionGames, overall: data.config.overallMinGames,
        })}
      </p>
    </div>
  );
}

function TrendChart({ data }: { data: PlayerTheoryTrendData }): JSX.Element {
  const { t } = useTranslation('common');
  const wide = useMediaQuery('(min-width: 640px)');
  const rows = useMemo(() => buildRows(data), [data]);
  if (rows.length === 0) return <p className="text-sm text-zinc-500 py-6 px-2">{t('analytics.theoryTrend.noPoints')}</p>;

  const t0 = rows[0].t;
  const t1 = Math.max(rows[rows.length - 1].t, t0 + 86_400_000);
  const years = new Date(t1).getUTCFullYear() - new Date(t0).getUTCFullYear() >= 2;
  const ticks = timeTicks(t0, t1, wide ? 7 : 4);
  const all = rows.flatMap((r) => KEYS.map((k) => r.values[k]));
  const yDomain: [number, number] = [Math.floor((Math.min(...all) - 1) / 5) * 5, Math.ceil((Math.max(...all) + 1) / 5) * 5];
  const yStep = yDomain[1] - yDomain[0] > 30 ? 10 : 5;
  const yTicks: number[] = [];
  for (let v = Math.ceil(yDomain[0] / yStep) * yStep; v <= yDomain[1]; v += yStep) yTicks.push(v);
  const single = rows.length === 1;
  return (
    <div className="w-full">
      <div className="mb-1 flex flex-wrap gap-x-3 gap-y-0.5 px-2 text-[11px] text-zinc-400">
        {KEYS.map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-4" style={{ background: COLORS[k] }} aria-hidden />
            {t(`analytics.theoryTrend.${k}`)}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-4 border-t-2 border-dashed border-zinc-400" aria-hidden />
          {t('analytics.theoryTrend.partial')}
        </span>
      </div>
      <div
        className="h-[220px] w-full"
        role="img"
        aria-label={t('analytics.theoryTrend.chartAria', { name: data.name, from: rows[0].date, to: rows[rows.length - 1].date })}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: wide ? 0 : -6 }}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis
              dataKey="t" type="number" domain={[t0, t1]} ticks={ticks} tickFormatter={(v: number) => fmtTick(v, years)}
              stroke="#71717a" fontSize={11}
            />
            <YAxis type="number" domain={yDomain} ticks={yTicks} stroke="#71717a" fontSize={11} width={wide ? 40 : 36} />
            <Tooltip content={<TrendTip />} cursor={{ stroke: '#71717a' }} isAnimationActive={false} />
            {KEYS.flatMap((k) => [
              <Line
                key={`${k}Part`} dataKey={`${k}Part`} stroke={COLORS[k]} strokeWidth={2} strokeDasharray="5 4"
                dot={single ? { r: 4, fill: COLORS[k], stroke: COLORS[k] } : false}
                activeDot={{ r: 4, stroke: '#18181b', strokeWidth: 2 }} connectNulls={false} isAnimationActive={false} legendType="none"
              />,
              <Line
                key={`${k}Full`} dataKey={`${k}Full`} stroke={COLORS[k]} strokeWidth={2} strokeLinejoin="round"
                dot={single ? { r: 4, fill: COLORS[k], stroke: COLORS[k] } : false}
                activeDot={{ r: 4, stroke: '#18181b', strokeWidth: 2 }}
                connectNulls={false} isAnimationActive={false} legendType="none"
              />,
              <Line
                key={`${k}Tail`} dataKey={`${k}Tail`} stroke={COLORS[k]} strokeWidth={1.5} strokeDasharray="2 3" opacity={0.7}
                dot={false} activeDot={false} connectNulls isAnimationActive={false} legendType="none"
              />,
            ])}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
