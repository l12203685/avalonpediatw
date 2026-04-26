import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Legend,
} from 'recharts';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisSeatOrder, getErrorMessage } from '../../services/api';
import type { SeatOrderData } from '../../services/api';

const RED        = '#ef4444';
const BLUE_DEAD  = '#f59e0b';
const BLUE_ALIVE = '#3b82f6';

/**
 * 派/梅/娜順序分析 — Edward 2026-04-26 spec
 *
 * Already had the three outcomes baked into the cache, so the only
 * structural change here is reordering the stacked bar segments to match
 * the new fixed display order: 三紅 → 三藍死 → 三藍活, plus i18n.
 */
export default function SeatOrderAnalysis(): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<SeatOrderData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchAnalysisSeatOrder();
        if (!cancelled) setData(d);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.seatOrder.loading')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  if (data.permutations.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        {t('analytics.deep.seatOrder.noData')}
      </div>
    );
  }

  // Reorder columns to fixed display order 三紅 → 三藍死 → 三藍活.
  const outcomeData = data.permutations.map(p => ({
    name: p.order,
    threeRed:        p['三紅pct'],
    threeBlueDead:   p['三藍梅死pct'],
    threeBlueAlive:  p['三藍梅活pct'],
  }));

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-1">{t('analytics.deep.seatOrder.title')}</h3>
        <p className="text-[10px] text-gray-600 mb-3">
          {t('analytics.deep.seatOrder.sub', { games: data.totalGames, rate: data.overallRedWinRate })}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.permutations.map(p => {
            const threeRedPct       = p['三紅pct'];
            const threeBlueDeadPct  = p['三藍梅死pct'];
            const threeBlueAlivePct = p['三藍梅活pct'];
            return (
              <div key={p.order} className="bg-gray-800/40 rounded-lg p-3 space-y-2">
                <div className="flex justify-between items-center">
                  <p className="text-sm font-bold text-white">{p.order}</p>
                  <p className="text-xs text-gray-500">{p.total} {t('analytics.deep.seatOrder.gamesLabel')}</p>
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span style={{ color: RED }}>{t('analytics.deep.outcomes.threeRed')}</span>
                    <span className="text-white font-bold">{threeRedPct}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: BLUE_DEAD }}>{t('analytics.deep.outcomes.threeBlueDead')}</span>
                    <span className="text-white font-bold">{threeBlueDeadPct}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: BLUE_ALIVE }}>{t('analytics.deep.outcomes.threeBlueAlive')}</span>
                    <span className="text-white font-bold">{threeBlueAlivePct}%</span>
                  </div>
                </div>
                <div className="flex h-2 w-full overflow-hidden rounded bg-zinc-800">
                  <div style={{ width: `${threeRedPct}%`,        backgroundColor: RED        }} />
                  <div style={{ width: `${threeBlueDeadPct}%`,   backgroundColor: BLUE_DEAD  }} />
                  <div style={{ width: `${threeBlueAlivePct}%`,  backgroundColor: BLUE_ALIVE }} />
                </div>
              </div>
            );
          })}
        </div>
      </motion.div>

      {/* Per-permutation outcome distribution stacked bar */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">{t('analytics.deep.seatOrder.outcomeTitle')}</h3>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={outcomeData}>
            <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#d1d5db' }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} tickFormatter={(v: number) => `${v}%`} />
            <Tooltip
              formatter={(val: unknown) => `${val}%`}
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              itemStyle={{ color: '#d1d5db' }}
            />
            <Legend />
            <Bar dataKey="threeRed"        name={t('analytics.deep.outcomes.threeRed')}       fill={RED}        stackId="a" />
            <Bar dataKey="threeBlueDead"   name={t('analytics.deep.outcomes.threeBlueDead')}  fill={BLUE_DEAD}  stackId="a" />
            <Bar dataKey="threeBlueAlive"  name={t('analytics.deep.outcomes.threeBlueAlive')} fill={BLUE_ALIVE} stackId="a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Interleaving table */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-1">{t('analytics.deep.seatOrder.interleaveTitle')}</h3>
        <p className="text-[10px] text-gray-600 mb-3">{t('analytics.deep.seatOrder.interleaveSub')}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left  py-2 px-2 text-gray-400">{t('analytics.deep.seatOrder.permCol')}</th>
                <th className="text-right py-2 px-2 text-gray-400">{t('analytics.deep.seatOrder.gamesLabel')}</th>
                <th className="text-right py-2 px-2 text-gray-400">{t('analytics.deep.seatOrder.interleaveCount')}</th>
                <th className="text-right py-2 px-2 text-gray-400">{t('analytics.deep.seatOrder.interleaveRateCol')}</th>
                <th className="text-right py-2 px-2 text-gray-400">{t('analytics.deep.seatOrder.interleaveRedRate')}</th>
                <th className="text-right py-2 px-2 text-gray-400">{t('analytics.deep.seatOrder.noInterleaveRedRate')}</th>
                <th className="text-right py-2 px-2 text-gray-400">{t('analytics.deep.seatOrder.overallRedRate')}</th>
              </tr>
            </thead>
            <tbody>
              {data.permutations.map(p => (
                <tr key={p.order} className="border-b border-gray-800">
                  <td className="py-2 px-2 text-white font-bold">{p.order}</td>
                  <td className="py-2 px-2 text-right text-gray-300">{p.total}</td>
                  <td className="py-2 px-2 text-right text-purple-400">{p['穿插任務']}</td>
                  <td className="py-2 px-2 text-right text-purple-400">{p['穿插率']}%</td>
                  <td className={`py-2 px-2 text-right font-bold ${p['穿插紅勝率'] >= 50 ? 'text-red-400' : 'text-blue-400'}`}>
                    {p['穿插紅勝率']}%
                  </td>
                  <td className={`py-2 px-2 text-right font-bold ${p['無穿插紅勝率'] >= 50 ? 'text-red-400' : 'text-blue-400'}`}>
                    {p['無穿插紅勝率']}%
                  </td>
                  <td className={`py-2 px-2 text-right font-bold ${p.redWinRate >= 50 ? 'text-red-400' : 'text-blue-400'}`}>
                    {p.redWinRate}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-2">{t('analytics.deep.seatOrder.conclusionTitle')}</h3>
        <ul className="text-xs text-gray-300 space-y-2 list-disc list-inside">
          <li>{t('analytics.deep.seatOrder.concl1')}</li>
          <li>{t('analytics.deep.seatOrder.concl2')}</li>
          <li>{t('analytics.deep.seatOrder.concl3')}</li>
        </ul>
      </motion.div>
    </div>
  );
}
