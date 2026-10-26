import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { useStatsFilter } from '../../../stats/statsFilter';

/**
 * 有篩選時，標在不隨篩選變動的區塊上 (docs/stats/filter_engine.md：L141 以外的特徵研究、精算榜等沒有可重算的
 * 引擎，介面須標示「此區塊不隨篩選變動」)。沒有篩選時不顯示。
 */
export default function NotFilteredNote({ text }: { text?: string }): JSX.Element | null {
  const { t } = useTranslation('common');
  const active = useStatsFilter((s) => s.key !== '');
  if (!active) return null;
  return (
    <p className="mb-2 inline-flex items-start gap-1.5 rounded-md border border-amber-700/60 bg-amber-950/40 px-2 py-1 text-xs text-amber-200" data-testid="not-filtered-note">
      <Info size={12} className="mt-0.5 shrink-0" />
      {text ?? t('analytics.filter.notFiltered')}
    </p>
  );
}
