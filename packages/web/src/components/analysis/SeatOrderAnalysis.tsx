import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  Legend,
} from 'recharts';
import { Loader, AlertCircle } from 'lucide-react';
import { fetchAnalysisSeatOrder, getErrorMessage } from '../../services/api';
import type { SeatOrderData } from '../../services/api';

export default function SeatOrderAnalysis(): JSX.Element {
  const [data, setData] = useState<SeatOrderData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchAnalysisSeatOrder();
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
        <Loader size={20} className="animate-spin" /> 載入座位順序分析...
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

  if (data.permutations.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        暫無座位順序資料
      </div>
    );
  }

  const chartData = data.permutations.map(p => ({
    name: p.order,
    total: p.total,
    redWinRate: p.redWinRate,
    blueWinRate: p.blueWinRate,
    merlinKillRate: p.merlinKillRate,
  }));

  const outcomeData = data.permutations.map(p => ({
    name: p.order,
    '\u4e09\u85cd\u6885\u6d3b': p['\u4e09\u85cd\u6885\u6d3bpct'],
    '\u4e09\u85cd\u6885\u6b7b': p['\u4e09\u85cd\u6885\u6b7bpct'],
    '\u4e09\u7d05': p['\u4e09\u7d05pct'],
  }));

  return (
    <div className="space-y-6">
      {/* Summary */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-1">
          派/梅/娜 座位順序分析 (Percival/Merlin/Morgana Seat Order)
        </h3>
        <p className="text-[10px] text-gray-600 mb-3">
          分析派西(派)/梅林(梅)/娜美(娜) 三位關鍵角色的 6 種座位排列順序對勝率的影響。共 {data.totalGames} 局有效資料, 整體紅方勝率 {data.overallRedWinRate}%
        </p>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {data.permutations.map(p => (
            <div key={p.order} className="bg-gray-800/40 rounded-lg p-3">
              <p className="text-sm font-bold text-white mb-2">{p.order}</p>
              <div className="grid grid-cols-2 gap-1 text-xs">
                <span className="text-gray-500">場次</span>
                <span className="text-white font-bold text-right">{p.total}</span>
                <span className="text-gray-500">紅方勝率</span>
                <span className={`font-bold text-right ${p.redWinRate >= 50 ? 'text-red-400' : 'text-blue-400'}`}>
                  {p.redWinRate}%
                </span>
                <span className="text-gray-500">梅林擊殺率</span>
                <span className="text-yellow-400 font-bold text-right">{p.merlinKillRate}%</span>
                <span className="text-gray-500">穿插任務率</span>
                <span className="text-purple-400 font-bold text-right">{p['\u7a7f\u63d2\u7387']}%</span>
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Win rate chart */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">各排列紅方勝率比較</h3>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={chartData}>
            <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#d1d5db' }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip
              formatter={(val: unknown) => `${val}%`}
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              itemStyle={{ color: '#d1d5db' }}
            />
            <Legend />
            <Bar dataKey="redWinRate" name="紅方勝率" radius={[4, 4, 0, 0]}>
              {chartData.map((d, i) => (
                <Cell key={i} fill={d.redWinRate >= 50 ? '#ef4444' : '#3b82f6'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Outcome breakdown stacked bar */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-3">結果分布比例 (三藍梅活/三藍梅死/三紅)</h3>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={outcomeData}>
            <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#d1d5db' }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} tickFormatter={(v: number) => `${v}%`} />
            <Tooltip
              formatter={(val: unknown) => `${val}%`}
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              itemStyle={{ color: '#d1d5db' }}
            />
            <Legend />
            <Bar dataKey={'\u4e09\u85cd\u6885\u6d3b'} name="三藍梅活" fill="#3b82f6" stackId="a" />
            <Bar dataKey={'\u4e09\u85cd\u6885\u6b7b'} name="三藍梅死" fill="#f59e0b" stackId="a" />
            <Bar dataKey={'\u4e09\u7d05'} name="三紅" fill="#ef4444" stackId="a" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Interleaving table */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-1">穿插分析</h3>
        <p className="text-[10px] text-gray-600 mb-3">
          「穿插」= 派/梅/娜三人的座位之間有其他玩家（非相鄰）
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left py-2 px-2 text-gray-400">排列</th>
                <th className="text-right py-2 px-2 text-gray-400">場次</th>
                <th className="text-right py-2 px-2 text-gray-400">穿插數</th>
                <th className="text-right py-2 px-2 text-gray-400">穿插率</th>
                <th className="text-right py-2 px-2 text-gray-400">穿插紅勝率</th>
                <th className="text-right py-2 px-2 text-gray-400">無穿插紅勝率</th>
                <th className="text-right py-2 px-2 text-gray-400">整體紅勝率</th>
              </tr>
            </thead>
            <tbody>
              {data.permutations.map(p => (
                <tr key={p.order} className="border-b border-gray-800">
                  <td className="py-2 px-2 text-white font-bold">{p.order}</td>
                  <td className="py-2 px-2 text-right text-gray-300">{p.total}</td>
                  <td className="py-2 px-2 text-right text-purple-400">{p['\u7a7f\u63d2\u4efb\u52d9']}</td>
                  <td className="py-2 px-2 text-right text-purple-400">{p['\u7a7f\u63d2\u7387']}%</td>
                  <td className={`py-2 px-2 text-right font-bold ${p['\u7a7f\u63d2\u7d05\u52dd\u7387'] >= 50 ? 'text-red-400' : 'text-blue-400'}`}>
                    {p['\u7a7f\u63d2\u7d05\u52dd\u7387']}%
                  </td>
                  <td className={`py-2 px-2 text-right font-bold ${p['\u7121\u7a7f\u63d2\u7d05\u52dd\u7387'] >= 50 ? 'text-red-400' : 'text-blue-400'}`}>
                    {p['\u7121\u7a7f\u63d2\u7d05\u52dd\u7387']}%
                  </td>
                  <td className={`py-2 px-2 text-right font-bold ${p.redWinRate >= 50 ? 'text-red-400' : 'text-blue-400'}`}>
                    {p.redWinRate}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>

      {/* Interpretation */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <h3 className="text-sm font-bold text-gray-400 mb-2">分析結論</h3>
        <ul className="text-xs text-gray-300 space-y-2 list-disc list-inside">
          <li>
            <span className="text-white font-bold">梅娜派</span> 紅勝率最低(~41%) -- 梅林和莫甘娜相鄰，派西更容易辨別真假梅林
          </li>
          <li>
            <span className="text-white font-bold">梅派娜</span> 紅勝率最高(~48%) -- 派西夾在中間，對隊友的資訊傳遞效率降低
          </li>
          <li>
            穿插場次中紅方勝率是否有差異 -- 比較上表「穿插紅勝率」vs「無穿插紅勝率」，
            穿插代表三人之間有其他玩家，可能干擾資訊傳遞
          </li>
        </ul>
      </motion.div>
    </div>
  );
}
