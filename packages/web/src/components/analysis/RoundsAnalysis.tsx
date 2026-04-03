import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  Legend,
} from 'recharts';
import { Loader, AlertCircle } from 'lucide-react';
import { fetchAnalysisRounds, getErrorMessage } from '../../services/api';
import type { RoundsAnalysisData } from '../../services/api';

function VisionCard({ title, data }: {
  title: string;
  data: { games: number; mission1PassRate: number; redWinRate: number; blueWinRate?: number };
}): JSX.Element {
  return (
    <div className="bg-gray-800/40 rounded-lg p-3 space-y-1">
      <p className="text-xs font-bold text-gray-400">{title}</p>
      <div className="grid grid-cols-2 gap-1 text-xs">
        <span className="text-gray-500">場次</span>
        <span className="text-white font-bold text-right">{data.games}</span>
        <span className="text-gray-500">任務1通過率</span>
        <span className="text-green-400 font-bold text-right">{data.mission1PassRate}%</span>
        <span className="text-gray-500">紅方勝率</span>
        <span className="text-red-400 font-bold text-right">{data.redWinRate}%</span>
        {data.blueWinRate !== undefined && (
          <>
            <span className="text-gray-500">藍方勝率</span>
            <span className="text-blue-400 font-bold text-right">{data.blueWinRate}%</span>
          </>
        )}
      </div>
    </div>
  );
}

export default function RoundsAnalysis(): JSX.Element {
  const [data, setData] = useState<RoundsAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchAnalysisRounds();
        if (!cancelled) setData(d);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> 載入回合分析...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || 'Failed to load'}
      </div>
    );
  }

  // Round progression chart data
  const progressionData = Object.entries(data.roundProgression).map(([round, v]) => ({
    name: round,
    bluePct: v.bluePct,
    redPct: v.redPct,
    total: v.total,
  }));

  // Fix #1: "1-1" = 第一局第一次派票 (Mission 1, Vote 1)
  const redInR11Data = data.redInR11.map(r => ({
    name: `${r.redCount} 紅`,
    games: r.games,
    redWinRate: r.redWinRate,
    passRate: r.mission1PassRate,
  }));

  // Mission 1 branch
  const branchData = data.mission1Branch.map(b => ({
    name: b.passed ? '任務1 通過' : '任務1 失敗',
    games: b.games,
    redWinRate: b.redWinRate,
    merlinKillRate: b.merlinKillRate,
  }));

  // Game states: stacked bar (red + blue = 100%), filter trivial & low-count
  const stateData = data.gameStates
    .filter(s => s.state !== '紅紅紅' && s.state !== '藍藍藍' && s.games >= 20)
    .map(s => ({
      name: s.state,
      games: s.games,
      redWinRate: s.redWinRate,
      blueWinRate: Math.round((100 - s.redWinRate) * 10) / 10,
    }));

  return (
    <div className="space-y-6">
      {/* Fix #1: Vision stats - clarify "1-1" means mission 1 vote 1 */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-1">
          第一局第一次派票分析 (Mission 1, Vote 1)
        </h3>
        <p className="text-[10px] text-gray-600 mb-3">
          1-1 = 第一局(任務1)的第一次派票組合, 分析該隊伍組成對後續局勢的影響
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <VisionCard title="梅林在隊" data={data.visionStats.merlinInTeam} />
          <VisionCard title="梅林不在隊" data={data.visionStats.merlinNotInTeam} />
          <VisionCard title="派西在隊" data={data.visionStats.percivalInTeam} />
          <VisionCard title="派西不在隊" data={data.visionStats.percivalNotInTeam} />
        </div>
      </motion.div>

      {/* Round progression */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">各任務藍紅勝負比例 (Round Progression %)</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={progressionData}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip
              formatter={(val: unknown) => `${val}%`}
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              itemStyle={{ color: '#d1d5db' }}
            />
            <Legend />
            <Bar dataKey="bluePct" name="藍方(通過)" fill="#3b82f6" stackId="a" />
            <Bar dataKey="redPct" name="紅方(失敗)" fill="#ef4444" stackId="a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Red count in first vote + Mission 1 branch */}
      <div className="grid md:grid-cols-2 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
        >
          <h3 className="text-sm font-bold text-gray-400 mb-1">第一次派票紅方人數 vs 紅方勝率</h3>
          <p className="text-[10px] text-gray-600 mb-2">
            任務1第一次派票隊伍中紅方角色的數量
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={redInR11Data}>
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#d1d5db' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
              <Tooltip
                formatter={(val: unknown) => `${val}%`}
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
                itemStyle={{ color: '#d1d5db' }}
              />
              <Bar dataKey="redWinRate" name="紅方勝率" radius={[4, 4, 0, 0]}>
                {redInR11Data.map((d, i) => (
                  <Cell key={i} fill={d.redWinRate >= 50 ? '#ef4444' : '#3b82f6'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Mission 1 branch */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
        >
          <h3 className="text-sm font-bold text-gray-400 mb-3">任務1分岐 (Mission 1 Branch)</h3>
          <div className="space-y-3">
            {branchData.map(b => (
              <div key={b.name} className="bg-gray-800/40 rounded-lg p-3">
                <div className="flex justify-between items-center mb-2">
                  <span className={`font-bold text-sm ${b.name.includes('通過') ? 'text-green-400' : 'text-red-400'}`}>
                    {b.name}
                  </span>
                  <span className="text-xs text-gray-500">{b.games} 場</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-gray-500">紅方勝率</p>
                    <p className="text-red-400 font-bold">{b.redWinRate}%</p>
                  </div>
                  <div>
                    <p className="text-gray-500">梅林擊殺率</p>
                    <p className="text-yellow-400 font-bold">{b.merlinKillRate}%</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      {/* Game states: stacked red/blue bar, filtered trivial & low-count */}
      {stateData.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
        >
          <h3 className="text-sm font-bold text-gray-400 mb-1">常見局勢 (Common Game States)</h3>
          <p className="text-[10px] text-gray-600 mb-3">
            局勢 = 各任務結果序列 (紅=任務失敗, 藍=任務成功), 紅+藍=100%, 僅顯示20場以上且非全紅/全藍
          </p>
          <ResponsiveContainer width="100%" height={Math.max(280, stateData.length * 32)}>
            <BarChart data={stateData} layout="vertical">
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} tickFormatter={(v: number) => `${v}%`} />
              <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 10, fill: '#d1d5db' }} />
              <Tooltip
                formatter={(val: unknown, name: unknown) => [
                  `${val}%`,
                  name === 'redWinRate' ? '紅方勝率' : '藍方勝率',
                ]}
                labelFormatter={(label: unknown) => {
                  const lbl = String(label);
                  const item = stateData.find(s => s.name === lbl);
                  return item ? `${lbl} (${item.games} 場)` : lbl;
                }}
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
                itemStyle={{ color: '#d1d5db' }}
              />
              <Legend />
              <Bar dataKey="redWinRate" name="紅方勝率" fill="#ef4444" stackId="a" />
              <Bar dataKey="blueWinRate" name="藍方勝率" fill="#3b82f6" stackId="a" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </motion.div>
      )}
    </div>
  );
}
