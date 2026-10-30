import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Clock, Loader, RefreshCw } from 'lucide-react';
import { useStatsFilter } from '../../stats/statsFilter';
import { useGameStore } from '../../store/gameStore';
import { InfoTip, StatTable, type StatColumn } from './ui';
import {
  fetchAnalysisRating,
  fmtElo,
  fmtTheoryPct,
  getErrorMessage,
  isAnalysisNotGenerated,
  isAnalysisRouteMissing,
  type RatingBoardData,
  type RatingPlayerRow,
} from '../../services/api';

/**
 * 戰績排行 > Elo (Edward 2026-10-30「新版把網站上的 ELO 都完全統一成你研發的版本」)：網站唯一的 Elo。
 *
 * 讀 /api/analysis/rating (generate_cache.py compute_rating；每日從第一局依時間重算)。預設只列近 activeDays 天
 * 有出賽、計入場數 ≥ boardMinGames 的玩家 (兩個門檻都讀快取的 RATING_CONFIG)；可以放寬，場數不到
 * provisionalGames 的標「暫定」。欄位：名次＋玩家、Elo、±1σ、場數、模型理論勝率、最後出賽；點一列開那位玩家的
 * 玩家雷達 (Elo 走勢在那裡)。Elo 依對局順序而定，不隨複合篩選重算，篩選中會註明。
 */

const MIN_GAMES_CHOICES = [1, 10, 30, 50, 100];

type Row = RatingPlayerRow & { shownRank: number };

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** asOf 往前 days 天 (含當天) 的第一天。 */
function since(asOf: string, days: number): string {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

export default function EloBoard(): JSX.Element {
  const { t } = useTranslation('common');
  const filtered = useStatsFilter((s) => s.key !== '');
  const openPlayerStats = useGameStore((s) => s.openPlayerStats);
  const [data, setData] = useState<RatingBoardData | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'notGenerated' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [activeOnly, setActiveOnly] = useState(true);
  const [minGames, setMinGames] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchAnalysisRating()
      .then(d => { if (!cancelled) { setData(d); setState('ok'); } })
      .catch(err => {
        if (cancelled) return;
        if (isAnalysisNotGenerated(err) || isAnalysisRouteMissing(err)) setState('notGenerated');
        else { setError(getErrorMessage(err)); setState('error'); }
      });
    return (): void => { cancelled = true; };
  }, [reload]);

  const cfg = data?.config ?? {};
  const activeDays = isNum(cfg.activeDays) ? cfg.activeDays : 90;
  const boardMin = isNum(cfg.boardMinGames) ? cfg.boardMinGames : 30;
  const provisionalGames = isNum(cfg.provisionalGames) ? cfg.provisionalGames : 30;
  const min = minGames ?? boardMin;
  const asOf = data?.asOf ?? data?.dataThrough ?? null;

  const rows = useMemo((): Row[] => {
    if (!data) return [];
    const from = asOf && activeOnly ? since(asOf, activeDays) : null;
    return data.players
      .filter(r => r.games >= min && (!from || (r.lastPlayed !== null && r.lastPlayed >= from)))
      .map((r, i) => ({ ...r, shownRank: i + 1 }));
  }, [data, asOf, activeOnly, activeDays, min]);

  const columns = useMemo((): StatColumn<Row>[] => [
    {
      key: 'name',
      label: t('analytics.elo.col.rankName'),
      format: (_v, row) => (
        <span className="inline-flex items-baseline gap-1.5">
          <span className={`inline-block w-6 text-right font-black ${row.shownRank === 1 ? 'text-amber-300' : row.shownRank <= 3 ? 'text-gray-200' : 'text-zinc-500'}`}>
            {row.shownRank}
          </span>
          <span className="font-semibold text-white">{row.name}</span>
          {row.provisional && (
            <span className="text-[10px] font-normal text-amber-300" title={t('analytics.elo.provisionalHint', { count: provisionalGames })}>
              {t('analytics.elo.provisional')}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'elo', label: t('analytics.elo.col.elo'), term: 'elo', align: 'right', emphasis: true, tone: 'amber',
      format: v => <span className="tabular-nums">{fmtElo(isNum(v) ? v : null)}</span>,
    },
    {
      key: 'sigma', label: t('analytics.elo.col.sigma'), align: 'right', className: 'text-zinc-400',
      format: v => <span className="tabular-nums">±{fmtElo(isNum(v) ? v : null)}</span>,
    },
    { key: 'games', label: t('analytics.elo.col.games'), format: 'int', align: 'right' },
    {
      key: 'modelTheory', label: t('analytics.elo.col.modelTheory'), term: 'eloModelTheory', align: 'right',
      format: v => fmtTheoryPct(isNum(v) ? v : null),
    },
    { key: 'lastPlayed', label: t('analytics.elo.col.lastPlayed'), className: 'text-zinc-400 hidden sm:table-cell' },
  ], [t, provisionalGames]);

  if (state === 'loading' && !data) {
    return (
      <div className="flex items-center justify-center py-10 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.elo.loading')}
      </div>
    );
  }
  if (state === 'notGenerated' || state === 'error' || !data) {
    return (
      <div className="flex items-center gap-3 flex-wrap px-4 py-4 rounded-xl border border-amber-800/40 bg-amber-900/10 text-amber-300 text-sm">
        {state === 'error' ? <AlertCircle size={18} className="flex-shrink-0" /> : <Clock size={18} className="flex-shrink-0" />}
        <span className="flex-1">{state === 'error' ? `${t('analytics.elo.loadFailed')} ${error ?? ''}` : t('analytics.elo.notGenerated')}</span>
        <button
          onClick={() => setReload(k => k + 1)}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700"
        >
          <RefreshCw size={12} /> {t('analytics.boards.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="elo-board">
      <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap">
        <h3 className="text-sm font-bold text-white">{t('analytics.elo.boardTitle')}</h3>
        <InfoTip title={t('analytics.elo.boardTitle')} testId="board-info-elo">
          <p>{t('analytics.elo.boardInfo1')}</p>
          <p className="text-zinc-400">{t('analytics.elo.boardInfo2', { days: activeDays, games: boardMin, provisional: provisionalGames })}</p>
          <p className="text-zinc-400">{t('analytics.elo.boardInfo3', { games: data.games, skipped: data.skippedGames, date: data.dataThrough ?? '—' })}</p>
          <p className="text-zinc-400">{t('analytics.r6.boards.clickHint')}</p>
        </InfoTip>
        <span className="text-[11px] text-zinc-500">{t('analytics.elo.average', { theory: fmtTheoryPct(data.averageTheory) })}</span>
      </div>
      {filtered && (
        <p className="text-[11px] text-amber-300">{t('analytics.elo.notFiltered')}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-400">
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} className="accent-amber-400" />
          {t('analytics.elo.activeOnly', { days: activeDays })}
        </label>
        <label className="inline-flex items-center gap-1.5">
          {t('analytics.elo.minGames')}
          <select
            value={min}
            onChange={e => setMinGames(Number(e.target.value))}
            className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-200"
          >
            {[...new Set([...MIN_GAMES_CHOICES, boardMin])].sort((a, b) => a - b).map(n => (
              <option key={n} value={n}>{n === 1 ? t('analytics.elo.allGames') : t('analytics.elo.atLeast', { count: n })}</option>
            ))}
          </select>
        </label>
        <span className="text-zinc-500">{t('analytics.elo.shown', { count: rows.length })}</span>
      </div>
      <StatTable
        columns={columns}
        rows={rows}
        rowKey={row => row.name}
        onRowClick={row => openPlayerStats(row.name)}
        rowTitle={row => t('analytics.elo.rowTip', { first: row.firstPlayed ?? '—', last: row.lastPlayed ?? '—' })}
        empty={t('analytics.elo.empty')}
      />
    </div>
  );
}
