/**
 * Panel A — 玩家 Archetype 雷達 (4 axes)
 *
 * Axes (raw 0-100):
 *   honesty     — 誠實度  (L141 lake_truthful_pct)
 *   consistency — 一致度  (L142 proxy: 100 - anomaly_vote_rate * 5)
 *   stickiness  — 專精度  (L137 proxy: top role winrate)
 *   flip        — 浮動度  (L136 proxy: anomaly_vote_rate * 5)
 *
 * Hover an axis → "你比 X% 玩家更 [軸]" via cohort percentile.
 *
 * Data source: backend /api/analysis/profile/:name/archetype.
 * Returns hasData=false when player has <10 games — component falls back to
 * an "資料不足" banner instead of the radar.
 */
import { useEffect, useState, useMemo } from 'react';
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip,
} from 'recharts';
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

const AXIS_KEYS: Array<keyof ArchetypePlayerResponse['data']['axes']> = [
  'honesty', 'consistency', 'stickiness', 'flip',
];

const AXIS_LABEL: Record<string, string> = {
  honesty:     '誠實',
  consistency: '一致',
  stickiness:  '專精',
  flip:        '浮動',
};

interface AxisChartDatum {
  axis: string;            // raw key for tooltip lookup
  dimension: string;       // display label (誠實 / 一致 / 專精 / 浮動)
  value: number;
  percentile: number;
}

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

  const chartData: AxisChartDatum[] = useMemo(() => {
    if (!resp || !resp.data.hasData) return [];
    return AXIS_KEYS.map(k => ({
      axis:       k,
      dimension:  AXIS_LABEL[k] ?? k,
      value:      resp.data.axes[k],
      percentile: resp.data.percentiles[k],
    }));
  }, [resp]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> 載入玩家風格雷達...
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

  // Top axis = where the player is most distinct.
  const topAxis = [...chartData].sort((a, b) => b.percentile - a.percentile)[0];

  return (
    <div className="bg-zinc-900/50 border border-gray-700 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-300">玩家風格雷達</h3>
        <span className="text-xs text-gray-500">{resp.data.sampleSize} 場 · 對比 {resp.cohort.n} 玩家</span>
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <RadarChart data={chartData}>
          <PolarGrid stroke="#374151" />
          <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 11, fill: '#d1d5db' }} />
          <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#6b7280' }} />
          <Radar
            name={resp.player.name}
            dataKey="value"
            stroke="#a855f7"
            fill="#a855f7"
            fillOpacity={0.35}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const d = payload[0].payload as AxisChartDatum;
              return (
                <div className="bg-zinc-900 border border-gray-700 rounded-lg px-3 py-2 text-xs">
                  <div className="text-white font-semibold">{d.dimension}</div>
                  <div className="text-gray-300">分數: {d.value.toFixed(1)}</div>
                  <div className="text-purple-300">你比 {d.percentile}% 玩家更{d.dimension}</div>
                </div>
              );
            }}
          />
        </RadarChart>
      </ResponsiveContainer>

      {/* Highlight the player's defining axis */}
      <div className="bg-purple-900/20 border border-purple-700/40 rounded-lg px-3 py-2 text-xs text-purple-200">
        最突出: <span className="font-bold">{topAxis.dimension}</span>
        <span className="text-purple-300 ml-2">(超越 {topAxis.percentile}% 玩家)</span>
      </div>

      {/* Per-axis explanation */}
      <div className="grid grid-cols-2 gap-2 text-[11px] text-gray-500">
        {AXIS_KEYS.map(k => (
          <div key={k} className="flex items-baseline gap-1">
            <span className="font-semibold text-gray-400">{AXIS_LABEL[k]}:</span>
            <span>{resp.axisHelp[k]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
