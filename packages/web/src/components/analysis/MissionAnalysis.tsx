import { useState, useEffect } from 'react';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisMissions, getErrorMessage } from '../../services/api';
import type { MissionAnalysisData } from '../../services/api';
import {
  Advanced, GlanceLegend, GlanceRow, SectionTabs, SplitBar, StatTable, Takeaway, Term, OUTCOME_COLORS, formatInt, formatRate, type StatColumn,
} from './ui';
import { useRoundsData } from './teams/useTeamsData';
import { missionRatesGlance, missionSwingGlance, pctText, restText } from './core/glance';
import { sampleText, sentenceText, winLegend, winSegments } from './core/glanceView';
import OutcomeBlocksTable, { useMinCellGames, type OutcomeGroup } from './OutcomeBlocksTable';
import { useAnalysisOverview } from './useAnalysisOverview';

/**
 * 任務分析 — Edward 2026-04-26 spec
 *
 * The mission pass-rate chart stays as-is (it's about missions, not game
 * outcomes). The "任務結果與最終勝負關聯" table now expands the final result
 * into three outcomes (三紅 / 三藍死 / 三藍活) instead of collapsing the blue
 * win into a single bar.
 *
 * (2026-10-14 Edward：一頁一屏、能用表格就不用圖、比率要用條件機率並附 n)
 *   - 兩張長條圖 (通過率、失敗票分布) 合成一張數字表：每輪 n = 打到這一輪的局數、通過率、
 *     1 張／2+ 張失敗的比例。五個數字的高低一眼就看得出來，長條圖沒有多說什麼。
 *   - 「任務結果 → 結局」從八組堆疊長條改成 OutcomeBlocksTable：第 k 輪通過／失敗的局裡
 *     任務結果 (三紅率)、刺殺結果 (三藍死 ÷ 三藍局，附三藍局數)、遊戲結果 (紅方最終勝)，
 *     最上面一列是全部局當對照。舊的「三藍死 %」除以全部局，不是刺殺成功率。
 *   - 兩張表用 SectionTabs 分成兩頁，桌機一頁一屏。
 *   - 「通過」沿用快取口徑：該輪 0 張失敗票 (generate_cache.py compute_missions)；表下註明。
 *
 * (2026-10-28 Edward：結果更直觀、名詞白話；修正)
 *   - 舊表把「0 張失敗票」標成「通過率」：第 4 個任務 (7 人以上) 1 張失敗票仍然成功，所以任務 4 的「通過率」
 *     65.7% 跟派隊分頁的成功率 84.1% 對不起來。改成：成功率 (照規則，跟派隊 › 任務進程同一份 /rounds 資料)
 *     + 0／1／2+ 張失敗票三欄；/rounds 沒有時成功率顯示「—」。
 *   - 「任務 → 結局」的分組沿用快取 (0 張失敗＝通過)：第 4 輪那兩列改叫「0 張失敗票／有失敗票」，不再說成敗。
 *   - 兩頁最上面各一句話 (從資料當下算)：最難／最容易成功的任務；結局差最多的那一輪。
 *
 * (2026-11-25 站長：「希望能更直觀讓看到的人一目瞭然」)
 *   - 成功率：五個任務各一格 (大數字＋成功｜失敗比例條＋小字局數)，最難／最容易的那格有標記；
 *     0／1／2+ 張失敗票的表收進「進階」。
 *   - 任務 → 結局：每個任務成功的局、失敗的局各一條「藍方贏｜紅方贏」比例條；三種結局的完整表收進「進階」。
 *     一句話改成用藍方最後贏的比例說 (跟總覽、湖中女神同一種說法)，數字跟長條出自同一個 helper (core/glance.ts)。
 *   - 算法都沒有改：成功率照舊用 /rounds 的 roundProgression，藍方贏＝三藍活 ÷ 那一組的局數 (＝100% − 紅方最後贏)。
 */

type MissionView = 'pass' | 'outcome';

interface PassRow {
  round: number;
  n: number;
  /** 照規則的任務成功率 (/rounds roundProgression)；沒有時 null。 */
  successRate: number | null;
  zeroFail: number | null;
  oneFail: number | null;
  twoFail: number | null;
}

export default function MissionAnalysis(): JSX.Element {
  const { t } = useTranslation('common');
  const [data, setData] = useState<MissionAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { overview } = useAnalysisOverview();
  const { data: rounds } = useRoundsData();
  const min = useMinCellGames();
  const k = 'analytics.r6.tabsa.missions';

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        const d = await fetchAnalysisMissions();
        if (!cancelled) setData(d);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return (): void => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.mission.loading')}
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

  const share = (part: number, total: number): number | null => (total > 0 ? (part / total) * 100 : null);
  const progression = ['第一局', '第二局', '第三局', '第四局', '第五局'].map(key => rounds?.roundProgression?.[key]);
  const passRows: PassRow[] = (data.missionPassRates ?? []).map(m => {
    const dist = (data.missionOutcomeByRound ?? []).find(o => o.round === m.round);
    // roundProgression 的鍵 第一局..第五局 (generate_cache.py round_labels)；局數對得上才用 (不同篩選／快取不混用)
    const prog = progression[m.round - 1];
    return {
      round: m.round,
      n: m.totalGames,
      successRate: prog && prog.total === m.totalGames && Number.isFinite(prog.bluePct) ? prog.bluePct : null,
      zeroFail: dist ? share(dist.allPass, dist.total) : m.passRate,
      oneFail: dist ? share(dist.oneFail, dist.total) : null,
      twoFail: dist ? share(dist.twoFail, dist.total) : null,
    };
  });

  const passColumns: StatColumn<PassRow>[] = [
    { key: 'round', label: t(`${k}.round`), value: r => t('analytics.deep.mission.missionLabel', { round: r.round }) },
    { key: 'n', label: t(`${k}.reached`), title: t(`${k}.reachedTitle`), format: 'int', className: 'text-zinc-400' },
    {
      key: 'successRate', label: t('analytics.r7.missions.success'), term: 'missionSuccessRate', format: 'pct', emphasis: true,
      bar: { color: OUTCOME_COLORS.三藍活 }, tone: 'blue', lowSample: min, n: r => (r.n < min ? r.n : null),
    },
    { key: 'zeroFail', label: t('analytics.r7.missions.zeroFail'), term: 'failCards', format: 'pct', className: 'text-zinc-400' },
    { key: 'oneFail', label: t('analytics.deep.mission.fail1'), term: 'failCards', format: 'pct', bar: { color: OUTCOME_COLORS.三藍死 } },
    { key: 'twoFail', label: t('analytics.deep.mission.fail2'), term: 'failCards', format: 'pct', bar: { color: OUTCOME_COLORS.三紅 } },
  ];
  const rates = missionRatesGlance(passRows);
  const m4 = passRows.find(r => r.round === 4);

  const corr = (data.missionOutcomeCorrelation ?? []).filter(c => c.round <= 4);
  const groups: OutcomeGroup[] = [];
  if (overview?.outcomeBreakdown) {
    groups.push({ key: 'all', label: t('analytics.r6.tabsa.outcomeTable.all'), counts: overview.outcomeBreakdown, reference: true });
  }
  for (const c of corr) {
    // 第 4 輪：快取以「0 張失敗票」分組，但 7 人以上 1 張失敗票任務仍成功 → 不說成敗，只說有沒有失敗票
    const r4 = c.round === 4;
    groups.push(
      { key: `p${c.round}`, label: t(r4 ? 'analytics.r7.missions.r4Zero' : `${k}.passed`, { round: c.round }), counts: c.passedOutcomes, tone: 'blue' },
      { key: `f${c.round}`, label: t(r4 ? 'analytics.r7.missions.r4Some' : `${k}.failed`, { round: c.round }), counts: c.failedOutcomes, tone: 'red' },
    );
  }
  const swing = missionSwingGlance(corr);
  const g = 'analytics.glance.missions';
  const thin = (n: number): string | undefined => (n < min ? t('analytics.glance.thin') : undefined);

  const items = [
    { id: 'pass' as MissionView, label: t(`${k}.tabs.pass`) },
    { id: 'outcome' as MissionView, label: t(`${k}.tabs.outcome`) },
  ];

  return (
    <SectionTabs items={items} persistKey="analysis.missions" ariaLabel={t('analytics.analysis.tabs.missions')}>
      {(view) => (view === 'pass' ? (
        <div className="space-y-2">
          {rates.sentence && (
            <Takeaway>
              <p>
                {sentenceText(t, rates.sentence)}
                {m4?.oneFail !== null && m4?.oneFail !== undefined && t('analytics.r7.missions.m4', { rate: formatRate(m4.oneFail) })}
              </p>
            </Takeaway>
          )}
          {rates.rows.length > 0 && (
            <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3" data-testid="mission-rates-glance">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h4 className="text-xs font-semibold text-zinc-300"><Term term="missionSuccessRate">{t(`${g}.ratesTitle`)}</Term></h4>
                <GlanceLegend items={[{ name: t(`${g}.success`), tone: 'blue' }, { name: t(`${g}.fail`), tone: 'red' }]} />
              </div>
              <div className="grid gap-x-3 gap-y-2.5 sm:grid-cols-5">
                {rates.rows.map(r => {
                  const sample = t(`${g}.reached`, { n: formatInt(r.success.n) });
                  return (
                    <div key={r.round} className="flex min-w-0 items-center gap-3 sm:block" data-testid={`mission-rate-${r.round}`}>
                      <div className="w-20 shrink-0 sm:mb-1 sm:w-auto">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                          {t(`${g}.mission`, { round: r.round })}
                          {(r.round === rates.hardest || r.round === rates.easiest) && (
                            <span className="rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-200">
                              {t(r.round === rates.hardest ? `${g}.hardest` : `${g}.easiest`)}
                            </span>
                          )}
                        </div>
                        <div className="text-2xl font-black leading-tight tabular-nums text-white">{pctText(r.success.pct)}</div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <SplitBar
                          sample={sample}
                          segments={[
                            { pct: r.success.pct, text: pctText(r.success.pct), name: t(`${g}.success`), tone: 'blue' },
                            { pct: 100 - r.success.pct, text: restText(r.success.pct), name: t(`${g}.fail`), tone: 'red' },
                          ]}
                        />
                        <div className="mt-0.5 text-[11px] tabular-nums text-zinc-500">{sample}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          <Advanced title={t(`${g}.ratesAdvanced`)} testId="mission-rates-advanced">
            {() => (
              <StatTable
                caption={t(`${k}.passCaption`)}
                columns={passColumns}
                rows={passRows}
                rowKey={r => String(r.round)}
                footnote={t('analytics.r7.missions.passNote')}
              />
            )}
          </Advanced>
        </div>
      ) : corr.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-6 text-center text-xs text-zinc-500">
          {t(`${k}.noCorrelation`)}
        </p>
      ) : (
        <div className="space-y-2">
          {swing.sentence && <Takeaway><p>{sentenceText(t, swing.sentence)}</p></Takeaway>}
          {swing.rows.length > 0 && (
            <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3" data-testid="mission-swing-glance">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h4 className="text-xs font-semibold text-zinc-300">{t(`${g}.swingTitle`)}</h4>
                <GlanceLegend items={winLegend(t)} />
              </div>
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                {swing.rows.map(r => {
                  // 任務 4：這份分組只分有沒有失敗票 (7 人以上 1 張失敗票任務仍成功)，不說成敗
                  const r4 = r.round === 4;
                  return (
                    <div key={r.round} className="min-w-0 space-y-1.5" data-testid={`mission-swing-${r.round}`}>
                      <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-100">
                        {t(`${g}.mission`, { round: r.round })}
                        {r.round === swing.widest && (
                          <span className="rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-200">{t(`${g}.widest`)}</span>
                        )}
                      </div>
                      <GlanceRow label={t(r4 ? `${g}.zeroFailAfter` : `${g}.passedAfter`)} sample={sampleText(t, r.passed.n)} thin={thin(r.passed.n)}>
                        <SplitBar segments={winSegments(t, r.passed)} sample={sampleText(t, r.passed.n)} />
                      </GlanceRow>
                      <GlanceRow label={t(r4 ? `${g}.someFailAfter` : `${g}.failedAfter`)} sample={sampleText(t, r.failed.n)} thin={thin(r.failed.n)}>
                        <SplitBar segments={winSegments(t, r.failed)} sample={sampleText(t, r.failed.n)} />
                      </GlanceRow>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          <Advanced title={t(`${g}.swingAdvanced`)} testId="mission-swing-advanced">
            {() => (
              <OutcomeBlocksTable
                caption={t(`${k}.outcomeCaption`)}
                rows={groups}
                groupLabel={t(`${k}.group`)}
                footnote={t('analytics.r7.missions.outcomeNote')}
              />
            )}
          </Advanced>
        </div>
      ))}
    </SectionTabs>
  );
}
