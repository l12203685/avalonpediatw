import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import DiscoveryList from '../discovery/DiscoveryList';
import { useDiscoveryNav } from '../discovery/discoveryNav';
import TwoRedCohortView from '../cohort/TwoRedCohortView';
import { SectionTabs, useSectionTab } from '../ui';

type FindingsView = 'discovery' | 'twoRedCohort';

/**
 * 發現與策略（2026-11-16 Edward：「數據分析有點太多太亂 也不知道怎麼去看數據或是從數據衍生出可以改善或優化的策略和方向」）：
 * 原本放在陣容強度底下、但跟每個分頁都有關的兩塊搬到這裡，放在總覽後面：
 *  - 自動發現：全部分析分頁的發現清單（每張卡附可以怎麼做）；其他分頁底下的自動發現「看全部」切到這裡（discoveryNav）。
 *  - 兩紅派隊分組：兩紅之後的派隊依 PR 分組與 S × PR 九宮格（cohort/TwoRedCohortView）；玩家雷達的「看各組」切到這裡。
 * 舊的陣容強度小分頁記憶（analysis.strength = discovery／twoRedCohort）讀不到就回到陣容強度的第一個小分頁，不會壞。
 */
export default function FindingsTab(): JSX.Element {
  const { t } = useTranslation('common');
  const items: { id: FindingsView; label: string }[] = [
    { id: 'discovery', label: t('analytics.analysis.findings.discovery') },
    { id: 'twoRedCohort', label: t('analytics.analysis.findings.twoRedCohort') },
  ];
  const [active, setView] = useSectionTab<FindingsView>(items, { defaultValue: 'discovery', persistKey: 'analysis.findings' });
  const view: FindingsView = active ?? 'discovery';
  const nav = useDiscoveryNav();
  useEffect(() => {
    if (nav.view !== 'discovery' && nav.view !== 'twoRedCohort') return;
    setView(nav.view);
    nav.consumeView();
  }, [nav.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <SectionTabs items={items} value={view} onChange={setView} ariaLabel={t('analytics.analysis.tabs.findings')}>
      {(v) => (v === 'twoRedCohort' ? <TwoRedCohortView /> : <DiscoveryList />)}
    </SectionTabs>
  );
}
