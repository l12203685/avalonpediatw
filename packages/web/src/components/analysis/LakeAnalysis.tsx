import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisLake, getErrorMessage } from '../../services/api';
import type { LakeAnalysisData, OutcomeBreakdown } from '../../services/api';
import OutcomeBar from './OutcomeBar';

/**
 * 湖中女神分析 — Edward 2026-04-26 spec
 *
 * Tab labels: 首湖/二湖/三湖 → 首位接湖者/第二位接湖者/第三位接湖者
 *   The original labels were too cryptic for non-veteran players. The full
 *   names spell out "first / second / third lake holder" so anyone can read
 *   the chart without prior knowledge of the slang.
 *
 * Every percentage is now expanded into the three game outcomes
 *   (三紅 / 三藍死 / 三藍活) in fixed display order, matching the rank
 *   baseline. Single redWinRate numbers were collapsing too much
 *   information — knowing red wins 52% doesn't tell you the structure of
 *   the remaining 48%.
 *
 * All hard-coded English strings (`holder=target faction`, etc.) have been
 *   replaced with translated keys so the bilingual switch covers them.
 */

export default function LakeAnalysis(): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<LakeAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLake, setSelectedLake] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchAnalysisLake();
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
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.lake.loading')}
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

  const tabLabels: string[] = [
    t('analytics.deep.lake.tabFirst'),
    t('analytics.deep.lake.tabSecond'),
    t('analytics.deep.lake.tabThird'),
  ];
  const currentTabLabel = tabLabels[selectedLake];
  const currentPerLake = data.perLake[selectedLake];
  const currentDetail = data.allLakeRoleStats[selectedLake];

  return (
    <div className="space-y-6">
      {/* Lake selector */}
      <div className="flex flex-wrap gap-2">
        {tabLabels.map((label, i) => (
          <button
            key={label}
            onClick={() => setSelectedLake(i)}
            disabled={!data.perLake[i]}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              selectedLake === i
                ? 'bg-cyan-600 text-white'
                : data.perLake[i]
                  ? 'bg-avalon-card/40 text-gray-500 hover:text-white border border-gray-700'
                  : 'bg-gray-900/30 text-gray-700 cursor-not-allowed border border-gray-800'
            }`}
          >
            {label} {data.perLake[i] ? `(${data.perLake[i].totalGames} ${t('analytics.deep.common.games')})` : ''}
          </button>
        ))}
      </div>

      {currentPerLake && (
        <>
          {/* Holder faction → outcome breakdown */}
          <motion.div
            key={`holder-${selectedLake}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4 space-y-3"
          >
            <h3 className="text-sm font-bold text-gray-400">
              {t('analytics.deep.lake.holderFactionVsRedWin', { lake: currentTabLabel })}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {currentPerLake.holderStats.map(h => (
                <div key={h.faction} className="bg-gray-800/40 rounded-lg p-3 space-y-2">
                  <div className="flex justify-between items-center">
                    <p className={`text-sm font-bold ${h.faction === '紅方' ? 'text-red-400' : 'text-blue-400'}`}>
                      {h.faction === '紅方' ? t('analytics.deep.common.redHeld') : t('analytics.deep.common.blueHeld')}
                    </p>
                    <p className="text-xs text-gray-500">{h.games} {t('analytics.deep.common.games')}</p>
                  </div>
                  <OutcomeBar outcomes={h.outcomes} variant="rows" showRawCounts={true} />
                  <OutcomeBar outcomes={h.outcomes} variant="stacked" />
                </div>
              ))}
            </div>

            {/* Same vs different faction */}
            {currentDetail && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                <SameOrDiffCard
                  title={t('analytics.deep.lake.sameFactionLabel')}
                  games={currentDetail.sameFaction.games}
                  outcomes={currentDetail.sameFaction.outcomes}
                  t={t}
                />
                <SameOrDiffCard
                  title={t('analytics.deep.lake.diffFactionLabel')}
                  games={currentDetail.diffFaction.games}
                  outcomes={currentDetail.diffFaction.outcomes}
                  t={t}
                />
              </div>
            )}
          </motion.div>

          {/* Combo stats: holder × target faction */}
          {currentPerLake.comboStats.filter(c => c.targetFaction !== '').length > 0 && (
            <motion.div
              key={`combo-${selectedLake}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
            >
              <h3 className="text-sm font-bold text-gray-400 mb-3">
                {t('analytics.deep.lake.comboFactionTitle', { lake: currentTabLabel })}
              </h3>
              <div className="space-y-3">
                {currentPerLake.comboStats
                  .filter(c => c.targetFaction !== '')
                  .map((c, i) => (
                    <div key={i} className="bg-gray-800/40 rounded-lg p-3 space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-bold text-gray-300">
                          <span className={c.holderFaction === '紅方' ? 'text-red-400' : 'text-blue-400'}>{c.holderFaction}</span>
                          <span className="text-gray-500 mx-1.5">→</span>
                          <span className={c.targetFaction === '紅方' ? 'text-red-400' : 'text-blue-400'}>{c.targetFaction}</span>
                        </span>
                        <span className="text-xs text-gray-500">{c.games} {t('analytics.deep.common.games')}</span>
                      </div>
                      <OutcomeBar outcomes={c.outcomes} variant="stacked" />
                    </div>
                  ))}
              </div>
            </motion.div>
          )}

          {/* Holder role outcome breakdown */}
          {currentDetail && currentDetail.holderRoleStats.filter(r => r.games >= 5).length > 0 && (
            <motion.div
              key={`hrole-${selectedLake}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
            >
              <h3 className="text-sm font-bold text-gray-400 mb-3">
                {t('analytics.deep.lake.holderRoleVsRedWin', { lake: currentTabLabel })}
              </h3>
              <RoleOutcomeTable rows={currentDetail.holderRoleStats.filter(r => r.games >= 5)} t={t} />
            </motion.div>
          )}

          {/* Target role outcome breakdown */}
          {currentDetail && currentDetail.targetRoleStats.filter(r => r.games >= 5).length > 0 && (
            <motion.div
              key={`trole-${selectedLake}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
            >
              <h3 className="text-sm font-bold text-gray-400 mb-3">
                {t('analytics.deep.lake.targetRoleVsRedWin', { lake: currentTabLabel })}
              </h3>
              <RoleOutcomeTable rows={currentDetail.targetRoleStats.filter(r => r.games >= 5)} t={t} />
            </motion.div>
          )}
        </>
      )}
    </div>
  );
}

function SameOrDiffCard({ title, games, outcomes, t }: {
  title: string;
  games: number;
  outcomes: OutcomeBreakdown;
  t: (k: string, opts?: Record<string, unknown>) => string;
}): JSX.Element {
  return (
    <div className="bg-gray-800/40 rounded-lg p-3 space-y-2">
      <div className="flex justify-between items-center">
        <p className="text-xs font-bold text-gray-300">{title}</p>
        <p className="text-xs text-gray-500">{games} {t('analytics.deep.common.games')}</p>
      </div>
      <OutcomeBar outcomes={outcomes} variant="rows" showRawCounts={true} />
      <OutcomeBar outcomes={outcomes} variant="stacked" />
    </div>
  );
}

interface RoleOutcomeRow {
  role: string;
  games: number;
  outcomes: OutcomeBreakdown;
}

function RoleOutcomeTable({ rows, t }: {
  rows: RoleOutcomeRow[];
  t: (k: string, opts?: Record<string, unknown>) => string;
}): JSX.Element {
  const sorted = [...rows].sort((a, b) => b.games - a.games);
  return (
    <div className="space-y-2">
      {sorted.map(r => (
        <div key={r.role} className="bg-gray-800/40 rounded-lg p-3 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm font-bold text-white">{r.role}</span>
            <span className="text-xs text-gray-500">{r.games} {t('analytics.deep.common.games')}</span>
          </div>
          <OutcomeBar outcomes={r.outcomes} variant="stacked" />
        </div>
      ))}
    </div>
  );
}
