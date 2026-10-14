import { useTranslation } from 'react-i18next';
import RoleFinalWinRates from '../RoleFinalWinRates';
import ChemistryMatrix from '../ChemistryMatrix';
import { SectionTabs, type SectionTabItem } from '../ui';

type RolesPage = 'roles' | 'chemistry';

/**
 * 角色與默契：各角色三塊結果 / 默契矩陣。
 *
 * (2026-10-14 Edward：「頁面不要拉太長，最好分頁切過去一頁可以顯示全部該分頁的內容」「角色勝率分三塊」)
 *  原本角色長條 + 默契矩陣上下排 (桌機 1400 px)，改成 SectionTabs 兩個小分頁，各自一屏。
 */
export default function RolesTab(): JSX.Element {
  const { t } = useTranslation('common');
  const items: SectionTabItem<RolesPage>[] = [
    { id: 'roles', label: t('analytics.r6.tabsb.roles.tabs.roles') },
    { id: 'chemistry', label: t('analytics.r6.tabsb.roles.tabs.chemistry') },
  ];
  return (
    <SectionTabs
      items={items}
      persistKey="analysis.roles"
      ariaLabel={t('analytics.r6.tabsb.roles.tabsLabel')}
      size="md"
    >
      {page => (page === 'roles' ? <RoleFinalWinRates /> : <ChemistryMatrix />)}
    </SectionTabs>
  );
}
