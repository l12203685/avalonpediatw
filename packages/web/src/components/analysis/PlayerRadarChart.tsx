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

const RADAR_LABELS: Record<string, string> = {
  winRate: '勝率',
  redWinRate: '紅方勝率',
  blueMerlinProtect: '梅林保護',
  roleTheory: '角色理論',
  positionTheory: '位置理論',
  redMerlinKillRate: '梅林擊殺',
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
                <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 10, fill: '#d1d5db' }} />
                <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#6b7280' }} />
                <Radar
                  name={radarData.player.name}
                  dataKey="value"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.3}
                />
                <Tooltip formatter={(val) => `${Number(val).toFixed(1)}%`} />
              </RadarChart>
            </ResponsiveContainer>
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
              <StatRow label="紅方勝率" value={`${radarData.player.redWin}%`} color="text-red-400" />
              <StatRow label="藍方勝率" value={`${radarData.player.blueWin}%`} color="text-blue-400" />
              <StatRow label="角色理論" value={`${radarData.player.roleTheory}%`} />
              <StatRow label="位置理論" value={`${radarData.player.positionTheory}%`} />
              <StatRow label="紅角率" value={`${radarData.player.redRoleRate}%`} color="text-red-400" />
              <StatRow label="藍角率" value={`${radarData.player.blueRoleRate}%`} color="text-blue-400" />
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
                        ['刺客', '娜美', '德魯', '奧伯'].includes(role) ? 'text-red-400' : 'text-blue-400'
                      }`}>{role}</span>
                      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            ['刺客', '娜美', '德魯', '奧伯'].includes(role) ? 'bg-red-500' : 'bg-blue-500'
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
