import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Droplets, Swords, Trophy, Vote } from 'lucide-react';
import { useAnalysisOverview, deriveStages } from '../useAnalysisOverview';
import { useRoundsData } from '../teams/useTeamsData';
import { useLakeData } from '../LakeAnalysis';
import { useAnalysisPlayerRows } from '../seatRoleBlocks';
import { poolVoting } from '../VotingOverview';
import { useMinCellGames } from '../OutcomeBlocksTable';
import { GlanceLegend, GlanceRow, KeyNumber, SplitBar, Term, formatInt, type GlanceTone } from '../ui';
import { anyThin, killGlance, lakeHolderGlance, missionOneGlance, overallGlance, pctText, restText, votesGlance } from './glance';
import { sampleText, sentenceText, voteLegend, voteSegments, winLegend, winSegments } from './glanceView';
import type { CoreTab } from './coreTabs';

/**
 * 總覽的大方向（2026-11-17 Edward：「先看大方向就好 真的要看細節才深入去看 要符合我們的核心: 任務結果 > 湖中女神 >
 * 隊伍派票組合 & 黑白球投票 > 發言資訊 & 狀態」「應用比較重要」；同日「發言與狀態不是屬於數據的一環…局勢樹比較像 任務結果 x 湖中女神」
 * → 只列三層）。
 *
 * 2026-11-25（站長：「希望能更直觀讓看到的人一目瞭然」）改成一眼看懂的卡片：最上面先回答「誰比較常贏」，三層各一張卡——
 * 一句白話結論（粗體）、一個大數字、兩三條比例條（藍＝藍方得利、紅＝紅方得利；投票是黑白球）、小字樣本數（「共 N 局」），
 * 最後才是「可以怎麼做」與「看細節」。句子、大數字、長條都從 glance.ts 的同一個結果拿（跟著上方篩選），
 * 算不出來（舊快取、篩選後太少）就只留可以怎麼做，不寫 0%。算法沒有改，只改呈現。
 */

const K = 'analytics.analysis.core';
const G = 'analytics.glance';

interface CardProps {
  layer: 1 | 2 | 3;
  icon: typeof Swords;
  title: string;
  /** 一句話結論（粗體）。 */
  sentence: string | null;
  /** 句子下面的小字提醒（樣本少）。 */
  note?: string | null;
  /** 大數字與它是什麼。 */
  keyNumber?: { value: string; label: ReactNode; tone?: GlanceTone } | null;
  /** 比例條（圖例＋幾列）。 */
  bars?: ReactNode;
  action: string;
  target: CoreTab;
  /** 沒給 = 已經在這一層的分頁裡，不放「看細節」，卡片橫著排。 */
  onGo?: (tab: CoreTab) => void;
  loading?: boolean;
}

function HeadlineCard({ layer, icon: Icon, title, sentence, note, keyNumber, bars, action, target, onGo, loading }: CardProps): JSX.Element {
  const { t } = useTranslation('common');
  const wide = !onGo;
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-zinc-800 bg-zinc-950/60 p-3" data-testid={`core-headline-${target}`}>
      <div className="flex items-center gap-2">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-bold text-zinc-200">{layer}</span>
        <Icon size={15} className="shrink-0 text-amber-300" aria-hidden />
        <h3 className="text-sm font-bold text-zinc-100">{title}</h3>
      </div>
      {loading && !sentence && <p className="mt-2 text-xs text-zinc-500">{t('analytics.deep.loading')}</p>}
      <div className={`mt-2 grid gap-3 ${wide ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-center lg:gap-6' : ''}`}>
        {(sentence || keyNumber) && (
          <div className="space-y-2.5">
            {sentence && <p className="text-sm font-semibold leading-snug text-zinc-50 sm:text-[15px]" data-testid="core-headline-sentence">{sentence}</p>}
            {sentence && note && <p className="text-[11px] text-amber-200/90" data-testid="core-headline-thin">{note}</p>}
            {keyNumber && <KeyNumber value={keyNumber.value} label={keyNumber.label} tone={keyNumber.tone} />}
          </div>
        )}
        {bars && <div className="space-y-2">{bars}</div>}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-amber-200/90"><span className="font-semibold">{t(`${K}.actionLabel`)}</span>{action}</p>
      {onGo && (
        <div className="mt-auto pt-2">
          <button
            type="button"
            onClick={() => onGo(target)}
            className="inline-flex items-center gap-1 rounded-md border border-blue-800 bg-blue-900/30 px-2 py-1 text-xs font-semibold text-blue-200 hover:bg-blue-800/50"
          >
            {t(`${K}.details`)}
            <ArrowRight size={12} />
          </button>
        </div>
      )}
    </section>
  );
}

/** 總覽最上面：誰比較常贏（全部局的藍方贏｜紅方贏），紅方贏的兩種方式寫在下面小字。 */
export function OverallHero(): JSX.Element | null {
  const { t } = useTranslation('common');
  const { overview, loading } = useAnalysisOverview();
  const glance = useMemo(() => overallGlance(overview ? deriveStages(overview) : null), [overview]);
  if (!glance) {
    return loading ? <p className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-500">{t('analytics.deep.loading')}</p> : null;
  }
  const sample = sampleText(t, glance.games);
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 sm:p-4" data-testid="overall-hero">
      <div className="flex items-center gap-2">
        <Trophy size={15} className="shrink-0 text-amber-300" aria-hidden />
        <h3 className="text-sm font-bold text-zinc-100">{t(`${G}.overall.title`)}</h3>
        <span className="ml-auto text-[11px] tabular-nums text-zinc-500">
          {sample}
          {typeof overview?.totalPlayers === 'number' && ` · ${t(`${G}.overall.players`, { n: formatInt(overview.totalPlayers) })}`}
        </span>
      </div>
      <div className="mt-2 grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-center lg:gap-6">
        <div className="space-y-2.5">
          <p className="text-base font-semibold leading-snug text-zinc-50 sm:text-lg" data-testid="overall-hero-sentence">{sentenceText(t, glance.sentence)}</p>
          <KeyNumber
            value={glance.lead === 'red' ? restText(glance.blue) : pctText(glance.blue)}
            tone={glance.lead}
            label={<Term term="finalWinRate">{t(`${G}.overall.${glance.lead}Key`)}</Term>}
          />
        </div>
        <div className="space-y-1.5">
          <SplitBar size="lg" showNames sample={sample} segments={winSegments(t, { pct: glance.blue, n: glance.games })} />
          <p className="text-xs leading-relaxed text-zinc-400" data-testid="overall-hero-how">
            {t(`${G}.overall.redHow`, { threeRed: pctText(glance.threeRed), killed: pctText(glance.killed) })}
          </p>
        </div>
      </div>
    </section>
  );
}

export function MissionsHeadline({ onGo }: { onGo?: (tab: CoreTab) => void }): JSX.Element {
  const { t } = useTranslation('common');
  const { data: rounds, loading } = useRoundsData();
  const { overview } = useAnalysisOverview();
  const m1 = useMemo(() => missionOneGlance(rounds?.mission1Branch), [rounds]);
  const kill = useMemo(() => killGlance(overview ? deriveStages(overview).assassination : null), [overview]);
  const min = useMinCellGames();
  const thin = (n: number): string | undefined => (n < min ? t(`${G}.thin`) : undefined);
  return (
    <HeadlineCard
      layer={1}
      icon={Swords}
      title={t(`${K}.missions.title`)}
      loading={loading}
      sentence={sentenceText(t, m1?.sentence) ?? sentenceText(t, kill?.sentence)}
      note={m1 && anyThin(min, m1.passed, m1.failed) ? t(`${G}.thinNote`, { min }) : null}
      keyNumber={m1 ? { value: pctText(m1.failed.pct), label: t(`${G}.missions.m1.key`), tone: 'blue' } : null}
      bars={(m1 || kill) && (
        <>
          {m1 && (
            <>
              <GlanceLegend items={winLegend(t)} />
              <GlanceRow label={t(`${G}.missions.m1.passedRow`)} sample={sampleText(t, m1.passed.n)} thin={thin(m1.passed.n)}>
                <SplitBar segments={winSegments(t, m1.passed)} sample={sampleText(t, m1.passed.n)} />
              </GlanceRow>
              <GlanceRow label={t(`${G}.missions.m1.failedRow`)} sample={sampleText(t, m1.failed.n)} thin={thin(m1.failed.n)}>
                <SplitBar segments={winSegments(t, m1.failed)} sample={sampleText(t, m1.failed.n)} />
              </GlanceRow>
            </>
          )}
          {kill && (
            <GlanceRow label={<Term term="killRate">{t(`${G}.missions.killRow`)}</Term>} sample={sampleText(t, kill.hit.n)} thin={thin(kill.hit.n)}>
              <SplitBar
                showNames
                sample={sampleText(t, kill.hit.n)}
                segments={[
                  { pct: kill.hit.pct, text: pctText(kill.hit.pct), name: t(`${G}.missions.hit`), tone: 'red' },
                  { pct: 100 - kill.hit.pct, text: restText(kill.hit.pct), name: t(`${G}.missions.miss`), tone: 'blue' },
                ]}
              />
            </GlanceRow>
          )}
        </>
      )}
      action={t(`${K}.missions.action`)}
      target="missions"
      onGo={onGo}
    />
  );
}

export function LakeHeadline({ onGo }: { onGo?: (tab: CoreTab) => void }): JSX.Element {
  const { t } = useTranslation('common');
  const { data, loading } = useLakeData();
  const glance = useMemo(
    () => lakeHolderGlance(data?.perLake?.[0]?.holderStats, t('analytics.deep.lake.tabFirst')),
    [data, t],
  );
  const min = useMinCellGames();
  const thin = (n: number): string | undefined => (n < min ? t(`${G}.thin`) : undefined);
  return (
    <HeadlineCard
      layer={2}
      icon={Droplets}
      title={t(`${K}.lake.title`)}
      loading={loading}
      sentence={sentenceText(t, glance?.sentence)}
      note={glance && anyThin(min, glance.blueHolder, glance.redHolder) ? t(`${G}.thinNote`, { min }) : null}
      keyNumber={glance ? { value: pctText(glance.blueHolder.pct), label: t(`${G}.lake.key`), tone: 'blue' } : null}
      // 在湖中女神分頁裡，下面「誰拿湖」就是同樣兩條（還能換第幾次湖），這張卡不重複畫
      bars={glance && onGo && (
        <>
          <GlanceLegend items={winLegend(t)} />
          <GlanceRow label={t(`${G}.lake.blueRow`)} sample={sampleText(t, glance.blueHolder.n)} thin={thin(glance.blueHolder.n)}>
            <SplitBar segments={winSegments(t, glance.blueHolder)} sample={sampleText(t, glance.blueHolder.n)} />
          </GlanceRow>
          <GlanceRow label={t(`${G}.lake.redRow`)} sample={sampleText(t, glance.redHolder.n)} thin={thin(glance.redHolder.n)}>
            <SplitBar segments={winSegments(t, glance.redHolder)} sample={sampleText(t, glance.redHolder.n)} />
          </GlanceRow>
        </>
      )}
      action={t(`${K}.lake.action`)}
      target="lake"
      onGo={onGo}
    />
  );
}

export function TeamsVotesHeadline({ onGo }: { onGo?: (tab: CoreTab) => void }): JSX.Element {
  const { t } = useTranslation('common');
  const { players, loading } = useAnalysisPlayerRows();
  const glance = useMemo(() => votesGlance(players ? poolVoting(players) : null), [players]);
  return (
    <HeadlineCard
      layer={3}
      icon={Vote}
      title={t(`${K}.teamsVotes.title`)}
      loading={loading}
      sentence={sentenceText(t, glance?.sentence)}
      keyNumber={glance ? { value: pctText(glance.withRed.pct), label: <Term term="evilTeamReject">{t(`${G}.votes.key`)}</Term>, tone: 'no' } : null}
      bars={glance && (
        <>
          <GlanceLegend items={voteLegend(t)} />
          <GlanceRow label={t(`${G}.votes.withRedRow`)} sample={sampleText(t, glance.withRed.n, 'votes')}>
            <SplitBar segments={voteSegments(t, glance.withRed, 'reject')} sample={sampleText(t, glance.withRed.n, 'votes')} />
          </GlanceRow>
          <GlanceRow label={t(`${G}.votes.allBlueRow`)} sample={sampleText(t, glance.allBlueApprove.n, 'votes')}>
            <SplitBar segments={voteSegments(t, glance.allBlueApprove, 'approve')} sample={sampleText(t, glance.allBlueApprove.n, 'votes')} />
          </GlanceRow>
        </>
      )}
      action={t(`${K}.teamsVotes.action`)}
      target="teamsVotes"
      onGo={onGo}
    />
  );
}

/** 總覽：先回答誰比較常贏，再三層各一張卡，照核心優先序排（發言不是數據，不另外列；局勢樹在任務結果裡）。 */
export default function CoreHeadlines({ onGo, intro }: { onGo: (tab: CoreTab) => void; intro?: ReactNode }): JSX.Element {
  return (
    <div className="space-y-2" data-testid="core-headlines">
      {intro}
      <OverallHero />
      <div className="grid gap-2 lg:grid-cols-3">
        <MissionsHeadline onGo={onGo} />
        <LakeHeadline onGo={onGo} />
        <TeamsVotesHeadline onGo={onGo} />
      </div>
    </div>
  );
}
