import { useState, useEffect, useMemo, useRef } from 'react';
import { Loader, AlertCircle, Radar, Table2, Sigma, TrendingUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  fetchAnalysisPlayers,
  fetchAnalysisPlayerByName,
  fmtPct,
  getErrorMessage,
  theorySettings,
} from '../../services/api';
import type { AnalysisPlayerStats, AnalysisPlayerRadar } from '../../services/api';
import { useAnalysisOverview } from './useAnalysisOverview';
import { matchPlayerName, type NameMatch } from '@avalon/shared';
import { SectionTabs, type SectionTabItem } from './ui';
import PlayerPicker, { filterPlayers } from './radar/PlayerPicker';
import RadarPanel from './radar/RadarPanel';
import BlocksPanel from './radar/BlocksPanel';
import TheoryPanel from './radar/TheoryPanel';
import EloPanel from './radar/EloPanel';
import { buildRadarModel } from './radar/radarModel';

/**
 * 玩家能力雷達 (2026-10-12 兩段結算改版、2026-10-13 理論勝率, docs/stats/two_stage_outcome.md)。
 *
 * (2026-10-14 Edward：角色勝率分三塊並用條件機率；角色理論改各角色近 10 場、忠臣近 40 場，位置理論
 *  近 100 場，整體理論 = 生涯角色理論、生涯滿 250 場才列；數字用表格；一個分頁一屏、不要往下捲)
 *   - 上方一列：選人框 (搜尋 + 浮動名單，見 radar/PlayerPicker) + 這位玩家的生涯場數與最終勝率；
 *     原本一整片名字按鈕把內容往下推，拿掉。
 *   - 下面三個小分頁 (SectionTabs，記住上次看的)：
 *       雷達圖  — 圖 + 每條軸的數字、n、定義 (radar/RadarPanel)
 *       三塊勝率 — 紅方、藍方、各角色的 任務結果／刺殺結果／遊戲結果，條件機率 + n (radar/BlocksPanel)；
 *                 取代舊的「詳細數據」側欄與任務結算口徑的「角色勝率」長條
 *       理論勝率 — 角色理論／位置理論／整體理論與各角色用到的場次 (radar/TheoryPanel)
 *   - 紅方刺中率、藍方梅林存活率是刺殺結果 (只看到達三藍的局)；算不出來 (null) 的軸不畫，
 *     不再退回 三藍死 / 全部紅方場 (player.redMerlinDead) 或藍方遊戲結果 (finalBlueWinRate)。
 *   - 視窗、門檻 (補值、整體理論的場數) 讀 overview.theoryConfig (theorySettings)，不寫死；
 *     舊快取缺的欄位顯示「下次每日更新後提供」，不畫成 0%。
 * 數字整理在 radar/radarModel (三塊結果用 @avalon/shared playerOutcomeBlocks，不在這裡重算)。
 *
 * (2026-10-30 Edward：「ELO 曲線不錯，可以放在玩家頁面」) 第四個小分頁「Elo 走勢」(radar/EloPanel)：目前的 Elo、±1σ
 *  與依時間的走勢 (/api/analysis/rating/:name)，自己拿資料，不等雷達資料。
 */
type RadarSection = 'radar' | 'blocks' | 'theory' | 'elo';

export default function PlayerRadarChart({ focus = null }: { focus?: { name: string; seq: number } | null } = {}): JSX.Element {
  const { t } = useTranslation('common');
  const { overview } = useAnalysisOverview();
  const settings = useMemo(() => theorySettings(overview?.theoryConfig), [overview?.theoryConfig]);
  const [playerList, setPlayerList] = useState<AnalysisPlayerStats[]>([]);
  // 舊名字 → 正式名字 (player_aliases.json)：打舊名字也找得到那位。
  const [aliases, setAliases] = useState<Record<string, string>>({});
  // 排行點名字 / #player= 連結帶進來的玩家優先 (store.openPlayerStats，名單到了再比對)；
  // 沒有才預設場次最多的人。
  const [selectedName, setSelectedName] = useState<string>('');
  const openedWithFocus = useRef(Boolean(focus?.name));
  const [radarData, setRadarData] = useState<AnalysisPlayerRadar | null>(null);
  const [loading, setLoading] = useState(true);
  const [radarLoading, setRadarLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [radarError, setRadarError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        const { players, aliases: playerAliases } = await fetchAnalysisPlayers();
        if (!cancelled) {
          setPlayerList(players);
          setAliases(playerAliases ?? {});
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
  // 找不到唯一一位就把名字放進搜尋框，展開名單列出候選。
  useEffect(() => {
    if (!focus?.name || names.length === 0) return;
    const m = matchPlayerName(focus.name, names, aliases);
    if (m.kind === 'found') {
      setSelectedName(m.name);
      setSearch('');
      setListOpen(false);
    } else {
      setSearch(focus.name);
      setListOpen(true);
    }
  }, [focus, names, aliases]);

  // 搜尋 (2026-10-13 玩家反應：用平常的暱稱查不到人)：完全相同 → 不分大小寫 → 忽略空白 →
  // 名字的一部分；只有一位就直接打開，多位列出候選，沒有就給「你是不是要找」。
  const match: NameMatch | null = useMemo(
    () => (search.trim() && names.length > 0 ? matchPlayerName(search, names, aliases) : null),
    [search, names, aliases],
  );
  const matchedName = match?.kind === 'found' ? match.name : null;
  useEffect(() => {
    if (!matchedName) return;
    const id = setTimeout(() => setSelectedName(matchedName), 250);
    return (): void => clearTimeout(id);
  }, [matchedName]);

  // 換人時舊的請求作廢：連打搜尋 (唯一符合 250 ms 後自動打開) 或連點兩個名字時，
  // 先送出的那位若較晚回來，不能蓋掉目前選的人。
  useEffect(() => {
    if (!selectedName) return;
    let stale = false;
    setRadarLoading(true);
    setRadarError(null);
    fetchAnalysisPlayerByName(selectedName)
      .then(data => { if (!stale) setRadarData(data); })
      .catch(err => { if (!stale) setRadarError(getErrorMessage(err)); })
      .finally(() => { if (!stale) setRadarLoading(false); });
    return (): void => { stale = true; };
  }, [selectedName]);

  const model = useMemo(
    () => (radarData ? buildRadarModel(radarData, settings, overview?.roleFinalWinRates) : null),
    [radarData, settings, overview?.roleFinalWinRates],
  );

  const options = useMemo(() => filterPlayers(playerList, search, match), [playerList, search, match]);

  const sections: SectionTabItem<RadarSection>[] = useMemo(() => [
    { id: 'radar', label: t('analytics.r6.radar.tabs.radar'), icon: Radar },
    { id: 'blocks', label: t('analytics.r6.radar.tabs.blocks'), icon: Table2 },
    { id: 'theory', label: t('analytics.r6.radar.tabs.theory'), icon: Sigma },
    { id: 'elo', label: t('analytics.elo.radarTab'), icon: TrendingUp },
  ], [t]);

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

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <PlayerPicker
          options={options}
          total={playerList.length}
          selectedName={selectedName}
          search={search}
          onSearchChange={setSearch}
          match={match}
          open={listOpen}
          onOpenChange={setListOpen}
          onPick={name => { setSelectedName(name); setSearch(''); setListOpen(false); }}
        />
        {model && (
          // flex-wrap：各段之間沒有空白可斷行 (英文)，用 flex 讓整段換到下一行而不是撐寬頁面。
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs text-zinc-400" data-testid="radar-player-summary">
            <span className="mr-0.5 min-w-0 break-all text-base font-bold text-white">{model.player.name}</span>
            <span className="whitespace-nowrap">{t('analytics.r6.radar.summary.games', { count: model.player.totalGames })}</span>
            <span className="text-zinc-600" aria-hidden>·</span>
            <span className="whitespace-nowrap">
              {t('analytics.r6.radar.summary.final')} <b className="text-zinc-200">{fmtPct(model.finalWinRate)}</b>
            </span>
            {model.player.firstPlayed && model.player.lastPlayed && (
              <>
                <span className="text-zinc-600" aria-hidden>·</span>
                <span className="whitespace-nowrap">{model.player.firstPlayed} ～ {model.player.lastPlayed}</span>
              </>
            )}
            {radarLoading && <Loader size={12} className="animate-spin self-center text-zinc-500" aria-hidden />}
          </div>
        )}
      </div>

      <SectionTabs
        items={sections}
        persistKey="analysis.players"
        ariaLabel={t('analytics.r6.radar.tabs.label')}
      >
        {active => {
          // Elo 走勢有自己的資料 (/rating/:name)，雷達資料失敗或還在載入時照樣顯示。
          if (active === 'elo') return selectedName ? <EloPanel name={selectedName} /> : null;
          if (radarError) {
            return (
              <div className="flex items-center justify-center py-16 text-red-400 gap-3">
                <AlertCircle size={20} /> {radarError}
              </div>
            );
          }
          if (!model) {
            return radarLoading ? (
              <div className="flex items-center justify-center py-16 text-gray-400 gap-3">
                <Loader size={20} className="animate-spin" /> {t('analytics.deep.radar.loadingRadar')}
              </div>
            ) : null;
          }
          // 換人時先留著上一位的表 (變淡)，新資料到了再換，版面不會跳。
          return (
            <div className={radarLoading ? 'pointer-events-none opacity-50 transition-opacity' : 'transition-opacity'} aria-busy={radarLoading}>
              {active === 'blocks' ? <BlocksPanel model={model} settings={settings} />
                : active === 'theory' ? <TheoryPanel model={model} settings={settings} />
                  : <RadarPanel model={model} settings={settings} />}
            </div>
          );
        }}
      </SectionTabs>
    </div>
  );
}
