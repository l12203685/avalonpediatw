/**
 * LeaderboardV3Table — Edward 8-metric leaderboard component.
 *
 * Edward 2026-04-26 22:41 spec：
 *   - 8 metric (三紅 / 三藍死 / 三藍活 / 紅勝 / 藍勝 / 三藍 / 任務勝 / 期望勝)
 *   - Sortable by any metric column
 *   - 入場門檻 server-side (能力角 ≥ 3 場 each, 忠臣 ≥ 15 場)
 *
 * Edward 2026-04-26 22:45：精準勝率欄 (角色×位置 cell shrinkage α=5)
 *
 * Edward 2026-04-27 23:42 batch revisions：
 *   - 砍 raw/shrunk toggle (前端永遠用 raw)
 *   - 砍 主玩角色 filter (不適用 — 角色每局隨機分配)
 *   - 場次區間: 5 檔 → 3 檔 (<100 / 100-200 / >200)
 *   - 加入 ELO 分數欄 (從 V2 endpoint join)
 *   - 修 ELO 分類 filter chip click bug (state val 對齊 *_tag 簡碼)
 *   - 表格字體縮緊不換行
 *   - 母體均值 + tooltip 文案明確化
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader, AlertTriangle, ChevronUp, ChevronDown, Filter } from 'lucide-react';
import { useGameStore } from '../store/gameStore';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:3001';

interface EightMetrics {
  threeRedOnRed: number;
  threeBlueDeadOnRed: number;
  threeBlueAliveOnBlue: number;
  redWinOnRed: number;
  blueWinOnBlue: number;
  threeBlueOnBlue: number;
  missionWin: number;
  expectedWin: number;
}

/** ELO tag from V2 endpoint, used for tier filter. */
type EloTagFilter = 'novice_tag' | 'mid_tag' | 'top_tag';

/** Game-count bucket filter values (Edward 2026-04-27 simplified to 3 buckets). */
type GamesFilter = 'all' | 'lt100' | '100to200' | 'gt200';

/** ELO tier filter values. `'all'` = no filter. */
type TierFilter = 'all' | EloTagFilter;

/** Per-player join data from V2 endpoint: tag (for filter) + score (for display). */
interface EloInfo {
  tag: EloTagFilter;
  score: number;
}

/** Map of playerId → ELO info from V2 endpoint. */
type EloInfoMap = Record<string, EloInfo>;

interface V3Entry {
  playerId: string;
  displayName: string;
  totalGames: number;
  redGames: number;
  blueGames: number;
  pRed: number;
  pBlue: number;
  raw: EightMetrics;
  shrunk: EightMetrics;
  precisionWinRate: number | null;
  cellsCovered: number;
}

interface V3Response {
  version: 3;
  entries: V3Entry[];
  globalMeans: {
    threeRedOnRed: number;
    threeBlueDeadOnRed: number;
    threeBlueAliveOnBlue: number;
    cellMean: number;
  };
  meta: {
    totalPlayers: number;
    eligiblePlayers: number;
    minAbilityRoleGames: number;
    minLoyalGames: number;
    shrinkAlpha: number;
    cellShrinkAlpha: number;
  };
}

type MetricKey =
  | 'elo'
  | 'totalGames'
  | 'redGames'
  | 'blueGames'
  | 'threeRedOnRed'
  | 'threeBlueDeadOnRed'
  | 'threeBlueAliveOnBlue'
  | 'redWinOnRed'
  | 'blueWinOnBlue'
  | 'threeBlueOnBlue'
  | 'missionWin'
  | 'expectedWin'
  | 'precisionWinRate';

/**
 * OutcomeMode — segment that toggles which result perspective the table emphasizes.
 *  - all          : default, every column at full opacity, sort by expectedWin
 *  - threeRed     : 紅角立場・3-Red lens, highlight red-side cols, sort by threeRedOnRed
 *  - threeBlueDead: 紅角立場・3B-Dead lens, highlight red-side cols, sort by threeBlueDeadOnRed
 *  - threeBlueAlive: 藍角立場・3B-Alive lens, highlight blue-side cols, sort by threeBlueAliveOnBlue
 */
type OutcomeMode = 'all' | 'threeRed' | 'threeBlueDead' | 'threeBlueAlive';

/** Sort key that becomes the default when an outcome mode is selected. */
const OUTCOME_DEFAULT_SORT: Record<OutcomeMode, MetricKey> = {
  all: 'expectedWin',
  threeRed: 'threeRedOnRed',
  threeBlueDead: 'threeBlueDeadOnRed',
  threeBlueAlive: 'threeBlueAliveOnBlue',
};

/**
 * Per-column emphasis tier under each outcome mode.
 *   'highlight' — bright accent color (text-red-300 / text-blue-300 / etc.)
 *   'normal'    — default text color (existing behavior)
 *   'dim'       — opacity-50, signals "not the focus"
 *
 * Mode 'all' returns every column as 'normal' so default look is unchanged.
 */
type Emphasis = 'highlight' | 'normal' | 'dim';

const RED_SIDE_COLS: MetricKey[] = [
  'threeRedOnRed',
  'threeBlueDeadOnRed',
  'redWinOnRed',
  'missionWin',
];
const BLUE_SIDE_COLS: MetricKey[] = [
  'threeBlueAliveOnBlue',
  'blueWinOnBlue',
  'threeBlueOnBlue',
];

function getEmphasis(mode: OutcomeMode, key: MetricKey): Emphasis {
  if (mode === 'all') return 'normal';
  if (mode === 'threeRed') {
    if (key === 'threeRedOnRed') return 'highlight';
    if (RED_SIDE_COLS.includes(key)) return 'normal';
    if (BLUE_SIDE_COLS.includes(key)) return 'dim';
    return 'normal';
  }
  if (mode === 'threeBlueDead') {
    if (key === 'threeBlueDeadOnRed') return 'highlight';
    if (RED_SIDE_COLS.includes(key)) return 'normal';
    if (BLUE_SIDE_COLS.includes(key)) return 'dim';
    return 'normal';
  }
  // threeBlueAlive
  if (key === 'threeBlueAliveOnBlue') return 'highlight';
  if (BLUE_SIDE_COLS.includes(key)) return 'normal';
  if (RED_SIDE_COLS.includes(key)) return 'dim';
  return 'normal';
}

/** Bucket a totalGames count into the GamesFilter enum (excluding 'all').
 *  Edward 2026-04-27: simplified to 3 buckets — <100 / 100-200 / >200. */
function bucketGames(total: number): Exclude<GamesFilter, 'all'> {
  if (total < 100) return 'lt100';
  if (total <= 200) return '100to200';
  return 'gt200';
}

/** Read filters from URL query string with safe fallbacks. */
function readFiltersFromUrl(): { games: GamesFilter; tier: TierFilter } {
  if (typeof window === 'undefined') {
    return { games: 'all', tier: 'all' };
  }
  const params = new URLSearchParams(window.location.search);
  const gpRaw = params.get('gp');
  const tierRaw = params.get('tier');

  const validGames: GamesFilter[] = ['all', 'lt100', '100to200', 'gt200'];
  const validTier: TierFilter[] = ['all', 'novice_tag', 'mid_tag', 'top_tag'];

  const games = (validGames as string[]).includes(gpRaw ?? '') ? (gpRaw as GamesFilter) : 'all';
  const tier = (validTier as string[]).includes(tierRaw ?? '') ? (tierRaw as TierFilter) : 'all';

  return { games, tier };
}

/** Persist filters to URL query string (replaceState — no history entry). */
function writeFiltersToUrl(games: GamesFilter, tier: TierFilter): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (games === 'all') params.delete('gp');
  else params.set('gp', games);
  if (tier === 'all') params.delete('tier');
  else params.set('tier', tier);
  // Strip legacy ?main= param (Edward 2026-04-27 砍主玩角色 filter)
  params.delete('main');
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState({}, '', next);
}

/** Tooltip wrapper — pure CSS hover, no extra dep */
function HelpTip({ id, label, hint }: { id: string; label: string; hint: string }): JSX.Element {
  return (
    <span className="relative group inline-flex items-center cursor-help" aria-describedby={id}>
      <span>{label}</span>
      <span
        id={id}
        role="tooltip"
        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-gray-900 text-gray-100 text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10 border border-gray-700"
      >
        {hint}
      </span>
    </span>
  );
}

export default function LeaderboardV3Table(): JSX.Element {
  const { t } = useTranslation(['leaderboard', 'common']);
  const { navigateToProfile } = useGameStore();

  const [data, setData] = useState<V3Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [outcomeMode, setOutcomeMode] = useState<OutcomeMode>('all');
  const [sortKey, setSortKey] = useState<MetricKey>('expectedWin');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  /** Track whether user manually clicked a header within current outcome mode.
   *  Switching mode resets the flag so the new default sort kicks in. */
  const [userOverrodeSort, setUserOverrodeSort] = useState(false);

  // ─────────────────────────────────────────────────────────────────────
  // Filter state (Edward 2026-04-27 batch revisions)
  //   - 場次區間: 3 檔 (<100 / 100-200 / >200)
  //   - ELO 分類: 從 V2 endpoint join
  //   - URL persisted via ?gp=&tier=
  //   - 砍 主玩角色 filter (角色每局隨機分配, 不是 player skill)
  // ─────────────────────────────────────────────────────────────────────
  const initial = useMemo(() => readFiltersFromUrl(), []);
  const [gamesFilter, setGamesFilter] = useState<GamesFilter>(initial.games);
  const [tierFilter, setTierFilter] = useState<TierFilter>(initial.tier);

  /** ELO info map (playerId → { tag, score }) joined from V2 endpoint. Null = not loaded yet. */
  const [eloInfoMap, setEloInfoMap] = useState<EloInfoMap | null>(null);
  /** True if V2 fetch failed — we disable tier filter and show tooltip. */
  const [eloLoadFailed, setEloLoadFailed] = useState(false);

  useEffect(() => {
    fetch(`${SERVER_URL}/api/leaderboard/v3`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as V3Response;
      })
      .then((payload) => {
        if (payload?.entries) setData(payload);
        else setError(t('leaderboard:loadFailed'));
      })
      .catch(() => setError(t('leaderboard:loadFailed')))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Fetch V2 endpoint to build playerId → ELO info (tag + score) map. */
  useEffect(() => {
    fetch(`${SERVER_URL}/api/leaderboard/v2`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as
          | {
              version: 2;
              groups: Record<
                string,
                Array<{ playerId: string; eloTag: EloTagFilter; elo: number }>
              >;
            }
          | { message: string };
      })
      .then((payload) => {
        if ('message' in payload) {
          setEloLoadFailed(true);
          return;
        }
        const map: EloInfoMap = {};
        for (const group of Object.values(payload.groups ?? {})) {
          for (const entry of group) {
            if (entry?.playerId && entry?.eloTag && typeof entry.elo === 'number') {
              map[entry.playerId] = { tag: entry.eloTag, score: entry.elo };
            }
          }
        }
        setEloInfoMap(map);
      })
      .catch(() => setEloLoadFailed(true));
  }, []);

  /** Persist filter state to URL (replaceState — no history entry). */
  useEffect(() => {
    writeFiltersToUrl(gamesFilter, tierFilter);
  }, [gamesFilter, tierFilter]);

  /** Read metric value from entry. Edward 2026-04-27: 永遠用 raw (砍 raw/shrunk toggle). */
  const getValue = (e: V3Entry, key: MetricKey): number => {
    if (key === 'elo') return eloInfoMap?.[e.playerId]?.score ?? -1;
    if (key === 'totalGames') return e.totalGames;
    if (key === 'redGames') return e.redGames;
    if (key === 'blueGames') return e.blueGames;
    if (key === 'precisionWinRate') return e.precisionWinRate ?? -1;
    return e.raw[key as keyof EightMetrics];
  };

  /** Apply filter mask first, then sort. Filter is independent of sort. */
  const sorted = useMemo<V3Entry[]>(() => {
    if (!data) return [];
    const masked = data.entries.filter((e) => {
      // 場次區間
      if (gamesFilter !== 'all' && bucketGames(e.totalGames) !== gamesFilter) return false;
      // ELO tier — only apply if eloInfoMap loaded; if entry missing from map, exclude when filtering
      if (tierFilter !== 'all') {
        if (!eloInfoMap) return false;
        if (eloInfoMap[e.playerId]?.tag !== tierFilter) return false;
      }
      return true;
    });
    masked.sort((a, b) => {
      const av = getValue(a, sortKey);
      const bv = getValue(b, sortKey);
      const diff = av - bv;
      return sortDir === 'asc' ? diff : -diff;
    });
    return masked;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, sortKey, sortDir, gamesFilter, tierFilter, eloInfoMap]);

  /** True iff any filter is active. */
  const hasActiveFilter = gamesFilter !== 'all' || tierFilter !== 'all';

  /** Clear all filters back to defaults. */
  const clearFilters = (): void => {
    setGamesFilter('all');
    setTierFilter('all');
  };

  const handleSort = (key: MetricKey): void => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // win-rate metrics default desc; game-count metrics default desc too
      setSortDir('desc');
    }
    // User now controls sort for current outcome mode; persist until mode change.
    setUserOverrodeSort(true);
  };

  /** When outcome mode changes (and user hasn't manually overridden), apply default sort. */
  useEffect(() => {
    if (userOverrodeSort) return;
    setSortKey(OUTCOME_DEFAULT_SORT[outcomeMode]);
    setSortDir('desc');
  }, [outcomeMode, userOverrodeSort]);

  /** Switch outcome mode + reset user-override flag so default sort takes over. */
  const switchOutcomeMode = (next: OutcomeMode): void => {
    setOutcomeMode(next);
    setUserOverrodeSort(false);
  };

  const SortIcon = ({ k }: { k: MetricKey }): JSX.Element | null => {
    if (sortKey !== k) return null;
    return sortDir === 'asc' ? (
      <ChevronUp size={12} className="inline ml-0.5 text-blue-400" />
    ) : (
      <ChevronDown size={12} className="inline ml-0.5 text-blue-400" />
    );
  };

  /** Headers config. derived columns (4/5) flagged for visual hint. */
  const HEADERS: Array<{
    key: MetricKey;
    label: string;
    tip?: string;
    derived?: boolean;
    align: 'left' | 'right';
  }> = [
    {
      key: 'elo',
      label: t('leaderboard:v3.headers.elo'),
      tip: t('leaderboard:v3.tooltips.elo'),
      align: 'right',
    },
    { key: 'totalGames', label: t('leaderboard:v3.headers.totalGames'), align: 'right' },
    { key: 'redGames', label: t('leaderboard:v3.headers.redGames'), align: 'right' },
    { key: 'blueGames', label: t('leaderboard:v3.headers.blueGames'), align: 'right' },
    {
      key: 'threeRedOnRed',
      label: t('leaderboard:v3.headers.threeRed'),
      tip: t('leaderboard:v3.tooltips.threeRed'),
      align: 'right',
    },
    {
      key: 'threeBlueDeadOnRed',
      label: t('leaderboard:v3.headers.threeBlueDead'),
      tip: t('leaderboard:v3.tooltips.threeBlueDead'),
      align: 'right',
    },
    {
      key: 'threeBlueAliveOnBlue',
      label: t('leaderboard:v3.headers.threeBlueAlive'),
      tip: t('leaderboard:v3.tooltips.threeBlueAlive'),
      align: 'right',
    },
    {
      key: 'redWinOnRed',
      label: t('leaderboard:v3.headers.redWin'),
      tip: t('leaderboard:v3.tooltips.redWin'),
      derived: true,
      align: 'right',
    },
    {
      key: 'blueWinOnBlue',
      label: t('leaderboard:v3.headers.blueWin'),
      tip: t('leaderboard:v3.tooltips.blueWin'),
      derived: true,
      align: 'right',
    },
    {
      key: 'threeBlueOnBlue',
      label: t('leaderboard:v3.headers.threeBlue'),
      tip: t('leaderboard:v3.tooltips.threeBlue'),
      align: 'right',
    },
    {
      key: 'missionWin',
      label: t('leaderboard:v3.headers.missionWin'),
      tip: t('leaderboard:v3.tooltips.missionWin'),
      align: 'right',
    },
    {
      key: 'expectedWin',
      label: t('leaderboard:v3.headers.expectedWin'),
      tip: t('leaderboard:v3.tooltips.expectedWin'),
      align: 'right',
    },
    {
      key: 'precisionWinRate',
      label: t('leaderboard:v3.headers.precision'),
      tip: t('leaderboard:v3.tooltips.precision'),
      align: 'right',
    },
  ];

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader size={24} className="animate-spin text-blue-400" />
        <span className="ml-2 text-sm text-gray-400">{t('leaderboard:v3.loading')}</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-red-900/40 border border-red-700 rounded-xl p-4 text-red-200 text-sm flex items-center gap-2">
        <AlertTriangle size={16} />
        {error || t('leaderboard:loadFailed')}
      </div>
    );
  }

  const meta = data.meta;
  const gm = data.globalMeans;

  return (
    <div className="space-y-3">
      {/* Subtitle + meta — Edward 2026-04-27: 上榜條件 + 母體均值說明 */}
      <div className="text-[11px] text-gray-400 leading-relaxed">
        <p className="text-gray-300">{t('leaderboard:v3.eligibilityRule')}</p>
        <p className="mt-1">
          {t('leaderboard:v3.eligibleCount', {
            eligible: meta.eligiblePlayers,
            total: meta.totalPlayers,
          })}
        </p>
        <p className="mt-1 text-[10px] text-gray-500">
          {t('leaderboard:v3.popAvgExplain')}
        </p>
        <p className="mt-1 text-[10px] text-gray-500">
          {t('leaderboard:v3.globalMeans')}: 三紅={gm.threeRedOnRed}% · 三藍死={gm.threeBlueDeadOnRed}% · 三藍活={gm.threeBlueAliveOnBlue}% · cell={gm.cellMean}%
        </p>
      </div>

      {/*
        Toolbar — Edward 2026-04-27 砍 raw/shrunk toggle (永遠用 raw)：
          left   : outcome-mode segmented control
          right  : filter clear button (chips below)
      */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {/* Outcome-mode segmented control */}
        <div className="flex items-center gap-1" role="group" aria-label="outcome mode">
          {(['all', 'threeRed', 'threeBlueDead', 'threeBlueAlive'] as const).map((om) => {
            const active = outcomeMode === om;
            const activeCls =
              om === 'threeRed'
                ? 'bg-red-900/60 text-red-200 border-red-600'
                : om === 'threeBlueDead'
                  ? 'bg-purple-900/60 text-purple-200 border-purple-600'
                  : om === 'threeBlueAlive'
                    ? 'bg-blue-900/60 text-blue-200 border-blue-600'
                    : 'bg-gray-700/70 text-gray-100 border-gray-500';
            return (
              <button
                key={om}
                onClick={() => switchOutcomeMode(om)}
                className={`px-3 py-1.5 rounded-full border transition-all ${
                  active
                    ? activeCls
                    : 'bg-gray-800/60 text-gray-400 border-gray-700 hover:border-gray-500'
                }`}
                aria-pressed={active}
              >
                {t(`leaderboard:v3.outcomeMode.${om}`)}
              </button>
            );
          })}
        </div>

        {/* Right segment — filter label + clear */}
        <div
          className="ml-auto inline-flex items-center gap-1 text-[10px]"
          data-slot="leaderboard-v3-filter-toolbar"
        >
          <span className="inline-flex items-center gap-1 text-gray-400 font-semibold">
            <Filter size={11} />
            {t('leaderboard:v3.filters.label')}:
          </span>
          {hasActiveFilter && (
            <button
              onClick={clearFilters}
              className="px-2 py-0.5 rounded-full border border-gray-600 bg-gray-800/60 text-gray-300 hover:border-gray-400 hover:text-white transition-all"
            >
              {t('leaderboard:v3.filters.clear')}
            </button>
          )}
        </div>
      </div>

      {/* Filter chips row — Edward 2026-04-27 simplified to 場次 (3 檔) + ELO 分類 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px]">
        {/* 場次區間 — 3 檔 */}
        <div className="inline-flex items-center gap-1">
          <span className="text-gray-500 mr-1">{t('leaderboard:v3.filters.games.label')}</span>
          {(
            [
              ['all', t('leaderboard:v3.filters.all')],
              ['lt100', t('leaderboard:v3.filters.games.lt100')],
              ['100to200', t('leaderboard:v3.filters.games.100to200')],
              ['gt200', t('leaderboard:v3.filters.games.gt200')],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setGamesFilter(val as GamesFilter)}
              className={`px-2 py-0.5 rounded-full border transition-all whitespace-nowrap ${
                gamesFilter === val
                  ? 'bg-amber-900/50 text-amber-200 border-amber-600'
                  : 'bg-gray-800/60 text-gray-400 border-gray-700 hover:border-gray-500'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ELO 分類 — Edward 2026-04-27 修 chip click bug (state val 對齊 *_tag) */}
        <div
          className="inline-flex items-center gap-1"
          title={eloLoadFailed ? t('leaderboard:v3.filters.tier.loadFailed') : undefined}
        >
          <span className={`mr-1 ${eloLoadFailed ? 'text-gray-600' : 'text-gray-500'}`}>
            {t('leaderboard:v3.filters.tier.label')}
          </span>
          {(
            [
              ['all', t('leaderboard:v3.filters.all')],
              ['novice_tag', t('leaderboard:v3.filters.tier.novice')],
              ['mid_tag', t('leaderboard:v3.filters.tier.mid')],
              ['top_tag', t('leaderboard:v3.filters.tier.top')],
            ] as const
          ).map(([val, label]) => {
            const disabled = eloLoadFailed && val !== 'all';
            return (
              <button
                key={val}
                onClick={() => !disabled && setTierFilter(val as TierFilter)}
                disabled={disabled}
                className={`px-2 py-0.5 rounded-full border transition-all whitespace-nowrap ${
                  disabled
                    ? 'bg-gray-900/40 text-gray-600 border-gray-800 cursor-not-allowed'
                    : tierFilter === val
                      ? 'bg-blue-900/50 text-blue-200 border-blue-600'
                      : 'bg-gray-800/60 text-gray-400 border-gray-700 hover:border-gray-500'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* No-match empty state when filters yield zero rows */}
      {hasActiveFilter && sorted.length === 0 && (
        <div className="bg-gray-900/40 border border-gray-700 rounded-xl p-6 text-center text-sm text-gray-400 space-y-3">
          <p>{t('leaderboard:v3.filters.noMatch')}</p>
          <button
            onClick={clearFilters}
            className="px-3 py-1.5 rounded-full border border-blue-600 bg-blue-900/40 text-blue-200 text-xs hover:bg-blue-900/60 transition-all"
          >
            {t('leaderboard:v3.filters.clear')}
          </button>
        </div>
      )}

      {/*
        Stats pill row — global outcome distribution (2146 games full record).
        The pill matching the active outcomeMode highlights with a thicker border.
        Numbers are hard-coded into i18n (per spec, no endpoint).
      */}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        {(
          [
            { om: 'all', i18nKey: 'leaderboard:v3.outcomeMode.statsAll', tone: 'gray' },
            { om: 'threeRed', i18nKey: 'leaderboard:v3.outcomeMode.statsThreeRed', tone: 'red' },
            {
              om: 'threeBlueDead',
              i18nKey: 'leaderboard:v3.outcomeMode.statsThreeBlueDead',
              tone: 'purple',
            },
            {
              om: 'threeBlueAlive',
              i18nKey: 'leaderboard:v3.outcomeMode.statsThreeBlueAlive',
              tone: 'blue',
            },
          ] as Array<{ om: OutcomeMode; i18nKey: string; tone: 'gray' | 'red' | 'purple' | 'blue' }>
        ).map(({ om, i18nKey, tone }) => {
          const active = outcomeMode === om;
          const toneCls =
            tone === 'red'
              ? active
                ? 'bg-red-900/40 text-red-200 border-red-500'
                : 'bg-gray-800/40 text-red-300/70 border-gray-700'
              : tone === 'purple'
                ? active
                  ? 'bg-purple-900/40 text-purple-200 border-purple-500'
                  : 'bg-gray-800/40 text-purple-300/70 border-gray-700'
                : tone === 'blue'
                  ? active
                    ? 'bg-blue-900/40 text-blue-200 border-blue-500'
                    : 'bg-gray-800/40 text-blue-300/70 border-gray-700'
                  : active
                    ? 'bg-gray-700/60 text-gray-100 border-gray-400'
                    : 'bg-gray-800/40 text-gray-400 border-gray-700';
          return (
            <span
              key={om}
              className={`px-2 py-0.5 rounded-full border ${toneCls} ${
                active ? 'border-2 font-semibold' : ''
              }`}
            >
              {t(i18nKey)}
            </span>
          );
        })}
      </div>

      {/*
        Sortable table — Edward 2026-04-27: 字體縮緊 + nowrap，永遠用 raw 數值。
        Container: text-[11px] (smaller than text-xs); cells/headers: whitespace-nowrap.
      */}
      <div className="overflow-x-auto -mx-4 px-4">
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="border-b border-gray-700 text-gray-400">
              <th
                className="text-left py-2 pr-2 font-semibold sticky left-0 bg-avalon-bg whitespace-nowrap"
                style={{ minWidth: '72px' }}
              >
                {t('leaderboard:v3.headers.player')}
              </th>
              {HEADERS.map((h) => {
                const emp = getEmphasis(outcomeMode, h.key);
                // emphasis tier classNames — applied IN ADDITION to existing styling
                //   highlight: brighter accent text + soft background tint
                //   dim      : opacity-50 to push column back visually
                //   normal   : no extra class
                const empCls =
                  emp === 'highlight'
                    ? 'text-amber-200 bg-amber-900/10'
                    : emp === 'dim'
                      ? 'opacity-50'
                      : '';
                return (
                  <th
                    key={h.key}
                    className={`py-2 px-1 font-semibold cursor-pointer hover:text-white transition-colors whitespace-nowrap text-${h.align} ${
                      h.derived ? 'text-gray-500 italic' : ''
                    } ${empCls}`}
                    onClick={() => handleSort(h.key)}
                    title={h.tip}
                  >
                    {h.tip ? (
                      <HelpTip id={`th-${h.key}`} label={h.label} hint={h.tip} />
                    ) : (
                      h.label
                    )}
                    <SortIcon k={h.key} />
                    {h.derived ? <span className="text-[8px] ml-0.5">*</span> : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((e, idx) => {
              // Edward 2026-04-27: 永遠用 raw 數值 (砍 raw/shrunk toggle)
              const m = e.raw;
              const eloInfo = eloInfoMap?.[e.playerId];
              // Per-cell emphasis class for current outcomeMode.
              //   highlight → brighter accent + ring; dim → opacity-50; normal → ''
              const cellCls = (k: MetricKey): string => {
                const emp = getEmphasis(outcomeMode, k);
                if (emp === 'highlight') return 'bg-amber-900/10 ring-1 ring-amber-700/40';
                if (emp === 'dim') return 'opacity-50';
                return '';
              };
              return (
                <tr
                  key={e.playerId}
                  className="border-b border-gray-800 hover:bg-gray-800/40 transition-colors cursor-pointer"
                  onClick={() => navigateToProfile(e.playerId)}
                >
                  <td className="py-1 pr-2 sticky left-0 bg-avalon-bg whitespace-nowrap">
                    <span className="text-gray-500 mr-1">{idx + 1}</span>
                    <span className="text-white font-medium">{e.displayName}</span>
                  </td>
                  <td className={`py-1 px-1 text-right text-yellow-300 font-semibold whitespace-nowrap ${cellCls('elo')}`}>
                    {eloInfo ? eloInfo.score : '—'}
                  </td>
                  <td className={`py-1 px-1 text-right text-gray-300 whitespace-nowrap ${cellCls('totalGames')}`}>
                    {e.totalGames}
                  </td>
                  <td className={`py-1 px-1 text-right text-red-300 whitespace-nowrap ${cellCls('redGames')}`}>
                    {e.redGames}
                  </td>
                  <td className={`py-1 px-1 text-right text-blue-300 whitespace-nowrap ${cellCls('blueGames')}`}>
                    {e.blueGames}
                  </td>
                  <td
                    className={`py-1 px-1 text-right text-gray-200 whitespace-nowrap ${cellCls('threeRedOnRed')}`}
                  >
                    {m.threeRedOnRed}%
                  </td>
                  <td
                    className={`py-1 px-1 text-right text-gray-200 whitespace-nowrap ${cellCls('threeBlueDeadOnRed')}`}
                  >
                    {m.threeBlueDeadOnRed}%
                  </td>
                  <td
                    className={`py-1 px-1 text-right text-gray-200 whitespace-nowrap ${cellCls('threeBlueAliveOnBlue')}`}
                  >
                    {m.threeBlueAliveOnBlue}%
                  </td>
                  <td
                    className={`py-1 px-1 text-right text-gray-400 italic whitespace-nowrap ${cellCls('redWinOnRed')}`}
                  >
                    {m.redWinOnRed}%
                  </td>
                  <td
                    className={`py-1 px-1 text-right text-gray-400 italic whitespace-nowrap ${cellCls('blueWinOnBlue')}`}
                  >
                    {m.blueWinOnBlue}%
                  </td>
                  <td
                    className={`py-1 px-1 text-right text-gray-200 whitespace-nowrap ${cellCls('threeBlueOnBlue')}`}
                  >
                    {m.threeBlueOnBlue}%
                  </td>
                  <td
                    className={`py-1 px-1 text-right text-amber-300 font-semibold whitespace-nowrap ${cellCls('missionWin')}`}
                  >
                    {m.missionWin}%
                  </td>
                  <td
                    className={`py-1 px-1 text-right text-emerald-300 font-bold whitespace-nowrap ${cellCls('expectedWin')}`}
                  >
                    {m.expectedWin}%
                  </td>
                  <td
                    className={`py-1 px-1 text-right text-purple-300 font-semibold whitespace-nowrap ${cellCls('precisionWinRate')}`}
                  >
                    {e.precisionWinRate !== null
                      ? `${e.precisionWinRate}%`
                      : t('leaderboard:v3.noPrecision')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-gray-600">
        * {t('leaderboard:v3.headers.redWin')} / {t('leaderboard:v3.headers.blueWin')} 為衍生欄
        (= {t('leaderboard:v3.headers.threeRed')}+{t('leaderboard:v3.headers.threeBlueDead')} /
        ={' '}
        {t('leaderboard:v3.headers.threeBlueAlive')})
      </p>
    </div>
  );
}
