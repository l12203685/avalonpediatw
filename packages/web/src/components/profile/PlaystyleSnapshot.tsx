/**
 * Panel C — 對戰風格快照 (Playstyle Snapshot)
 *
 * Three signals derived from real Firestore game records:
 *   1. R3+ 強硬度 (reject rate at round 3+, split by player's role camp)
 *      = reject votes / total votes cast in R3-R5
 *   2. 刺客目標座位偏好 (assassin attacker's top-3 target seats),
 *      shown only when player has been assassin >= 3 times
 *   3. 隊長 stickiness (proportion of leader proposals where the next proposal
 *      keeps the same team), shown only when player has led >= 5 proposals
 *
 * Data source: backend /api/analysis/profile/:name/playstyle.
 */
import { useEffect, useState } from 'react';
import { Loader, AlertCircle } from 'lucide-react';
import {
  fetchPlayerPlaystyle,
  getErrorMessage,
  type PlaystylePlayerResponse,
} from '../../services/api';

interface PlaystyleSnapshotProps {
  playerName: string;
}

function formatPctile(p: number | null): string {
  if (p === null) return '';
  if (p >= 80) return `top ${(100 - p).toFixed(0)}%`;
  if (p <= 20) return `bottom ${p.toFixed(0)}%`;
  return `${p.toFixed(0)} 百分位`;
}

function pctileColor(p: number | null): string {
  if (p === null) return 'text-gray-500';
  if (p >= 70) return 'text-emerald-300';
  if (p <= 30) return 'text-rose-300';
  return 'text-slate-200';
}

function seatRangeLabel(seats: number[]): string {
  // Seats sorted by count desc; we group into front/mid/back if applicable.
  const sortedAsc = [...seats].sort((a, b) => a - b);
  const min = sortedAsc[0];
  const max = sortedAsc[sortedAsc.length - 1];
  return `${min}–${max}`;
}

export default function PlaystyleSnapshot({ playerName }: PlaystyleSnapshotProps): JSX.Element {
  const [resp, setResp]       = useState<PlaystylePlayerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPlayerPlaystyle(playerName)
      .then(d => { if (!cancelled) setResp(d); })
      .catch(e => { if (!cancelled) setError(getErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [playerName]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> 載入對戰風格...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8 text-red-400 gap-3">
        <AlertCircle size={20} /> {error}
      </div>
    );
  }

  if (!resp || !resp.data.hasData) {
    return (
      <div className="bg-zinc-900/50 border border-gray-700 rounded-xl p-6 text-center text-gray-400">
        <AlertCircle size={20} className="inline mr-2 align-middle" />
        資料不足（需 R3+ 投票 ≥ {resp?.thresholds.r3MinVotes ?? 10} 次或刺客 ≥ {resp?.thresholds.assassinMinAttempts ?? 3} 場）
      </div>
    );
  }

  const d = resp.data;
  const labels = resp.labels;

  const rows: Array<{ label: string; value: string; pctile: number | null; sub?: string }> = [];

  if (d.r3RejectRate.red !== null) {
    rows.push({
      label: labels.r3RejectRedLabel,
      value: `${d.r3RejectRate.red.toFixed(2)}`,
      pctile: d.r3RejectPercentile.red,
      sub: 'R3-R5 紅角投否決比 (越高 = 越強硬)',
    });
  }
  if (d.r3RejectRate.blue !== null) {
    rows.push({
      label: labels.r3RejectBlueLabel,
      value: `${d.r3RejectRate.blue.toFixed(2)}`,
      pctile: d.r3RejectPercentile.blue,
      sub: 'R3-R5 藍角投否決比 (高 = 強硬)',
    });
  }
  if (d.assassinTopSeats && d.assassinTopSeats.length > 0) {
    const range = seatRangeLabel(d.assassinTopSeats);
    rows.push({
      label: labels.assassinTargetLabel,
      value: `座 ${d.assassinTopSeats.join('-')}`,
      pctile: null,
      sub: `刺 ${d.assassinAttempts} 次, 偏好區間 座 ${range}`,
    });
  }
  if (d.captainStickiness !== null) {
    rows.push({
      label: labels.captainStickinessLabel,
      value: `${d.captainStickiness.toFixed(2)}`,
      pctile: d.captainStickinessPercentile,
      sub: '同隊重提比 (高 = 堅持型)',
    });
  }

  return (
    <div className="bg-zinc-900/50 border border-gray-700 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-300">對戰風格快照</h3>
        <span className="text-xs text-gray-500">vs 全玩家 cohort</span>
      </div>

      <div className="space-y-2">
        {rows.map(r => (
          <div
            key={r.label}
            className="flex items-baseline justify-between gap-2 px-3 py-2 rounded-lg bg-zinc-800/40 border border-gray-700/60"
          >
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-gray-300">{r.label}</span>
              {r.sub && <span className="text-[10px] text-gray-500">{r.sub}</span>}
            </div>
            <div className="flex flex-col items-end">
              <span className="text-sm font-bold text-gray-100 font-mono">{r.value}</span>
              {r.pctile !== null && (
                <span className={`text-[10px] ${pctileColor(r.pctile)}`}>
                  {formatPctile(r.pctile)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="text-[10px] text-gray-500">
        cohort: R3+ 紅 n={resp.cohort.r3Red.n} · R3+ 藍 n={resp.cohort.r3Blue.n}
        · 隊長 n={resp.cohort.captainStickiness.n}
        · 刺客 ≥{resp.thresholds.assassinMinAttempts} 場 n={resp.cohort.assassinAttempts.n}
      </div>
    </div>
  );
}
