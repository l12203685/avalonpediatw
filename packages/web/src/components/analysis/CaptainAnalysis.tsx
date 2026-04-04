import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Cell,
} from 'recharts';
import { Loader, AlertCircle } from 'lucide-react';
import { fetchAnalysisCaptain, getErrorMessage } from '../../services/api';
import type { CaptainAnalysisData } from '../../services/api';

const RED_COLOR = '#ef4444';
const BLUE_COLOR = '#3b82f6';

export default function CaptainAnalysis(): JSX.Element {
  const [data, setData] = useState<CaptainAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchAnalysisCaptain();
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
        <Loader size={20} className="animate-spin" /> 載入隊長分析...
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

  if (data.perMission.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        暫無隊長分析資料
      </div>
    );
  }

  // Chart 1: per-mission red vs blue captain rate
  const missionChartData = data.perMission.map(m => ({
    name: `任務 ${m.mission}`,
    red: m.redCaptainRate,
    blue: m.blueCaptainRate,
    games: m.games,
  }));

  // Chart 2: captain faction vs mission outcome (pass/fail rate for each faction)
  // Group by faction
  const redRows = data.captainFactionVsOutcome.filter(r => r.captainFaction === '紅方');
  const blueRows = data.captainFactionVsOutcome.filter(r => r.captainFaction === '藍方');
  const redPass = redRows.find(r => r.missionResult === 'pass');
  const redFail = redRows.find(r => r.missionResult === 'fail');
  const bluePass = blueRows.find(r => r.missionResult === 'pass');
  const blueFail = blueRows.find(r => r.missionResult === 'fail');

  // Chart 3: when captain is red/blue AND mission passes/fails, what is the game win rate?
  const winRateRows = data.captainMissionGameWinRates;

  const winRateChartData = winRateRows.map(r => ({
    name: `${r.captainFaction === '紅方' ? '紅隊' : '藍隊'}長 任務${r.missionResult === 'pass' ? '通過' : '失敗'}`,
    red: r.redGameWinRate,
    blue: r.blueGameWinRate,
    total: r.totalMissions,
    faction: r.captainFaction,
    result: r.missionResult,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/40 rounded-xl p-4 border border-gray-700"
      >
        <h2 className="text-lg font-bold text-white mb-1">隊長陣營分析</h2>
        <p className="text-xs text-gray-400">
          根據 文字記錄 解析每局每任務的隊長席位，對應配置欄位確認陣營。
          共分析 {data.perMission[0]?.games ?? 0}+ 局。
        </p>
      </motion.div>

      {/* Per-mission captain faction rate */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="bg-avalon-card/40 rounded-xl p-4 border border-gray-700"
      >
        <h3 className="text-sm font-semibold text-gray-300 mb-3">各任務隊長陣營比率</h3>
        <p className="text-xs text-gray-500 mb-4">
          每個任務中，接受提案的隊長來自紅方/藍方的比率。紅方在後期任務的佔比明顯下降，
          因為累積的任務失敗後藍方開始排除紅方成員。
        </p>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={missionChartData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
            <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#9ca3af' }} />
            <YAxis unit="%" tick={{ fontSize: 11, fill: '#9ca3af' }} domain={[0, 100]} />
            <Tooltip
              contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
              formatter={(value: unknown, name: unknown) => [
                `${value}%`,
                name === 'red' ? '紅方隊長' : '藍方隊長',
              ]}
            />
            <Legend
              formatter={(v) => v === 'red' ? '紅方隊長' : '藍方隊長'}
              wrapperStyle={{ fontSize: 12 }}
            />
            <Bar dataKey="red" name="red" fill={RED_COLOR} radius={[3, 3, 0, 0]} />
            <Bar dataKey="blue" name="blue" fill={BLUE_COLOR} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>

        {/* Table */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs text-gray-300">
            <thead>
              <tr className="border-b border-gray-700 text-gray-500">
                <th className="text-left py-2 pr-4">任務</th>
                <th className="text-right pr-4">紅方隊長%</th>
                <th className="text-right pr-4">藍方隊長%</th>
                <th className="text-right">樣本數</th>
              </tr>
            </thead>
            <tbody>
              {data.perMission.map(m => (
                <tr key={m.mission} className="border-b border-gray-800 hover:bg-white/5">
                  <td className="py-1.5 pr-4 font-medium">任務 {m.mission}</td>
                  <td className="text-right pr-4 text-red-400">{m.redCaptainRate}%</td>
                  <td className="text-right pr-4 text-blue-400">{m.blueCaptainRate}%</td>
                  <td className="text-right text-gray-500">{m.games}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>

      {/* Captain faction vs mission pass/fail */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-avalon-card/40 rounded-xl p-4 border border-gray-700"
      >
        <h3 className="text-sm font-semibold text-gray-300 mb-1">隊長陣營 vs 任務結果</h3>
        <p className="text-xs text-gray-500 mb-4">
          紅方隊長提案的任務通過率 vs 藍方隊長的通過率。
          紅方隊長會主動讓任務失敗，因此通過率遠低於藍方。
        </p>
        <div className="grid grid-cols-2 gap-4">
          {/* Red faction card */}
          <div className="bg-red-900/20 border border-red-800/40 rounded-lg p-4">
            <div className="text-xs text-red-400 font-semibold mb-3">紅方隊長</div>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400">任務通過</span>
                <span className="text-sm font-bold text-green-400">
                  {redPass?.percentage ?? 0}%
                  <span className="text-xs text-gray-500 ml-1">({redPass?.count ?? 0})</span>
                </span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-1.5">
                <div
                  className="bg-green-500 h-1.5 rounded-full"
                  style={{ width: `${redPass?.percentage ?? 0}%` }}
                />
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400">任務失敗</span>
                <span className="text-sm font-bold text-red-400">
                  {redFail?.percentage ?? 0}%
                  <span className="text-xs text-gray-500 ml-1">({redFail?.count ?? 0})</span>
                </span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-1.5">
                <div
                  className="bg-red-500 h-1.5 rounded-full"
                  style={{ width: `${redFail?.percentage ?? 0}%` }}
                />
              </div>
            </div>
          </div>

          {/* Blue faction card */}
          <div className="bg-blue-900/20 border border-blue-800/40 rounded-lg p-4">
            <div className="text-xs text-blue-400 font-semibold mb-3">藍方隊長</div>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400">任務通過</span>
                <span className="text-sm font-bold text-green-400">
                  {bluePass?.percentage ?? 0}%
                  <span className="text-xs text-gray-500 ml-1">({bluePass?.count ?? 0})</span>
                </span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-1.5">
                <div
                  className="bg-green-500 h-1.5 rounded-full"
                  style={{ width: `${bluePass?.percentage ?? 0}%` }}
                />
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400">任務失敗</span>
                <span className="text-sm font-bold text-red-400">
                  {blueFail?.percentage ?? 0}%
                  <span className="text-xs text-gray-500 ml-1">({blueFail?.count ?? 0})</span>
                </span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-1.5">
                <div
                  className="bg-red-500 h-1.5 rounded-full"
                  style={{ width: `${blueFail?.percentage ?? 0}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Captain faction + mission outcome -> game win rate */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="bg-avalon-card/40 rounded-xl p-4 border border-gray-700"
      >
        <h3 className="text-sm font-semibold text-gray-300 mb-1">隊長陣營 × 任務結果 → 遊戲勝率</h3>
        <p className="text-xs text-gray-500 mb-4">
          當紅/藍方擔任隊長且任務通過或失敗時，最終紅方/藍方贏得整局的機率。
        </p>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={winRateChartData} margin={{ top: 4, right: 8, left: -16, bottom: 24 }}>
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: '#9ca3af' }}
              angle={-15}
              textAnchor="end"
              interval={0}
            />
            <YAxis unit="%" tick={{ fontSize: 11, fill: '#9ca3af' }} domain={[0, 100]} />
            <Tooltip
              contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
              formatter={(value: unknown, name: unknown) => [
                `${value}%`,
                name === 'red' ? '紅方贏局率' : '藍方贏局率',
              ]}
            />
            <Legend
              formatter={(v) => v === 'red' ? '紅方贏局率' : '藍方贏局率'}
              wrapperStyle={{ fontSize: 12 }}
            />
            <Bar dataKey="red" name="red" fill={RED_COLOR} radius={[3, 3, 0, 0]} />
            <Bar dataKey="blue" name="blue" fill={BLUE_COLOR} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>

        {/* Detail table */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs text-gray-300">
            <thead>
              <tr className="border-b border-gray-700 text-gray-500">
                <th className="text-left py-2 pr-3">隊長陣營</th>
                <th className="text-left pr-3">任務結果</th>
                <th className="text-right pr-3">任務數</th>
                <th className="text-right pr-3">紅方贏局%</th>
                <th className="text-right">藍方贏局%</th>
              </tr>
            </thead>
            <tbody>
              {winRateRows.map((r, i) => (
                <tr key={i} className="border-b border-gray-800 hover:bg-white/5">
                  <td className={`py-1.5 pr-3 font-medium ${r.captainFaction === '紅方' ? 'text-red-400' : 'text-blue-400'}`}>
                    {r.captainFaction}
                  </td>
                  <td className={`pr-3 ${r.missionResult === 'pass' ? 'text-green-400' : 'text-red-400'}`}>
                    {r.missionResult === 'pass' ? '通過' : '失敗'}
                  </td>
                  <td className="text-right pr-3 text-gray-500">{r.totalMissions}</td>
                  <td className="text-right pr-3 text-red-400">{r.redGameWinRate}%</td>
                  <td className="text-right text-blue-400">{r.blueGameWinRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}
