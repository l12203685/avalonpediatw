import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { Loader, AlertCircle } from 'lucide-react';
import { fetchAnalysisLake, getErrorMessage } from '../../services/api';
import type { LakeAnalysisData } from '../../services/api';

export default function LakeAnalysis(): JSX.Element {
  const [data, setData] = useState<LakeAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLake, setSelectedLake] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchAnalysisLake();
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
        <Loader size={20} className="animate-spin" /> 載入湖中女神分析...
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

  const lakeLabels = ['首湖', '二湖', '三湖'];
  const currentPerLake = data.perLake[selectedLake];
  const currentDetail = data.allLakeRoleStats[selectedLake];

  // Holder faction stats
  const holderFactionData = currentPerLake?.holderStats.map(h => ({
    name: h.faction,
    redWinRate: h.redWinRate,
    games: h.games,
    fill: h.faction === '紅方' ? '#ef4444' : '#3b82f6',
  })) ?? [];

  // Combo stats (holder x target faction)
  const comboData = currentPerLake?.comboStats
    .filter(c => c.targetFaction !== '')
    .map(c => ({
      name: `${c.holderFaction} > ${c.targetFaction}`,
      redWinRate: c.redWinRate,
      games: c.games,
    })) ?? [];

  // Holder role stats for selected lake
  const holderRoleData = currentDetail?.holderRoleStats
    .filter(r => r.games >= 5)
    .sort((a, b) => b.games - a.games)
    .map(r => ({
      role: r.role,
      redWinRate: r.redWinRate,
      blueWinRate: r.blueWinRate ?? 0,
      games: r.games,
      fill: ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '娜美', '德魯', '奧伯'].includes(r.role) ? '#ef4444' : '#3b82f6',
    })) ?? [];

  // Target role stats for selected lake
  const targetRoleData = currentDetail?.targetRoleStats
    .filter(r => r.games >= 5)
    .sort((a, b) => b.games - a.games)
    .map(r => ({
      role: r.role,
      redWinRate: r.redWinRate,
      games: r.games,
      fill: ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '娜美', '德魯', '奧伯'].includes(r.role) ? '#ef4444' : '#3b82f6',
    })) ?? [];

  return (
    <div className="space-y-6">
      {/* Lake selector */}
      <div className="flex gap-2">
        {lakeLabels.map((label, i) => (
          <button
            key={label}
            onClick={() => setSelectedLake(i)}
            disabled={!data.perLake[i]}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              selectedLake === i
                ? 'bg-cyan-600 text-white'
                : data.perLake[i]
                  ? 'bg-avalon-card/40 text-gray-500 hover:text-white border border-gray-700'
                  : 'bg-gray-900/30 text-gray-700 cursor-not-allowed border border-gray-800'
            }`}
          >
            {label} {data.perLake[i] ? `(${data.perLake[i].totalGames} 場)` : ''}
          </button>
        ))}
      </div>

      {currentPerLake && (
        <>
          {/* Holder faction overview */}
          <motion.div
            key={`holder-${selectedLake}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
          >
            <h3 className="text-sm font-bold text-gray-400 mb-3">
              {lakeLabels[selectedLake]} 持有者陣營 vs 紅方勝率
            </h3>
            <div className="grid grid-cols-2 gap-3 mb-4">
              {holderFactionData.map(h => (
                <div key={h.name} className="bg-gray-800/40 rounded-lg p-3 text-center">
                  <p className={`text-sm font-bold ${h.name === '紅方' ? 'text-red-400' : 'text-blue-400'}`}>
                    {h.name}持有
                  </p>
                  <p className="text-xl font-black text-white">{h.redWinRate}%</p>
                  <p className="text-[10px] text-gray-500">{h.games} 場 / 紅方勝率</p>
                </div>
              ))}
            </div>

            {/* Same vs different faction */}
            {currentDetail && (
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-gray-800/40 rounded-lg p-3 text-center">
                  <p className="text-xs font-bold text-gray-400">同陣營湖 (holder=target faction)</p>
                  <p className="text-lg font-black text-white">{currentDetail.sameFaction.redWinRate}%</p>
                  <p className="text-[10px] text-gray-500">{currentDetail.sameFaction.games} 場</p>
                </div>
                <div className="bg-gray-800/40 rounded-lg p-3 text-center">
                  <p className="text-xs font-bold text-gray-400">跨陣營湖 (holder!=target faction)</p>
                  <p className="text-lg font-black text-white">{currentDetail.diffFaction.redWinRate}%</p>
                  <p className="text-[10px] text-gray-500">{currentDetail.diffFaction.games} 場</p>
                </div>
              </div>
            )}
          </motion.div>

          {/* Combo stats */}
          {comboData.length > 0 && (
            <motion.div
              key={`combo-${selectedLake}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
            >
              <h3 className="text-sm font-bold text-gray-400 mb-3">
                {lakeLabels[selectedLake]} 持有者 &gt; 目標 陣營組合
              </h3>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={comboData} layout="vertical">
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                  <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 10, fill: '#d1d5db' }} />
                  <Tooltip
                    formatter={(val: unknown) => [`${val}%`, '紅方勝率']}
                    labelFormatter={(label: unknown) => {
                      const lbl = String(label);
                      const item = comboData.find(c => c.name === lbl);
                      return item ? `${lbl} (${item.games} 場)` : lbl;
                    }}
                    contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
                    itemStyle={{ color: '#d1d5db' }}
                  />
                  <Bar dataKey="redWinRate" name="紅方勝率" radius={[0, 4, 4, 0]}>
                    {comboData.map((d, i) => (
                      <Cell key={i} fill={d.redWinRate >= 50 ? '#ef4444' : '#3b82f6'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </motion.div>
          )}

          {/* Holder role stats */}
          {holderRoleData.length > 0 && (
            <motion.div
              key={`hrole-${selectedLake}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
            >
              <h3 className="text-sm font-bold text-gray-400 mb-3">
                {lakeLabels[selectedLake]} 持有者角色 vs 紅方勝率
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={holderRoleData}>
                  <XAxis dataKey="role" tick={{ fontSize: 10, fill: '#d1d5db' }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                  <Tooltip
                    formatter={(val: unknown) => [`${val}%`, '紅方勝率']}
                    labelFormatter={(label: unknown) => {
                      const lbl = String(label);
                      const item = holderRoleData.find(r => r.role === lbl);
                      return item ? `${lbl} (${item.games} 場)` : lbl;
                    }}
                    contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
                    itemStyle={{ color: '#d1d5db' }}
                  />
                  <Bar dataKey="redWinRate" name="紅方勝率" radius={[4, 4, 0, 0]}>
                    {holderRoleData.map((d, i) => (
                      <Cell key={i} fill={d.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </motion.div>
          )}

          {/* Target role stats */}
          {targetRoleData.length > 0 && (
            <motion.div
              key={`trole-${selectedLake}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
            >
              <h3 className="text-sm font-bold text-gray-400 mb-3">
                {lakeLabels[selectedLake]} 被驗者角色 vs 紅方勝率
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={targetRoleData}>
                  <XAxis dataKey="role" tick={{ fontSize: 10, fill: '#d1d5db' }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                  <Tooltip
                    formatter={(val: unknown) => [`${val}%`, '紅方勝率']}
                    labelFormatter={(label: unknown) => {
                      const lbl = String(label);
                      const item = targetRoleData.find(r => r.role === lbl);
                      return item ? `${lbl} (${item.games} 場)` : lbl;
                    }}
                    contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
                    itemStyle={{ color: '#d1d5db' }}
                  />
                  <Bar dataKey="redWinRate" name="紅方勝率" radius={[4, 4, 0, 0]}>
                    {targetRoleData.map((d, i) => (
                      <Cell key={i} fill={d.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </motion.div>
          )}
        </>
      )}
    </div>
  );
}
