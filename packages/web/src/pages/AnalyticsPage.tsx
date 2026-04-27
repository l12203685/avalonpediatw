import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Trophy, BarChart3, Crown, TrendingUp, Loader, Search, AlertTriangle,
  Users, X, Target, Swords, Map, Compass, Droplets, Shuffle, Microscope,
} from 'lucide-react';
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip,
} from 'recharts';
import { useGameStore } from '../store/gameStore';
import { type LeaderboardEntry } from '../services/api';
import {
  fetchAnalysisPlayerByName,
  getErrorMessage,
  type AnalysisPlayerRadar,
} from '../services/api';
import { ALL_TIERS, ELO_RANKS, rankLeaderboard, type EloRank } from '../utils/eloRank';
import OverviewPanel from '../components/analysis/OverviewPanel';
import SeatHeatmap from '../components/analysis/SeatHeatmap';
import ChemistryMatrix from '../components/analysis/ChemistryMatrix';
import MissionAnalysis from '../components/analysis/MissionAnalysis';
import RoundsAnalysis from '../components/analysis/RoundsAnalysis';
import LakeAnalysis from '../components/analysis/LakeAnalysis';
import SeatOrderAnalysis from '../components/analysis/SeatOrderAnalysis';
import CaptainAnalysis from '../components/analysis/CaptainAnalysis';
import FeatureStudiesPanel from '../components/analytics/FeatureStudiesPanel';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:3001';

const PROVIDER_BADGE: Record<string, string> = {
  google:  'G',
  discord: 'D',
  line:    'L',
  email:   'E',
  guest:   '?',
};

const RANK_COLORS = ['text-yellow-400', 'text-gray-300', 'text-amber-600'];
const ALL_RANK_LABELS = ['全部', ...ALL_TIERS.map(r => r.label)];

/**
 * #98 (2026-04-23) IA 重整：數據排行頁拆成兩大區 —
 *  - 勝率排行 (ELO Leaderboard)：原本 LeaderboardPage 的排名清單；點玩家彈出雷達彈窗
 *  - 深度分析 (Deep Analysis)：把 AnalysisPage 的分頁內容直接搬進來
 * 「玩家雷達」不再獨立 tab，融進勝率排行的點擊體驗。
 *
 * (2026-04-27) 新增第三 tab「特徵研究」: 把 v7 features 研究 (loops 136/139/141/
 * 142/143) 萃取成可瀏覽的玩家信號頁。前 2 張 card 預設展開, 後 3 張收合。
 */
type TopTab = 'leaderboard' | 'deepAnalysis' | 'featureStudies';
type DeepTab =
  | 'overview' | 'seat' | 'seatOrder' | 'chemistry'
  | 'mission' | 'rounds' | 'lake' | 'captain';

interface DeepTabDef { id: DeepTab; labelKey: string; icon: typeof BarChart3 }

// Tab labels are sourced from i18n so the bilingual switch covers them.
const DEEP_TABS: DeepTabDef[] = [
  { id: 'overview',   labelKey: 'analytics.deep.tabs.overview',   icon: BarChart3 },
  { id: 'seat',       labelKey: 'analytics.deep.tabs.seat',       icon: Map },
  { id: 'seatOrder',  labelKey: 'analytics.deep.tabs.seatOrder',  icon: Shuffle },
  { id: 'chemistry',  labelKey: 'analytics.deep.tabs.chemistry',  icon: Target },
  { id: 'mission',    labelKey: 'analytics.deep.tabs.mission',    icon: Swords },
  { id: 'rounds',     labelKey: 'analytics.deep.tabs.rounds',     icon: Compass },
  { id: 'lake',       labelKey: 'analytics.deep.tabs.lake',       icon: Droplets },
  { id: 'captain',    labelKey: 'analytics.deep.tabs.captain',    icon: Crown },
];

export default function AnalyticsPage(): JSX.Element {
  const { t } = useTranslation();
  const { setGameState } = useGameStore();
  const [activeTab, setActiveTab] = useState<TopTab>('leaderboard');

  return (
    <div className="min-h-screen bg-black p-4 pb-24">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => setGameState('home')}
            className="p-2 bg-zinc-900/70 rounded-lg border border-zinc-700 hover:border-white text-zinc-300 hover:text-white transition-colors"
            aria-label={t('nav.back')}
          >
            <ArrowLeft size={20} />
          </motion.button>
          <h1 className="text-2xl font-black text-white">{t('nav.analytics')}</h1>
        </div>

        {/* Top-level tabs (3 tabs) */}
        <div className="flex flex-wrap gap-2 mb-6 border-b border-zinc-800 pb-2">
          <TopTabButton
            active={activeTab === 'leaderboard'}
            onClick={() => setActiveTab('leaderboard')}
            icon={Trophy}
            label={t('analytics.tab.leaderboard')}
          />
          <TopTabButton
            active={activeTab === 'deepAnalysis'}
            onClick={() => setActiveTab('deepAnalysis')}
            icon={BarChart3}
            label={t('analytics.tab.deepAnalysis')}
          />
          <TopTabButton
            active={activeTab === 'featureStudies'}
            onClick={() => setActiveTab('featureStudies')}
            icon={Microscope}
            label={t('analytics.tab.featureStudies')}
          />
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === 'leaderboard'    && <EloLeaderboardWithRadar />}
            {activeTab === 'deepAnalysis'   && <DeepAnalysisSection />}
            {activeTab === 'featureStudies' && <FeatureStudiesPanel />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function TopTabButton({
  active, onClick, icon: Icon, label,
}: { active: boolean; onClick: () => void; icon: typeof Trophy; label: string }): JSX.Element {
  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-colors ${
        active
          ? 'bg-white text-black'
          : 'bg-zinc-900/70 border border-zinc-700 text-zinc-300 hover:border-white hover:text-white'
      }`}
    >
      <Icon size={16} />
      {label}
    </motion.button>
  );
}

// ──────────────────────────────────────────────────────────────
// 勝率排行 + 點玩家彈雷達
// ──────────────────────────────────────────────────────────────

function EloLeaderboardWithRadar(): JSX.Element {
  const { t } = useTranslation(['leaderboard', 'common']);
  const [entries, setEntries]   = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [dbOffline, setDbOffline] = useState(false);
  const [search, setSearch]     = useState('');
  const [rankFilter, setRankFilter] = useState('全部');
  const [radarOpenFor, setRadarOpenFor] = useState<LeaderboardEntry | null>(null);

  useEffect(() => {
    fetch(`${SERVER_URL}/api/leaderboard`)
      .then(r => r.json() as Promise<{ leaderboard?: LeaderboardEntry[]; message?: string }>)
      .then(data => {
        if (data.message === 'Database not configured') setDbOffline(true);
        setEntries(data.leaderboard ?? []);
      })
      .catch(() => setError(t('leaderboard:loadFailed')))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tierMap = useMemo(() => rankLeaderboard(entries), [entries]);
  const getTier = useCallback(
    (entry: LeaderboardEntry): EloRank => tierMap.get(entry.id) ?? ELO_RANKS[0],
    [tierMap],
  );

  const filtered = useMemo(() => {
    let result = entries;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(e => e.display_name.toLowerCase().includes(q));
    }
    if (rankFilter !== '全部') {
      result = result.filter(e => getTier(e).label === rankFilter);
    }
    return result;
  }, [entries, search, rankFilter, getTier]);

  const isFiltered = search.trim() !== '' || rankFilter !== '全部';

  return (
    <div className="space-y-4">
      {dbOffline && (
        <div className="flex items-start gap-3 bg-yellow-900/30 border border-yellow-700/50 rounded-xl px-4 py-3 text-sm text-yellow-300">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">{t('leaderboard:dbOffline')}</p>
            <p className="text-xs text-yellow-400/70 mt-0.5">{t('leaderboard:dbOfflineHint')}</p>
          </div>
        </div>
      )}

      {/* Search + rank filter */}
      {!loading && !error && entries.length > 0 && (
        <div className="space-y-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('leaderboard:searchPlaceholder')}
              className="w-full bg-avalon-card/60 border border-gray-700 focus:border-blue-500/70 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none transition-colors"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ALL_RANK_LABELS.map(label => {
              const rankDef = ALL_TIERS.find(r => r.label === label);
              const isActive = rankFilter === label;
              if (label === '全部') {
                return (
                  <button
                    key={label}
                    onClick={() => setRankFilter('全部')}
                    className={`text-xs px-2.5 py-1 rounded-full border font-semibold transition-all ${
                      isActive
                        ? 'bg-white/20 border-white/50 text-white'
                        : 'bg-gray-800/60 border-gray-600 text-gray-400 hover:border-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {t('leaderboard:all')}
                  </button>
                );
              }
              if (!rankDef) return null;
              return (
                <button
                  key={label}
                  onClick={() => setRankFilter(label)}
                  className={`text-xs px-2.5 py-1 rounded-full border font-semibold transition-all ${
                    isActive
                      ? `${rankDef.color} ${rankDef.bgColor} ${rankDef.borderColor}`
                      : 'bg-gray-800/60 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {isFiltered && (
            <p className="text-xs text-gray-500">
              {t('leaderboard:showingCount', { filtered: filtered.length, total: entries.length })}
            </p>
          )}
          <p className="text-xs text-zinc-500">{t('common:analytics.radarHint')}</p>
        </div>
      )}

      {loading && (
        <div className="flex justify-center pt-10">
          <Loader size={32} className="animate-spin text-blue-400" />
        </div>
      )}
      {error && (
        <div className="bg-red-900/50 border border-red-600 rounded-xl p-4 text-red-200 text-sm text-center">
          {error}
        </div>
      )}
      {!loading && !error && !dbOffline && entries.length === 0 && (
        <div className="text-center py-16 text-gray-500">
          <Users size={48} className="mx-auto mb-3 opacity-40" />
          <p>{t('leaderboard:noData')}</p>
          <p className="text-sm mt-1">{t('leaderboard:noDataHint')}</p>
        </div>
      )}
      {!loading && !error && entries.length > 0 && filtered.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <Search size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t('leaderboard:noResults')}</p>
          <p className="text-xs mt-1 text-gray-600">{t('leaderboard:noResultsHint')}</p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((entry, idx) => {
            const rank = getTier(entry);
            return (
              <button
                key={entry.id}
                onClick={() => setRadarOpenFor(entry)}
                className="w-full bg-avalon-card/60 hover:bg-avalon-card/90 border border-gray-700 hover:border-blue-500/50 rounded-xl p-4 flex items-center gap-4 transition-all text-left"
              >
                <div className={`w-8 text-center font-black text-lg ${RANK_COLORS[idx] ?? 'text-gray-500'}`}>
                  {idx === 0 ? <Crown size={20} className="mx-auto text-yellow-400" /> : idx + 1}
                </div>
                {entry.photo_url ? (
                  <img src={entry.photo_url} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-amber-600 flex items-center justify-center text-white font-bold text-sm">
                    {entry.display_name[0]?.toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white truncate">{entry.display_name}</span>
                    <span className="text-xs px-1.5 py-0.5 bg-gray-700 rounded text-gray-400">
                      {PROVIDER_BADGE[entry.provider] ?? '?'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5">
                    <span>{t('leaderboard:winsLosses', { wins: entry.games_won, losses: entry.games_lost })}</span>
                    <span className="text-blue-400">{entry.win_rate}%</span>
                  </div>
                  {entry.badges.length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {entry.badges.slice(0, 4).map(b => (
                        <span key={b} className="text-xs px-1.5 py-0.5 bg-amber-900/50 border border-amber-700/50 text-amber-300 rounded-full">
                          {b}
                        </span>
                      ))}
                      {entry.badges.length > 4 && (
                        <span className="text-xs text-gray-600">+{entry.badges.length - 4}</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-1 justify-end">
                    <TrendingUp size={14} className="text-blue-400" />
                    <span className="font-bold text-white text-lg">{entry.elo_rating}</span>
                  </div>
                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full border ${rank.color} ${rank.bgColor} ${rank.borderColor}`}>
                    {rank.label}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Radar popup */}
      <AnimatePresence>
        {radarOpenFor && (
          <RadarPopup
            entry={radarOpenFor}
            onClose={() => setRadarOpenFor(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Radar popup: fetches /api/analysis/players/:name on open
// ──────────────────────────────────────────────────────────────

function RadarPopup({
  entry, onClose,
}: { entry: LeaderboardEntry; onClose: () => void }): JSX.Element {
  const [radar, setRadar] = useState<AnalysisPlayerRadar | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetchAnalysisPlayerByName(entry.display_name)
      .then(data => { if (!cancelled) setRadar(data); })
      .catch(e => { if (!cancelled) setErr(getErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entry.display_name]);

  const chartData = useMemo(() => {
    if (!radar) return [];
    return [
      { dimension: '勝率',     value: radar.radar.winRate },
      { dimension: '紅方勝率', value: radar.radar.redWinRate },
      { dimension: '藍方守梅', value: radar.radar.blueMerlinProtect },
      { dimension: '理論勝率', value: radar.radar.roleTheory },
      { dimension: '位置率',   value: radar.radar.positionTheory },
      { dimension: '紅方刺梅', value: radar.radar.redMerlinKillRate },
      { dimension: '經驗值',   value: radar.radar.experience },
    ];
  }, [radar]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        className="bg-zinc-950 border border-zinc-700 rounded-2xl max-w-xl w-full max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
          <div className="flex items-center gap-3">
            {entry.photo_url ? (
              <img src={entry.photo_url} alt="" className="w-10 h-10 rounded-full object-cover" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-amber-600 flex items-center justify-center text-white font-bold text-sm">
                {entry.display_name[0]?.toUpperCase()}
              </div>
            )}
            <div>
              <h3 className="text-white font-bold text-lg">{entry.display_name}</h3>
              <p className="text-xs text-zinc-400">ELO {entry.elo_rating} · {entry.games_won}W / {entry.games_lost}L</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
            aria-label="close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4">
          {loading && (
            <div className="flex items-center justify-center py-12 text-zinc-400 gap-3">
              <Loader size={18} className="animate-spin" /> 載入雷達...
            </div>
          )}
          {err && !loading && (
            <div className="py-8 text-center text-amber-300 text-sm">
              <p>無 Sheets 雷達資料：{err}</p>
              <p className="text-xs text-zinc-500 mt-1">此玩家可能尚未累積足夠線下戰績</p>
            </div>
          )}
          {radar && !loading && (
            <div className="space-y-4">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3">
                <ResponsiveContainer width="100%" height={280}>
                  <RadarChart data={chartData}>
                    <PolarGrid stroke="#374151" />
                    <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 10, fill: '#d1d5db' }} />
                    <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#6b7280' }} />
                    <Radar
                      name={radar.player.name}
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
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <StatRow label="總場次" value={radar.player.totalGames.toString()} />
                <StatRow label="勝率" value={`${radar.player.winRate}%`} />
                <StatRow label="理論勝率" value={`${radar.player.roleTheory}%`} />
                <StatRow label="位置率" value={`${radar.player.positionTheory}%`} />
                <StatRow label="紅方勝率" value={`${radar.player.redWin}%`} />
                <StatRow label="藍方勝率" value={`${radar.player.blueWin}%`} />
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function StatRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex justify-between bg-zinc-900/60 rounded-lg px-3 py-2 border border-zinc-800">
      <span className="text-zinc-500">{label}</span>
      <span className="font-bold text-white">{value}</span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 深度分析：把 AnalysisPage 的子面板展開在這裡
// ──────────────────────────────────────────────────────────────

function DeepAnalysisSection(): JSX.Element {
  const { t } = useTranslation('common');
  const [deepTab, setDeepTab] = useState<DeepTab>('overview');
  return (
    <div>
      <p className="text-xs text-zinc-500 mb-3">
        {t('analytics.deep.subtitle', { count: 2145 })} · {t('analytics.deep.subtitleSource')}
      </p>
      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4 scrollbar-hide">
        {DEEP_TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setDeepTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all ${
              deepTab === id
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
                : 'bg-avalon-card/40 text-gray-400 hover:text-white hover:bg-avalon-card/60 border border-gray-700'
            }`}
          >
            <Icon size={14} />
            {t(labelKey)}
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.div
          key={deepTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
        >
          {deepTab === 'overview'   && <OverviewPanel />}
          {deepTab === 'seat'       && <SeatHeatmap />}
          {deepTab === 'chemistry'  && <ChemistryMatrix />}
          {deepTab === 'mission'    && <MissionAnalysis />}
          {deepTab === 'rounds'     && <RoundsAnalysis />}
          {deepTab === 'lake'       && <LakeAnalysis />}
          {deepTab === 'seatOrder'  && <SeatOrderAnalysis />}
          {deepTab === 'captain'    && <CaptainAnalysis />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
