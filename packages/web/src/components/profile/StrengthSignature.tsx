/**
 * Panel B — Strength Signature (角色 × winrate 熱力)
 *
 * 7 roles ordered: 刺 / 娜 / 德 / 奧 / 派 / 梅 / 忠
 *   green = z ≥ +0.5  (high)
 *   gray  = -0.5 < z < 0.5 (neutral)
 *   red   = z ≤ -0.5  (low)
 *   slash = sample < 3 (insufficient — UI hint only)
 *
 * Data source: backend /api/analysis/profile/:name/strength.
 * z-score normalized over per-role population of players with sample >= 3.
 */
import { useEffect, useState, useMemo } from 'react';
import { Loader, AlertCircle } from 'lucide-react';
import {
  fetchPlayerStrength,
  getErrorMessage,
  type StrengthPlayerResponse,
  type StrengthRoleEntry,
} from '../../services/api';

interface StrengthSignatureProps {
  playerName: string;
}

const ROLE_SHORT: Record<string, string> = {
  '刺客':     '刺',
  '莫甘娜':   '娜',
  '莫德雷德': '德',
  '奧伯倫':   '奧',
  '派西維爾': '派',
  '梅林':     '梅',
  '忠臣':     '忠',
};

const ROLE_CAMP: Record<string, 'red' | 'blue'> = {
  '刺客':     'red',
  '莫甘娜':   'red',
  '莫德雷德': 'red',
  '奧伯倫':   'red',
  '派西維爾': 'blue',
  '梅林':     'blue',
  '忠臣':     'blue',
};

function colorClass(c: StrengthRoleEntry['color']): string {
  switch (c) {
    case 'high':         return 'bg-emerald-600/30 border-emerald-500/60 text-emerald-300';
    case 'low':          return 'bg-rose-600/30 border-rose-500/60 text-rose-300';
    case 'neutral':      return 'bg-slate-700/40 border-slate-600 text-slate-200';
    case 'insufficient': return 'bg-zinc-900/60 border-zinc-700/40 text-zinc-600';
  }
}

export default function StrengthSignature({ playerName }: StrengthSignatureProps): JSX.Element {
  const [resp, setResp]       = useState<StrengthPlayerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPlayerStrength(playerName)
      .then(d => { if (!cancelled) setResp(d); })
      .catch(e => { if (!cancelled) setError(getErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [playerName]);

  const roles = useMemo(() => resp?.data.roles ?? [], [resp]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> 載入角色強度...
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
        資料不足（每個角色需 ≥ 3 場）
      </div>
    );
  }

  const top = resp.data.topRoles;
  const bottom = resp.data.bottomRoles;
  const recommendation = (() => {
    const pieces: string[] = [];
    if (top.length > 0) {
      pieces.push(`你最強的角是 ${top.join(' / ')}`);
    }
    if (bottom.length > 0) {
      pieces.push(`最弱 ${bottom.join(' / ')}（建議多玩練）`);
    }
    return pieces.join('; ') || '各角表現平均';
  })();

  return (
    <div className="bg-zinc-900/50 border border-gray-700 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-300">角色強度熱力</h3>
        <span className="text-xs text-gray-500">綠 = 高於平均 · 紅 = 低於 · 灰 = 樣本不足</span>
      </div>

      {/* Heatmap row */}
      <div className="grid grid-cols-7 gap-1.5">
        {roles.map(r => {
          const camp = ROLE_CAMP[r.role] ?? 'blue';
          return (
            <div
              key={r.role}
              className={`relative border rounded-lg p-2 text-center ${colorClass(r.color)}`}
              title={
                r.color === 'insufficient'
                  ? `${r.role}: 樣本 ${r.sampleSize} 場 (不足 3 場)`
                  : `${r.role}: ${r.winRate?.toFixed(1)}% · ${r.sampleSize} 場 · z=${r.zScore?.toFixed(2)}`
              }
            >
              <div className={`text-[10px] font-semibold ${camp === 'red' ? 'opacity-90' : 'opacity-90'}`}>
                {ROLE_SHORT[r.role] ?? r.role}
              </div>
              <div className="text-sm font-bold mt-0.5">
                {r.color === 'insufficient'
                  ? <span className="text-zinc-600">—</span>
                  : `${r.winRate?.toFixed(0)}%`}
              </div>
              <div className="text-[9px] mt-0.5 opacity-70">
                {r.color === 'insufficient' ? `${r.sampleSize}場` : `${r.sampleSize}場`}
              </div>
            </div>
          );
        })}
      </div>

      {/* Top/bottom recommendation */}
      <div className="bg-zinc-800/40 border border-gray-700/60 rounded-lg px-3 py-2 text-xs text-gray-300">
        {recommendation}
      </div>

      {/* Cohort info */}
      <div className="text-[10px] text-gray-500">
        z-score 對齊全玩家同角分布; 同角樣本 ≥ {resp.cohort.minRoleSample} 場才入榜.
      </div>
    </div>
  );
}
