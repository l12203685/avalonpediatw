import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip,
} from 'recharts';
import { Loader, AlertCircle, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  fetchAnalysisPlayers,
  fetchAnalysisPlayerByName,
  finalFields,
  fmtPct,
  getErrorMessage,
  theoryLastWindows,
  theorySettings,
} from '../../services/api';
import type { AnalysisPlayerStats, AnalysisPlayerRadar, AnalysisTheoryConfig, PlayerTheoryWindow } from '../../services/api';
import { useAnalysisOverview } from './useAnalysisOverview';
import { cleanNameQuery, compactName, matchPlayerName, normalizeName, type NameMatch } from '@avalon/shared';

/**
 * 玩家能力雷達 (2026-10-12 兩段結算改版、2026-10-13 理論勝率, docs/stats/two_stage_outcome.md)。
 * 軸：最終勝率、紅方最終勝率、藍方三藍活率、任務結算勝率、角色理論勝率、位置理論勝率
 * (兩者都是生涯，Edward 的定義)、紅方刺中率、經驗。
 * 角色理論 = Σ 抽到該角色的機率（忠臣 4/10、其他各 1/10）× 本人該角色最終勝率；
 * 位置理論 = Σ 1/10 × 本人該位置最終勝率；只讀 player.theory (舊後端的 radar.roleTheory
 * 是舊口徑，不讀)。旁邊的表列快取有的近 N 場 (現在是 100、50) 與生涯。超額勝率不再顯示。
 * 算不出來的軸 (例如舊快取還沒有理論勝率) 不畫，不畫成 0%。補值門檻與視窗讀
 * overview.theoryConfig，說明文字跟著變 (門檻 0 = 不補，就不提補值)。
 * 後端 radar 缺新鍵 (舊後端) 時由 finalFields() 以原始計數算，公式同後端。
 */
type AxisKey =
  | 'winRate' | 'redWinRate' | 'blueMerlinProtect' | 'missionWinRate'
  | 'roleTheory' | 'positionTheory' | 'redMerlinKillRate' | 'experience';

const AXIS_ORDER: AxisKey[] = [
  'winRate', 'redWinRate', 'blueMerlinProtect', 'missionWinRate',
  'roleTheory', 'positionTheory', 'redMerlinKillRate', 'experience',
];

interface AxisPoint {
  key: AxisKey;
  dimension: string;
  /** 畫在圖上的 0–100 值。 */
  value: number;
  /** 原始值 (算不出來的軸不放進圖裡，見 buildAxes)。 */
  raw: number | null;
}

const RED_ROLES = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫'];

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function buildAxes(
  data: AnalysisPlayerRadar,
  roleFinalWinRates: Record<string, number> | undefined,
  label: (k: AxisKey) => string,
): AxisPoint[] {
  const { player, radar } = data;
  const ff = finalFields(player, roleFinalWinRates);
  const values: Record<AxisKey, number | null> = {
    winRate: ff.finalWinRate ?? num(radar.winRate),
    redWinRate: ff.finalRedWinRate ?? num(radar.redWinRate),
    blueMerlinProtect: ff.finalBlueWinRate ?? num(radar.blueMerlinProtect) ?? num(player.blueMerlinAlive),
    missionWinRate: ff.missionWinRate ?? num(radar.missionWinRate) ?? num(player.winRate),
    roleTheory: num(player.theory?.career?.roleTheory),
    positionTheory: num(player.theory?.career?.positionTheory),
    redMerlinKillRate: num(radar.redMerlinKillRate) ?? num(player.redMerlinDead),
    experience: num(radar.experience) ?? Math.min(player.totalGames / 10, 100),
  };
  // 算不出來的軸 (舊快取的角色理論／位置理論等) 不畫：畫在 0 會看起來像 0%。
  return AXIS_ORDER.flatMap(key => {
    const raw = values[key];
    return raw === null ? [] : [{ key, dimension: label(key), value: clamp100(raw), raw }];
  });
}

export default function PlayerRadarChart({ focus = null }: { focus?: { name: string; seq: number } | null } = {}): JSX.Element {
  const { t } = useTranslation('common');
  const { overview } = useAnalysisOverview();
  const settings = useMemo(() => theorySettings(overview?.theoryConfig), [overview?.theoryConfig]);
  const [playerList, setPlayerList] = useState<AnalysisPlayerStats[]>([]);
  // 排行點名字 / #player= 連結帶進來的玩家優先 (store.openPlayerStats，名單到了再比對)；
  // 沒有才預設場次最多的人。
  const [selectedName, setSelectedName] = useState<string>('');
  const openedWithFocus = useRef(Boolean(focus?.name));
  const [radarData, setRadarData] = useState<AnalysisPlayerRadar | null>(null);
  const [loading, setLoading] = useState(true);
  const [radarLoading, setRadarLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        const { players } = await fetchAnalysisPlayers();
        if (!cancelled) {
          setPlayerList(players);
          if (players.length > 0 && !openedWithFocus.current) setSelectedName(prev => prev || players[0].name);
        }
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return (): void => { cancelled = true; };
  }, []);

  // 名單：場次多的在前 (快取順序)，暱稱比對與機器人 /戰績 同一套規則 (@avalon/shared)。
  const names = useMemo(() => playerList.map(p => p.name), [playerList]);

  // 排行點名字 / #player= 連結：名單到了之後用同一套比對 (大小寫、暱稱) 找到那位；
  // 找不到唯一一位就把名字放進搜尋框，列出候選。
  useEffect(() => {
    if (!focus?.name || names.length === 0) return;
    const m = matchPlayerName(focus.name, names);
    if (m.kind === 'found') {
      setSelectedName(m.name);
      setSearch('');
    } else {
      setSearch(focus.name);
    }
  }, [focus, names]);

  // 搜尋 (2026-10-13 玩家反應：用平常的暱稱查不到人)：完全相同 → 不分大小寫 → 忽略空白 →
  // 名字的一部分；只有一位就直接打開，多位列出候選，沒有就給「你是不是要找」。
  const match: NameMatch | null = useMemo(
    () => (search.trim() && names.length > 0 ? matchPlayerName(search, names) : null),
    [search, names],
  );
  const matchedName = match?.kind === 'found' ? match.name : null;
  useEffect(() => {
    if (!matchedName) return;
    const id = setTimeout(() => setSelectedName(matchedName), 250);
    return (): void => clearTimeout(id);
  }, [matchedName]);

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

  const axisLabel = useCallback(
    (k: AxisKey): string => t(`analytics.deep.radar.axes.${k}`),
    [t],
  );

  const chartData = useMemo(
    () => (radarData ? buildAxes(radarData, overview?.roleFinalWinRates, axisLabel) : []),
    [radarData, overview?.roleFinalWinRates, axisLabel],
  );

  const ff = useMemo(
    () => (radarData ? finalFields(radarData.player, overview?.roleFinalWinRates) : null),
    [radarData, overview?.roleFinalWinRates],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.radar.loadingPlayers')}
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

  const filteredPlayers = filterPlayers(playerList, search, match);
  const pickFirst = (): void => {
    const first = match?.kind === 'found' ? match.name : filteredPlayers[0]?.name;
    if (first) setSelectedName(first);
  };

  return (
    <div className="space-y-4">
      {/* Player selector */}
      <div className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4">
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder={t('analytics.deep.radar.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') pickFirst(); }}
            data-testid="radar-search"
            className="w-full bg-avalon-card border border-gray-600 rounded-lg pl-8 pr-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>
        {match && match.kind !== 'found' && (
          <p data-testid="radar-search-status" className="text-[11px] text-gray-400 mb-2">
            {match.kind === 'ambiguous'
              ? t('analytics.deep.radar.searchMany', { count: match.total })
              : match.suggestions && match.suggestions.length > 0
                ? t('analytics.deep.radar.searchSuggest', { query: cleanNameQuery(match.query) })
                : t('analytics.deep.radar.searchNone', { query: cleanNameQuery(match.query) })}
          </p>
        )}
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
          <Loader size={20} className="animate-spin" /> {t('analytics.deep.radar.loadingRadar')}
        </div>
      ) : radarData && ff ? (
        <div className="grid md:grid-cols-2 gap-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
          >
            <h3 className="text-sm font-bold text-gray-400 mb-2">
              {t('analytics.deep.radar.title', { name: radarData.player.name })}
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
                  formatter={(_val: unknown, _name, item) => {
                    const p = item.payload as AxisPoint;
                    if (p.key === 'experience') return [p.raw === null ? '—' : p.raw.toFixed(1), p.dimension];
                    return [fmtPct(p.raw), p.dimension];
                  }}
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
                  itemStyle={{ color: '#d1d5db' }}
                />
              </RadarChart>
            </ResponsiveContainer>
            {/* Radar dimension explanation */}
            <div className="mt-3 text-xs text-gray-500 space-y-1">
              {chartData.map(({ key: k }) => (
                <p key={k}>
                  {t(`analytics.deep.radar.legend.${k}`)}
                  {(k === 'roleTheory' || k === 'positionTheory') && settings.theoryMinCellGames > 0
                    && t(`analytics.deep.radar.topUp.${k === 'roleTheory' ? 'role' : 'seat'}`, { n: settings.theoryMinCellGames })}
                </p>
              ))}
            </div>
          </motion.div>

          {/* Player stats sidebar */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4 space-y-3"
          >
            <h3 className="text-sm font-bold text-gray-400">
              {t('analytics.deep.radar.details', { name: radarData.player.name })}
            </h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <StatRow label={t('analytics.deep.radar.stats.totalGames')} value={radarData.player.totalGames.toString()} />
              <StatRow label={t('analytics.deep.radar.stats.finalWinRate')} value={fmtPct(ff.finalWinRate)} />
              <StatRow label={t('analytics.deep.radar.stats.missionWinRate')} value={fmtPct(ff.missionWinRate)} />
              <StatRow label={t('analytics.deep.radar.stats.merlinSurvival')} value={fmtPct(ff.merlinSurvivalRate)} color="text-blue-400" />
              <StatRow label={t('analytics.deep.radar.stats.redFinal')} value={fmtPct(ff.finalRedWinRate)} color="text-red-400" />
              <StatRow label={t('analytics.deep.radar.stats.blueFinal')} value={fmtPct(ff.finalBlueWinRate)} color="text-blue-400" />
              <StatRow label={t('analytics.deep.radar.stats.red3Red')} value={fmtPct(num(radarData.player.red3Red))} color="text-red-400" />
              <StatRow label={t('analytics.deep.radar.stats.redMerlinDead')} value={fmtPct(num(radarData.player.redMerlinDead))} color="text-yellow-400" />
              <StatRow label={t('analytics.deep.radar.stats.blueMerlinAlive')} value={fmtPct(num(radarData.player.blueMerlinAlive))} color="text-blue-400" />
            </div>

            <TheoryTable player={radarData.player} settings={settings} />

            {/* Role win rates (任務結算口徑, 舊欄位保留) */}
            <div>
              <p className="text-xs font-bold text-gray-500 mb-1.5">{t('analytics.deep.radar.stats.roleWinRates')}</p>
              <div className="space-y-1">
                {Object.entries(radarData.player.roleWinRates ?? {})
                  .filter(([, v]) => typeof v === 'number' && v > 0)
                  .map(([role, wr]) => {
                    const isRed = RED_ROLES.includes(role);
                    return (
                      <div key={role} className="flex items-center gap-2">
                        <span className={`text-xs w-12 font-semibold ${isRed ? 'text-red-400' : 'text-blue-400'}`}>{role}</span>
                        <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${isRed ? 'bg-red-500' : 'bg-blue-500'}`}
                            style={{ width: `${clamp100(wr)}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-400 w-10 text-right">{wr}%</span>
                      </div>
                    );
                  })}
              </div>
              <p className="text-[10px] text-gray-600 mt-1">{t('analytics.deep.radar.legacyNote')}</p>
            </div>
          </motion.div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 搜尋框下的名字：名字含搜尋字 (不分大小寫、全半形，也忽略空白與 ._-·) 的全部列出，
 * 場次多的在前；一個都沒有時列「你是不是要找」的建議。沒打字 = 全部。
 */
function filterPlayers(players: AnalysisPlayerStats[], search: string, match: NameMatch | null): AnalysisPlayerStats[] {
  const cleaned = cleanNameQuery(search);
  if (!cleaned) return players;
  const nq = normalizeName(cleaned);
  const cq = compactName(cleaned);
  const hits = players.filter(p => normalizeName(p.name).includes(nq) || (cq !== '' && compactName(p.name).includes(cq)));
  if (hits.length > 0) return hits;
  const suggested = match?.kind === 'none' ? match.suggestions ?? [] : [];
  return players.filter(p => suggested.includes(p.name));
}

/**
 * 理論勝率表：快取有的近 N 場 (現在是 100、50)、生涯 × 角色理論／位置理論／最終勝率。
 * 場數沒超過 N 時「近 N 場」就是全部場次，只列生涯那一行；舊快取沒有 theory → 提示。
 */
function TheoryTable({ player, settings }: { player: AnalysisPlayerStats; settings: AnalysisTheoryConfig }): JSX.Element {
  const { t } = useTranslation('common');
  const theory = player.theory;
  const career = theory?.career;
  if (!career) {
    return <p className="text-xs text-gray-500">{t('analytics.deep.radar.stats.theoryPending')}</p>;
  }
  const rows: Array<{ label: string; w: PlayerTheoryWindow }> = [];
  const windows = theoryLastWindows(theory);
  for (const w of windows) {
    if (career.games > w.window) {
      rows.push({ label: t('analytics.deep.radar.stats.lastN', { count: w.window }), w });
    }
  }
  rows.push({ label: t('analytics.deep.radar.stats.career', { count: career.games }), w: career });
  return (
    <div>
      <p className="text-xs font-bold text-gray-500 mb-1.5">{t('analytics.deep.radar.stats.theoryTitle')}</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-gray-500">
            <th className="text-left font-normal py-0.5" />
            <th className="text-right font-normal py-0.5">{t('analytics.deep.radar.stats.colRoleTheory')}</th>
            <th className="text-right font-normal py-0.5">{t('analytics.deep.radar.stats.colPositionTheory')}</th>
            <th className="text-right font-normal py-0.5">{t('analytics.deep.radar.stats.colFinal')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, w }) => (
            <tr key={label} className="border-t border-gray-800">
              <td className="py-1 text-gray-400">{label}</td>
              <td className="py-1 text-right font-bold text-amber-200">{fmtPct(w.roleTheory)}</td>
              <td className="py-1 text-right text-gray-300">{fmtPct(w.positionTheory)}</td>
              <td className="py-1 text-right text-gray-300">{fmtPct(w.finalWinRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-gray-600 mt-1">
        {windows.length > 0 && t('analytics.deep.radar.stats.theoryNote', { windows: windows.map(w => w.window).join('/') })}
        {settings.theoryMinCellGames > 0 && t('analytics.deep.radar.stats.theoryNoteTopUp', { n: settings.theoryMinCellGames })}
      </p>
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
