import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Loader, AlertCircle, RefreshCw, Trophy, Clock, Medal } from 'lucide-react';
import { useGameStore } from '../../store/gameStore';
import {
  fetchAnalysisLeaderboard,
  getErrorMessage,
  isAnalysisNotGenerated,
  isAnalysisRouteMissing,
  isTheoryBoard,
  fmtPct,
  fmtSignedPoints,
  theorySettings,
  type AnalysisLeaderboardData,
  type AnalysisLeaderboardBoard,
  type AnalysisLeaderboardRow,
} from '../../services/api';

/**
 * 排行 (docs/stats/two_stage_outcome.md `leaderboard` 段，Edward 2026-10-13)：
 *  「條件篩選可以是近期，但資料篩選不能少場」— 誰上榜看近 activeDays (90) 天有沒有出賽，
 *  數字一律是各人自己的最近 N 場，不用短期日期區間。說明文字的天數、場數讀 leaderboard.config。
 *  - main 榜：表格 — 名次、名字、角色理論、位置理論、最終勝率、場數 (各人最近 100 場)
 *  - 小卡：近 50 場、進步榜 (最近 50 vs 再之前 50，差值單位是百分點)、刺客刺中率 (最近 20 次刺殺)、
 *    新人榜 (例外：全部場次)、角色王 (該角色最近 20 場)
 *  - 舊快取的榜 (沒有 metric，超額勝率)：不顯示，提示下次每日更新後提供
 *  - 快取尚無此段 (503 "Leaderboard not yet generated")：顯示「排行尚未產生（每日 03:47 重算）」
 *  - 舊後端沒有此路由 (404，網站先於伺服器部署)：顯示「後端尚未更新」
 *    兩者都附重試鍵；其他 503 (載入快取失敗、代理層) 走一般錯誤並顯示伺服器訊息。
 * 全部由 generate_cache.py 算好；這裡只讀不重算。
 */

const CARD_ORDER = ['last50', 'improved', 'assassin', 'newcomers', 'roleTitles'];

function useIsEn(): boolean {
  const { i18n } = useTranslation('common');
  return Boolean(i18n.language?.toLowerCase().startsWith('en'));
}

function boardTitle(board: AnalysisLeaderboardBoard, isEn: boolean): string {
  return isEn && board.titleEn ? board.titleEn : board.title;
}

function boardPeriod(board: AnalysisLeaderboardBoard, isEn: boolean): string {
  return isEn && board.periodEn ? board.periodEn : board.period;
}

function boardNote(board: AnalysisLeaderboardBoard, isEn: boolean): string | undefined {
  return isEn && board.noteEn ? board.noteEn : board.note;
}

/** The note's first clause (who qualifies); the legend after it is shown once, under the main board. */
function qualifier(note: string | undefined): string | undefined {
  if (!note) return undefined;
  const first = note.split(/[；;]/)[0]?.trim();
  return first || undefined;
}

function rankClass(rank: number): string {
  if (rank === 1) return 'text-amber-300';
  if (rank === 2) return 'text-gray-200';
  if (rank === 3) return 'text-orange-300';
  return 'text-gray-500';
}

function deltaClass(v: number | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'text-gray-500';
  if (v > 0) return 'text-emerald-300';
  if (v < 0) return 'text-rose-300';
  return 'text-gray-300';
}

/** 非錯誤的「暫時沒有排行」狀態：快取尚未產生 / 後端版本過舊 / 快取還是改版前的格式。 */
type BoardsNotice = 'notGenerated' | 'backendOutdated' | 'upgrading';

export default function LeaderboardBoards(): JSX.Element {
  const { t } = useTranslation('common');
  const isEn = useIsEn();
  const [data, setData] = useState<AnalysisLeaderboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<BoardsNotice | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 天數、場數讀快取的 leaderboard.config (舊快取沒有這些鍵 → 產生器預設值)。
  const settings = theorySettings(data?.config);

  useEffect(() => {
    let cancelled = false;
    fetchAnalysisLeaderboard()
      .then(d => {
        if (cancelled) return;
        setData(d);
        setError(null);
        const boards = Array.isArray(d.boards) ? d.boards : [];
        // 改版前的快取：榜都沒有 metric (超額勝率) → 不顯示，等每日重算。
        setNotice(boards.length > 0 && !boards.some(isTheoryBoard) ? 'upgrading' : null);
      })
      .catch(e => {
        if (cancelled) return;
        if (isAnalysisNotGenerated(e)) {
          setNotice('notGenerated');
        } else if (isAnalysisRouteMissing(e)) {
          setNotice('backendOutdated');
        } else {
          setError(getErrorMessage(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [reloadKey]);

  const retry = (): void => {
    setLoading(true);
    setError(null);
    setNotice(null);
    setReloadKey(k => k + 1);
  };

  const retryButton = (
    <button
      onClick={retry}
      className="mt-1 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700"
    >
      <RefreshCw size={12} /> {t('analytics.boards.retry')}
    </button>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.boards.loading')}
      </div>
    );
  }

  if (notice) {
    return (
      <div className="flex items-center gap-3 flex-wrap px-4 py-4 rounded-xl border border-amber-800/40 bg-amber-900/10 text-amber-300 text-sm">
        <Clock size={18} className="flex-shrink-0" />
        <span className="flex-1">{t(`analytics.boards.${notice}`, { games: settings.mainGames })}</span>
        {retryButton}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3 text-red-400">
        <AlertCircle size={24} />
        <p className="text-sm">{t('analytics.boards.loadFailed')}</p>
        {error && <p className="text-xs text-gray-500 max-w-md text-center">{error}</p>}
        {retryButton}
      </div>
    );
  }

  const boards = (Array.isArray(data.boards) ? data.boards : []).filter(isTheoryBoard);
  const main = boards.find(b => b.id === 'main');
  const others = boards
    .filter(b => b.id !== 'main' && Array.isArray(b.rows) && b.rows.length > 0)
    .sort((a, b) => {
      const ia = CARD_ORDER.indexOf(a.id);
      const ib = CARD_ORDER.indexOf(b.id);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">
        {t('analytics.boards.asOf', { date: data.asOf })}
        {data.dates && (
          <> · {t('analytics.boards.datesNote', { parsed: data.dates.parsed, unparsed: data.dates.unparsed })}</>
        )}
      </p>
      <p className="text-[11px] text-zinc-500 leading-relaxed">{t('analytics.boards.principle', { days: settings.activeDays })}</p>

      {main && main.rows.length > 0 ? (
        <MainBoard board={main} isEn={isEn} />
      ) : (
        <div className="px-4 py-4 rounded-xl border border-gray-700 bg-avalon-card/30 text-sm text-gray-500">
          {t('analytics.boards.empty', { days: settings.activeDays, games: settings.mainGames })}
        </div>
      )}

      {others.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {others.map(b => (
            <BoardCard key={b.id} board={b} isEn={isEn} />
          ))}
        </div>
      )}
    </div>
  );
}

function rowTip(t: (k: string, o?: Record<string, unknown>) => string, row: AnalysisLeaderboardRow): string {
  return [
    typeof row.careerGames === 'number' ? t('analytics.boards.tip.career', { count: row.careerGames }) : null,
    row.from && row.to ? t('analytics.boards.tip.span', { from: row.from, to: row.to }) : null,
    (row.sparseRoles ?? 0) > 0 || (row.sparseSeats ?? 0) > 0
      ? t('analytics.boards.tip.sparse', { roles: row.sparseRoles ?? 0, seats: row.sparseSeats ?? 0 })
      : null,
  ].filter(Boolean).join(' · ');
}

function MainBoard({ board, isEn }: { board: AnalysisLeaderboardBoard; isEn: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const note = boardNote(board, isEn);
  // 點名字 → 該玩家的玩家雷達 (不用登入)。
  const openPlayerStats = useGameStore((s) => s.openPlayerStats);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-avalon-card/30 border border-gray-700 rounded-xl overflow-hidden"
    >
      <div className="px-4 pt-4 pb-3 border-b border-gray-700">
        <div className="flex items-center gap-2 flex-wrap">
          <Trophy size={16} className="text-amber-300" />
          <h3 className="text-base font-bold text-white">{boardTitle(board, isEn)}</h3>
          <span className="text-xs text-zinc-400">· {boardPeriod(board, isEn)}</span>
        </div>
        {note && <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">{note}</p>}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-zinc-500 border-b border-zinc-800">
              <th className="text-left py-2 pl-4 pr-2 w-12">{t('analytics.boards.col.rank')}</th>
              <th className="text-left py-2 px-2">{t('analytics.boards.col.name')}</th>
              <th className="text-right py-2 px-2">{t('analytics.boards.col.roleTheory')}</th>
              <th className="text-right py-2 px-2">{t('analytics.boards.col.positionTheory')}</th>
              <th className="text-right py-2 px-2">{t('analytics.boards.col.finalWinRate')}</th>
              <th className="text-right py-2 pl-2 pr-4">{t('analytics.boards.col.games')}</th>
            </tr>
          </thead>
          <tbody>
            {board.rows.map(row => (
              <tr
                key={`${row.rank}-${row.name}`}
                className="border-b border-zinc-800/60 hover:bg-white/5 cursor-pointer"
                title={rowTip(t, row)}
                onClick={() => openPlayerStats(row.name)}
              >
                <td className={`py-1.5 pl-4 pr-2 font-black ${rankClass(row.rank)}`}>
                  {row.rank <= 3 ? <Medal size={14} className="inline -mt-0.5 mr-0.5" /> : null}{row.rank}
                </td>
                <td className="py-1.5 px-2 font-semibold text-white">{row.name}</td>
                <td className="py-1.5 px-2 text-right font-bold text-amber-200">{fmtPct(row.roleTheory ?? row.value)}</td>
                <td className="py-1.5 px-2 text-right text-gray-300">{fmtPct(row.positionTheory)}</td>
                <td className="py-1.5 px-2 text-right text-gray-300">{fmtPct(row.finalWinRate)}</td>
                <td className="py-1.5 pl-2 pr-4 text-right text-gray-400">{row.games}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}

function BoardCard({ board, isEn }: { board: AnalysisLeaderboardBoard; isEn: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const who = qualifier(boardNote(board, isEn));
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="min-w-0 bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-1">
        <h4 className="text-sm font-bold text-white">{boardTitle(board, isEn)}</h4>
        <span className="text-[10px] text-zinc-500">{boardPeriod(board, isEn)}</span>
      </div>
      {(who || board.allGames) && (
        <p className="text-[10px] text-zinc-500 mb-2">
          {board.allGames && (
            <span className="mr-1 px-1.5 py-0.5 rounded bg-amber-900/30 border border-amber-800/50 text-amber-300">
              {t('analytics.boards.exception')}
            </span>
          )}
          {who}
        </p>
      )}
      {/* flex-wrap: on a phone the numbers move under the name instead of widening the page. */}
      <ol className="space-y-1">
        {board.rows.map(row => (
          <li key={`${row.rank}-${row.role ?? ''}-${row.name}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 text-xs" title={rowTip(t, row)}>
            <span className={`w-5 text-right font-black ${rankClass(row.rank)}`}>{row.rank}</span>
            <BoardRowBody board={board} row={row} />
          </li>
        ))}
      </ol>
    </motion.div>
  );
}

function BoardRowBody({ board, row }: { board: AnalysisLeaderboardBoard; row: AnalysisLeaderboardRow }): JSX.Element {
  const { t } = useTranslation('common');
  const games = `${row.games} ${t('analytics.deep.common.games')}`;

  switch (board.metric) {
    case 'roleTheoryDelta':
      return (
        <>
          <span className="flex-1 font-semibold text-white truncate">{row.name}</span>
          {/* 角色理論的差，單位是百分點 (不是相對成長 %) */}
          <span className={`font-bold ${deltaClass(row.value)}`}>
            {Number.isFinite(row.value) ? t('analytics.boards.points', { value: fmtSignedPoints(row.value) }) : '—'}
          </span>
          <span className="text-zinc-500 whitespace-nowrap">
            {fmtPct(row.recentRoleTheory)} ← {fmtPct(row.priorRoleTheory)}
          </span>
        </>
      );
    case 'hitRate':
      return (
        <>
          <span className="flex-1 font-semibold text-white truncate">{row.name}</span>
          <span className="font-bold text-amber-300">{fmtPct(row.value)}</span>
          <span className="text-zinc-500 whitespace-nowrap">
            {typeof row.hits === 'number' && typeof row.attempts === 'number'
              ? t('analytics.boards.attempts', { hits: row.hits, attempts: row.attempts })
              : games}
          </span>
        </>
      );
    case 'finalWinRate':
      return (
        <>
          <span className="w-14 text-zinc-300">{row.role ?? ''}</span>
          <span className="flex-1 font-semibold text-white truncate">{row.name}</span>
          <span className="font-bold text-amber-300">{fmtPct(row.value)}</span>
          <span className="text-zinc-500 whitespace-nowrap">
            {typeof row.wins === 'number' ? `${row.wins}/${row.games}` : games}
          </span>
        </>
      );
    default:
      // roleTheory (last50 / newcomers) and unknown metrics: 角色理論 · 位置理論 · 最終 · 場數
      return (
        <>
          <span className="flex-1 font-semibold text-white truncate">{row.name}</span>
          <span className="font-bold text-amber-200">{fmtPct(row.roleTheory ?? row.value)}</span>
          <span className="text-zinc-500 whitespace-nowrap">
            {typeof row.positionTheory === 'number' ? `${t('analytics.boards.col.positionTheory')} ${fmtPct(row.positionTheory)} · ` : ''}
            {typeof row.finalWinRate === 'number' ? `${t('analytics.boards.col.finalWinRate')} ${fmtPct(row.finalWinRate)} · ` : ''}
            {games}
          </span>
        </>
      );
  }
}
