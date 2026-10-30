import { useTranslation } from 'react-i18next';
import { Crown } from 'lucide-react';
import { useGameStore } from '../../store/gameStore';
import { InfoTip } from './ui';
import BoardInfo from './BoardInfo';
import { useRoleLabel } from './roleLabels';
import { fmtPct, type AnalysisLeaderboardBoard, type AnalysisRoleTopRow } from '../../services/api';

/**
 * 角色王 (Edward 2026-10-30「角色王可以列出每一個角色對應的勝率 TOP10 的玩家嗎？玩家名稱(勝率) 這樣」)：
 * 每個角色一張小卡，列該角色勝率前 10 名「玩家名稱（勝率%）」，勝率整數。名單與勝率讀快取 roleTitles 榜的 roleTop
 * (generate_cache.compute_leaderboard；上榜條件改過時是瀏覽器端引擎重算的同一份)：上榜門檻、視窗 (忠臣 200 或 100、
 * 其他 50 或 25 場) 與口徑 (該角色最近 W 場的最終勝率) 都跟原本的角色王一樣，第 1 名 (同率並列) 就是角色王。
 * 同一個角色每個人的場數都是該角色的視窗，所以場數 (近 N 場) 寫在卡片標題下，勝場 / 場數放在滑鼠提示。
 * 舊快取沒有 roleTop：只列各角色的角色王 (rows) 並提示下次每日更新。
 * 版面：桌機 7 張卡一列、平板 3–4 欄、手機 2 欄；卡片內名字過長就截斷，不會橫向捲動。
 */

/** 卡片順序：藍方三角 → 紅方四角 (Edward 列的順序)；快取多出來的角色接在後面。 */
const CARD_ORDER: readonly string[] = ['梅林', '派西維爾', '忠臣', '莫德雷德', '莫甘娜', '刺客', '奧伯倫'];
const RED_ROLES = new Set(['刺客', '莫甘娜', '莫德雷德', '奧伯倫']);
const TOP_N = 10;

function rankClass(rank: number): string {
  if (rank === 1) return 'text-amber-300';
  if (rank === 2) return 'text-gray-200';
  if (rank === 3) return 'text-orange-300';
  return 'text-zinc-500';
}

export default function RoleChampions({
  board, isEn, activeDays,
}: {
  board: AnalysisLeaderboardBoard;
  isEn: boolean;
  activeDays: number;
}): JSX.Element {
  const { t } = useTranslation('common');
  const roleLabel = useRoleLabel();
  const openPlayerStats = useGameStore((s) => s.openPlayerStats);
  const title = isEn && board.titleEn ? board.titleEn : board.title;
  const holders = board.rows.filter((r) => r.role);
  const top = board.roleTop;
  const roles = [
    ...CARD_ORDER,
    ...Object.keys(board.roleWindowGames ?? {}),
    ...Object.keys(top ?? {}),
    ...holders.map((r) => r.role as string),
  ].filter((role, i, all) => all.indexOf(role) === i);
  const listFor = (role: string): AnalysisRoleTopRow[] => top?.[role]
    ?? holders.filter((r) => r.role === role).map((r) => ({
      rank: 1, name: r.name, value: r.value, games: r.games, wins: r.wins ?? 0, careerRoleGames: r.careerRoleGames ?? r.games,
    }));
  const shownTop = top ? Math.max(0, ...Object.values(top).map((l) => l.length)) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap">
        <h3 className="text-sm font-bold text-white">{title}</h3>
        <InfoTip title={title} testId="board-info-roleTitles">
          <BoardInfo board={board} isEn={isEn}>
            <p className="text-zinc-400">{t('analytics.boards.principle', { days: activeDays })}</p>
            <p className="text-zinc-400">{t('analytics.r6.boards.roleTop.nHint')}</p>
            <p className="text-zinc-400">{t('analytics.r6.boards.clickHint')}</p>
          </BoardInfo>
        </InfoTip>
        {top && <span className="text-[11px] text-zinc-500">{t('analytics.r6.boards.roleTop.subtitle', { count: shownTop || TOP_N })}</span>}
      </div>
      {!top && <p className="text-[11px] text-amber-300/80">{t('analytics.r6.boards.roleTop.legacy')}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7" data-testid="role-champions">
        {roles.map((role) => {
          const list = listFor(role);
          const window = board.roleWindowGames?.[role];
          const qualified = holders.find((r) => r.role === role)?.qualified;
          const red = RED_ROLES.has(role);
          return (
            <section
              key={role}
              className={`min-w-0 rounded-xl border bg-zinc-950 p-2 ${red ? 'border-red-900/50' : 'border-blue-900/50'}`}
              aria-label={roleLabel(role)}
              data-testid={`role-card-${role}`}
            >
              <header className="mb-1 min-w-0 px-0.5">
                <h4 className={`truncate text-sm font-bold ${red ? 'text-red-300' : 'text-blue-300'}`}>{roleLabel(role)}</h4>
                <p className="truncate text-[10px] text-zinc-500">
                  {[
                    typeof window === 'number' ? t('analytics.r6.boards.lastN', { count: window }) : null,
                    typeof qualified === 'number' ? t('analytics.r6.boards.roleTop.qualified', { count: qualified }) : null,
                  ].filter(Boolean).join(' · ')}
                </p>
              </header>
              {list.length === 0 ? (
                <p className="px-1 py-2 text-[11px] text-zinc-500">
                  {t('analytics.r6.boards.roleTop.empty', { count: window ?? 0 })}
                </p>
              ) : (
                <ol className="space-y-px text-xs tabular-nums">
                  {list.map((r, i) => (
                    <li key={`${r.name}-${i}`}>
                      <button
                        type="button"
                        onClick={() => openPlayerStats(r.name)}
                        title={t('analytics.r6.boards.roleTop.tip', { name: r.name, wins: r.wins, games: r.games, career: r.careerRoleGames })}
                        className="flex w-full min-w-0 items-baseline gap-1 rounded px-0.5 py-0.5 text-left hover:bg-zinc-800/70"
                      >
                        <span className={`w-4 shrink-0 text-right font-black ${rankClass(r.rank)}`}>{r.rank}</span>
                        <span className="min-w-0 truncate font-semibold text-white">{r.name}</span>
                        <span className={`shrink-0 ${r.rank === 1 ? 'text-amber-300' : 'text-zinc-300'}`}>
                          {t('analytics.r6.boards.roleTop.rateParen', { rate: fmtPct(r.value) })}
                        </span>
                        {r.rank === 1 && (
                          <Crown size={11} className="ml-auto shrink-0 self-center text-amber-300" aria-label={t('analytics.r6.boards.roleTop.holder')} />
                        )}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
