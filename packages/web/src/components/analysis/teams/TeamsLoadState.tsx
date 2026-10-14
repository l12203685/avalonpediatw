import type { ReactNode } from 'react';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * 派隊各小分頁共用的載入／失敗／尚無資料 (2026-10-14)。小分頁要一屏放得下，所以比舊的 py-20 矮。
 * notGenerated (快取還沒有這段) 或 empty (舊快取這段是空的) 都顯示「下次每日更新後提供」，不當成錯誤。
 */
export default function TeamsLoadState({
  loading, error, notGenerated = false, empty = false, children,
}: {
  loading: boolean;
  error: string | null;
  notGenerated?: boolean;
  empty?: boolean;
  /** 沒有在載入、沒有錯、也不是空的時候顯示。 */
  children: () => ReactNode;
}): JSX.Element {
  const { t } = useTranslation('common');
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-xs text-zinc-400">
        <Loader size={16} className="animate-spin" aria-hidden /> {t('analytics.r6.teams.loading')}
      </div>
    );
  }
  if (notGenerated || (empty && !error)) {
    return (
      <p className="py-10 text-center text-xs text-zinc-500">{t('analytics.r6.teams.pending')}</p>
    );
  }
  if (error !== null) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-xs text-red-400">
        <AlertCircle size={16} aria-hidden /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }
  return <>{children()}</>;
}
