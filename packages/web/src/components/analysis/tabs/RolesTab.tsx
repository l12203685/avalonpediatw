import { useTranslation } from 'react-i18next';
import RoleFinalWinRates from '../RoleFinalWinRates';
import ChemistryMatrix from '../ChemistryMatrix';
import SectionTitle from './SectionTitle';

/** 角色與默契：默契矩陣 + 各角色最終勝率表 (舊快取沒有時隱藏)。 */
export default function RolesTab(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-8">
      <RoleFinalWinRates />
      <div>
        <SectionTitle>{t('analytics.analysis.section.chemistry')}</SectionTitle>
        <ChemistryMatrix />
      </div>
    </div>
  );
}
