/** 對戰風格：牌譜每日重算投票；刺座與同隊重提比仍沿用既有資料。 */
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

  if (!resp) return <p className="text-sm text-gray-400">下次每日更新後提供</p>;

  const d = resp.data;
  const labels = resp.labels;
  const voting = resp.voting;
  const rows: Array<{ label: string; value: string; pctile: number | null; sub?: string }> = [];

  if (voting) {
    for (const [key, label] of [['loyal', '忠臣'], ['red', '紅方']] as const) {
      const cell = voting.r3Reject[key];
      rows.push({
        label: `${label}第 3 局後反對率`,
        value: cell.rate === null ? '樣本不足' : `${cell.rate.toFixed(1)}%`,
        pctile: cell.pr,
        sub: `反對 ${cell.hits}／有效 ${cell.votes} 票；PR 母體 ${cell.cohortPlayers} 人`,
      });
    }
    for (const [window, title] of [['r3Plus', 'R3–R5'], ['all', '全部回合']] as const) {
      for (const [metric, label] of [['evilTeamReject', '有紅方的隊反對率'], ['goodTeamApprove', '全藍的隊贊成率']] as const) {
        const cell = voting.teamComposition[window][metric];
        rows.push({
          label: `${title} · ${label}`,
          value: cell.rate === null ? '樣本不足' : `${cell.rate.toFixed(1)}%`,
          pctile: null,
          sub: `${metric === 'evilTeamReject' ? '反對' : '贊成'} ${cell.hits}／符合隊伍條件的有效 ${cell.votes} 票`,
        });
      }
    }
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
        <span className="text-xs text-gray-500">有效票數與比較母體</span>
      </div>

      {!voting && <p className="text-sm text-gray-400">第 3 局後反對率：下次每日更新後提供</p>}
      <p className="text-xs text-gray-400 leading-relaxed">
        第 3 局後包含 R3–R5；第 5 次強制提議沒有投票，一律排除。
        每項至少 {voting?.minVotes ?? 10} 票才顯示百分率。忠臣視角不含梅林、派西維爾。
        隊伍條件用事後揭曉的真實身分，涵蓋玩家所有角色，不能解讀成當時已知資訊或實力排名。
      </p>
      <div className="space-y-2">
        {rows.map(r => (
          <div
            key={r.label}
            className="flex items-baseline justify-between gap-2 px-3 py-2 rounded-lg bg-zinc-800/40 border border-gray-700/60"
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-xs font-semibold text-gray-300">{r.label}</span>
              {r.sub && <span className="text-[10px] text-gray-500">{r.sub}</span>}
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <span className="text-sm font-bold text-gray-100 font-mono">{r.value}</span>
              {r.pctile !== null && (
                <span className="text-[10px] text-slate-300">
                  PR {r.pctile.toFixed(1)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="text-[10px] text-gray-500">
        刺座與隊長資料沿用既有計算；隊長比較母體 {resp.cohort.captainStickiness.n} 人
        · 刺客 ≥{resp.thresholds.assassinMinAttempts} 場 n={resp.cohort.assassinAttempts.n}
      </div>
    </div>
  );
}
