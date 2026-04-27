import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Trophy, BarChart3, Crown, TrendingUp, Loader, Search, AlertTriangle,
  Users, Target, Swords, Map, Compass, Droplets, Shuffle, Microscope,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import {
  TIER_GROUP_LABEL_ZH,
  ELO_TAG_ZH,
  type TierGroup,
  type EloTag,
  type LeaderboardEntryV2,
} from '@avalon/shared';
import { useGameStore } from '../store/gameStore';
import OverviewPanel from '../components/analysis/OverviewPanel';
import SeatHeatmap from '../components/analysis/SeatHeatmap';
import ChemistryMatrix from '../components/analysis/ChemistryMatrix';
import MissionAnalysis from '../components/analysis/MissionAnalysis';
import RoundsAnalysis from '../components/analysis/RoundsAnalysis';
import LakeAnalysis from '../components/analysis/LakeAnalysis';
import SeatOrderAnalysis from '../components/analysis/SeatOrderAnalysis';
import CaptainAnalysis from '../components/analysis/CaptainAnalysis';
import FeatureStudiesPanel from '../components/analytics/FeatureStudiesPanel';
import LeaderboardV3Table from '../components/LeaderboardV3Table';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:3001';

/**
 * #98 (2026-04-23) IA 重整：數據排行頁拆成兩大區 —
 *  - 勝率排行 (ELO Leaderboard)：原本 LeaderboardPage 的排名清單；點玩家彈出雷達彈窗
 *  - 深度分析 (Deep Analysis)：把 AnalysisPage 的分頁內容直接搬進來
 * 「玩家雷達」不再獨立 tab，融進勝率排行的點擊體驗。
 *
 * (2026-04-27) 新增第三 tab「特徵研究」: 把 v7 features 研究 (loops 136/139/141/
 * 142/143) 萃取成可瀏覽的玩家信號頁。前 2 張 card 預設展開, 後 3 張收合。
 *
 * (2026-04-27 18:05 整合) Edward「features 跟原本的數據分析怎麼不見了」—
 * T1 把大廳「數據排行」按鈕 hijack 到 LeaderboardPage 後，AnalyticsPage 入口
 * 被切斷, 深度分析 + 特徵研究都看不到。本次調整：
 *   - 大廳按鈕回 'analytics' (HomePage 改回)
 *   - 第一 tab「精算榜」: V3 8-metric 表 + 下方「分層瀏覽」collapse 展開 V2
 *     五分層 (rookie/regular/veteran/expert/master)；舊 V1 EloLeaderboardWithRadar
 *     退役（V3 已含全部欄, RadarPopup 玩家點仍能 popup）。
 *   - 第二 tab「深度分析」: 不動
 *   - 第三 tab「特徵研究」: 不動
 * LeaderboardPage 仍保留供 'leaderboard' route 用作備援/Alternative entry。
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
      <div className="max-w-6xl mx-auto">
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
            {activeTab === 'leaderboard'    && <PrecisionBoardSection />}
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
// 精算榜 (V3 8-metric) + 分層瀏覽 (V2 5 TierGroup) collapse
// ──────────────────────────────────────────────────────────────

function PrecisionBoardSection(): JSX.Element {
  const { t } = useTranslation('common');
  const [tiersOpen, setTiersOpen] = useState(false);

  return (
    <div className="space-y-6">
      <LeaderboardV3Table />

      <div>
        <button
          onClick={() => setTiersOpen(v => !v)}
          data-testid="analytics-expand-tiers"
          className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-zinc-900/60 hover:bg-zinc-900/90 border border-zinc-700 hover:border-white rounded-xl transition-colors text-sm font-semibold text-zinc-200"
        >
          <span className="flex items-center gap-2">
            <Users size={16} className="text-blue-400" />
            {tiersOpen
              ? t('analytics.collapseTiers', { defaultValue: '收合分層瀏覽' })
              : t('analytics.expandTiers', { defaultValue: '分層瀏覽 (5 組 ELO 分層)' })}
          </span>
          {tiersOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>

        <AnimatePresence initial={false}>
          {tiersOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="pt-4">
                <TierGroupSection />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// V2 五分層瀏覽 — 從 LeaderboardPage classic mode 萃取
// 來源：GET /api/leaderboard/v2 → { groups: { rookie, regular, veteran, expert, master } }
// ──────────────────────────────────────────────────────────────

const TIER_GROUPS: readonly TierGroup[] = [
  'rookie', 'regular', 'veteran', 'expert', 'master',
] as const;

interface LeaderboardEntryV2Enriched extends LeaderboardEntryV2 {
  displayName?: string | null;
  photoUrl?: string | null;
}

interface LeaderboardV2Response {
  version: 2;
  groups: Record<TierGroup, LeaderboardEntryV2Enriched[]>;
}

const ELO_TAG_STYLE: Record<EloTag, { text: string; bg: string; border: string }> = {
  novice_tag: { text: 'text-green-400', bg: 'bg-green-900/40', border: 'border-green-700' },
  mid_tag: { text: 'text-blue-400', bg: 'bg-blue-900/40', border: 'border-blue-700' },
  top_tag: { text: 'text-yellow-400', bg: 'bg-yellow-900/40', border: 'border-yellow-700' },
};

const TIER_TAB_STYLE: Record<TierGroup, string> = {
  rookie: 'bg-gray-700/60 text-gray-200 border-gray-500',
  regular: 'bg-blue-900/60 text-blue-200 border-blue-600',
  veteran: 'bg-purple-900/60 text-purple-200 border-purple-600',
  expert: 'bg-orange-900/60 text-orange-200 border-orange-600',
  master: 'bg-yellow-900/60 text-yellow-200 border-yellow-500',
};

const RANK_COLORS = ['text-yellow-400', 'text-gray-300', 'text-amber-600'];

function TierGroupSection(): JSX.Element {
  const { t } = useTranslation(['leaderboard', 'common']);
  const { navigateToProfile } = useGameStore();

  const [groups, setGroups] = useState<Record<TierGroup, LeaderboardEntryV2Enriched[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dbOffline, setDbOffline] = useState(false);
  const [activeTier, setActiveTier] = useState<TierGroup>('rookie');
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch(`${SERVER_URL}/api/leaderboard/v2`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as LeaderboardV2Response | { message: string };
      })
      .then((data) => {
        if ('message' in data && data.message === 'Database not configured') {
          setDbOffline(true);
          return;
        }
        const payload = data as LeaderboardV2Response;
        if (payload?.groups) {
          setGroups(payload.groups);
        } else {
          setError(t('leaderboard:loadFailed'));
        }
      })
      .catch(() => setError(t('leaderboard:loadFailed')))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo<LeaderboardEntryV2Enriched[]>(() => {
    if (!groups) return [];
    const list = groups[activeTier] ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((e) => {
      const name = (e.displayName ?? e.playerId).toLowerCase();
      return name.includes(q);
    });
  }, [groups, activeTier, search]);

  const tierCounts = useMemo<Record<TierGroup, number>>(() => {
    const out: Record<TierGroup, number> = {
      rookie: 0, regular: 0, veteran: 0, expert: 0, master: 0,
    };
    if (!groups) return out;
    for (const g of TIER_GROUPS) {
      out[g] = groups[g]?.length ?? 0;
    }
    return out;
  }, [groups]);

  const totalInTier = tierCounts[activeTier];
  const isFiltered = search.trim() !== '' && groups !== null;

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

      {!loading && !error && !dbOffline && groups && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5" role="tablist">
            {TIER_GROUPS.map((tier) => {
              const label = TIER_GROUP_LABEL_ZH[tier];
              const count = tierCounts[tier];
              const isActive = activeTier === tier;
              return (
                <button
                  key={tier}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => {
                    setActiveTier(tier);
                    setSearch('');
                  }}
                  className={`text-xs px-2.5 py-1.5 rounded-full border font-semibold transition-all ${
                    isActive
                      ? `${TIER_TAB_STYLE[tier]}`
                      : 'bg-gray-800/60 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                  }`}
                >
                  <span>{label}</span>
                  <span className="ml-1.5 text-[10px] opacity-70">({count})</span>
                </button>
              );
            })}
          </div>

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('leaderboard:searchPlaceholder')}
              className="w-full bg-avalon-card/60 border border-gray-700 focus:border-blue-500/70 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none transition-colors"
            />
          </div>

          {isFiltered && (
            <p className="text-xs text-gray-500">
              {t('leaderboard:showingCount', { filtered: filtered.length, total: totalInTier })}
            </p>
          )}
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

      {!loading && !error && !dbOffline && groups && totalInTier === 0 && !isFiltered && (
        <div className="text-center py-12 text-gray-500">
          <Users size={48} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">{t('leaderboard:groupEmpty')}</p>
        </div>
      )}

      {!loading && !error && groups && totalInTier > 0 && filtered.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <Search size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t('leaderboard:noResults')}</p>
          <p className="text-xs mt-1 text-gray-600">{t('leaderboard:noResultsHint')}</p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((entry, idx) => {
            const tagStyle = ELO_TAG_STYLE[entry.eloTag] ?? ELO_TAG_STYLE.mid_tag;
            const name = entry.displayName ?? entry.playerId;
            const winPct = Math.round((entry.winRate ?? 0) * 100);
            const theoPct = Math.round((entry.theoreticalWinRate ?? 0) * 100);
            return (
              <button
                key={entry.playerId}
                onClick={() => navigateToProfile(entry.playerId)}
                className="w-full bg-avalon-card/60 hover:bg-avalon-card/90 border border-gray-700 hover:border-blue-500/50 rounded-xl p-4 flex items-center gap-4 transition-all text-left"
              >
                <div className={`w-8 text-center font-black text-lg ${RANK_COLORS[idx] ?? 'text-gray-500'}`}>
                  {idx === 0 ? <Crown size={20} className="mx-auto text-yellow-400" /> : idx + 1}
                </div>

                {entry.photoUrl ? (
                  <img src={entry.photoUrl} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-amber-600 flex items-center justify-center text-white font-bold text-sm">
                    {name[0]?.toUpperCase()}
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white truncate">{name}</span>
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${tagStyle.text} ${tagStyle.bg} ${tagStyle.border}`}
                    >
                      {ELO_TAG_ZH[entry.eloTag] ?? entry.eloTag}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5 flex-wrap">
                    <span>{entry.totalGames} {t('leaderboard:games')}</span>
                    <span className="text-blue-400">{t('leaderboard:winRate')} {winPct}%</span>
                    <span className="text-emerald-400">{t('leaderboard:theoreticalWinRate')} {theoPct}%</span>
                  </div>
                </div>

                <div className="text-right">
                  <div className="flex items-center gap-1 justify-end">
                    <TrendingUp size={14} className="text-blue-400" />
                    <span className="font-bold text-white text-lg">{entry.elo}</span>
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5">{t('leaderboard:elo')}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
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
