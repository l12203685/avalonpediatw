import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAnalysisOverview } from './useAnalysisOverview';

/**
 * 位置勝率圖 — 2026-10-12 從 OverviewPanel 搬到「位置」分頁。
 * 資料是 overview.seatPositionWinRates (任務結算口徑的整體勝率 + 各角色勝率)，
 * tooltip 另附三種結果分布 (快取有 outcomes 時)。
 */

// Canonical role names only. The old short forms (娜美/德魯/奧伯/派西)
// have been purged from analysis_cache.json.
const ROLE_COLORS: Record<string, string> = {
  '刺客': '#ef4444',
  '莫甘娜': '#f87171',
  '莫德雷德': '#fb923c',
  '奧伯倫': '#fbbf24',
  '派西維爾': '#3b82f6',
  '梅林': '#60a5fa',
  '忠臣': '#93c5fd',
};

export default function SeatPositionChart(): JSX.Element | null {
  const { t } = useTranslation('common');
  const { overview, loading } = useAnalysisOverview();

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-gray-500">
        <Loader size={14} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }

  const seatData = overview?.seatPositionWinRates ?? [];
  if (seatData.length === 0) return null;

  return (
    <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
      <h3 className="text-sm font-bold text-gray-400 mb-1">{t('analytics.deep.overview.seatPositionTitle')}</h3>
      <p className="text-[10px] text-gray-600 mb-2">{t('analytics.deep.overview.seatPositionSub')}</p>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={seatData}>
          <XAxis dataKey="seat" tick={{ fontSize: 11, fill: '#d1d5db' }} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const d = payload[0].payload as typeof seatData[number];
              return (
                <div className="bg-gray-800 border border-gray-600 rounded-lg p-3 text-xs">
                  <p className="font-bold text-gray-200 mb-1">{t('analytics.deep.overview.seatGames', { seat: d.seat, games: d.totalGames })}</p>
                  <p className="text-gray-300 mb-1">{t('analytics.deep.overview.overallWinRate')}: {d.overallWinRate}%</p>
                  {d.outcomes && (
                    <p className="mb-2 text-[10px]">
                      <span className="text-red-300">{t('analytics.deep.outcomes.threeRed')} {d.outcomes.threeRedPct}%</span>
                      <span className="mx-1 text-gray-600">·</span>
                      <span className="text-amber-300">{t('analytics.deep.outcomes.threeBlueDead')} {d.outcomes.threeBlueDeadPct}%</span>
                      <span className="mx-1 text-gray-600">·</span>
                      <span className="text-blue-300">{t('analytics.deep.outcomes.threeBlueAlive')} {d.outcomes.threeBlueAlivePct}%</span>
                    </p>
                  )}
                  {d.roles.map(r => (
                    <p key={r.role} style={{ color: ROLE_COLORS[r.role] || '#9ca3af' }}>
                      {r.role}: {r.winRate}% ({r.games} {t('analytics.deep.common.games')})
                    </p>
                  ))}
                </div>
              );
            }}
          />
          <Bar dataKey="overallWinRate" name={t('analytics.deep.overview.overallWinRate')} radius={[4, 4, 0, 0]}>
            {seatData.map((_, i) => (
              <Cell key={i} fill={i < 5 ? '#6366f1' : '#8b5cf6'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="text-[10px] text-gray-600 mt-2">{t('analytics.deep.overview.seatPositionBasis')}</p>
    </div>
  );
}
