import { BarChart3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useGameStore } from '../store/gameStore';

/**
 * 「看戰績、排行與分析都不用登入。」+「直接看戰績排行」— shown wherever a login
 * form appears (LoginPage, AuthGateModal). 2026-10-13 players' report: some
 * thought the stats needed a login, and one could not reach the leaderboard.
 * `onNavigate` runs before switching pages (e.g. a modal closes itself).
 */
export default function StatsNoLoginNote({
  onNavigate,
  testId = 'stats-no-login',
}: {
  onNavigate?: () => void;
  testId?: string;
}): JSX.Element {
  const { t } = useTranslation();
  const { setGameState } = useGameStore();
  return (
    <div
      data-testid={testId}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-700/50 bg-emerald-900/20 px-3 py-2"
    >
      <p className="flex-1 min-w-[10rem] text-xs text-emerald-100 leading-relaxed">
        {t('gate.statsNoLogin', { defaultValue: '看戰績、排行與分析都不用登入。' })}
      </p>
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          setGameState('analytics');
        }}
        data-testid={`${testId}-go`}
        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 hover:bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors"
      >
        <BarChart3 size={14} />
        {t('gate.goStats', { defaultValue: '直接看戰績排行' })}
      </button>
    </div>
  );
}
