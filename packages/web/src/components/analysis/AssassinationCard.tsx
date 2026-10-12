import { motion } from 'framer-motion';
import { Loader, AlertCircle, Crosshair } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAnalysisOverview, deriveStages } from './useAnalysisOverview';

/**
 * 刺殺結算卡 (docs/stats/two_stage_outcome.md)：只算三藍局 —
 * 三藍死 = 刺中、三藍活 = 沒刺中。資料用 overview.assassinationStage；
 * 舊快取沒有時以 merlinKillRate (三藍局刺中率) 推算，並標明。
 */
export default function AssassinationCard(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview, loading, error } = useAnalysisOverview();

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-gray-500">
        <Loader size={14} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }
  if (error || !overview) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-red-400">
        <AlertCircle size={14} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  const stages = deriveStages(overview);
  const legacy = !overview.assassinationStage;
  const killPct = legacy && typeof overview.merlinKillRate === 'number'
    ? overview.merlinKillRate
    : stages.assassination.killPct;
  const survivePct = legacy && typeof overview.merlinKillRate === 'number'
    ? Math.round((100 - overview.merlinKillRate) * 10) / 10
    : stages.assassination.survivePct;
  const { games, merlinKilled, merlinSurvived } = stages.assassination;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
    >
      <div className="flex items-center gap-2 mb-1">
        <Crosshair size={16} className="text-amber-300" />
        <h3 className="text-sm font-bold text-gray-300">{t('analytics.deep.assassination.title')}</h3>
      </div>
      <p className="text-[10px] text-gray-500 mb-3">{t('analytics.deep.assassination.sub')}</p>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="bg-gray-800/40 rounded-lg px-3 py-2">
          <p className="text-xl font-black text-white">{games.toLocaleString()}</p>
          <p className="text-[10px] text-gray-500">{t('analytics.deep.assassination.threeBlueGames')}</p>
        </div>
        <div className="bg-gray-800/40 rounded-lg px-3 py-2">
          <p className="text-xl font-black text-amber-300">{killPct}%</p>
          <p className="text-[10px] text-gray-500">{t('analytics.deep.assassination.killRate')}</p>
          {games > 0 && (
            <p className="text-[10px] text-gray-600">{t('analytics.deep.assassination.killedCount', { count: merlinKilled })}</p>
          )}
        </div>
        <div className="bg-gray-800/40 rounded-lg px-3 py-2">
          <p className="text-xl font-black text-blue-300">{survivePct}%</p>
          <p className="text-[10px] text-gray-500">{t('analytics.deep.assassination.surviveRate')}</p>
          {games > 0 && (
            <p className="text-[10px] text-gray-600">{t('analytics.deep.assassination.survivedCount', { count: merlinSurvived })}</p>
          )}
        </div>
      </div>

      <div className="h-2 w-full rounded-full overflow-hidden flex bg-gray-800">
        <div className="h-full bg-amber-500" style={{ width: `${Math.max(0, Math.min(100, killPct))}%` }} />
        <div className="h-full bg-blue-500" style={{ width: `${Math.max(0, Math.min(100, survivePct))}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-gray-500 mt-1">
        <span className="text-amber-300">{t('analytics.deep.outcomes.threeBlueDead')}</span>
        <span className="text-blue-300">{t('analytics.deep.outcomes.threeBlueAlive')}</span>
      </div>

      <p className="text-[10px] text-gray-600 mt-3">{t('analytics.deep.assassination.rule')}</p>
      {legacy && (
        <p className="text-[10px] text-gray-600 mt-0.5">{t('analytics.deep.assassination.legacy')}</p>
      )}
    </motion.div>
  );
}
