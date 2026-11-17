import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, GitBranch } from 'lucide-react';
import MissionAnalysis from '../MissionAnalysis';
import RoundsAnalysis from '../RoundsAnalysis';
import OverviewPanel from '../OverviewPanel';
import AssassinationTab from '../tabs/AssassinationTab';
import LakeTab from '../tabs/LakeTab';
import TeamsTab from '../tabs/TeamsTab';
import VotesTab from '../tabs/VotesTab';
import StateTreeTab from '../tabs/StateTreeTab';
import PositionTab from '../tabs/PositionTab';
import RolesTab from '../tabs/RolesTab';
import StrengthTab from '../tabs/StrengthTab';
import PlayersTab from '../tabs/PlayersTab';
import DiscoveryList from '../discovery/DiscoveryList';
import DiscoveryBlock from '../discovery/DiscoveryBlock';
import { useDiscoveryNav } from '../discovery/discoveryNav';
import TwoRedCohortView from '../cohort/TwoRedCohortView';
import { MoreDetails, SectionTabs, useSectionTab } from '../ui';
import { useMinCellGames } from '../OutcomeBlocksTable';
import CoreHeadlines, { LakeHeadline, MissionsHeadline, TeamsVotesHeadline } from './CoreHeadlines';
import { CORE_PERSIST, type AdvancedSub, type CoreTab, type CoreTarget, type MissionsSub, type TeamsVotesSub } from './coreTabs';

/**
 * 新的數據分析分頁內容（2026-11-17 數據頁改版，coreTabs.ts）：每一層先放那一層的大方向卡（同總覽那張），再用小分頁切細節。
 * 舊的分頁元件都沒有刪，只是搬進這裡的小分頁；舊網址與跳轉經 coreTabs.LEGACY_TABS 導到對的小分頁。
 */

const K = 'analytics.analysis.core';

/** 總覽：三層大方向；原本的總覽（三段結算、每人結果、理論勝率連結）收進「看細節」。 */
export function OverviewCoreTab({ onGo }: { onGo: (tab: CoreTab) => void }): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-3">
      <CoreHeadlines onGo={onGo} />
      <MoreDetails items={[{ id: 'overviewAll', title: t(`${K}.overviewMore`), render: () => <OverviewPanel /> }]} />
      <DiscoveryBlock page="overview" />
    </div>
  );
}

/**
 * ① 任務結果：任務（通過率、任務 → 結局）／任務 × 湖中（局勢樹：任務順序 × 湖的宣告 → 結果）／完整任務路徑／刺殺（遊戲怎麼結束的另一半）。
 * 局勢樹 2026-11-17 搬進來（Edward：「局勢樹比較像 任務結果 x 湖中女神」）；湖中女神那頁有連過來的按鈕。
 */
export function MissionsCoreTab(): JSX.Element {
  const { t } = useTranslation('common');
  const min = useMinCellGames();
  const items: { id: MissionsSub; label: string }[] = [
    { id: 'missions', label: t(`${K}.sub.missions`) },
    { id: 'stateTree', label: t(`${K}.sub.stateTree`) },
    { id: 'paths', label: t(`${K}.sub.paths`) },
    { id: 'assassination', label: t(`${K}.sub.assassination`) },
  ];
  return (
    <div className="space-y-3">
      <MissionsHeadline />
      <SectionTabs items={items} persistKey={CORE_PERSIST.missions} ariaLabel={t('analytics.analysis.tabs.missions')}>
        {(view) => {
          if (view === 'stateTree') return <StateTreeTab />;
          if (view === 'paths') return <RoundsAnalysis section="paths" lowSample={min} />;
          if (view === 'assassination') return <><AssassinationTab /><DiscoveryBlock page="assassination" /></>;
          return <><MissionAnalysis /><DiscoveryBlock page="missions" /></>;
        }}
      </SectionTabs>
    </div>
  );
}

/** ② 湖中女神；任務 × 湖的組合（局勢樹）在任務結果，這裡放連過去的按鈕。 */
export function LakeCoreTab({ onJump }: { onJump?: (target: CoreTarget) => void }): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="space-y-3">
      <LakeHeadline />
      {onJump && (
        <button
          type="button"
          onClick={() => onJump({ tab: 'missions', sub: 'stateTree' })}
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-800 bg-blue-900/30 px-2 py-1 text-xs font-semibold text-blue-200 hover:bg-blue-800/50"
          data-testid="lake-statetree-link"
        >
          <GitBranch size={12} />
          {t(`${K}.lake.stateTreeLink`)}
          <ArrowRight size={12} />
        </button>
      )}
      <LakeTab />
      <DiscoveryBlock page="lake" />
    </div>
  );
}

/** ③ 派隊與投票：派隊（隊長、1-1）／投票（黑白球）／兩紅之後的派隊（強者怎麼派）。 */
export function TeamsVotesCoreTab(): JSX.Element {
  const { t } = useTranslation('common');
  const items: { id: TeamsVotesSub; label: string }[] = [
    { id: 'votes', label: t(`${K}.sub.votes`) },
    { id: 'teams', label: t(`${K}.sub.teams`) },
    { id: 'twoRed', label: t(`${K}.sub.twoRed`) },
  ];
  const [active, setView] = useSectionTab<TeamsVotesSub>(items, { defaultValue: 'votes', persistKey: CORE_PERSIST.teamsVotes });
  const view: TeamsVotesSub = active ?? 'votes';
  const nav = useDiscoveryNav();
  useEffect(() => {
    if (nav.view !== 'twoRedCohort') return;
    setView('twoRed');
    nav.consumeView();
  }, [nav.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-3">
      <TeamsVotesHeadline />
      <SectionTabs items={items} value={view} onChange={setView} ariaLabel={t('analytics.analysis.core.tabs.teamsVotes')}>
        {(v) => {
          if (v === 'teams') return <><TeamsTab /><DiscoveryBlock page="teams" /></>;
          if (v === 'twoRed') return <TwoRedCohortView />;
          return <><VotesTab /><DiscoveryBlock page="votes" /></>;
        }}
      </SectionTabs>
    </div>
  );
}

/** 進階（預設不在第一眼）：完整的自動發現、位置、角色與默契、陣容強度、玩家雷達。 */
export function AdvancedCoreTab({ focus }: { focus: { name: string; seq: number } | null }): JSX.Element {
  const { t } = useTranslation('common');
  const items: { id: AdvancedSub; label: string }[] = [
    { id: 'discovery', label: t('analytics.analysis.findings.discovery') },
    { id: 'players', label: t('analytics.analysis.tabs.players') },
    { id: 'position', label: t('analytics.analysis.tabs.position') },
    { id: 'roles', label: t('analytics.analysis.tabs.roles') },
    { id: 'strength', label: t('analytics.analysis.tabs.strength') },
  ];
  const [active, setView] = useSectionTab<AdvancedSub>(items, { defaultValue: 'discovery', persistKey: CORE_PERSIST.advanced });
  const view: AdvancedSub = active ?? 'discovery';
  const nav = useDiscoveryNav();
  // 自動發現的「看全部」→ 完整清單；「在組成比較打開」→ 陣容強度（StrengthTab 自己處理 compare 並清掉）
  useEffect(() => {
    if (nav.view === 'discovery') { setView('discovery'); nav.consumeView(); }
    else if (nav.view === 'compare') setView('strength');
  }, [nav.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  // 排行點名字（focus）→ 玩家雷達：由 AnalyticsPage 在「點名字的那一下」記下 players 小分頁再重新掛載（initialTarget／goTo），
  // 這裡不看 focus 切小分頁——focus 點過之後一直不是 null，掛載時強制切到玩家雷達會蓋掉記下的小分頁與上面自動發現的跳轉。
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">{t(`${K}.advancedIntro`)}</p>
      <SectionTabs items={items} value={view} onChange={setView} ariaLabel={t('analytics.analysis.core.tabs.advanced')}>
        {(v) => {
          if (v === 'players') return <PlayersTab focus={focus} />;
          if (v === 'position') return <><PositionTab /><DiscoveryBlock page="position" /></>;
          if (v === 'roles') return <><RolesTab /><DiscoveryBlock page="roles" /></>;
          if (v === 'strength') return <><StrengthTab /><DiscoveryBlock page="strength" /></>;
          return <DiscoveryList />;
        }}
      </SectionTabs>
    </div>
  );
}
