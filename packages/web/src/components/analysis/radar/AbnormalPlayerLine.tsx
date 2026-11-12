import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ABNORMAL_MEASURES, abnormalRatio, abnormalRecords, playerTier, sumAbnormal,
  type AbnormalMeasure, type PlayerTier,
} from '@avalon/shared/stats';
import { useCohortCuts } from '../../../stats/cohortCuts';
import { InfoTip } from '../ui';
import { useAbnormalCohort } from '../cohort/useCohortData';
import { cohortPct } from '../cohort/cohortFormat';

/** 自己的分母不到這個值時變淡（差一張就差 10 個百分點以上）。 */
export const ABNORMAL_PLAYER_MIN_N = 10;

const C = 'analytics.cohort.abnormal';

/**
 * 玩家雷達「兩紅之後」：這位玩家兩紅之後的異常票（全部的票，站長 2026-11-12 的定義，@avalon/shared abnormalVotes.ts）——
 * 內黑率、內黑正確率、外白率、外白正確率，每個後面是對照組（跟下面派隊表的「對照組」同一個：自己的 PR 組或全體）的同一個數字。
 * 對照組不含這位玩家自己的票，每一筆照當局的 PR 分組；自己的分母不到 ABNORMAL_PLAYER_MIN_N 的指標變淡。
 * 跟著篩選；算不出來時不顯示（不擋派隊表）。
 */
export default function AbnormalPlayerLine({ name, tier }: { name: string; tier: PlayerTier | null }): JSX.Element | null {
  const { t } = useTranslation('common');
  const cuts = useCohortCuts((s) => s.cuts);
  const state = useAbnormalCohort();
  const records = state.status === 'ok' ? state.data.records : null;
  const sums = useMemo(() => {
    if (!records) return null;
    const twoRed = abnormalRecords(records, 'twoRed');
    const mine = sumAbnormal(twoRed.filter((r) => r.player === name));
    const ref = sumAbnormal(twoRed.filter((r) => r.player !== name && (tier === null || playerTier(r.pr, cuts) === tier)));
    return { mine, ref };
  }, [records, name, tier, cuts]);
  if (!sums) return null;
  const refLabel = tier === null ? t('analytics.r6.radar.twoRed.compare.allShort') : t(`analytics.cohort.player.${tier}`);
  const item = (m: AbnormalMeasure): JSX.Element => {
    const mine = abnormalRatio(sums.mine, m, 'all');
    const ref = abnormalRatio(sums.ref, m, 'all');
    return (
      <span
        key={m}
        className={`whitespace-nowrap ${mine.n < ABNORMAL_PLAYER_MIN_N ? 'opacity-50' : ''}`}
        title={t(`${C}.cellTitle.all.${m}`, mine)}
        data-testid={`abnormal-player-${m}`}
      >
        <span className="text-zinc-300">{t(`${C}.measure.all.${m}`)}</span>{' '}
        <span className="font-semibold text-zinc-100">{cohortPct(mine.k, mine.n)}</span>
        <span className="text-zinc-500">{t(`${C}.player.kOfN`, { k: mine.k, n: mine.n })}</span>
        <span className="text-zinc-500">{t(`${C}.player.ref`, { label: refLabel, pct: cohortPct(ref.k, ref.n) })}</span>
      </span>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-400" data-testid="abnormal-player-line">
      <span className="inline-flex items-center gap-1">
        {t(`${C}.player.title`)}
        <InfoTip title={t(`${C}.player.title`)} testId="abnormal-player-info">
          <p>{t(`${C}.help.what`)}</p>
          <p>{t(`${C}.help.all`)}</p>
          <p>{t(`${C}.help.right`)}</p>
          <p>{t(`${C}.player.help`, { min: ABNORMAL_PLAYER_MIN_N })}</p>
        </InfoTip>
      </span>
      {ABNORMAL_MEASURES.map(item)}
    </div>
  );
}
