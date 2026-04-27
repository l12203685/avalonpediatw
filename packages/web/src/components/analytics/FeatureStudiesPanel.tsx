import { useState, useEffect, useMemo, Component, type ReactNode } from 'react';
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
  type FeatureStudiesData,
  type FeatureStudyEntry,
} from '../../services/api';

/**
 * 特徵研究 Panel — AnalyticsPage 第三 tab
 *
 * 5 個高訊號 v7 features (loop 136/139/141/142/143) 從 staging/selfplay
 * 報告萃取成 cache.featureStudies → 後端 /api/analysis/feature-studies →
 * 此 panel 列直立 5 張 card；前 2 張預設展開，後 3 張收合節省 viewport。
 *
 * 視覺類型 dispatch:
 *   - bar       — 角色 lie% 橫條圖 (L141) / 隊長 tier hit rate (L143)
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

const CHART_TOOLTIP_STYLE = {
  background: '#1f2937',
  border: '1px solid #374151',
  borderRadius: 8,
};

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

export default function FeatureStudiesPanel(): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<FeatureStudiesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFeatureStudies()
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(getErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" />
        {t('analytics.featureStudies.loading')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-amber-300">
        <AlertCircle size={28} />
        <p className="text-sm">{t('analytics.featureStudies.loadFailed')}</p>
        {error && <p className="text-xs text-gray-500 max-w-md text-center">{error}</p>}
        <button
          onClick={() => setReloadKey(k => k + 1)}
          className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700"
        >
          <RefreshCw size={12} /> {t('analytics.featureStudies.retry')}
        </button>
      </div>
    );
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

function FeatureCard({
  feature, defaultOpen, orderIndex,
}: { feature: FeatureStudyEntry; defaultOpen: boolean; orderIndex: number }): JSX.Element {
  const { t, i18n } = useTranslation('common');
  const [open, setOpen] = useState(defaultOpen);
  const isEn = i18n.language?.toLowerCase().startsWith('en');

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
            <span>{t('analytics.featureStudies.sampleSize', { games: feature.sampleSize.games })}</span>
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

// ─── 1. Bar chart (L141 lie rate / L143 leader tier hit rate) ─────────────────

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
}

interface SeatRow {
  seat: number;
  n: number;
  hitRate: number;
}

function BarVisual({ feature }: { feature: FeatureStudyEntry }): JSX.Element {
  const { i18n } = useTranslation('common');
  const isEn = i18n.language?.toLowerCase().startsWith('en');
  const data = feature.data as Record<string, unknown>;

  // L141 lie rate
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
        {seatRows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-zinc-300">
              <thead>
                <tr className="border-b border-gray-700 text-zinc-500">
                  <th className="text-left py-2 pr-4">Seat</th>
                  <th className="text-right pr-4">N</th>
                  <th className="text-right">Hit %</th>
                </tr>
              </thead>
              <tbody>
                {seatRows.map(s => (
                  <tr key={s.seat} className="border-b border-zinc-800/60">
                    <td className="py-1 pr-4 font-mono">#{s.seat}</td>
                    <td className="text-right pr-4 text-zinc-400">{s.n}</td>
                    <td className="text-right text-red-300">{s.hitRate.toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
}

interface HighEvCell {
  label: string;
  labelEn: string;
  n: number;
  threeRedPct: number;
  deltaThreeRed: number;
  directionEn?: string;
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
              <th className="text-right pr-4">N</th>
              <th className="text-right">{t('analytics.featureStudies.consistInconsist')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.role} className="border-b border-zinc-800/60">
                <td className="py-1 pr-4">
                  <span className={r.camp === 'red' ? 'text-red-300' : 'text-blue-300'}>
                    {isEn ? r.roleEn : r.role}
                  </span>
                </td>
                <td className="text-right pr-4 font-bold text-white">{r.consistencyRate.toFixed(2)}%</td>
                <td className="text-right pr-4 text-zinc-400">{r.total}</td>
                <td className="text-right text-zinc-500">{r.consistent}/{r.inconsistent}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cells.length > 0 && (
        <div>
          <div className="text-xs text-zinc-500 mb-2 font-semibold">
            {t('analytics.featureStudies.highEvCells')}
          </div>
          <div className="space-y-1.5">
            {cells.map(c => (
              <div
                key={c.label}
                className="flex items-center justify-between gap-2 text-xs bg-zinc-900/40 border border-zinc-800 rounded-lg px-3 py-2"
              >
                <span className="text-zinc-300 truncate">
                  {isEn && c.labelEn ? c.labelEn : c.label}
                </span>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-zinc-500">n={c.n}</span>
                  <span className={c.deltaThreeRed >= 0 ? 'text-red-400 font-bold' : 'text-blue-400 font-bold'}>
                    Δ {c.deltaThreeRed >= 0 ? '+' : ''}{c.deltaThreeRed.toFixed(2)}pp
                  </span>
                </div>
              </div>
            ))}
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
