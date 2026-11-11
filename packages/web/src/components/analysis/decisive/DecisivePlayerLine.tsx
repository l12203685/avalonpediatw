import { useTranslation } from 'react-i18next';
import { useGameStore } from '../../../store/gameStore';
import { rememberDecisiveBoard } from './decisiveLayout';
import { useDecisiveReport } from './useDecisiveReport';

/** 0..1 → 整數百分比（只四捨五入一次）；null → —。 */
const pct = (x: number | null): string => (x === null ? '—' : `${Math.round(x * 100)}%`);

/**
 * 玩家雷達「兩紅之後」最上面的一行：這位玩家在兩紅之後的關鍵票（張數、正確率、外白與內黑的對錯）＋「看排行」
 * （數據排行打開「關鍵外白／內黑」、範圍切到兩紅之後）。跟著篩選；算不出來時不顯示（不擋派隊表）。
 */
export default function DecisivePlayerLine({ name }: { name: string }): JSX.Element | null {
  const { t } = useTranslation('common');
  const state = useDecisiveReport('twoRed');
  if (state.status !== 'ok') return null;
  const { report } = state;
  const row = report.players.find((p) => p.name === name);
  const k = 'analytics.decisive.player';
  const open = (): void => {
    rememberDecisiveBoard('twoRed');
    // 要清掉 statsFocus：戰績排行看到 statsFocus 會再跳回玩家雷達（AnalyticsPage）
    useGameStore.setState({ gameState: 'analytics', statsFocus: null });
    window.scrollTo({ top: 0 });
  };
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-400" data-testid="decisive-player-line">
      <span>
        {row && row.n + row.neutral > 0
          ? t(`${k}.line`, {
            n: row.n,
            raw: pct(row.raw),
            p0: pct(report.all.p0),
            oyR: row.grid.offYes.right, oyW: row.grid.offYes.wrong,
            onR: row.grid.onNo.right, onW: row.grid.onNo.wrong,
          })
          : t(`${k}.none`)}
      </span>
      <button type="button" onClick={open} className="text-amber-300 underline-offset-2 hover:underline" data-testid="decisive-player-link">
        {t(`${k}.link`)}
      </button>
    </p>
  );
}
