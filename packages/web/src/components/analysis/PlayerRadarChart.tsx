import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip,
} from 'recharts';
import { Loader, AlertCircle, Search } from 'lucide-react';
import {
  fetchAnalysisPlayers,
  fetchAnalysisPlayerByName,
  getErrorMessage,
} from '../../services/api';
import type { AnalysisPlayerStats, AnalysisPlayerRadar } from '../../services/api';

// Radar axis labels (zh-TW). Keys match backend /api/analysis/players/:name radar payload.
const RADAR_LABELS: Record<string, string> = {
  winRate: '勝率',
  redWinRate: '紅方勝率',
  blueMerlinProtect: '藍方守梅',
  roleTheory: '理論勝率',
  positionTheory: '位置率',
  redMerlinKillRate: '紅方刺梅',
  experience: '經驗值',
};

export default function PlayerRadarChart(): JSX.Element {
  const [playerList, setPlayerList] = useState<AnalysisPlayerStats[]>([]);
  const [selectedName, setSelectedName] = useState<string>('');
  const [radarData, setRadarData] = useState<AnalysisPlayerRadar | null>(null);
  const [loading, setLoading] = useState(true);
  const [radarLoading, setRadarLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { players } = await fetchAnalysisPlayers();
        if (!cancelled) {
          setPlayerList(players);
          if (players.length > 0) setSelectedName(players[0].name);
        }
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadRadar = useCallback(async (name: string) => {
    if (!name) return;
    setRadarLoading(true);
    try {
      const data = await fetchAnalysisPlayerByName(name);
      setRadarData(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setRadarLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedName) loadRadar(selectedName);
  }, [selectedName, loadRadar]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> 載入玩家資料...
      </div>
    );
  }

  if (error && playerList.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400 gap-3">
        <AlertCircle size={20} /> {error}
      </div>
    );
  }

  const filteredPlayers = search
    ? playerList.filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    : playerList;

  const chartData = radarData
    ? Object.entries(radarData.radar).map(([key, value]) => ({
        dimension: RADAR_LABELS[key] || key,
        value: typeof value === 'number' ? value : 0,
      }))
    : [];

  return (
    <div className="space-y-4">
      {/* Player selector */}
      <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder="搜尋玩家 (Search player)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-avalon-card border border-gray-600 rounded-lg pl-8 pr-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
          {filteredPlayers.map(p => (
            <button
              key={p.name}
              onClick={() => { setSelectedName(p.name); setSearch(''); }}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                selectedName === p.name
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800/60 text-gray-400 hover:text-white hover:bg-gray-700/60 border border-gray-700'
              }`}
            >
              {p.name} ({p.totalGames})
            </button>
          ))}
        </div>
      </div>

      {/* Radar chart */}
      {radarLoading ? (
        <div className="flex items-center justify-center py-16 text-gray-400 gap-3">
          <Loader size={20} className="animate-spin" /> 載入雷達圖...
        </div>
      ) : radarData ? (
        <div className="grid md:grid-cols-2 gap-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
          >
            <h3 className="text-sm font-bold text-gray-400 mb-2">
              {radarData.player.name} — 能力雷達圖
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <RadarChart data={chartData}>
                <PolarGrid stroke="#374151" />
                <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 9, fill: '#d1d5db' }} />
                <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#6b7280' }} />
                <Radar
                  name={radarData.player.name}
                  dataKey="value"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.3}
                />
                <Tooltip
                  formatter={(val: unknown) => `${Number(val).toFixed(1)}%`}
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
                  itemStyle={{ color: '#d1d5db' }}
                />
              </RadarChart>
            </ResponsiveContainer>
            {/* Radar dimension explanation */}
            <div className="mt-3 text-xs text-gray-500 space-y-1">
              <p>勝率: 整體遊戲勝率</p>
              <p>紅方勝率: 擔任紅方(邪惡)時的勝率</p>
              <p>藍方守梅: 擔任藍方時完成三任務且梅林未被刺殺的勝率</p>
              <p>理論勝率: 考慮角色分配後的理論勝率</p>
              <p>位置率: 座位位置對勝率的影響</p>
              <p>紅方刺梅: 擔任紅方時藍方完成三任務但梅林被刺殺的勝率</p>
              <p>經驗值: 依總場次換算的經驗指標 (上限 100)</p>
            </div>
          </motion.div>

          {/* Player stats sidebar */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4 space-y-3"
          >
            <h3 className="text-sm font-bold text-gray-400">
              {radarData.player.name} — 詳細數據
            </h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <StatRow label="總場次" value={radarData.player.totalGames.toString()} />
              <StatRow label="勝率" value={`${radarData.player.winRate}%`} />
              <StatRow label="理論勝率" value={`${radarData.player.roleTheory}%`} />
              <StatRow label="位置率" value={`${radarData.player.positionTheory}%`} />
              <StatRow label="紅方勝率" value={`${radarData.player.redWin}%`} color="text-red-400" />
              <StatRow label="藍方勝率" value={`${radarData.player.blueWin}%`} color="text-blue-400" />
              <StatRow label="三紅(紅方)" value={`${radarData.player.red3Red}%`} color="text-red-400" />
              <StatRow label="三藍梅死(紅方)" value={`${radarData.player.redMerlinDead}%`} color="text-yellow-400" />
              <StatRow label="三藍梅活(藍方)" value={`${radarData.player.blueMerlinAlive}%`} color="text-blue-400" />
            </div>

            {/* Role win rates */}
            <div>
              <p className="text-xs font-bold text-gray-500 mb-1.5">角色勝率 (Role Win Rates)</p>
              <div className="space-y-1">
                {Object.entries(radarData.player.roleWinRates)
                  .filter(([, v]) => v > 0)
                  .map(([role, wr]) => (
                    <div key={role} className="flex items-center gap-2">
                      <span className={`text-xs w-10 font-semibold ${
                        ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '娜美', '德魯', '奧伯'].includes(role) ? 'text-red-400' : 'text-blue-400'
                      }`}>{role}</span>
                      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '娜美', '德魯', '奧伯'].includes(role) ? 'bg-red-500' : 'bg-blue-500'
                          }`}
                          style={{ width: `${wr}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-400 w-10 text-right">{wr}%</span>
                    </div>
                  ))}
              </div>
            </div>
          </motion.div>
        </div>
      ) : null}
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <div className="flex justify-between bg-gray-800/40 rounded-lg px-3 py-1.5">
      <span className="text-gray-500 text-xs">{label}</span>
      <span className={`font-bold text-xs ${color || 'text-white'}`}>{value}</span>
    </div>
  );
}
