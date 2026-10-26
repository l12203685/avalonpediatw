import { useState, useEffect, useCallback, Component, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Loader, AlertCircle, ChevronDown, ChevronUp, BookOpen, RefreshCw } from 'lucide-react';
import {
  fetchFeatureStudies,
  getErrorMessage,
  isAnalysisNotGenerated,
  type FeatureStudiesData,
  type FeatureStudyEntry,
  type LakeClaimCell,
  type LakeClaimData,
} from '../../services/api';
import { filterScopedLoader } from '../../stats/filterScopedLoader';
import { isFilterableStudy } from '../../stats/filteredRoutes';
import NotFilteredNote from '../analysis/filter/NotFilteredNote';
import { StatTable, type StatColumn, type Tone } from '../analysis/ui';
import { useRoleLabel } from '../analysis/roleLabels';
import { studyHash } from '../../utils/statsLinks';
import { openStudy } from './studyLink';

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
 * (2026-10-14 Edward：「有些可以用表格數字，不一定要用圖」「查看完整研究大多點不開」)
 *   - 五項研究全部改成 StatTable 數字表 (比率 + n、樣本不足變淡)，不再用 recharts：
 *     L136 的差距只有 ±2pp、L139 只有 4 輪，數字比長條／折線清楚 (舊的發散長條圖刻度還會印出
 *     -2.398000000006pp 這種數字)。
 *   - 「查看完整研究」以前連到不存在的 /docs/feature-study-*，而且 preventDefault，永遠打不開；
 *     現在連到 #study=<id>，打開站內的完整研究 (FeatureStudyReport：問題、方法與定義、樣本與日期、
 *     完整數字表 + 95% 區間、注意事項)。哪個分頁的卡片都一樣能開，網址可以直接分享。
 *   - FeatureVisual 有 full 模式 (完整研究用)：多列出區間、原始欄位與次要表 (L142 高 EV 格、
 *     L139 有無 R3 forced P5 的比較、L136 陣營整體)。快取沒有區間的研究，完整研究裡的 95% 區間
 *     由網站依 n 與比率以 Wilson 法推算 (wilson95，公式同 generate_cache.py 的 wilson_interval)。
 *   - 樣本不足門檻用研究自己的 minSample (L141 data.minSample；其餘同 generate_cache.py
 *     LAKE_CLAIM_MIN_SAMPLE = 30)，不是理論勝率的 theoryMinCellGames (那是玩家單一角色的場數門檻)。
 *
 * Error handling:
 *   - 503 (cache 未生成) → 顯「特徵研究 cache 尚未生成」+ retry button
 *   - 資料形狀不對、渲染失敗 → ErrorBoundary 顯示提示，不讓整頁壞掉
 */

/** generate_cache.py LAKE_CLAIM_MIN_SAMPLE：研究表格 n 低於這個值標「樣本不足」。 */
export const LOW_SAMPLE_N = 30;

// ─── Module-level cache + hook ───────────────────────────────────────────────

const studiesLoader = filterScopedLoader(fetchFeatureStudies);

export function loadFeatureStudies(force = false): Promise<FeatureStudiesData> {
  return studiesLoader.load(force);
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
  const [data, setData] = useState<FeatureStudiesData | null>(studiesLoader.peek);
  const [loading, setLoading] = useState<boolean>(() => studiesLoader.peek() === null);
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

interface StudyErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

interface StudyErrorBoundaryState {
  hasError: boolean;
}

export class StudyErrorBoundary extends Component<StudyErrorBoundaryProps, StudyErrorBoundaryState> {
  constructor(props: StudyErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): StudyErrorBoundaryState {
    return { hasError: true };
  }
  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[FeatureStudies] render error', error);
  }
  render(): ReactNode {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

export function LoadFailed({ error, notGenerated, onRetry, compact }: {
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

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rnd1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Wilson score 95% 區間 (%，一位小數)，公式同 generate_cache.py wilson_interval。
 * 給快取沒附區間的研究用 (完整研究裡標「網站推算」)。n ≤ 0 時 null。
 */
export function wilson95(hits: number, n: number): [number, number] | null {
  if (!(n > 0) || !(hits >= 0)) return null;
  const z = 1.959964;
  const p = Math.min(1, hits / n);
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [rnd1(Math.max(0, centre - half) * 100), rnd1(Math.min(1, centre + half) * 100)];
}

/** 比率 % 與 n → 推回筆數 (快取只給兩位小數的比率時用)，再算 Wilson 區間。 */
export function wilsonFromRate(ratePct: number | null | undefined, n: number | null | undefined): [number, number] | null {
  const r = num(ratePct);
  const size = num(n);
  if (r === null || size === null) return null;
  return wilson95(Math.round((r / 100) * size), size);
}

function CiText({ ci }: { ci: [number, number] | null | undefined }): JSX.Element | null {
  if (!ci) return null;
  return <span className="text-[10px] font-normal text-zinc-500">[{ci[0].toFixed(1)}–{ci[1].toFixed(1)}]</span>;
}

function pctText(v: unknown, digits = 1): string {
  const n = num(v);
  return n === null ? '—' : `${n.toFixed(digits)}%`;
}

function signedPp(v: unknown, digits = 2): string {
  const n = num(v);
  if (n === null) return '—';
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(digits)}pp`;
}

function campTone(camp: unknown): Tone | undefined {
  return camp === 'red' ? 'red' : camp === 'blue' ? 'blue' : undefined;
}

/** 研究的樣本不足門檻：L141 用 data.minSample，其餘 30。 */
export function studyMinSample(feature: FeatureStudyEntry): number {
  const v = num((feature.data as Record<string, unknown> | undefined)?.minSample);
  return v !== null && v > 0 ? v : LOW_SAMPLE_N;
}

function useIsEn(): boolean {
  const { i18n } = useTranslation('common');
  return i18n.language?.toLowerCase().startsWith('en') ?? false;
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
  return (
    <>
      {!isFilterableStudy(loopId) && <NotFilteredNote />}
      <FeatureCard feature={feature} defaultOpen={defaultOpen} orderIndex={0} />
    </>
  );
}

/** 「查看完整研究」連結：href 是 #study=<id> (中鍵／新分頁也能開)，點擊直接打開站內完整研究。 */
export function StudyLink({ loopId, className = '' }: { loopId: string; className?: string }): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <a
      href={studyHash(loopId)}
      className={`inline-flex items-center gap-1 font-semibold text-blue-300 hover:text-blue-200 transition-colors ${className}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // 新分頁：交給瀏覽器
        e.preventDefault();
        openStudy(loopId);
      }}
    >
      <BookOpen size={12} aria-hidden /> {t('analytics.featureStudies.viewFullReport')}
    </a>
  );
}

function FeatureCard({
  feature, defaultOpen, orderIndex,
}: { feature: FeatureStudyEntry; defaultOpen: boolean; orderIndex: number }): JSX.Element {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(defaultOpen);
  const isEn = useIsEn();

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
        className="w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-white/5 transition-colors"
        aria-expanded={open}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
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
        <div className="border-t border-gray-700 px-4 py-3 space-y-2.5">
          <StudyErrorBoundary
            fallback={(
              <div className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded-lg p-3">
                {t('analytics.featureStudies.chartError')}
              </div>
            )}
          >
            <FeatureVisual feature={feature} />
          </StudyErrorBoundary>

          <p className="text-xs text-zinc-300 leading-relaxed">{takeaway}</p>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <span>
              {t('analytics.featureStudies.sampleSize', { games: feature.sampleSize.games })}
              {feature.computedAt ? ` · ${feature.computedAt}` : ''}
            </span>
            <StudyLink loopId={feature.loopId} />
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ─── Visual dispatcher ────────────────────────────────────────────────────────

/**
 * 研究的數字表。full = 完整研究 (多列區間、原始欄位與次要表)；預設是分頁卡片的精簡版。
 */
export function FeatureVisual({ feature, full = false }: { feature: FeatureStudyEntry; full?: boolean }): JSX.Element {
  const data = (feature.data ?? {}) as Record<string, unknown>;
  switch (feature.visualType) {
    case 'lakeClaim': return <LakeClaimVisual feature={feature} full={full} />;
    case 'bar':
      if (Array.isArray(data.leaderTierRows)) return <AssassinTargetVisual feature={feature} full={full} />;
      return <LegacyLieVisual feature={feature} />;
    case 'table':     return <ConsistencyVisual feature={feature} full={full} />;
    case 'divergent': return <VoteFlipVisual feature={feature} full={full} />;
    case 'line':      return <ForcedP5Visual feature={feature} full={full} />;
    default:
      return (
        <pre className="text-xs text-zinc-400 overflow-x-auto bg-zinc-900/40 rounded-lg p-3">
          {JSON.stringify(feature.data, null, 2)}
        </pre>
      );
  }
}

function LowHint({ min }: { min: number }): JSX.Element {
  const { t } = useTranslation('common');
  return <>{t('analytics.r6.tabsa.studyTable.lowHint', { min })}</>;
}

function ComputedCiHint(): JSX.Element {
  const { t } = useTranslation('common');
  return <>{t('analytics.r6.tabsa.studyTable.computedCi')}</>;
}

// ─── L141 湖中宣告可信度 (lakeClaim, generate_cache.py) ───────────────────────

function isRedClaim(c: LakeClaimCell): boolean {
  return c.declaredEn === 'evil' || c.declared === '紅';
}

interface ClaimRow {
  key: string;
  label: string;
  tone?: Tone;
  red?: LakeClaimCell;
  blue?: LakeClaimCell;
}

function claimRows(cells: LakeClaimCell[], groupOf: (c: LakeClaimCell) => string, toneOf?: (c: LakeClaimCell) => Tone | undefined): ClaimRow[] {
  const rows: ClaimRow[] = [];
  for (const c of cells) {
    const g = groupOf(c);
    let row = rows.find(r => r.key === g);
    if (!row) {
      row = { key: g, label: g, tone: toneOf?.(c) };
      rows.push(row);
    }
    if (isRedClaim(c)) row.red = c;
    else row.blue = c;
  }
  return rows;
}

function LakeClaimTable({ rows, min, firstLabel, full, caption }: {
  rows: ClaimRow[];
  min: number;
  firstLabel: string;
  full: boolean;
  caption?: ReactNode;
}): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.r6.tabsa.studyTable';
  const cellColumn = (side: 'red' | 'blue'): StatColumn<ClaimRow> => ({
    key: side,
    label: side === 'red' ? t('analytics.featureStudies.lake.declaredRed') : t('analytics.featureStudies.lake.declaredBlue'),
    title: t(side === 'red' ? `${k}.claimRedTitle` : `${k}.claimBlueTitle`),
    align: 'right',
    value: row => row[side]?.hitRate,
    format: (_v, row): ReactNode => {
      const c = row[side];
      if (!c) return '—';
      // 手機上區間換到第二行，表格不必橫捲那麼多
      return (
        <span className="inline-flex flex-col items-end leading-tight sm:flex-row sm:items-baseline sm:gap-1">
          <span>{pctText(c.hitRate)}</span>
          <CiText ci={num(c.ciLow) !== null && num(c.ciHigh) !== null ? [c.ciLow, c.ciHigh] : null} />
          {full && typeof c.hits === 'number' && (
            <span className="text-[10px] font-normal text-zinc-500">{t(`${k}.hits`, { hits: c.hits })}</span>
          )}
        </span>
      );
    },
    n: row => row[side]?.n,
    lowSample: min,
    tone: side,
  });
  return (
    <StatTable
      caption={caption}
      columns={[
        { key: 'label', label: firstLabel, format: (_v, row) => row.label, tone: row => row.tone },
        cellColumn('red'),
        cellColumn('blue'),
      ]}
      rows={rows}
      rowKey={row => row.key}
    />
  );
}

function LakeClaimVisual({ feature, full }: { feature: FeatureStudyEntry; full: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const isEn = useIsEn();
  const data = feature.data as unknown as LakeClaimData;
  const min = studyMinSample(feature);
  const cells = Array.isArray(data.rows) ? data.rows : [];
  const holderCells = Array.isArray(data.holderRows) ? data.holderRows : [];

  if (cells.length === 0) {
    return <pre className="text-xs text-zinc-400">{JSON.stringify(data, null, 2)}</pre>;
  }

  const byLake = claimRows(cells, c => (isEn ? (c.lakeEn ?? c.lake ?? '') : (c.lake ?? c.lakeEn ?? '')));
  const byHolder = claimRows(
    holderCells,
    c => {
      const red = c.holderEn === 'evil' || c.holder === '紅';
      return t(red ? 'analytics.r6.tabsa.studyTable.redHolder' : 'analytics.r6.tabsa.studyTable.blueHolder');
    },
    c => (c.holderEn === 'evil' || c.holder === '紅' ? 'red' : 'blue'),
  );

  return (
    <div className="space-y-2">
      <div className={`grid gap-3 ${full ? '' : 'md:grid-cols-2'}`}>
        <LakeClaimTable
          rows={byLake}
          min={min}
          full={full}
          firstLabel={t('analytics.featureStudies.lake.lake')}
          caption={<span className="text-[11px] font-semibold text-zinc-500">{t('analytics.r6.tabsa.studyTable.byLake')}</span>}
        />
        {byHolder.length > 0 && (
          <LakeClaimTable
            rows={byHolder}
            min={min}
            full={full}
            firstLabel={t('analytics.featureStudies.lake.holder')}
            caption={<span className="text-[11px] font-semibold text-zinc-500">{t('analytics.featureStudies.lake.byHolder')}</span>}
          />
        )}
      </div>
      <p className="text-[10px] leading-relaxed text-zinc-500">
        {t('analytics.featureStudies.lake.columns')} · <LowHint min={min} />
        {typeof data.undeclared === 'number' && data.undeclared > 0 && (
          <> {t('analytics.featureStudies.lake.undeclared', { count: data.undeclared })}</>
        )}
      </p>
    </div>
  );
}

// ─── L141 舊形狀 (bar, lieRate)：只剩舊快取會出現 ───────────────────────────────

interface LieRow {
  role: string;
  roleEn: string;
  camp: string;
  lieRate: number;
  total: number;
}

function LegacyLieVisual({ feature }: { feature: FeatureStudyEntry }): JSX.Element {
  const { t } = useTranslation('common');
  const isEn = useIsEn();
  const role = useRoleLabel();
  const data = feature.data as Record<string, unknown>;
  const rows = Array.isArray(data.rows) ? (data.rows as LieRow[]).filter(r => r && typeof r === 'object') : [];
  if (rows.length === 0 || rows[0].lieRate === undefined) {
    return <pre className="text-xs text-zinc-400">{JSON.stringify(data, null, 2)}</pre>;
  }
  return (
    <StatTable
      columns={[
        { key: 'role', label: t('analytics.featureStudies.role'), value: r => (isEn ? r.roleEn : role(r.role)), tone: r => campTone(r.camp) },
        { key: 'lieRate', label: t('analytics.r6.tabsa.studyTable.lieRate'), format: 'pct', n: 'total', lowSample: LOW_SAMPLE_N, emphasis: true },
      ]}
      rows={rows}
      rowKey={r => r.role}
      footnote={<LowHint min={LOW_SAMPLE_N} />}
    />
  );
}

// ─── L143 刺客目標 (bar, leaderTierRows + topSeatRows) ────────────────────────

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

function AssassinTargetVisual({ feature, full }: { feature: FeatureStudyEntry; full: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const isEn = useIsEn();
  const k = 'analytics.r6.tabsa.studyTable';
  const data = feature.data as Record<string, unknown>;
  const tierRows = ((data.leaderTierRows as LeaderTierRow[] | undefined) ?? []).filter(r => r && typeof r === 'object');
  const seatRows = ((data.topSeatRows as SeatRow[] | undefined) ?? []).filter(r => r && typeof r === 'object');
  const min = LOW_SAMPLE_N;

  const tierColumns: StatColumn<LeaderTierRow>[] = [
    { key: 'tier', label: t('analytics.featureStudies.tier'), value: r => (isEn ? r.tierEn : r.tierZh) },
    {
      key: 'hitRate', label: t('analytics.featureStudies.hitRate'), title: t(`${k}.hitRateTitle`),
      format: 'pct', n: 'n', lowSample: min, tone: 'amber', emphasis: true,
    },
  ];
  if (full) {
    tierColumns.push(
      { key: 'ci', label: t(`${k}.ciComputed`), align: 'right', value: r => r.hitRate, format: (_v, r) => <CiText ci={wilsonFromRate(r.hitRate, r.n)} /> },
      { key: 'missRate', label: t(`${k}.missRate`), format: 'pct' },
    );
  }
  const seatColumns: StatColumn<SeatRow>[] = [
    { key: 'seat', label: t('analytics.featureStudies.seat'), value: r => t(`${k}.seatLabel`, { seat: r.seat }) },
    {
      key: 'hitRate', label: t('analytics.featureStudies.hitRate'), title: t(`${k}.hitRateTitle`),
      format: 'pct', n: 'n', lowSample: min, tone: 'amber',
    },
  ];
  if (full) {
    seatColumns.push({ key: 'ci', label: t(`${k}.ciComputed`), align: 'right', value: r => r.hitRate, format: (_v, r) => <CiText ci={wilsonFromRate(r.hitRate, r.n)} /> });
  }

  return (
    <div className="space-y-2">
      <div className={`grid gap-3 ${full ? '' : 'md:grid-cols-2'}`}>
        <StatTable
          caption={<span className="text-[11px] font-semibold text-zinc-500">{t(`${k}.byTier`)}</span>}
          columns={tierColumns}
          rows={tierRows}
          rowKey={r => r.tier}
        />
        {seatRows.length > 0 && (
          <StatTable
            caption={<span className="text-[11px] font-semibold text-zinc-500">{t(`${k}.topSeats`, { count: seatRows.length })}</span>}
            columns={seatColumns}
            rows={seatRows}
            rowKey={r => String(r.seat)}
          />
        )}
      </div>
      <p className="text-[10px] leading-relaxed text-zinc-500">
        {t(`${k}.hitRateNote`)} <LowHint min={min} />
        {full && <> <ComputedCiHint /></>}
      </p>
    </div>
  );
}

// ─── L142 持湖宣告後言行一致度 (table) ────────────────────────────────────────

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

function ConsistencyVisual({ feature, full }: { feature: FeatureStudyEntry; full: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const isEn = useIsEn();
  const role = useRoleLabel();
  const k = 'analytics.r6.tabsa.studyTable';
  const data = feature.data as Record<string, unknown>;
  const rows = ((data.rows as ConsistencyRow[] | undefined) ?? []).filter(r => r && typeof r === 'object');
  const cells = ((data.highEvCells as HighEvCell[] | undefined) ?? []).filter(c => c && typeof c === 'object');
  const min = LOW_SAMPLE_N;

  const columns: StatColumn<ConsistencyRow>[] = [
    { key: 'role', label: t('analytics.featureStudies.role'), value: r => (isEn ? r.roleEn : role(r.role)), tone: r => campTone(r.camp) },
    {
      key: 'consistencyRate', label: t('analytics.featureStudies.consistency'), title: t(`${k}.consistencyTitle`),
      format: 'pct', n: 'total', lowSample: min, emphasis: true,
    },
  ];
  if (full) {
    columns.push({
      key: 'ci', label: t(`${k}.ciComputed`), align: 'right', value: r => r.consistencyRate,
      format: (_v, r) => <CiText ci={wilson95(r.consistent, r.total)} />,
    });
  }
  columns.push({
    key: 'split', label: t('analytics.featureStudies.consistInconsist'), align: 'right',
    value: r => `${r.consistent} / ${r.inconsistent}`, className: 'text-zinc-500',
  });

  // 「娜|宣藍|consistent」→ 莫甘娜・宣告藍・言行一致
  const cellLabel = (c: HighEvCell): string => {
    if (isEn && c.labelEn) return c.labelEn;
    const [r, claim, kind] = String(c.label ?? '').split('|');
    if (!claim || !kind) return c.label;
    const claimText = claim.includes('紅') ? t('analytics.featureStudies.lake.declaredRed') : t('analytics.featureStudies.lake.declaredBlue');
    const kindText = kind === 'consistent' ? t(`${k}.consistent`) : t(`${k}.inconsistent`);
    return `${role(r)}・${claimText}・${kindText}`;
  };

  return (
    <div className="space-y-3">
      <StatTable
        columns={columns}
        rows={rows}
        rowKey={r => r.role}
        footnote={<>{t(`${k}.consistencyNote`)} <LowHint min={min} />{full && <> <ComputedCiHint /></>}</>}
      />
      {full && cells.length > 0 && (
        <StatTable
          caption={<span className="text-[11px] font-semibold text-zinc-500">{t('analytics.featureStudies.highEvCells')}</span>}
          columns={[
            { key: 'label', label: t(`${k}.combo`), value: cellLabel, className: 'whitespace-normal min-w-[9rem]' },
            { key: 'threeRedPct', label: t(`${k}.threeRedRate`), format: 'pct', n: 'n', lowSample: min, tone: 'red' },
            { key: 'ci', label: t(`${k}.ciComputed`), align: 'right', value: c => c.threeRedPct, format: (_v, c) => <CiText ci={wilsonFromRate(c.threeRedPct, c.n)} /> },
            {
              key: 'deltaThreeRed', label: t(`${k}.deltaThreeRed`), align: 'right',
              format: v => signedPp(v), tone: c => (c.deltaThreeRed >= 0 ? 'red' : 'blue'),
            },
          ]}
          rows={cells}
          rowKey={c => c.label}
          footnote={<>{t(`${k}.highEvNote`)} <LowHint min={min} /></>}
        />
      )}
    </div>
  );
}

// ─── L136 改隊後投票翻轉率 (divergent) ────────────────────────────────────────

interface VoteFlipRow {
  role: string;
  roleEn: string;
  camp: string;
  signedEv: number;
  totalChances: number;
  flipRedPct: number;
  flipBluePct: number;
}

interface VoteFlipSummary {
  blueOverall?: number;
  redOverall?: number;
  delta?: number;
}

function VoteFlipVisual({ feature, full }: { feature: FeatureStudyEntry; full: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const isEn = useIsEn();
  const role = useRoleLabel();
  const k = 'analytics.r6.tabsa.studyTable';
  const data = feature.data as Record<string, unknown>;
  const rows = ((data.rows as VoteFlipRow[] | undefined) ?? []).filter(r => r && typeof r === 'object');
  const summary = (data.summary && typeof data.summary === 'object' ? data.summary : {}) as VoteFlipSummary;

  const columns: StatColumn<VoteFlipRow>[] = [
    { key: 'role', label: t('analytics.featureStudies.role'), value: r => (isEn ? r.roleEn : role(r.role)), tone: r => campTone(r.camp) },
  ];
  if (full) {
    columns.push(
      { key: 'flipRedPct', label: t(`${k}.flipRed`), title: t(`${k}.flipColsTitle`), format: v => pctText(v, 2), align: 'right' },
      { key: 'flipBluePct', label: t(`${k}.flipBlue`), title: t(`${k}.flipColsTitle`), format: v => pctText(v, 2), align: 'right' },
    );
  }
  columns.push(
    {
      key: 'signedEv', label: t(`${k}.signedEv`), title: t(`${k}.signedEvTitle`), align: 'right', emphasis: true,
      format: v => signedPp(v), tone: r => (r.signedEv >= 0 ? 'blue' : 'red'),
    },
    { key: 'totalChances', label: t(`${k}.chances`), title: t(`${k}.chancesTitle`), format: 'int', className: 'text-zinc-400' },
  );

  const hasSummary = num(summary.blueOverall) !== null && num(summary.redOverall) !== null;
  return (
    <div className="space-y-2">
      {hasSummary && (
        <p className="text-xs text-zinc-400">
          {t(`${k}.flipSummary`, {
            blue: pctText(summary.blueOverall, 2),
            red: pctText(summary.redOverall, 2),
            delta: num(summary.delta) !== null ? (summary.delta as number).toFixed(2) : '—',
          })}
        </p>
      )}
      <StatTable
        columns={columns}
        rows={rows}
        rowKey={r => r.role}
        footnote={t(full ? `${k}.flipNoteFull` : `${k}.flipNote`)}
      />
    </div>
  );
}

// ─── L139 R3+ 強制 P5 (line) ──────────────────────────────────────────────────

interface ForcedRow {
  round: string;
  n: number;
  threeRedPct: number;
  deltaThreeRed: number;
  deltaThreeBlueAlive: number;
  deltaThreeBlueDead: number;
}

interface ForcedComparison {
  n: number;
  threeRedPct: number;
  deltaBaseline: number;
}

function ForcedP5Visual({ feature, full }: { feature: FeatureStudyEntry; full: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.r6.tabsa.studyTable';
  const data = feature.data as Record<string, unknown>;
  const rows = ((data.rows as ForcedRow[] | undefined) ?? []).filter(r => r && typeof r === 'object');
  const baseline = num(data.baselineRedPct);
  const comparison = (data.comparison && typeof data.comparison === 'object' ? data.comparison : {}) as Record<string, ForcedComparison | undefined>;
  const withR3 = comparison.withR3Forced;
  const withoutR3 = comparison.withoutR3Forced;
  const min = LOW_SAMPLE_N;

  const columns: StatColumn<ForcedRow>[] = [
    { key: 'round', label: t(`${k}.forcedRound`), title: t(`${k}.forcedRoundTitle`) },
    { key: 'threeRedPct', label: t(`${k}.threeRedRate`), format: v => pctText(v, 2), align: 'right', n: 'n', lowSample: min, tone: 'red', emphasis: true },
  ];
  if (full) {
    columns.push({ key: 'ci', label: t(`${k}.ciComputed`), align: 'right', value: r => r.threeRedPct, format: (_v, r) => <CiText ci={wilsonFromRate(r.threeRedPct, r.n)} /> });
  }
  columns.push({ key: 'deltaThreeRed', label: t(`${k}.deltaThreeRed`), align: 'right', format: v => signedPp(v), tone: r => (r.deltaThreeRed >= 0 ? 'red' : 'blue') });
  if (full) {
    columns.push(
      { key: 'deltaThreeBlueDead', label: t(`${k}.deltaThreeBlueDead`), align: 'right', format: v => signedPp(v), tone: 'amber' },
      { key: 'deltaThreeBlueAlive', label: t(`${k}.deltaThreeBlueAlive`), align: 'right', format: v => signedPp(v), tone: 'blue' },
    );
  }

  interface CompareRow { key: string; label: string; c: ForcedComparison }
  const compareRows: CompareRow[] = [];
  if (withR3) compareRows.push({ key: 'with', label: t(`${k}.withR3`), c: withR3 });
  if (withoutR3) compareRows.push({ key: 'without', label: t(`${k}.withoutR3`), c: withoutR3 });

  return (
    <div className="space-y-2.5">
      <StatTable
        columns={columns}
        rows={rows}
        rowKey={r => r.round}
        footnote={
          <>
            {baseline !== null && t(`${k}.forcedBaseline`, { baseline: baseline.toFixed(2) })} <LowHint min={min} />
            {full && <> <ComputedCiHint /></>}
          </>
        }
      />
      {compareRows.length > 0 && (full ? (
        <StatTable
          caption={<span className="text-[11px] font-semibold text-zinc-500">{t(`${k}.r3Compare`)}</span>}
          columns={[
            { key: 'label', label: t(`${k}.group`), value: r => r.label },
            { key: 'rate', label: t(`${k}.threeRedRate`), value: r => r.c.threeRedPct, format: v => pctText(v, 2), align: 'right', n: r => r.c.n, tone: 'red' },
            { key: 'ci', label: t(`${k}.ciComputed`), align: 'right', value: r => r.c.threeRedPct, format: (_v, r) => <CiText ci={wilsonFromRate(r.c.threeRedPct, r.c.n)} /> },
            { key: 'delta', label: t(`${k}.deltaBaseline`), align: 'right', value: r => r.c.deltaBaseline, format: v => signedPp(v) },
          ]}
          rows={compareRows}
          rowKey={r => r.key}
        />
      ) : (
        <p className="text-xs text-zinc-400">
          {t(`${k}.r3CompareLine`, {
            withRate: pctText(withR3?.threeRedPct, 2), withN: withR3?.n ?? '—',
            withoutRate: pctText(withoutR3?.threeRedPct, 2), withoutN: withoutR3?.n ?? '—',
          })}
        </p>
      ))}
    </div>
  );
}
