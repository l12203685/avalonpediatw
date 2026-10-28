import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader, AlertCircle } from 'lucide-react';
import { useGameStore } from '../../store/gameStore';
import { useStatsFilter } from '../../stats/statsFilter';
import { useAnalysisPlayerRows, type PlayerWithSeatStats } from './seatRoleBlocks';
import { StatTable, type StatColumn } from './ui';

/**
 * 勝率表 (2026-10-26，玩家回饋：「我想要看近期的玩家勝率就好，篩掉最近沒出現的，例如這颱風天我就想要看這四天」)。
 *
 * 排行的各榜看各人最近 N 場、角色理論要每個角色打滿近 10 場，篩一段短期間時大家都不夠場數、榜是空的。
 * 這張表只看篩選後的局：期間內有出賽的每一位玩家、場數、最終勝率 (紅勝 = 三紅 + 三藍死、藍勝 = 三藍活)、
 * 紅藍各自的勝率與超額勝率 (扣掉抽到角色的運氣)，最低場數自己選。資料是 /api/analysis/players
 * (有篩選時由瀏覽器端引擎重算)，沒有篩選時就是全部對局。
 * 預設依場數排序、最低 50 場 (Edward 2026-10-28)；篩一段短期間時最低 3 場 (50 場會讓表變空)。
 */
type SortKey = 'finalWinRate' | 'excessWinRate' | 'totalGames';

const MIN_GAMES = [1, 3, 5, 10, 20, 50, 100] as const;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function wins(p: PlayerWithSeatStats): number | null {
  const raw = [p.rawRedThreeRed, p.rawRedMerlinDead, p.rawBlueMerlinAlive].map(num);
  return raw.every((x) => x !== null) ? (raw as number[]).reduce((a, b) => a + b, 0) : null;
}

export default function PeriodWinRates(): JSX.Element {
  const { t } = useTranslation('common');
  const filtered = useStatsFilter((s) => s.key !== '');
  const openPlayerStats = useGameStore((s) => s.openPlayerStats);
  const { players, loading, error } = useAnalysisPlayerRows();
  const [minGames, setMinGames] = useState<number>(filtered ? 3 : 50);
  const [sort, setSort] = useState<SortKey>('totalGames');
  const k = 'analytics.winRates';

  const rows = useMemo(() => {
    const list = (players ?? []).filter((p) => p.totalGames >= minGames && num(p.finalWinRate) !== null);
    const key = (p: PlayerWithSeatStats): number => (sort === 'totalGames' ? p.totalGames : num(p[sort]) ?? -Infinity);
    return [...list].sort((a, b) => key(b) - key(a) || b.totalGames - a.totalGames || a.name.localeCompare(b.name));
  }, [players, minGames, sort]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t(`${k}.loading`)}
      </div>
    );
  }
  if (error || !players) {
    return (
      <div className="flex items-center justify-center py-10 text-red-400 gap-3">
        <AlertCircle size={20} /> {error ?? t('analytics.deep.loadFailed')}
      </div>
    );
  }

  const columns: StatColumn<PlayerWithSeatStats>[] = [
    { key: 'name', label: t(`${k}.col.name`), format: (v, _r, i) => `${i + 1}. ${String(v)}` },
    { key: 'totalGames', label: t(`${k}.col.games`), format: 'int', align: 'right', emphasis: sort === 'totalGames' },
    { key: 'wins', label: t(`${k}.col.wins`), value: wins, format: 'int', align: 'right' },
    { key: 'finalWinRate', label: t(`${k}.col.finalWinRate`), term: 'finalWinRate', format: 'pct', align: 'right', emphasis: sort === 'finalWinRate', tone: 'amber' },
    { key: 'finalRedWinRate', label: t(`${k}.col.red`), term: 'redWinRate', format: 'pct', align: 'right', tone: 'red', n: 'rawRedGames' },
    { key: 'finalBlueWinRate', label: t(`${k}.col.blue`), term: 'blueWinRate', format: 'pct', align: 'right', tone: 'blue', n: 'rawBlueGames' },
    {
      key: 'excessWinRate', label: t(`${k}.col.excess`), term: 'excessWinRate', align: 'right', emphasis: sort === 'excessWinRate',
      format: (v) => (num(v) === null ? '—' : `${(v as number) > 0 ? '+' : ''}${(v as number).toFixed(1)}`),
    },
    { key: 'lastPlayed', label: t(`${k}.col.lastPlayed`), format: 'text', className: 'text-zinc-400' },
  ];

  return (
    <div className="space-y-2" data-testid="period-win-rates">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-400">
        <label className="inline-flex items-center gap-1.5">
          {t(`${k}.minGames`)}
          <select className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100" value={minGames}
            onChange={(e) => setMinGames(Number(e.target.value))} data-testid="win-rates-min-games">
            {MIN_GAMES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5">
          {t(`${k}.sort`)}
          <select className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100" value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="totalGames">{t(`${k}.col.games`)}</option>
            <option value="finalWinRate">{t(`${k}.col.finalWinRate`)}</option>
            <option value="excessWinRate">{t(`${k}.col.excess`)}</option>
          </select>
        </label>
        <span>{t(filtered ? `${k}.scopeFiltered` : `${k}.scopeAll`, { count: rows.length })}</span>
      </div>
      <StatTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        stickyFirstColumn
        maxHeight="min(60vh, 32rem)"
        onRowClick={(r) => openPlayerStats(r.name)}
        empty={t(`${k}.empty`)}
        footnote={t(`${k}.note`)}
      />
    </div>
  );
}
