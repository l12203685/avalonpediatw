import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader } from 'lucide-react';
import {
  AnalysisApiError,
  fetchPlayerRating,
  fmtElo,
  fmtTheoryPct,
  getErrorMessage,
  isAnalysisNotGenerated,
  isAnalysisRouteMissing,
  type PlayerRatingData,
  type TheoryTrendGames,
} from '../../../services/api';
import { DEFAULT_TREND_VIEW, dayNumber, gamePoints, niceTicks, rollingMean, trendWindow, type TrendView } from './trendSeries';

/**
 * 玩家雷達 > Elo 走勢 (Edward 2026-10-30「ELO 曲線不錯，可以放在玩家頁面」)。
 *
 * 讀 /api/analysis/rating/:name (generate_cache.py compute_rating)：每個出賽日最後一局後的 Elo 與 ±1σ。
 * 上方一列是目前的 Elo、±1σ、計入場數、模型理論勝率 (不到 provisionalGames 場標「暫定」)；下方是依時間的
 * 走勢 (SVG，不用圖表套件)：線 = Elo、淺色帶 = ±1σ、灰色虛線 = 1500 (平均老手)。最後出賽之後其他人的變動
 * 仍會移動目前的 Elo，所以最後一點到資料日期之間畫一段虛線接到目前的 Elo。滑過 (或點) 圖看那一天的數字。
 * Elo 不隨複合篩選變動 (依對局順序而定)。
 *
 * (Edward 2026-11-10「可以切換X軸是場次 … 可以取rolling 平均」) TrendsPanel 傳進共用的 view：
 *  - 場次軸：每一場之後的 Elo (perGame，/theory-trend/:name 的 games.elo；X = 生涯第幾場，還沒計入 Elo 的場次沒有點)；
 *    X 不會隨時間前進，所以不畫接到目前 Elo 的虛線。
 *  - 移動平均：粗線 = 平均 (trendSeries.rollingMean)、淡色細線 = 原始 Elo，±1σ 帶照原始值；開著時也不畫尾巴的虛線。
 */

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 24, left: 40 };
const LINE = '#60a5fa';
const BAND = 'rgba(96, 165, 250, 0.18)';

function dayValue(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** 時間軸刻度：跨幾年就標年份，不然標月份；最多約 maxTicks 個。 */
function timeTicks(t0: number, t1: number, maxTicks: number): Array<{ t: number; label: string }> {
  const a = new Date(t0);
  const b = new Date(t1);
  const years = b.getUTCFullYear() - a.getUTCFullYear();
  const out: Array<{ t: number; label: string }> = [];
  if (years >= 2) {
    const step = Math.max(1, Math.ceil((years + 1) / maxTicks));
    for (let y = a.getUTCFullYear() + 1; y <= b.getUTCFullYear(); y += step) out.push({ t: Date.UTC(y, 0, 1), label: String(y) });
    return out;
  }
  const months = years * 12 + b.getUTCMonth() - a.getUTCMonth();
  const step = Math.max(1, Math.ceil((months + 1) / maxTicks));
  for (let m = 1; m <= months; m += step) {
    const d = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + m, 1));
    out.push({ t: d.getTime(), label: `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}` });
  }
  return out;
}

function useWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    return (): void => ro.disconnect();
  }, []);
  return [ref, width];
}

export default function EloPanel({
  name, view = DEFAULT_TREND_VIEW, perGame = null,
}: { name: string; view?: TrendView; perGame?: TheoryTrendGames | null }): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<PlayerRatingData | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'notRated' | 'notGenerated' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!name) return;
    let stale = false;
    setState('loading');
    fetchPlayerRating(name)
      .then(d => { if (!stale) { setData(d); setState('ok'); } })
      .catch(err => {
        if (stale) return;
        setData(null);
        if (err instanceof AnalysisApiError && err.status === 404 && /not rated/i.test(err.serverError ?? '')) setState('notRated');
        else if (isAnalysisNotGenerated(err) || isAnalysisRouteMissing(err)) setState('notGenerated');
        else { setError(getErrorMessage(err)); setState('error'); }
      });
    return (): void => { stale = true; };
  }, [name]);

  if (state === 'loading' && !data) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.elo.loading')}
      </div>
    );
  }
  if (state === 'notRated' || state === 'notGenerated' || state === 'error' || !data) {
    return (
      <div className="flex items-center gap-3 px-4 py-4 rounded-xl border border-gray-700 bg-avalon-card/30 text-sm text-zinc-400">
        <AlertCircle size={18} className="flex-shrink-0" />
        <span>{state === 'error' ? `${t('analytics.elo.loadFailed')} ${error ?? ''}` : t(`analytics.elo.${state === 'notGenerated' ? 'notGenerated' : 'notRated'}`)}</span>
      </div>
    );
  }

  const { player, config } = data;
  const provisionalGames = typeof config.provisionalGames === 'number' ? config.provisionalGames : 30;
  return (
    <div className={state === 'loading' ? 'opacity-50 transition-opacity' : 'transition-opacity'} data-testid="elo-panel">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2 text-xs text-zinc-400">
        <span className="whitespace-nowrap">
          Elo <b className="text-2xl font-black text-white tabular-nums">{fmtElo(player.elo)}</b>
          <span className="ml-1 text-zinc-400 tabular-nums">±{fmtElo(player.sigma)}</span>
        </span>
        {player.provisional && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 border border-amber-800/50 text-amber-300"
            title={t('analytics.elo.provisionalHint', { count: provisionalGames })}
          >
            {t('analytics.elo.provisional')}
          </span>
        )}
        <span className="whitespace-nowrap">{t('analytics.elo.rankOf', { rank: player.rank })}</span>
        <span className="whitespace-nowrap">{t('analytics.elo.games', { count: player.games })}</span>
        <span className="whitespace-nowrap">
          {t('analytics.elo.modelTheory')} <b className="text-zinc-200">{fmtTheoryPct(player.modelTheory)}</b>
        </span>
        {data.dataThrough && <span className="whitespace-nowrap text-zinc-500">{t('analytics.elo.dataThrough', { date: data.dataThrough })}</span>}
      </div>
      <div className="rounded-xl border border-gray-700 bg-zinc-950/70 px-1 py-2">
        <EloChart data={data} view={view} perGame={perGame} />
      </div>
      <p className="mt-1.5 text-[11px] text-zinc-500">{t('analytics.elo.chartNote')}</p>
    </div>
  );
}

/** t = X 的值：日期軸是毫秒、場次軸是生涯第幾場；avg = 移動平均 (沒開為 undefined)。 */
interface Pt { t: number; date: string; elo: number; sigma: number; games: number; current?: boolean; avg?: number }

function EloChart({ data, view, perGame }: { data: PlayerRatingData; view: TrendView; perGame: TheoryTrendGames | null }): JSX.Element {
  const { t } = useTranslation('common');
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const byGames = view.axis === 'games' && perGame !== null;

  const points = useMemo((): Pt[] => {
    const pts: Pt[] = byGames
      ? gamePoints(perGame).flatMap((p) => (p.elo === null || p.sigma === null ? []
        : [{ t: p.game, date: p.date, elo: p.elo, sigma: p.sigma, games: p.game }]))
      : data.series.map(([date, elo, sigma, games]) => ({ t: dayValue(date), date, elo, sigma, games }));
    if (view.smooth && pts.length) {
      const avg = rollingMean(pts.map((p) => (byGames ? p.t : dayNumber(p.date))), pts.map((p) => p.elo), trendWindow(view));
      pts.forEach((p, i) => { p.avg = avg[i].mean ?? p.elo; });
    }
    const last = pts[pts.length - 1];
    if (!byGames && !view.smooth && last && data.dataThrough && data.dataThrough > last.date) {
      pts.push({
        t: dayValue(data.dataThrough), date: data.dataThrough, elo: Math.round(data.player.elo),
        sigma: Math.round(data.player.sigma), games: data.player.games, current: true,
      });
    }
    return pts;
  }, [data, perGame, byGames, view]);

  if (points.length === 0) {
    return <p className="text-sm text-zinc-500 py-6">{t('analytics.elo.noPoints')}</p>;
  }

  const w = Math.max(width, 260);
  const innerW = w - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const t0 = points[0].t;
  const t1 = Math.max(points[points.length - 1].t, t0 + (byGames ? 1 : 86_400_000));
  const lo = Math.min(1500, ...points.map(p => p.elo - p.sigma)) - 4;
  const hi = Math.max(1500, ...points.map(p => p.elo + p.sigma)) + 4;
  const x = (v: number): number => PAD.left + ((v - t0) / (t1 - t0)) * innerW;
  const y = (v: number): number => PAD.top + (1 - (v - lo) / (hi - lo)) * innerH;
  const played = points.filter(p => !p.current);
  const line = played.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.elo).toFixed(1)}`).join('');
  const smoothLine = view.smooth
    ? played.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.avg ?? p.elo).toFixed(1)}`).join('')
    : null;
  const band = [
    ...points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.elo + p.sigma).toFixed(1)}`),
    ...[...points].reverse().map(p => `L${x(p.t).toFixed(1)},${y(p.elo - p.sigma).toFixed(1)}`),
    'Z',
  ].join('');
  const tail = points[points.length - 1].current ? points.slice(-2) : null;
  const yTicks = niceTicks(lo, hi, 5);
  const xTicks = byGames
    ? niceTicks(t0, t1, w < 480 ? 4 : 7).filter(v => v >= t0).map(v => ({ t: v, label: String(v) }))
    : timeTicks(t0, t1, w < 480 ? 4 : 7);

  const onMove = (e: ReactPointerEvent<SVGRectElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const tx = t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].t - tx) < Math.abs(points[best].t - tx)) best = i;
    }
    setHover(best);
  };
  const hp = hover === null ? null : points[hover];
  const tipLeft = hp ? Math.min(Math.max(x(hp.t) - 70, 0), w - 140) : 0;

  return (
    <div ref={ref} className="relative w-full select-none">
      <svg
        width={w}
        height={HEIGHT}
        role="img"
        aria-label={t('analytics.elo.chartAria', {
          name: data.player.name, from: points[0].date, to: points[points.length - 1].date, elo: fmtElo(data.player.elo),
        })}
        className="block max-w-full"
      >
        {yTicks.map(v => (
          <g key={v}>
            <line x1={PAD.left} x2={w - PAD.right} y1={y(v)} y2={y(v)} stroke="#3f3f46" strokeWidth={1} opacity={0.5} />
            <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="#a1a1aa">{v}</text>
          </g>
        ))}
        {xTicks.map(tk => (
          <text key={tk.t} x={x(tk.t)} y={HEIGHT - 6} textAnchor="middle" fontSize={10} fill="#a1a1aa">{tk.label}</text>
        ))}
        <line x1={PAD.left} x2={w - PAD.right} y1={y(1500)} y2={y(1500)} stroke="#a1a1aa" strokeWidth={1} strokeDasharray="4 4" />
        <path d={band} fill={BAND} stroke="none" />
        <path
          d={line} fill="none" stroke={LINE} strokeWidth={smoothLine ? 1 : 2} strokeOpacity={smoothLine ? 0.35 : 1}
          strokeLinejoin="round" strokeLinecap="round"
        />
        {smoothLine && <path d={smoothLine} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {tail && (
          <path
            d={`M${x(tail[0].t)},${y(tail[0].elo)}L${x(tail[1].t)},${y(tail[1].elo)}`}
            fill="none" stroke={LINE} strokeWidth={2} strokeDasharray="4 4" opacity={0.7}
          />
        )}
        {played.length === 1 && <circle cx={x(played[0].t)} cy={y(played[0].elo)} r={4} fill={LINE} />}
        {hp && (
          <g pointerEvents="none">
            <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="#71717a" strokeWidth={1} />
            <circle cx={x(hp.t)} cy={y(hp.avg ?? hp.elo)} r={4.5} fill={LINE} stroke="#18181b" strokeWidth={2} />
          </g>
        )}
        <rect
          x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="transparent"
          onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}
          style={{ touchAction: 'pan-y' }}
        />
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute top-1 z-10 w-[140px] rounded-md border border-zinc-700 bg-zinc-900/95 px-2 py-1 text-[11px] text-zinc-300 shadow"
          style={{ left: tipLeft }}
        >
          <div className="text-zinc-400">
            {hp.date || t('analytics.trendView.undated')}{hp.current ? ` · ${t('analytics.elo.current')}` : ''}
          </div>
          {hp.avg !== undefined && (
            <div><span className="text-zinc-400">{t('analytics.trendView.smoothed')}</span> <b className="text-white tabular-nums">{Math.round(hp.avg)}</b></div>
          )}
          <div>
            {hp.avg !== undefined && <span className="text-zinc-400">{t('analytics.trendView.raw')} </span>}
            <b className={hp.avg !== undefined ? 'tabular-nums text-zinc-200' : 'text-white tabular-nums'}>{hp.elo}</b>{' '}
            <span className="tabular-nums">±{hp.sigma}</span>
          </div>
          <div className="text-zinc-500">{t('analytics.elo.gamesSoFar', { count: hp.games })}</div>
        </div>
      )}
    </div>
  );
}
