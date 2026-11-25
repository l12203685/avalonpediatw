import { useTranslation } from 'react-i18next';
import type { LakeClaimData } from '../../services/api';
import { FeatureStudyCard, useFeatureStudies } from '../analytics/FeatureStudiesPanel';
import { Advanced, GlanceLegend, KeyNumber, MeterBar, RankRow, Takeaway, formatInt } from './ui';
import { lakeClaimGlance, pctText, type ClaimPair, type Share } from './core/glance';
import { sampleText, sentenceText } from './core/glanceView';

/**
 * 湖中女神 › 宣告可信度（站長 2026-11-25：「希望能更直觀讓看到的人一目瞭然」，第二批）。
 *
 * 原本是研究卡 L141 的兩張數字表（一位小數＋95% 區間＋n=）。現在：
 *  - 一句話：藍方、紅方拿湖說「紅」各有多少是真的；第一次湖不分誰拿，說「紅」、說「藍」各有多少是真的；
 *  - 一個大數字：紅方拿湖說「紅」是真的比例（最不能信的那一種）；
 *  - 長條：照「誰拿湖」和「第幾次湖」各一組，每種宣告一條「是真的」的比例（紅條＝說對方是紅方、藍條＝說對方是藍方），
 *    數字直接寫在旁邊、小字「共 N 次」；
 *  - 原本的表（含 95% 區間）收進「進階」。
 * 數字都來自同一份 /feature-studies 的 L141（每晚從牌譜重算、跟著上方篩選），句子與長條出自 core/glance.ts lakeClaimGlance；
 * 算法沒有改。資料還沒載入、載入失敗或是舊形狀時，直接顯示原本的研究卡（它自己會顯示載入中／錯誤）。
 */
export default function LakeClaimGlance(): JSX.Element {
  const { t } = useTranslation('common');
  const { data, loading, error } = useFeatureStudies();
  const feature = data?.features.find(f => f.loopId === 'L141');
  if (loading || error || !feature || feature.visualType !== 'lakeClaim') {
    return <FeatureStudyCard loopId="L141" defaultOpen />;
  }
  const claim = feature.data as unknown as LakeClaimData;
  const min = typeof claim.minSample === 'number' ? claim.minSample : 30;
  const glance = lakeClaimGlance(claim.rows, claim.holderRows);
  if (glance.byLake.length === 0 && glance.byHolder.length === 0) {
    return <FeatureStudyCard loopId="L141" defaultOpen />;
  }
  const g = 'analytics.glance.claim';
  const bar = (key: string, side: 'red' | 'blue', share: Share | null): JSX.Element | null => {
    if (!share) return null;
    const label = t(side === 'red' ? `${g}.saidRed` : `${g}.saidBlue`);
    const sample = sampleText(t, share.n, 'times');
    return (
      <RankRow key={key} label={label} dot={side} sample={sample} thin={share.n < min ? t('analytics.glance.thin') : undefined}>
        <MeterBar pct={share.pct} text={pctText(share.pct)} tone={side} label={`${label} ${pctText(share.pct)}（${sample}）`} />
      </RankRow>
    );
  };
  const group = (pair: ClaimPair, title: string): JSX.Element => (
    <div key={pair.key} className="space-y-1.5" data-testid={`lake-claim-${pair.key}`}>
      <div className="text-xs font-semibold text-zinc-200">{title}</div>
      {bar(`${pair.key}-red`, 'red', pair.saidRed)}
      {bar(`${pair.key}-blue`, 'blue', pair.saidBlue)}
    </div>
  );
  return (
    <div className="space-y-2">
      {(glance.sentence || glance.lakeSentence) && (
        <Takeaway>
          {glance.sentence && <p>{sentenceText(t, glance.sentence)}</p>}
          {glance.lakeSentence && <p>{sentenceText(t, glance.lakeSentence)}</p>}
        </Takeaway>
      )}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3" data-testid="lake-claim-glance">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h4 className="text-xs font-semibold text-zinc-300">{t(`${g}.title`)}</h4>
          <GlanceLegend items={[{ name: t(`${g}.saidRedLegend`), tone: 'red' }, { name: t(`${g}.saidBlueLegend`), tone: 'blue' }]} />
        </div>
        {glance.redHolderSaidRed && (
          <div className="mb-3">
            <KeyNumber value={pctText(glance.redHolderSaidRed.pct)} label={t(`${g}.key`)} tone="red" />
          </div>
        )}
        <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
          {glance.byHolder.length > 0 && (
            <div className="min-w-0 space-y-3">
              <h4 className="text-xs font-bold text-zinc-100">{t(`${g}.byHolder`)}</h4>
              {glance.byHolder.map(p => group(p, t(p.key === 'red' ? `${g}.redHolder` : `${g}.blueHolder`)))}
            </div>
          )}
          {glance.byLake.length > 0 && (
            <div className="min-w-0 space-y-3">
              <h4 className="text-xs font-bold text-zinc-100">{t(`${g}.byLakeTitle`)}</h4>
              {glance.byLake.map(p => group(p, p.key))}
            </div>
          )}
        </div>
        {typeof claim.undeclared === 'number' && claim.undeclared > 0 && (
          <p className="mt-2 text-[11px] text-zinc-500">{t(`${g}.undeclared`, { n: formatInt(claim.undeclared) })}</p>
        )}
      </section>
      <Advanced title={t(`${g}.advanced`)} testId="lake-claim-advanced">{() => <FeatureStudyCard loopId="L141" defaultOpen />}</Advanced>
    </div>
  );
}
