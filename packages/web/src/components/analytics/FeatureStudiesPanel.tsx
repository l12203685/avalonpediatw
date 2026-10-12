import { useState, useEffect, useMemo, useCallback, Component, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Loader, AlertCircle, ChevronDown, ChevronUp, ExternalLink, RefreshCw } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line, CartesianGrid, ReferenceLine, Legend,
} from 'recharts';
import {
  fetchFeatureStudies,
  getErrorMessage,
  isAnalysisNotGenerated,
  type FeatureStudiesData,
  type FeatureStudyEntry,
  type LakeClaimCell,
  type LakeClaimData,
} from '../../services/api';

/**
 * 特徵研究 (loops 136/139/141/142/143)
 *
 * cache.featureStudies → 後端 /api/analysis/feature-studies → 這裡。
 *
 * (2026-10-12 重構, docs/stats/two_stage_outcome.md)
 *   - 資料只抓一次：module 級快取 + `useFeatureStudies()`；`FeatureStudyCard`
 *     可依 loopId 放進「分析」各分頁 (派隊 L139、投票 L136、湖中女神 L141 + L142、
 *     刺殺 L143)，預設展開。`FeatureStudiesPanel` (全部列出) 保留。
 *   - 卡片的 title / hook / takeaway 一律以快取文字為準 (結論已由資料層修正)。
 *   - L141 改為 `lakeClaim`：首湖/二湖/三湖 × 宣告紅/藍 的可信度、95% 區間、n，
 *     n < minSample 標「樣本不足」；舊形狀 (bar, lieRate) 仍可渲染。
 *   - L142 / L143 表格加 n 欄與「樣本不足」標記 (lowSample 或 n < 30)。
 *
 * 視覺類型 dispatch:
 *   - lakeClaim — 湖中宣告可信度表 (L141 新)
 *   - bar       — 角色 lie% 橫條圖 (L141 舊) / 隊長 tier hit rate (L143)
 *   - table     — 一致度表 + 高 EV cells (L142)
 *   - divergent — 翻轉率 signed EV bar，0 為中軸 (L136)
 *   - line      — R{n} forced P5 對 outcome shift (L139)
 *
 * Error handling:
 *   - 503 (cache 未生成) → 顯「特徵研究 cache 尚未生成」+ retry button
 *   - chart render fail  → ErrorBoundary fallback to table view
 */

const RED_COLOR  = '#ef4444';
const BLUE_COLOR = '#3b82f6';
const NEUTRAL_COLOR = '#9ca3af';
const LOW_SAMPLE_N = 30;

const CHART_TOOLTIP_STYLE = {
  background: '#1f2937',
  border: '1px solid #374151',
  borderRadius: 8,
};

// ─── Module-level cache + hook ───────────────────────────────────────────────

let fsCache: FeatureStudiesData | null = null;
let fsInflight: Promise<FeatureStudiesData> | null = null;

export function loadFeatureStudies(force = false): Promise<FeatureStudiesData> {
  if (!force && fsCache) return Promise.resolve(fsCache);
  if (!force && fsInflight) return fsInflight;
  const p = fetchFeatureStudies()
    .then(d => {
      fsCache = d;
      return d;
    })
    .finally(() => {
      if (fsInflight === p) fsInflight = null;
    });
  fsInflight = p;
  return p;
}

export interface FeatureStudiesState {
  data: FeatureStudiesData | null;
  loading: boolean;
  error: string | null;
  /** 503：快取尚未產生。 */
  notGenerated: boolean;
  reload: () => void;
}

export function useFeatureStudies(): FeatureStudiesState {
  const [data, setData] = useState<FeatureStudiesData | null>(fsCache);
  const [loading, setLoading] = useState<boolean>(fsCache === null);
  const [error, setError] = useState<string | null>(null);
  const [notGenerated, setNotGenerated] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadFeatureStudies(reloadKey > 0)
      .then(d => {
        if (cancelled) return;
        setData(d);
        setError(null);
        setNotGenerated(false);
      })
      .catch(e => {
        if (cancelled) return;
        if (isAnalysisNotGenerated(e)) setNotGenerated(true);
        setError(getErrorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback((): void => {
    setLoading(true);
    setError(null);
    setNotGenerated(false);
    setReloadKey(k => k + 1);
  }, []);

  return { data, loading, error, notGenerated, reload };
}

// ─── Error boundary ──────────────────────────────────────────────────────────

interface ChartErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

interface ChartErrorBoundaryState {
  hasError: boolean;
}

class ChartErrorBoundary extends Component<ChartErrorBoundaryProps, ChartErrorBoundaryState> {
  constructor(props: ChartErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): ChartErrorBoundaryState {
    return { hasError: true };
  }
  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[FeatureStudies] chart render error', error);
  }
  render(): ReactNode {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function LoadFailed({ error, notGenerated, onRetry, compact }: {
  error: string | null;
  notGenerated: boolean;
  onRetry: () => void;
  compact?: boolean;
}): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className={`flex flex-col items-center justify-center gap-2 text-amber-300 ${compact ? 'py-4' : 'py-16 gap-3'}`}>
      <AlertCircle size={compact ? 18 : 28} />
      <p className="text-sm">{notGenerated ? t('analytics.featureStudies.loadFailed') : t('analytics.featureStudies.loadError')}</p>
      {error && !notGenerated && <p className="text-xs text-gray-500 max-w-md text-center">{error}</p>}
      <button
        onClick={onRetry}
        className="mt-1 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700"
      >
        <RefreshCw size={12} /> {t('analytics.featureStudies.retry')}
      </button>
    </div>
  );
}

export function LowSampleBadge(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <span className="ml-1 inline-block align-middle text-[9px] px-1 py-0.5 rounded bg-amber-900/40 border border-amber-800/50 text-amber-300 whitespace-nowrap">
      {t('analytics.featureStudies.lowSample')}
    </span>
  );
}

function isLow(flag: boolean | undefined, n: number | undefined, min = LOW_SAMPLE_N): boolean {
  if (typeof flag === 'boolean') return flag;
  return typeof n === 'number' && n < min;
}

// ─── Panel (全部列出) ─────────────────────────────────────────────────────────

export default function FeatureStudiesPanel(): JSX.Element {
  const { t } = useTranslation('common');
  const { data, loading, error, notGenerated, reload } = useFeatureStudies();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" />
        {t('analytics.featureStudies.loading')}
      </div>
    );
  }

  if (error || !data) {
    return <LoadFailed error={error} notGenerated={notGenerated} onRetry={reload} />;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">
        {t('analytics.featureStudies.subtitle', { count: data.sampleSize.games })}
      </p>
      {data.features.map((feature, idx) => (
        <FeatureCard
          key={feature.loopId}
          feature={feature}
          defaultOpen={idx < 2}
          orderIndex={idx}
        />
      ))}
    </div>
  );
}

// ─── Single card by loopId (放進各分析分頁) ───────────────────────────────────

export function FeatureStudyCard({ loopId, defaultOpen = true }: {
  loopId: string;
  defaultOpen?: boolean;
}): JSX.Element {
  const { t } = useTranslation('common');
  const { data, loading, error, notGenerated, reload } = useFeatureStudies();

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-gray-500">
        <Loader size={14} className="animate-spin" /> {t('analytics.featureStudies.loading')}
      </div>
    );
  }
  if (error || !data) {
    return <LoadFailed error={error} notGenerated={notGenerated} onRetry={reload} compact />;
  }
  const feature = data.features.find(f => f.loopId === loopId);
  if (!feature) {
    return (
      <p className="text-xs text-zinc-500 px-1 py-2">
        {t('analytics.featureStudies.notFound', { loopId })}
      </p>
    );
  }
  return <FeatureCard feature={feature} defaultOpen={defaultOpen} orderIndex={0} />;
}

function FeatureCard({
  feature, defaultOpen, orderIndex,
}: { feature: FeatureStudyEntry; defaultOpen: boolean; orderIndex: number }): JSX.Element {
  const { t, i18n } = useTranslation('common');
  const [open, setOpen] = useState(defaultOpen);
  const isEn = i18n.language?.toLowerCase().startsWith('en');

  // 文字一律以快取為準 (資料層已修正結論)。
  const title       = isEn ? feature.titleEn       : feature.title;
  const oneLineHook = isEn ? feature.oneLineHookEn : feature.oneLineHook;
  const takeaway    = isEn ? feature.takeawayEn    : feature.takeaway;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: orderIndex * 0.04 }}
      className="bg-avalon-card/30 border border-gray-700 rounded-xl overflow-hidden"
    >
      {/* Header (always visible, click to toggle) */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full text-left px-4 py-3 flex items-center justify-between gap-3 hover:bg-white/5 transition-colors"
        aria-expanded={open}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono px-1.5 py-0.5 bg-blue-900/40 border border-blue-800/50 text-blue-300 rounded">
              {feature.loopId}
            </span>
            <h3 className="text-base font-bold text-white truncate">{title}</h3>
          </div>
          <p className="text-xs text-zinc-400 line-clamp-2">{oneLineHook}</p>
        </div>
        {open
          ? <ChevronUp size={18} className="text-zinc-400 flex-shrink-0" />
          : <ChevronDown size={18} className="text-zinc-400 flex-shrink-0" />
        }
      </button>

      {/* Body (visible when open) */}
      {open && (
        <div className="border-t border-gray-700 px-4 py-4 space-y-3">
          <ChartErrorBoundary
            fallback={(
              <div className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded-lg p-3">
                {t('analytics.featureStudies.chartError')}
              </div>
            )}
          >
            <FeatureVisual feature={feature} />
          </ChartErrorBoundary>

          <p className="text-xs text-zinc-300 leading-relaxed">{takeaway}</p>
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>
              {t('analytics.featureStudies.sampleSize', { games: feature.sampleSize.games })}
              {feature.computedAt ? ` · ${feature.computedAt}` : ''}
            </span>
            <a
              href={`/docs/feature-study-${feature.loopId.toLowerCase()}`}
              className="inline-flex items-center gap-1 hover:text-blue-400 transition-colors"
              onClick={(e) => {
                // Wiki route not yet wired; prevent navigation but keep semantics.
                e.preventDefault();
              }}
            >
              {t('analytics.featureStudies.viewFullReport')} <ExternalLink size={11} />
            </a>
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ─── Visual dispatcher ────────────────────────────────────────────────────────

function FeatureVisual({ feature }: { feature: FeatureStudyEntry }): JSX.Element {
  switch (feature.visualType) {
    case 'lakeClaim': return <LakeClaimVisual feature={feature} />;
    case 'bar':       return <BarVisual feature={feature} />;
    case 'table':     return <TableVisual feature={feature} />;
    case 'divergent': return <DivergentVisual feature={feature} />;
    case 'line':      return <LineVisual feature={feature} />;
    default:
      return (
        <pre className="text-xs text-zinc-400 overflow-x-auto bg-zinc-900/40 rounded-lg p-3">
          {JSON.stringify(feature.data, null, 2)}
        </pre>
      );
  }
}

// ─── 0. Lake claim table (L141, generate_cache.py) ───────────────────────────

function isRedClaim(c: LakeClaimCell): boolean {
  return c.declaredEn === 'evil' || c.declared === '紅';
}

function LakeClaimCellView({ cell, min }: { cell: LakeClaimCell | undefined; min: number }): JSX.Element {
  if (!cell) return <span className="text-zinc-600">—</span>;
  const low = isLow(cell.lowSample, cell.n, min);
  return (
    <span className="whitespace-nowrap">
      <span className={`font-bold ${low ? 'text-zinc-400' : 'text-white'}`}>{cell.hitRate.toFixed(1)}%</span>
      <span className="text-zinc-500 text-[10px] ml-1">[{cell.ciLow.toFixed(1)}–{cell.ciHigh.toFixed(1)}]</span>
      <span className="text-zinc-500 text-[10px] ml-1">n={cell.n}</span>
      {low && <LowSampleBadge />}
    </span>
  );
}

function LakeClaimTable({ rows, min, firstCol, firstLabel }: {
  rows: LakeClaimCell[];
  min: number;
  firstCol: (c: LakeClaimCell) => string;
  firstLabel: string;
}): JSX.Element {
  const { t } = useTranslation('common');
  const groups: string[] = [];
  for (const r of rows) {
    const k = firstCol(r);
    if (!groups.includes(k)) groups.push(k);
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs text-zinc-300">
        <thead>
          <tr className="border-b border-gray-700 text-zinc-500">
            <th className="text-left py-2 pr-3">{firstLabel}</th>
            <th className="text-left py-2 pr-3 text-red-300">{t('analytics.featureStudies.lake.declaredRed')}</th>
            <th className="text-left py-2 text-blue-300">{t('analytics.featureStudies.lake.declaredBlue')}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(g => {
            const inGroup = rows.filter(r => firstCol(r) === g);
            const red = inGroup.find(isRedClaim);
            const blue = inGroup.find(r => !isRedClaim(r));
            return (
              <tr key={g} className="border-b border-zinc-800/60">
                <td className="py-1.5 pr-3 font-semibold text-zinc-200 whitespace-nowrap">{g}</td>
                <td className="py-1.5 pr-3"><LakeClaimCellView cell={red} min={min} /></td>
                <td className="py-1.5"><LakeClaimCellView cell={blue} min={min} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LakeClaimVisual({ feature }: { feature: FeatureStudyEntry }): JSX.Element {
  const { t, i18n } = useTranslation('common');
  const isEn = i18n.language?.toLowerCase().startsWith('en');
  const data = feature.data as unknown as LakeClaimData;
  const min = typeof data.minSample === 'number' ? data.minSample : LOW_SAMPLE_N;
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const holderRows = Array.isArray(data.holderRows) ? data.holderRows : [];

  if (rows.length === 0) {
    return <pre className="text-xs text-zinc-400">{JSON.stringify(data, null, 2)}</pre>;
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] text-zinc-500 mb-1">
          {t('analytics.featureStudies.lake.columns')} · {t('analytics.featureStudies.lowSampleHint', { min })}
        </p>
        <LakeClaimTable
          rows={rows}
          min={min}
          firstLabel={t('analytics.featureStudies.lake.lake')}
          firstCol={c => (isEn ? (c.lakeEn ?? c.lake ?? '') : (c.lake ?? c.lakeEn ?? ''))}
        />
      </div>
      {holderRows.length > 0 && (
        <div>
          <p className="text-[11px] text-zinc-500 mb-1 font-semibold">{t('analytics.featureStudies.lake.byHolder')}</p>
          <LakeClaimTable
            rows={holderRows}
            min={min}
            firstLabel={t('analytics.featureStudies.lake.holder')}
            firstCol={c => (isEn ? (c.holderEn ?? c.holder ?? '') : (c.holder ?? c.holderEn ?? ''))}
          />
        </div>
      )}
      {typeof data.undeclared === 'number' && data.undeclared > 0 && (
        <p className="text-[11px] text-zinc-500 italic">
          {t('analytics.featureStudies.lake.undeclared', { count: data.undeclared })}
        </p>
      )}
    </div>
  );
}

// ─── 1. Bar chart (L141 舊 lie rate / L143 leader tier hit rate) ──────────────

interface LieRow {
  role: string;
  roleEn: string;
  camp: string;
  lieRate: number;
  total: number;
}

interface LeaderTierRow {
  tier: string;
  tierEn: string;
  tierZh: string;
  n: number;
  hitRate: number;
  missRate: number;
  lowSample?: boolean;
}

interface SeatRow {
  seat: number;
  n: number;
  hitRate: number;
  lowSample?: boolean;
}

function BarVisual({ feature }: { feature: FeatureStudyEntry }): JSX.Element {
  const { t, i18n } = useTranslation('common');
  const isEn = i18n.language?.toLowerCase().startsWith('en');
  const data = feature.data as Record<string, unknown>;

  // L141 (舊形狀) lie rate
  if (Array.isArray(data.rows) && data.rows.length > 0 && (data.rows[0] as Record<string, unknown>).lieRate !== undefined) {
    const rows = data.rows as LieRow[];
    const chartData = rows.map(r => ({
      label: isEn ? r.roleEn : r.role,
      value: r.lieRate,
      camp:  r.camp,
      total: r.total,
    }));
    return (
      <div className="space-y-2">
        <ResponsiveContainer width="100%" height={Math.max(220, chartData.length * 32)}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
            <XAxis type="number" domain={[0, 60]} unit="%" tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <YAxis type="category" dataKey="label" width={72} tick={{ fontSize: 12, fill: '#d1d5db' }} />
            <Tooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              formatter={(v: unknown) => [`${Number(v).toFixed(2)}%`, String(data.axisLabel ?? 'Lie %')]}
            />
            <Bar dataKey="value" radius={[0, 4, 4, 0]}>
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.camp === 'red' ? RED_COLOR : BLUE_COLOR} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // L143 leader tier + seat top
  if (Array.isArray(data.leaderTierRows)) {
    const tierRows  = data.leaderTierRows as LeaderTierRow[];
    const seatRows  = (data.topSeatRows as SeatRow[] | undefined) ?? [];
    const tierChart = tierRows.map(r => ({
      label: isEn ? r.tierEn : r.tierZh,
      value: r.hitRate,
      n:     r.n,
    }));
    return (
      <div className="space-y-4">
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={tierChart} margin={{ top: 4, right: 16, left: -16, bottom: 4 }}>
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <YAxis unit="%" domain={[0, 60]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              formatter={(v: unknown, _n, p) => [
                `${Number(v).toFixed(2)}%  (n=${(p.payload as { n: number }).n})`,
                'Hit %',
              ]}
            />
            <Bar dataKey="value" fill={RED_COLOR} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-zinc-300">
            <thead>
              <tr className="border-b border-gray-700 text-zinc-500">
                <th className="text-left py-2 pr-4">{t('analytics.featureStudies.tier')}</th>
                <th className="text-right pr-4">n</th>
                <th className="text-right">{t('analytics.featureStudies.hitRate')}</th>
              </tr>
            </thead>
            <tbody>
              {tierRows.map(r => {
                const low = isLow(r.lowSample, r.n);
                return (
                  <tr key={r.tier} className="border-b border-zinc-800/60">
                    <td className="py-1 pr-4">{isEn ? r.tierEn : r.tierZh}</td>
                    <td className="text-right pr-4 text-zinc-400 whitespace-nowrap">{r.n}{low && <LowSampleBadge />}</td>
                    <td className={`text-right ${low ? 'text-zinc-400' : 'text-red-300'}`}>{r.hitRate.toFixed(2)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {seatRows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-zinc-300">
              <thead>
                <tr className="border-b border-gray-700 text-zinc-500">
                  <th className="text-left py-2 pr-4">{t('analytics.featureStudies.seat')}</th>
                  <th className="text-right pr-4">n</th>
                  <th className="text-right">{t('analytics.featureStudies.hitRate')}</th>
                </tr>
              </thead>
              <tbody>
                {seatRows.map(s => {
                  const low = isLow(s.lowSample, s.n);
                  return (
                    <tr key={s.seat} className="border-b border-zinc-800/60">
                      <td className="py-1 pr-4 font-mono">#{s.seat}</td>
                      <td className="text-right pr-4 text-zinc-400 whitespace-nowrap">{s.n}{low && <LowSampleBadge />}</td>
                      <td className={`text-right ${low ? 'text-zinc-400' : 'text-red-300'}`}>{s.hitRate.toFixed(2)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-zinc-500">{t('analytics.featureStudies.lowSampleHint', { min: LOW_SAMPLE_N })}</p>
      </div>
    );
  }

  return <pre className="text-xs text-zinc-400">{JSON.stringify(data, null, 2)}</pre>;
}

// ─── 2. Table (L142 consistency rate + high-EV cells) ─────────────────────────

interface ConsistencyRow {
  role: string;
  roleEn: string;
  camp: string;
  consistencyRate: number;
  total: number;
  consistent: number;
  inconsistent: number;
  lowSample?: boolean;
}

interface HighEvCell {
  label: string;
  labelEn: string;
  n: number;
  threeRedPct: number;
  deltaThreeRed: number;
  directionEn?: string;
  lowSample?: boolean;
}

function TableVisual({ feature }: { feature: FeatureStudyEntry }): JSX.Element {
  const { t, i18n } = useTranslation('common');
  const isEn = i18n.language?.toLowerCase().startsWith('en');
  const data = feature.data as Record<string, unknown>;
  const rows = (data.rows as ConsistencyRow[] | undefined) ?? [];
  const cells = (data.highEvCells as HighEvCell[] | undefined) ?? [];

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-zinc-300">
          <thead>
            <tr className="border-b border-gray-700 text-zinc-500">
              <th className="text-left py-2 pr-4">{t('analytics.featureStudies.role')}</th>
              <th className="text-right pr-4">{t('analytics.featureStudies.consistency')}</th>
              <th className="text-right pr-4">n</th>
              <th className="text-right">{t('analytics.featureStudies.consistInconsist')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const low = isLow(r.lowSample, r.total);
              return (
                <tr key={r.role} className="border-b border-zinc-800/60">
                  <td className="py-1 pr-4">
                    <span className={r.camp === 'red' ? 'text-red-300' : 'text-blue-300'}>
                      {isEn ? r.roleEn : r.role}
                    </span>
                  </td>
                  <td className={`text-right pr-4 font-bold ${low ? 'text-zinc-400' : 'text-white'}`}>{r.consistencyRate.toFixed(2)}%</td>
                  <td className="text-right pr-4 text-zinc-400 whitespace-nowrap">{r.total}{low && <LowSampleBadge />}</td>
                  <td className="text-right text-zinc-500">{r.consistent}/{r.inconsistent}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="text-[11px] text-zinc-500 mt-1">{t('analytics.featureStudies.lowSampleHint', { min: LOW_SAMPLE_N })}</p>
      </div>

      {cells.length > 0 && (
        <div>
          <div className="text-xs text-zinc-500 mb-2 font-semibold">
            {t('analytics.featureStudies.highEvCells')}
          </div>
          <div className="space-y-1.5">
            {cells.map(c => {
              const low = isLow(c.lowSample, c.n);
              return (
                <div
                  key={c.label}
                  className="flex items-center justify-between gap-2 text-xs bg-zinc-900/40 border border-zinc-800 rounded-lg px-3 py-2"
                >
                  <span className="text-zinc-300 truncate">
                    {isEn && c.labelEn ? c.labelEn : c.label}
                  </span>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-zinc-500 whitespace-nowrap">n={c.n}{low && <LowSampleBadge />}</span>
                    <span className={low ? 'text-zinc-400 font-bold' : c.deltaThreeRed >= 0 ? 'text-red-400 font-bold' : 'text-blue-400 font-bold'}>
                      Δ {c.deltaThreeRed >= 0 ? '+' : ''}{c.deltaThreeRed.toFixed(2)}pp
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 3. Divergent bar (L136 signed EV with 0 axis) ────────────────────────────

interface DivergentRow {
  role: string;
  roleEn: string;
  camp: string;
  signedEv: number;
  totalChances: number;
  flipRedPct: number;
  flipBluePct: number;
}

function DivergentVisual({ feature }: { feature: FeatureStudyEntry }): JSX.Element {
  const { i18n } = useTranslation('common');
  const isEn = i18n.language?.toLowerCase().startsWith('en');
  const data = feature.data as Record<string, unknown>;
  const rows = (data.rows as DivergentRow[] | undefined) ?? [];

  const chartData = useMemo(
    () => rows.map(r => ({
      label: isEn ? r.roleEn : r.role,
      value: r.signedEv,
      camp:  r.camp,
      n:     r.totalChances,
    })),
    [rows, isEn],
  );

  const maxAbs = useMemo(
    () => Math.max(0.5, ...chartData.map(d => Math.abs(d.value))) * 1.1,
    [chartData],
  );

  return (
    <ResponsiveContainer width="100%" height={Math.max(220, chartData.length * 30)}>
      <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <XAxis
          type="number"
          domain={[-maxAbs, maxAbs]}
          unit="pp"
          tick={{ fontSize: 11, fill: '#9ca3af' }}
        />
        <YAxis type="category" dataKey="label" width={72} tick={{ fontSize: 12, fill: '#d1d5db' }} />
        <ReferenceLine x={0} stroke="#6b7280" strokeDasharray="2 2" />
        <Tooltip
          contentStyle={CHART_TOOLTIP_STYLE}
          formatter={(v: unknown, _n, p) => {
            const raw = Number(v);
            const n = (p.payload as { n: number }).n;
            return [`${raw >= 0 ? '+' : ''}${raw.toFixed(2)}pp  (n=${n.toLocaleString()})`, 'signed EV'];
          }}
        />
        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
          {chartData.map((entry, i) => (
            <Cell key={i} fill={entry.value >= 0 ? BLUE_COLOR : RED_COLOR} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── 4. Line (L139 forced P5 round shift) ─────────────────────────────────────

interface ForcedRow {
  round: string;
  n: number;
  threeRedPct: number;
  deltaThreeRed: number;
  deltaThreeBlueAlive: number;
  deltaThreeBlueDead: number;
}

function LineVisual({ feature }: { feature: FeatureStudyEntry }): JSX.Element {
  const { t, i18n } = useTranslation('common');
  const isEn = i18n.language?.toLowerCase().startsWith('en');
  const data = feature.data as Record<string, unknown>;
  const rows = (data.rows as ForcedRow[] | undefined) ?? [];
  const note = isEn ? (data.noteEn as string | undefined) : (data.note as string | undefined);

  const chartData = rows.map(r => ({
    round: r.round,
    threeRed:  r.deltaThreeRed,
    blueAlive: r.deltaThreeBlueAlive,
    blueDead:  r.deltaThreeBlueDead,
    n:         r.n,
  }));

  return (
    <div className="space-y-3">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData} margin={{ top: 8, right: 16, left: -16, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis dataKey="round" tick={{ fontSize: 11, fill: '#9ca3af' }} />
          <YAxis unit="pp" tick={{ fontSize: 11, fill: '#9ca3af' }} />
          <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="2 2" />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            formatter={(v: unknown) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}pp`}
          />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            formatter={(name) => {
              if (name === 'threeRed')  return isEn ? 'Δ 3-Red'        : 'Δ 三紅';
              if (name === 'blueAlive') return isEn ? 'Δ 3-Blue Alive' : 'Δ 三藍活';
              if (name === 'blueDead')  return isEn ? 'Δ 3-Blue Dead'  : 'Δ 三藍死';
              return String(name);
            }}
          />
          <Line type="monotone" dataKey="threeRed"  stroke={RED_COLOR}  strokeWidth={2} dot />
          <Line type="monotone" dataKey="blueAlive" stroke={BLUE_COLOR} strokeWidth={2} dot />
          <Line type="monotone" dataKey="blueDead"  stroke={NEUTRAL_COLOR} strokeWidth={2} dot />
        </LineChart>
      </ResponsiveContainer>
      {note && (
        <p className="text-[11px] text-zinc-500 italic">
          {t('analytics.featureStudies.noteLabel')} {note}
        </p>
      )}
    </div>
  );
}
