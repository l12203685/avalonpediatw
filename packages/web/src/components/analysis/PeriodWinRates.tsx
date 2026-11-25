import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader, AlertCircle } from 'lucide-react';
import { useGameStore } from '../../store/gameStore';
import { useStatsFiltered } from '../../stats/statsFilter';
import { useAnalysisPlayerRows, type PlayerWithSeatStats } from './seatRoleBlocks';
import { InfoTip, RATE_DIGITS, StatTable, formatInt, type StatColumn } from './ui';
import { BenchmarkToggle, benchmarkName, benchmarkPlayerRow, useBenchmarkGroups, useBenchmarkPinned } from './BenchmarkRows';
import { BoardCards, BoardLead, type BoardCardRow } from './BoardCards';
import { boardGlance, pctText, shownPct } from './core/glance';
import { useMediaQuery, WIDE_BOARD_QUERY } from '../../hooks/useMediaQuery';

/**
 * 勝率表 (2026-10-26，玩家回饋：「我想要看近期的玩家勝率就好，篩掉最近沒出現的，例如這颱風天我就想要看這四天」)。
 *
 * 排行的各榜看各人最近 N 場、角色理論要每個角色打滿近 10 場，篩一段短期間時大家都不夠場數、榜是空的。
 * 這張表只看篩選後的局：期間內有出賽的每一位玩家、場數、最終勝率 (紅勝 = 三紅 + 三藍死、藍勝 = 三藍活)、
 * 紅藍各自的勝率與超額勝率 (扣掉抽到角色的運氣)，最低場數自己選。資料是 /api/analysis/players
 * (有篩選時由瀏覽器端引擎重算)，沒有篩選時就是全部對局。
 * 預設依場數排序、最低 50 場 (Edward 2026-10-28)；篩一段短期間時最低 3 場 (50 場會讓表變空)。
 * (2026-11-03 Edward) 最上面釘基準列 (散客／全體／前 X%／中間／後 Y% (預設 20／20)，BenchmarkRows)：不受排序、最低場數影響，
 * 不算進人數。
 * (2026-11-25 站長「一目瞭然」，第三批) 表格上面先一句話 (照目前的排序，前三名是誰、多少；比最終勝率時加上不算散客的全體)；
 * 手機改成一位玩家一張小卡 (BoardCards)，先列前 10 名、「看全部」展開，基準列收在「對照組」、完整表格收在「進階」。
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
  const filtered = useStatsFiltered();
  const openPlayerStats = useGameStore((s) => s.openPlayerStats);
  const { players, loading, error } = useAnalysisPlayerRows();
  const [minGames, setMinGames] = useState<number>(filtered ? 3 : 50);
  const [sort, setSort] = useState<SortKey>('totalGames');
  const k = 'analytics.winRates';
  const pinned = useBenchmarkPinned(benchmarkPlayerRow).props;
  const wide = useMediaQuery(WIDE_BOARD_QUERY);
  const { section, groups } = useBenchmarkGroups();

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
      format: (v) => (num(v) === null ? '—' : `${(v as number) > 0 ? '+' : ''}${(v as number).toFixed(RATE_DIGITS)}`),
    },
    { key: 'lastPlayed', label: t(`${k}.col.lastPlayed`), format: 'text', className: 'text-zinc-400' },
  ];

  const table = (): JSX.Element => (
    <StatTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.name}
      stickyFirstColumn
      maxHeight="min(60vh, 32rem)"
      onRowClick={(r) => openPlayerStats(r.name)}
      empty={t(`${k}.empty`)}
      {...pinned}
    />
  );

  // ── 一句話與手機的小卡：跟表格同一份 rows、同一個排序 ──
  const G = 'analytics.glance.board';
  const signed = (v: number): string => `${shownPct(v) > 0 ? '+' : ''}${shownPct(v)}`;
  const fmt = (v: number): string => (sort === 'totalGames' ? t(`${G}.games`, { n: formatInt(v) }) : sort === 'excessWinRate' ? signed(v) : pctText(v));
  const valueOf = (p: PlayerWithSeatStats): number | null => (sort === 'totalGames' ? p.totalGames : num(p[sort]));
  const regular = groups.find((g) => g.id === 'regular');
  const base = sort === 'finalWinRate' && regular ? num(benchmarkPlayerRow(regular).finalWinRate) : null;
  const sortLabel = t(`${k}.col.${sort === 'totalGames' ? 'games' : sort === 'excessWinRate' ? 'excess' : 'finalWinRate'}`);
  const glance = boardGlance(rows.map((p) => ({ name: p.name, value: valueOf(p) })), sortLabel, fmt, base, sort === 'totalGames' ? 'most' : 'top');
  const maxGames = Math.max(1, ...rows.map((p) => p.totalGames));
  const card = (p: PlayerWithSeatStats, rank: number | null, name: string): BoardCardRow => {
    const v = valueOf(p);
    const w = wins(p);
    const pair = (label: string, x: unknown): string[] => (num(x) === null ? [] : [t(`${G}.pair`, { label, value: pctText(x as number) })]);
    return {
      key: `${rank === null ? 'ref' : 'row'}-${name}`,
      rank,
      name,
      // 超額勝率有正有負，不畫成從 0 開始的長條
      value: sort === 'excessWinRate' ? null : v,
      text: v === null ? '—' : sort === 'totalGames' ? formatInt(v) : fmt(v),
      details: [
        ...(sort === 'finalWinRate' ? [] : pair(t(`${k}.col.finalWinRate`), p.finalWinRate)),
        ...pair(t(`${k}.col.red`), p.finalRedWinRate),
        ...pair(t(`${k}.col.blue`), p.finalBlueWinRate),
        ...(sort === 'totalGames' ? [] : [w === null ? t(`${G}.games`, { n: formatInt(p.totalGames) }) : t(`${G}.winsOf`, { games: formatInt(p.totalGames), wins: formatInt(w) })]),
      ],
      label: v === null ? undefined : `${name} ${sortLabel} ${fmt(v)}`,
      onClick: rank === null ? undefined : (): void => openPlayerStats(p.name),
    };
  };

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
        <span className="inline-flex items-center gap-1">
          {t(filtered ? `${k}.scopeFiltered` : `${k}.scopeAll`, { count: rows.length })}
          <InfoTip title={t(`${k}.tab`)}><p>{t(`${k}.note`)}</p></InfoTip>
        </span>
        {wide && <BenchmarkToggle />}
      </div>
      <BoardLead glance={glance} />
      {wide || rows.length === 0 ? table() : (
        <BoardCards
          rows={rows.map((p, i) => card(p, i + 1, p.name))}
          reference={section ? groups.map((g) => card(benchmarkPlayerRow(g), null, benchmarkName(t, section, g, true))) : []}
          referenceExtra={<BenchmarkToggle />}
          refValue={base}
          max={sort === 'totalGames' ? maxGames : 100}
          table={table}
        />
      )}
    </div>
  );
}
