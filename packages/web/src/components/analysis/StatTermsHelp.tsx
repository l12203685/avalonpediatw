import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, ChevronDown } from 'lucide-react';
import {
  fetchAnalysisLeaderboard, isTheoryBoard, theorySettings,
  type AnalysisLeaderboardData,
} from '../../services/api';
import { STATS_HELP_ANCHOR } from '../../utils/statsHelp';
import { STAT_TERMS, Term, TermRows } from './ui';
import BoardInfo, { boardText } from './BoardInfo';
import { roleWindowSizes } from './radar/radarModel';
import { MAX_ROWS, MIN_PLAYER_GAMES } from './SeatHeatmap';

/**
 * 說明頁的「統計名詞與算法」(Edward 2026-10-30：「理論勝率的右邊 上綁文字說明有點太過冗長 其它說明也是類似
 * 可以另外全部集中丟到說明頁面 或是用滑鼠移過去再顯示定義跟算法就好」)。
 *
 * 戰績排行與分析頁各表原本印在畫面上的說明 (表格旁的定義、表格下的註腳) 都收進了名詞提示 (Term) 和表名旁的 ⓘ
 * (InfoTip)；這裡把全部集中列一次，文字一律沿用同一份 i18n 字串 (與排行快取的說明)，不另外改寫：
 *  1. 名詞：statTerms 每個名詞的定義 / 算法 / 怎麼看 (與 Term 同一份)
 *  2. 表格上的記號：淡色、補值、n、點一列
 *  3. 戰績排行各榜：期間、上榜、定義 (讀排行快取，與各榜 ⓘ 同一份 BoardInfo)
 *  4. 分析頁各表：各分頁表格的說明
 * 門檻數字 (補值場數、近期天數、角色窗) 讀排行快取的 config，讀不到用產生器預設值；跟資料有關的數字
 * (局數、條數) 用「N」。
 */

/** 排行榜小分頁的順序 (與 LeaderboardBoards 相同)；有 theory 榜時 main / position / overall 併進理論表。 */
const BOARD_ORDER = ['theory', 'main', 'position', 'overall', 'last50', 'improved', 'assassin', 'newcomers', 'roleTitles'];
const MERGED_INTO_THEORY = new Set(['main', 'position', 'overall']);
const RADAR_AXES = ['winRate', 'redWinRate', 'blueMerlinProtect', 'missionWinRate', 'roleTheory', 'positionTheory', 'redMerlinKillRate', 'experience'] as const;
const CHEMISTRY_GUIDES: ReadonlyArray<[string, string[]]> = [
  ['coWin', ['analytics.deep.chemistry.guideCoWin']],
  ['coLose', ['analytics.deep.chemistry.guideCoLose']],
  ['winCorr', ['analytics.deep.chemistry.guideWinCorr1', 'analytics.deep.chemistry.guideWinCorr2']],
  ['coWinMinusLose', ['analytics.deep.chemistry.guideCoWinMinusLose1', 'analytics.deep.chemistry.guideCoWinMinusLose2']],
  ['outcomePair', ['analytics.r6.tabsb.chemistry.pairDescription']],
];

function useIsEn(): boolean {
  const { i18n } = useTranslation('common');
  return Boolean(i18n.language?.toLowerCase().startsWith('en'));
}

/** 可收合的一段 (原生 details，鍵盤、螢幕閱讀器都可用)。 */
function Group({ id, title, children, defaultOpen = false }: {
  id?: string;
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}): JSX.Element {
  return (
    <details id={id} open={defaultOpen} className="group rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-white hover:bg-zinc-900/70 md:text-base [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <ChevronDown size={18} className="shrink-0 text-zinc-400 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-3 border-t border-zinc-800 px-4 pb-4 pt-3 text-sm leading-relaxed text-zinc-300">{children}</div>
    </details>
  );
}

/** 一張表：表名 + 幾段說明。 */
function Item({ title, children }: { title: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <h4 className="font-semibold text-zinc-100">{title}</h4>
      <div className="mt-0.5 space-y-1 text-[13px] text-zinc-400 md:text-sm">{children}</div>
    </div>
  );
}

function TabHeading({ children }: { children: ReactNode }): JSX.Element {
  return <h3 className="pt-1 text-xs font-bold uppercase tracking-wide text-amber-300/90">{children}</h3>;
}

export default function StatTermsHelp(): JSX.Element {
  const { t } = useTranslation('common');
  const isEn = useIsEn();
  const [board, setBoard] = useState<AnalysisLeaderboardData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAnalysisLeaderboard()
      .then(d => { if (!cancelled) setBoard(d); })
      .catch(() => { /* 排行讀不到：各榜那段不列，其他照常 */ });
    return (): void => { cancelled = true; };
  }, []);

  const settings = theorySettings(board?.config);
  const min = settings.theoryMinCellGames;
  const { special, loyal } = roleWindowSizes(settings);
  const boards = (board && Array.isArray(board.boards) ? board.boards : [])
    .filter(isTheoryBoard)
    .filter(b => Array.isArray(b.rows) && b.rows.length > 0);
  const merged = boards.some(b => b.id === 'theory');
  const shownBoards = (merged ? boards.filter(b => !MERGED_INTO_THEORY.has(b.id)) : boards)
    .map((b, i) => ({ b, pos: BOARD_ORDER.indexOf(b.id) === -1 ? BOARD_ORDER.length + i : BOARD_ORDER.indexOf(b.id) }))
    .sort((a, b) => a.pos - b.pos)
    .map(x => x.b);
  const N = 'N';
  const tab = (key: string): string => t(`analytics.analysis.tabs.${key}`);

  return (
    <section id={STATS_HELP_ANCHOR} className="scroll-mt-16 space-y-3" data-testid="stat-terms-help">
      <div className="flex items-center gap-2 px-1">
        <BarChart3 size={18} className="text-white" />
        <h2 className="text-lg font-bold text-white md:text-xl">{t('analytics.help.title')}</h2>
      </div>
      <p className="px-1 text-sm leading-relaxed text-zinc-400">{t('analytics.help.intro')}</p>

      <Group title={t('analytics.help.terms')} defaultOpen>
        <dl className="grid gap-3 md:grid-cols-2">
          {STAT_TERMS.map(term => (
            <div key={term} id={`term-${term}`} className="min-w-0 rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-[13px]">
              <dt className="mb-1 font-semibold text-white">{t(`statTerms.${term}.name`)}</dt>
              <dd><TermRows term={term} /></dd>
            </div>
          ))}
        </dl>
      </Group>

      <Group title={t('analytics.help.symbols')}>
        <ul className="list-disc space-y-1.5 pl-5 marker:text-zinc-600">
          <li>{t('analytics.boards.theory.footnote', { min })}</li>
          <li>{t('analytics.r6.boards.sparseNote', { min })}</li>
          <li>{t('analytics.ui.blocks.cellNote')} {t('analytics.ui.blocks.lowSampleNote', { min })}</li>
          <li>{t('analytics.r6.overview.theory.nHint')}</li>
          <li>{t('analytics.boards.principle', { days: settings.activeDays })}</li>
          <li>{t('analytics.r6.boards.clickHint')}</li>
        </ul>
      </Group>

      <Group title={t('analytics.help.boards')}>
          {shownBoards.map(b => (
            <Item key={b.id} title={boardText(b, isEn).title}>
              <BoardInfo board={b} isEn={isEn} />
            </Item>
          ))}
          <Item title={t('analytics.winRates.tab')}>
            <p>{t('analytics.winRates.note')}</p>
          </Item>
      </Group>

      <Group title={t('analytics.help.tables')}>
        <TabHeading>{tab('overview')}</TabHeading>
        <Item title={t('analytics.r6.overview.outcomes.title')}>
          <p>{t('analytics.r7.mix.note')}</p>
          <p>{t('analytics.r7.mix.tableNote')}</p>
        </Item>
        <Item title={t('analytics.r6.overview.theory.title')}>
          <p>{t('analytics.r6.overview.theory.scope')}</p>
          <p>{t('analytics.r6.overview.theory.defRole')}</p>
          <p>{t('analytics.r6.overview.theory.defPosition')}</p>
          <p>{t('analytics.r6.overview.theory.defOverall')}</p>
          {min > 0 && <p>{t('analytics.r6.overview.theory.topUp', { n: min })}</p>}
        </Item>

        <TabHeading>{tab('teams')}</TabHeading>
        <Item title={t('analytics.r6.teams.captain.perMissionCaption')}>
          <p>{t('analytics.r6.teams.captain.intro', { replace: { count: N } })}</p>
        </Item>
        <Item title={t('analytics.r6.teams.captain.resultCaption')}>
          <p>{t('analytics.r6.teams.captain.nNote')}</p>
        </Item>
        <Item title={t('analytics.r6.teams.tabs.firstVote')}>
          <p><Term term="firstProposal">1-1</Term>{t('analytics.r7.firstVote.introRest')}</p>
        </Item>
        <Item title={t('analytics.r6.teams.progression.pathCaption')}>
          <p>{t('analytics.r6.teams.progression.pathNote', { replace: { count: N } })}</p>
        </Item>
        <Item title={[t('analytics.r6.teams.blocks.mission'), t('analytics.r6.teams.blocks.assassination'), t('analytics.r6.teams.blocks.final')].join(t('analytics.help.sep'))}>
          <p>{t('analytics.r6.teams.blocks.note')}</p>
          {min > 0 && <p>{t('analytics.r6.teams.blocks.lowSample', { min })}</p>}
        </Item>

        <TabHeading>{tab('votes')}</TabHeading>
        <Item title={t('analytics.r7.votes.tabs.overview')}>
          <p>{t('analytics.r7.votes.note')}</p>
        </Item>

        <TabHeading>{tab('missions')}</TabHeading>
        <Item title={t('analytics.r6.tabsa.missions.passCaption')}>
          <p>{t('analytics.r7.missions.passNote')}</p>
        </Item>
        <Item title={t('analytics.r6.tabsa.missions.outcomeCaption')}>
          <p>{t('analytics.r7.missions.outcomeNote')}</p>
        </Item>

        <TabHeading>{tab('lake')}</TabHeading>
        <Item title={t('analytics.r6.tabsa.lake.tabs.faction')}>
          <p>{t('analytics.r6.tabsa.lake.factionNote')}</p>
          <p>{t('analytics.r6.tabsa.outcomeTable.note')} {t('analytics.r6.tabsa.outcomeTable.lowSample', { min })}</p>
        </Item>

        <TabHeading>{tab('assassination')}</TabHeading>
        <Item title={t('analytics.deep.assassination.title')}>
          <p>{t('analytics.deep.assassination.sub')}</p>
          <p>{t('analytics.deep.assassination.rule')}</p>
        </Item>
        <Item title={t('analytics.r6.tabsa.assassination.seatCaption')}>
          <p>{t('analytics.r7.seatKill.note')} {t('analytics.r6.tabsa.outcomeTable.lowSample', { min })}</p>
        </Item>

        <TabHeading>{tab('position')}</TabHeading>
        <Item title={t('analytics.r6.tabsb.position.tabs.seats')}>
          <p>{t('analytics.r6.tabsb.seats.note')}</p>
        </Item>
        <Item title={t('analytics.r6.tabsb.position.tabs.seatRoles')}>
          <p>{t('analytics.r6.tabsb.seatRoles.note')}</p>
          <p>{t('analytics.ui.blocks.missionHint')}</p>
          <p>{t('analytics.ui.blocks.assassinationHint')}</p>
          <p>{t('analytics.ui.blocks.finalHint')}</p>
        </Item>
        <Item title={t('analytics.r6.tabsb.position.tabs.players')}>
          <p>{t('analytics.r6.tabsb.heatmap.note', { min: MIN_PLAYER_GAMES, max: MAX_ROWS })}</p>
          <p>{t('analytics.r6.tabsb.heatmap.noteMarks')}</p>
          <p>{t('analytics.r6.tabsb.heatmap.noteBlocks')}</p>
        </Item>
        <Item title={t('analytics.r6.tabsb.order.blocksTitle')}>
          <p>{t('analytics.r6.tabsb.order.sub', { games: N })}</p>
          <p>{t('analytics.r6.tabsb.order.blocksNote')}</p>
        </Item>
        <Item title={t('analytics.deep.seatOrder.interleaveTitle')}>
          <p>{t('analytics.deep.seatOrder.interleaveSub')}</p>
          <p>{t('analytics.r6.tabsb.order.interleaveNote')}</p>
        </Item>

        <TabHeading>{tab('roles')}</TabHeading>
        <Item title={t('analytics.r6.tabsb.roleBlocks.title')}>
          <p>{t('analytics.r6.tabsb.roleBlocks.note')}</p>
          <p>{t('analytics.deep.roleFinal.note')}{min > 0 && t('analytics.deep.roleFinal.noteTopUp', { n: min })}</p>
        </Item>
        <Item title={t('analytics.r6.tabsb.roles.tabs.chemistry')}>
          <ul className="list-disc space-y-1 pl-5 marker:text-zinc-600">
            {CHEMISTRY_GUIDES.map(([key, guides]) => (
              <li key={key}>
                <span className="font-semibold text-zinc-200">{t(`analytics.deep.chemistry.descriptions.${key}`)}</span>
                {t('analytics.help.colon')}
                {guides.map(g => t(g)).join(' ')}
              </li>
            ))}
          </ul>
        </Item>

        <TabHeading>{tab('players')}</TabHeading>
        <Item title={t('analytics.r6.radar.tabs.radar')}>
          <ul className="list-disc space-y-1 pl-5 marker:text-zinc-600">
            {RADAR_AXES.map(axis => (
              <li key={axis}>
                <span className="font-semibold text-zinc-200">{t(`analytics.r6.radar.axes.${axis}`)}</span>
                {t('analytics.help.colon')}
                {t(`analytics.r6.radar.axisDef.${axis}`, { special, loyal, games: settings.positionGames })}
              </li>
            ))}
          </ul>
          <p>{t('analytics.r6.radar.radarNote')}</p>
        </Item>
        <Item title={t('analytics.r6.radar.tabs.blocks')}>
          <p>{t('analytics.ui.blocks.cellNote')}</p>
          <p>{t('analytics.r6.radar.blocks.rolesNote')}</p>
        </Item>
        <Item title={t('analytics.r6.radar.theory.summaryCaption')}>
          <p>
            {t('analytics.r6.radar.theory.note', { special, loyal, position: settings.positionGames, overall: settings.overallMinGames })}
            {min > 0 && <> {t('analytics.r6.radar.theory.noteTopUp', { n: min })}</>}
          </p>
        </Item>
        <Item title={t('analytics.r6.radar.theory.rolesCaption')}>
          <p>{t('analytics.r6.radar.theory.rolesNote')}</p>
        </Item>
      </Group>
    </section>
  );
}
