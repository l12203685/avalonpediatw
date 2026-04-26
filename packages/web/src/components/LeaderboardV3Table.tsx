/**
 * LeaderboardV3Table — Edward 8-metric leaderboard component.
 *
 * Edward 2026-04-26 22:41 spec：
 *   - 8 metric (三紅 / 三藍死 / 三藍活 / 紅勝 / 藍勝 / 三藍 / 任務勝 / 期望勝)
 *   - Sortable by any metric column
 *   - Toggle Raw / Shrinkage (Bayesian α=10)
 *   - 入場門檻 server-side (能力角 ≥ 3 場 each, 忠臣 ≥ 15 場)
 *
 * Edward 2026-04-26 22:45：精準勝率欄 (角色×位置 cell shrinkage α=5)
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader, AlertTriangle, ChevronUp, ChevronDown } from 'lucide-react';
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

type Mode = 'raw' | 'shrunk';

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
  const [mode, setMode] = useState<Mode>('shrunk');
  const [sortKey, setSortKey] = useState<MetricKey>('expectedWin');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

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

  /** Read metric value from entry given current mode (raw/shrunk). */
  const getValue = (e: V3Entry, key: MetricKey): number => {
    if (key === 'totalGames') return e.totalGames;
    if (key === 'redGames') return e.redGames;
    if (key === 'blueGames') return e.blueGames;
    if (key === 'precisionWinRate') return e.precisionWinRate ?? -1;
    const bag = mode === 'raw' ? e.raw : e.shrunk;
    return bag[key as keyof EightMetrics];
  };

  const sorted = useMemo<V3Entry[]>(() => {
    if (!data) return [];
    const list = [...data.entries];
    list.sort((a, b) => {
      const av = getValue(a, sortKey);
      const bv = getValue(b, sortKey);
      const diff = av - bv;
      return sortDir === 'asc' ? diff : -diff;
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, sortKey, sortDir, mode]);

  const handleSort = (key: MetricKey): void => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // win-rate metrics default desc; game-count metrics default desc too
      setSortDir('desc');
    }
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
      {/* Subtitle + meta */}
      <div className="text-xs text-gray-400 leading-relaxed">
        <p>{t('leaderboard:v3.subtitle')}</p>
        <p className="mt-1">
          {t('leaderboard:v3.eligibleCount', {
            eligible: meta.eligiblePlayers,
            total: meta.totalPlayers,
          })}
        </p>
        <p className="mt-1 text-[10px] text-gray-500">
          {t('leaderboard:v3.globalMeans')}: 三紅={gm.threeRedOnRed}% · 三藍死={gm.threeBlueDeadOnRed}% · 三藍活={gm.threeBlueAliveOnBlue}% · cell={gm.cellMean}%
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex items-center gap-2 text-xs">
        <button
          onClick={() => setMode('raw')}
          className={`px-3 py-1.5 rounded-full border transition-all ${
            mode === 'raw'
              ? 'bg-blue-900/60 text-blue-200 border-blue-600'
              : 'bg-gray-800/60 text-gray-400 border-gray-700 hover:border-gray-500'
          }`}
        >
          {t('leaderboard:v3.rawMode')}
        </button>
        <button
          onClick={() => setMode('shrunk')}
          className={`px-3 py-1.5 rounded-full border transition-all ${
            mode === 'shrunk'
              ? 'bg-emerald-900/60 text-emerald-200 border-emerald-600'
              : 'bg-gray-800/60 text-gray-400 border-gray-700 hover:border-gray-500'
          }`}
        >
          {t('leaderboard:v3.shrinkMode')}
        </button>
        <span className="text-[10px] text-gray-500 ml-2">
          {mode === 'raw'
            ? t('leaderboard:v3.rawHint')
            : t('leaderboard:v3.shrinkHint')}
        </span>
      </div>

      {/* Sortable table */}
      <div className="overflow-x-auto -mx-4 px-4">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-gray-700 text-gray-400">
              <th
                className="text-left py-2 pr-2 font-semibold sticky left-0 bg-avalon-bg"
                style={{ minWidth: '80px' }}
              >
                {t('leaderboard:v3.headers.player')}
              </th>
              {HEADERS.map((h) => (
                <th
                  key={h.key}
                  className={`py-2 px-1.5 font-semibold cursor-pointer hover:text-white transition-colors text-${h.align} ${
                    h.derived ? 'text-gray-500 italic' : ''
                  }`}
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
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((e, idx) => {
              const m = mode === 'raw' ? e.raw : e.shrunk;
              return (
                <tr
                  key={e.playerId}
                  className="border-b border-gray-800 hover:bg-gray-800/40 transition-colors cursor-pointer"
                  onClick={() => navigateToProfile(e.playerId)}
                >
                  <td className="py-1.5 pr-2 sticky left-0 bg-avalon-bg">
                    <span className="text-gray-500 mr-1">{idx + 1}</span>
                    <span className="text-white font-medium">{e.displayName}</span>
                  </td>
                  <td className="py-1.5 px-1.5 text-right text-gray-300">{e.totalGames}</td>
                  <td className="py-1.5 px-1.5 text-right text-red-300">{e.redGames}</td>
                  <td className="py-1.5 px-1.5 text-right text-blue-300">{e.blueGames}</td>
                  <td className="py-1.5 px-1.5 text-right text-gray-200">{m.threeRedOnRed}%</td>
                  <td className="py-1.5 px-1.5 text-right text-gray-200">
                    {m.threeBlueDeadOnRed}%
                  </td>
                  <td className="py-1.5 px-1.5 text-right text-gray-200">
                    {m.threeBlueAliveOnBlue}%
                  </td>
                  <td className="py-1.5 px-1.5 text-right text-gray-400 italic">
                    {m.redWinOnRed}%
                  </td>
                  <td className="py-1.5 px-1.5 text-right text-gray-400 italic">
                    {m.blueWinOnBlue}%
                  </td>
                  <td className="py-1.5 px-1.5 text-right text-gray-200">{m.threeBlueOnBlue}%</td>
                  <td className="py-1.5 px-1.5 text-right text-amber-300 font-semibold">
                    {m.missionWin}%
                  </td>
                  <td className="py-1.5 px-1.5 text-right text-emerald-300 font-bold">
                    {m.expectedWin}%
                  </td>
                  <td className="py-1.5 px-1.5 text-right text-purple-300 font-semibold">
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
