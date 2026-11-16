import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import LakeAnalysis from '../LakeAnalysis';
import { FeatureStudyCard } from '../../analytics/FeatureStudiesPanel';
import { MoreDetails, SectionTabs } from '../ui';

// 2026-11-16 Edward「數據分析太多太亂」：少用的區塊收進最後一個小分頁「更多細節」（每塊預設收起，內容沒有刪）
type LakeTabView = 'faction' | 'holderRole' | 'targetRole' | 'claim' | 'more';

/**
 * 湖中女神：LakeAnalysis + L141 (宣告可信度) + L142 (言行一致度)。
 *
 * (2026-10-14 Edward：頁面不要拉太長，分頁切過去一頁顯示全部) 原本一頁約 5 個螢幕高，
 * 改成 SectionTabs 五頁：陣營、持湖角色、被湖角色 (三頁共用「第幾次湖」的選擇)、
 * 宣告可信度 (L141)、言行一致 (L142)；每頁桌機一屏。
 */
export default function LakeTab(): JSX.Element {
  const { t } = useTranslation('common');
  const [lake, setLake] = useState(0);
  const k = 'analytics.r6.tabsa.lake.tabs';
  const items: { id: LakeTabView; label: string }[] = [
    { id: 'faction', label: t(`${k}.faction`) },
    { id: 'holderRole', label: t(`${k}.holderRole`) },
    { id: 'targetRole', label: t(`${k}.targetRole`) },
    { id: 'claim', label: t(`${k}.claim`) },
    { id: 'more', label: t('analytics.analysis.more.tab') },
  ];
  return (
    <SectionTabs items={items} persistKey="analysis.lake" ariaLabel={t('analytics.analysis.tabs.lake')}>
      {(view) => {
        if (view === 'claim') return <FeatureStudyCard loopId="L141" defaultOpen />;
        if (view === 'more') return <MoreDetails items={[{ id: 'l142', title: t(`${k}.consistency`), render: () => <FeatureStudyCard loopId="L142" defaultOpen /> }]} />;
        return <LakeAnalysis view={view} lake={lake} onLakeChange={setLake} />;
      }}
    </SectionTabs>
  );
}
