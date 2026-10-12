import { motion } from 'framer-motion';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { Loader, AlertCircle, Trophy, Users, Swords } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fmtPct, fmtSignedPct } from '../../services/api';
import OutcomeBar from './OutcomeBar';
import { useAnalysisOverview, deriveStages, type StageSummaries } from './useAnalysisOverview';

/**
 * 總覽 (2026-10-12 兩段結算改版, docs/stats/two_stage_outcome.md)：
 *  - 卡片：總場次、玩家數、三段結算 (任務結算 → 刺殺結算 → 最終)
 *  - 「理論勝率排行」改為「超額勝率排行 (30 場以上)」(topPlayersByExcess)；
 *    舊快取 (schemaVersion < 2 且沒有 topPlayersByExcess 欄位) 退回 topPlayersByTheory
 *    並把標題標成舊口徑；新快取但沒人達 30 場 (rows 為 []) 顯示「尚無玩家達 30 場」，
 *    不能誤標成「快取尚未重算」
 *  - 三種結果分布、場次排行保留；位置勝率圖搬到「位置」分頁 (SeatPositionChart)
 */

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: typeof Trophy;
  label: string;
  value: string;
  sub?: string;
  color: string;
}): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`bg-avalon-card/40 border rounded-xl p-4 ${color}`}
    >
      <Icon size={18} className="mb-2 opacity-70" />
      <p className="text-2xl font-black">{value}</p>
      <p className="text-xs opacity-60">{label}</p>
      {sub && <p className="text-xs mt-1 opacity-40">{sub}</p>}
    </motion.div>
  );
}

function StageColumn({ label, games, a, b, arrow }: {
  label: string;
  games: string;
  a: { label: string; pct: number; color: string };
  b: { label: string; pct: number; color: string };
  arrow?: boolean;
}): JSX.Element {
  return (
    <div className="relative flex flex-col items-center px-1">
      {arrow && (
        <span className="absolute -left-2 top-1/2 -translate-y-1/2 text-gray-600 text-sm" aria-hidden>→</span>
      )}
      <p className="text-[10px] opacity-70 font-semibold mb-1">{label}</p>
      <div className="flex items-baseline gap-2">
        <span className={`text-base font-black ${a.color}`}>{a.pct}%</span>
        <span className="text-[10px] opacity-50">/</span>
        <span className={`text-base font-black ${b.color}`}>{b.pct}%</span>
      </div>
      <div className="flex gap-3 text-[9px] opacity-60">
        <span>{a.label}</span>
        <span>{b.label}</span>
      </div>
      <p className="text-[9px] opacity-40 mt-0.5">{games}</p>
    </div>
  );
}

/** 三段結算卡：任務結算 紅/藍 → 刺殺結算 刺中/存活 → 最終 紅/藍。 */
function StageCard({ stages }: { stages: StageSummaries }): JSX.Element {
  const { t } = useTranslation('common');
  const g = (n: number): string => t('analytics.deep.overview.stages.gamesSuffix', { count: n });
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="col-span-2 bg-avalon-card/40 border rounded-xl p-4 border-amber-700/50 text-amber-100"
    >
      <div className="flex items-center gap-2 mb-2">
        <Trophy size={18} className="opacity-70 text-amber-300" />
        <p className="text-[10px] opacity-60">{t('analytics.deep.overview.stages.title')}</p>
      </div>
      <div className="grid grid-cols-3 gap-1">
        <StageColumn
          label={t('analytics.deep.overview.stages.mission')}
          games={g(stages.mission.games)}
          a={{ label: t('analytics.deep.overview.stages.red'), pct: stages.mission.redPct, color: 'text-red-300' }}
          b={{ label: t('analytics.deep.overview.stages.blue'), pct: stages.mission.bluePct, color: 'text-blue-300' }}
        />
        <StageColumn
          arrow
          label={t('analytics.deep.overview.stages.assassination')}
          games={g(stages.assassination.games)}
          a={{ label: t('analytics.deep.overview.stages.killed'), pct: stages.assassination.killPct, color: 'text-amber-300' }}
          b={{ label: t('analytics.deep.overview.stages.survived'), pct: stages.assassination.survivePct, color: 'text-blue-300' }}
        />
        <StageColumn
          arrow
          label={t('analytics.deep.overview.stages.final')}
          games={g(stages.final.games)}
          a={{ label: t('analytics.deep.overview.stages.red'), pct: stages.final.redPct, color: 'text-red-300' }}
          b={{ label: t('analytics.deep.overview.stages.blue'), pct: stages.final.bluePct, color: 'text-blue-300' }}
        />
      </div>
      <p className="text-[10px] mt-2 opacity-50">{t('analytics.deep.overview.stages.rule')}</p>
      {stages.derived && (
        <p className="text-[10px] mt-0.5 opacity-40">{t('analytics.deep.overview.stages.derived')}</p>
      )}
    </motion.div>
  );
}

interface ExcessRow { name: string; excessWinRate: number; finalWinRate: number; games: number }
interface LegacyRow { name: string; roleTheory: number; winRate: number; games: number }

const TOOLTIP_STYLE = { backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' };

function ExcessRankingChart({ rows }: { rows: ExcessRow[] }): JSX.Element {
  const { t } = useTranslation('common');
  const maxAbs = Math.max(5, ...rows.map(r => Math.abs(r.excessWinRate))) * 1.15;
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, rows.length * 26)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
        <XAxis type="number" domain={[-maxAbs, maxAbs]} unit="%" tick={{ fontSize: 11, fill: '#9ca3af' }} />
        <YAxis type="category" dataKey="name" width={64} tick={{ fontSize: 11, fill: '#d1d5db' }} />
        <ReferenceLine x={0} stroke="#6b7280" strokeDasharray="2 2" />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          itemStyle={{ color: '#d1d5db' }}
          formatter={(val: unknown, _n, item) => {
            const r = item.payload as ExcessRow;
            return [
              `${fmtSignedPct(Number(val))} · ${t('analytics.deep.overview.finalWinRateColumn')} ${fmtPct(r.finalWinRate)} · ${r.games} ${t('analytics.deep.common.games')}`,
              t('analytics.deep.overview.excessColumn'),
            ];
          }}
        />
        <Bar dataKey="excessWinRate" name={t('analytics.deep.overview.excessColumn')} radius={[0, 4, 4, 0]}>
          {rows.map((r, i) => (
            <Cell key={i} fill={r.excessWinRate < 0 ? '#f43f5e' : i === 0 ? '#f59e0b' : i < 3 ? '#3b82f6' : '#6b7280'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** 舊快取沒有 topPlayersByExcess 時的退路：roleTheory ≈ 任務結算勝率 (舊口徑)。 */
function LegacyTheoryChart({ rows }: { rows: LegacyRow[] }): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, rows.length * 26)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
        <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: '#9ca3af' }} />
        <YAxis type="category" dataKey="name" width={64} tick={{ fontSize: 11, fill: '#d1d5db' }} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          itemStyle={{ color: '#d1d5db' }}
          formatter={(val: unknown) => [`${val}%`, t('analytics.deep.overview.legacyTheoryColumn')]}
        />
        <Bar dataKey="roleTheory" name={t('analytics.deep.overview.legacyTheoryColumn')} radius={[0, 4, 4, 0]}>
          {rows.map((_, i) => (
            <Cell key={i} fill={i === 0 ? '#f59e0b' : i < 3 ? '#3b82f6' : '#6b7280'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function OverviewPanel(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview, loading, error } = useAnalysisOverview();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  // Edward 2026-04-26: Outcome breakdown is THE primary chart now.
  // Three mutually exclusive game results, fixed display order
  // 三紅 → 三藍死 → 三藍活 (matches rank baseline).
  const overallOutcomes = overview.outcomeBreakdown;
  const stages = deriveStages(overview);

  // 新舊快取以欄位有無判斷 (契約：舊快取 = 欄位缺，不是 rows 為空)。資料層對
  // topPlayersByExcess 以 30 場篩選，小資料集的新快取會是 []，不能當成舊快取。
  const isV2 = (overview.schemaVersion ?? 0) >= 2 || Array.isArray(overview.topPlayersByExcess);
  const excessRows = isV2
    ? (overview.topPlayersByExcess ?? [])
      .filter(r => typeof r.excessWinRate === 'number' && Number.isFinite(r.excessWinRate))
      .slice(0, 8)
    : [];
  const legacyRows = isV2 ? [] : (overview.topPlayersByTheory ?? []).slice(0, 8);

  return (
    <div className="space-y-6">
      {/* Summary cards — 2026-10-12: 三段結算 card replaces 三結果 + 梅林擊殺率 cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Swords}
          label={t('analytics.deep.common.totalGames')}
          value={overview.totalGames.toLocaleString()}
          color="border-blue-700/50 text-blue-300"
        />
        <StatCard
          icon={Users}
          label={t('analytics.deep.common.totalPlayers')}
          value={overview.totalPlayers.toString()}
          color="border-purple-700/50 text-purple-300"
        />
        <StageCard stages={stages} />
      </div>

      {/* Outcome breakdown + excess win-rate ranking */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-400 mb-3">{t('analytics.deep.overview.outcomeBreakdown')}</h3>
          <OutcomeBar outcomes={overallOutcomes} variant="rows" showRawCounts={true} />
          <div className="mt-3">
            <OutcomeBar outcomes={overallOutcomes} variant="stacked" />
          </div>
        </div>

        <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-400 mb-1">
            {isV2
              ? t('analytics.deep.overview.excessRanking')
              : t('analytics.deep.overview.excessRankingLegacy')}
          </h3>
          <p className="text-[10px] text-gray-600 mb-2">
            {isV2
              ? t('analytics.deep.overview.excessLegend')
              : t('analytics.deep.overview.excessLegendLegacy')}
          </p>
          {excessRows.length > 0 ? (
            <ExcessRankingChart rows={excessRows} />
          ) : legacyRows.length > 0 ? (
            <LegacyTheoryChart rows={legacyRows} />
          ) : (
            <p className="text-xs text-gray-500 py-6 text-center">
              {isV2 ? t('analytics.deep.overview.excessEmpty') : '—'}
            </p>
          )}
        </div>
      </div>

      {/* Top players by games played */}
      <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
        <h3 className="text-sm font-bold text-gray-400 mb-3">{t('analytics.deep.overview.gamesRanking')}</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={(overview.topPlayersByGames ?? []).slice(0, 10)}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
            <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: '#d1d5db' }} />
            <Bar dataKey="games" name={t('analytics.deep.overview.gamesColumn')} fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
