import { BarChart3, Loader, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { outcomeBlocks, roleFaction, theorySettings, type OutcomeCounts } from '../services/api';
import { useAnalysisOverview } from './analysis/useAnalysisOverview';
import { blockValues, seatFactionCounts, useIsWide } from './analysis/seatRoleBlocks';
import { MetricBlocks, type MetricBlockRow } from './analysis/ui';
import { useStatsFilter } from '../stats/statsFilter';
import { WIKI_ROLE_NAMES } from '../data/wiki';
import { CampDisc } from './CampDisc';

/**
 * 百科角色文章與「X數據解析」的實戰數據卡 (2026-10-30)。
 *
 * 以前讀 data/roleStats.ts 的靜態數字：好人角色把「三藍死」算成贏、紅方只算三紅，而且只記錄了 4 個座位。
 * 現在跟數據分析頁同一個來源、同一個口徑：/api/analysis/overview 的 seatPositionWinRates
 * (每個位置 × 角色的 三紅／三藍死／三藍活 局數，全部對局)，三塊結果一律由 @avalon/shared 的 outcomeBlocks 算：
 *   任務結果 (n = 全部局)、刺殺結果 (n = 打到三藍的局)、遊戲結果 = 最終勝率 (三藍活才算藍方贏)。
 * 第一列 = 全部位置 (同數據分析頁「位置 × 角色」表的「全部位置」列)，下面是 1–10 號各位置。
 * 讀取中顯示讀取中，讀不到顯示稍後再試；不退回任何寫死的數字。篩選跟著數據分析頁 (useStatsFilter)。
 */

interface RoleStatsCardProps {
  /** 角色代號 (merlin、percival、loyal_servant、mordred、morgana、assassin、oberon)。 */
  role: string;
}

function addCounts(a: OutcomeCounts | undefined, b: OutcomeCounts): OutcomeCounts {
  return {
    三紅: (a?.三紅 ?? 0) + b.三紅,
    三藍死: (a?.三藍死 ?? 0) + b.三藍死,
    三藍活: (a?.三藍活 ?? 0) + b.三藍活,
  };
}

export default function RoleStatsCard({ role }: RoleStatsCardProps): JSX.Element | null {
  const { t } = useTranslation('common');
  const { overview, loading, error, reload } = useAnalysisOverview();
  const filtered = useStatsFilter(s => s.key !== '');
  const wide = useIsWide();
  const name = WIKI_ROLE_NAMES[role];
  if (!name) return null;

  const faction = roleFaction(name);
  const isGood = faction === 'blue';
  const k = 'wiki.liveStats';

  const header = (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <div className="flex items-center gap-1.5 min-w-0">
        <BarChart3 size={16} className="text-yellow-400 shrink-0" />
        <h3 className="text-sm font-bold text-white">{t(`${k}.title`, { role: name })}</h3>
      </div>
      <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded shrink-0 ${isGood ? 'bg-blue-900/60 text-blue-300' : 'bg-red-900/60 text-red-300'}`}>
        <CampDisc team={isGood ? 'good' : 'evil'} className="w-3.5 h-3.5" alt={t(isGood ? `${k}.good` : `${k}.evil`)} />
        {t(isGood ? `${k}.good` : `${k}.evil`)}
      </span>
    </div>
  );

  // 手機不加外框與內距：三塊結果表在 375px 的文章視窗裡才放得下。
  const frame = (body: JSX.Element): JSX.Element => (
    <div
      className={`sm:bg-avalon-card/60 sm:border ${isGood ? 'sm:border-blue-500/40' : 'sm:border-red-500/40'} rounded-lg sm:p-3 space-y-3 min-w-0`}
      data-testid="role-live-stats"
    >
      {header}
      {body}
    </div>
  );

  if (loading && !overview) {
    return frame(
      <div className="flex items-center gap-2 py-4 text-xs text-gray-400">
        <Loader size={14} className="animate-spin" /> {t(`${k}.loading`)}
      </div>,
    );
  }

  const seats = seatFactionCounts(overview);
  if (!seats) {
    return frame(
      <div className="flex flex-wrap items-center gap-2 py-3 text-xs text-gray-400">
        <span>{error || !overview ? t(`${k}.failed`) : t('analytics.r6.tabsb.pendingUpdate')}</span>
        {(error || !overview) && (
          <button
            type="button"
            onClick={reload}
            className="inline-flex items-center gap-1 rounded border border-gray-600 px-2 py-0.5 text-gray-300 hover:border-yellow-500 hover:text-yellow-300"
          >
            <RefreshCw size={12} /> {t(`${k}.retry`)}
          </button>
        )}
      </div>,
    );
  }

  const minCell = theorySettings(overview?.theoryConfig).theoryMinCellGames;
  let all: OutcomeCounts | undefined;
  const seatRows: MetricBlockRow[] = [];
  for (const s of seats) {
    const c = s.roles[name];
    if (!c) continue;
    all = addCounts(all, c);
    seatRows.push({
      key: s.seat,
      label: t('analytics.r6.tabsb.seats.seatLabel', { n: s.seat }),
      tone: faction,
      ...blockValues(outcomeBlocks(c, faction)),
    });
  }
  if (!all) {
    return frame(<p className="py-3 text-xs text-gray-400">{t('analytics.r6.tabsb.pendingUpdate')}</p>);
  }
  const totalRow: MetricBlockRow = {
    key: 'all',
    label: t(`${k}.allRow`),
    title: t('analytics.r6.tabsb.seatRoles.allSeats'),
    tone: faction,
    ...blockValues(outcomeBlocks(all, faction)),
  };

  return frame(
    <>
      <MetricBlocks
        rows={[totalRow, ...seatRows]}
        groupLabel={t(`${k}.seatCol`)}
        showRules={wide}
        lowSample={minCell > 0 ? minCell : undefined}
        highlightRow={row => row.key === 'all'}
        footnote={
          <>
            {t(`${k}.note`, { role: name })}
            {role === 'loyal_servant' && <> {t(`${k}.loyalNote`)}</>}
          </>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-700/50 pt-2 text-[10px] text-gray-500">
        <span>{filtered ? t(`${k}.sourceFiltered`) : t(`${k}.source`)}</span>
        <a href="#stats" className="text-yellow-400 underline hover:text-yellow-300">{t(`${k}.openStats`)}</a>
      </div>
    </>,
  );
}
