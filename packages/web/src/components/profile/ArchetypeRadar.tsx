/**
 * Panel A — 玩家風格（Edward 2026-10-28：原本的「誠實度、一致度、專精度、浮動度」看不懂，改成白話的三個數字）
 *
 * The cache's axes (raw 0-100) and what each row shows:
 *   honesty     → 持湖說真話：拿到湖中女神後，宣告和實際陣營相符的比例（L141 lake_truthful_pct；藍紅合算）
 *   flip        → 異常票：隊外投白、隊內投黑的比例（axis = rate × 5, clipped at 100）
 *   stickiness  → 最強角色勝率：勝率最高的角色的勝率（L137 proxy: top role winrate）
 *   consistency is 100 − flip (the same number), so it is not shown.
 *
 * Each row says how the player compares: "高於 X% 玩家" from the cohort percentile.
 *
 * Data source: backend /api/analysis/profile/:name/archetype.
 * Returns hasData=false when player has <10 games — component falls back to
 * an "資料不足" banner instead.
 */
import { useEffect, useState } from 'react';
import { Loader, AlertCircle } from 'lucide-react';
import {
  fetchPlayerArchetype,
  getErrorMessage,
  type ArchetypePlayerResponse,
} from '../../services/api';

interface ArchetypeRadarProps {
  /** Display name as keyed in analysis_cache.json (e.g. "Sin", "HAO"). */
  playerName: string;
}

type AxisKey = keyof ArchetypePlayerResponse['data']['axes'];

interface StyleRow {
  key: AxisKey;
  label: string;
  /** The rate shown, from the raw axis. */
  value: (axis: number) => string;
  /** How the percentile is said: 高於 / 多於. */
  compare: string;
  help: string;
}

const ROWS: StyleRow[] = [
  {
    key: 'honesty', label: '持湖說真話', value: (v) => `${v.toFixed(1)}%`, compare: '高於',
    help: '拿到湖中女神後，宣告和實際陣營相符的比例（藍紅合算；紅方說謊是正常戰術）',
  },
  {
    key: 'flip', label: '異常票', value: (v) => (v >= 100 ? '≥20%' : `${(v / 5).toFixed(1)}%`), compare: '多於',
    help: '隊外投白、隊內投黑的比例（越高 = 投票越不照常規）',
  },
  {
    key: 'stickiness', label: '最強角色勝率', value: (v) => `${v.toFixed(1)}%`, compare: '高於',
    help: '自己勝率最高的那個角色的勝率',
  },
];

export default function ArchetypeRadar({ playerName }: ArchetypeRadarProps): JSX.Element {
  const [resp, setResp]       = useState<ArchetypePlayerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPlayerArchetype(playerName)
      .then(d => { if (!cancelled) setResp(d); })
      .catch(e => { if (!cancelled) setError(getErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [playerName]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> 載入玩家風格...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-10 text-red-400 gap-3">
        <AlertCircle size={20} /> {error}
      </div>
    );
  }

  if (!resp || !resp.data.hasData) {
    const totalGames = resp?.data.sampleSize ?? 0;
    return (
      <div className="bg-zinc-900/50 border border-gray-700 rounded-xl p-6 text-center text-gray-400">
        <AlertCircle size={20} className="inline mr-2 align-middle" />
        資料不足（需 ≥ 10 場）— 目前 {totalGames} 場
      </div>
    );
  }

  return (
    <div className="bg-zinc-900/50 border border-gray-700 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-300">玩家風格</h3>
        <span className="text-xs text-gray-500">{resp.data.sampleSize} 場 · 對比 {resp.cohort.n} 位玩家</span>
      </div>

      <div className="space-y-3">
        {ROWS.map(row => {
          const axis = resp.data.axes[row.key];
          const pr = Math.round(resp.data.percentiles[row.key]);
          return (
            <div key={row.key} data-testid={`style-row-${row.key}`}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold text-gray-200">{row.label}</span>
                <span className="text-white font-bold tabular-nums">{row.value(axis)}</span>
              </div>
              <div className="h-1.5 bg-zinc-800 rounded-full mt-1 overflow-hidden" aria-hidden>
                <div className="h-full bg-purple-500/80" style={{ width: `${pr}%` }} />
              </div>
              <div className="flex justify-between gap-2 text-[11px] mt-0.5">
                <span className="text-gray-500">{row.help}</span>
                <span className="text-purple-300 whitespace-nowrap">{row.compare} {pr}% 玩家</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
