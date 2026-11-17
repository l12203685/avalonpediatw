import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Droplets, Swords, Vote } from 'lucide-react';
import { useAnalysisOverview, deriveStages } from '../useAnalysisOverview';
import { useRoundsData } from '../teams/useTeamsData';
import { useLakeData } from '../LakeAnalysis';
import { useAnalysisPlayerRows } from '../seatRoleBlocks';
import { poolVoting } from '../VotingOverview';
import { outcomeRow, redFinalRate } from '../outcomeTest';
import { formatRate } from '../ui';
import type { CoreTab } from './coreTabs';

/**
 * 總覽的三層大方向（2026-11-17 Edward：「先看大方向就好 真的要看細節才深入去看 要符合我們的核心: 任務結果 > 湖中女神 >
 * 隊伍派票組合 & 黑白球投票 > 發言資訊 & 狀態」「應用比較重要」；同日「發言與狀態不是屬於數據的一環…局勢樹比較像 任務結果 x 湖中女神」
 * → 只列三層）。每層一兩句：數字從資料當下算（跟著上方篩選），後面接
 * 「可以怎麼做」，按鈕切到那一層的分頁看細節。數字算不出來（舊快取、篩選後太少）就只留可以怎麼做，不寫 0%。
 */

const K = 'analytics.analysis.core';

function blueFinal(o: Parameters<typeof redFinalRate>[0]): number | null {
  const r = redFinalRate(o);
  return r === null ? null : 100 - r;
}

function gamesOf(o: Parameters<typeof outcomeRow>[0] | null | undefined): number {
  return o ? outcomeRow(o).reduce((a, b) => a + b, 0) : 0;
}

interface CardProps {
  layer: 1 | 2 | 3;
  icon: typeof Swords;
  title: string;
  findings: (string | null)[];
  action: string;
  target: CoreTab;
  /** 沒給 = 已經在這一層的分頁裡，不放「看細節」。 */
  onGo?: (tab: CoreTab) => void;
  loading?: boolean;
}

function HeadlineCard({ layer, icon: Icon, title, findings, action, target, onGo, loading }: CardProps): JSX.Element {
  const { t } = useTranslation('common');
  const shown = findings.filter((f): f is string => !!f);
  return (
    <section className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3" data-testid={`core-headline-${target}`}>
      <div className="flex items-center gap-2">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-900/60 text-[11px] font-bold text-blue-200">{layer}</span>
        <Icon size={15} className="shrink-0 text-amber-300" aria-hidden />
        <h3 className="text-sm font-bold text-zinc-100">{title}</h3>
      </div>
      <div className="mt-2 space-y-1 text-xs leading-relaxed text-zinc-300 sm:text-[13px]">
        {loading && shown.length === 0 && <p className="text-zinc-500">{t('analytics.deep.loading')}</p>}
        {shown.map((f, i) => <p key={i}>{f}</p>)}
        <p className="text-amber-200/90"><span className="font-semibold">{t(`${K}.actionLabel`)}</span>{action}</p>
      </div>
      {onGo && <button
        type="button"
        onClick={() => onGo(target)}
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-blue-800 bg-blue-900/30 px-2 py-1 text-xs font-semibold text-blue-200 hover:bg-blue-800/50"
      >
        {t(`${K}.details`)}
        <ArrowRight size={12} />
      </button>}
    </section>
  );
}

export function MissionsHeadline({ onGo }: { onGo?: (tab: CoreTab) => void }): JSX.Element {
  const { t } = useTranslation('common');
  const { data: rounds, loading } = useRoundsData();
  const { overview } = useAnalysisOverview();
  const passed = rounds?.mission1Branch?.find(b => b.passed);
  const failed = rounds?.mission1Branch?.find(b => !b.passed);
  const pBlue = passed?.outcomes ? blueFinal(passed.outcomes) : null;
  const fBlue = failed?.outcomes ? blueFinal(failed.outcomes) : null;
  const stages = overview ? deriveStages(overview) : null;
  const kill = stages?.assassination;
  return (
    <HeadlineCard
      layer={1}
      icon={Swords}
      title={t(`${K}.missions.title`)}
      loading={loading}
      findings={[
        pBlue !== null && fBlue !== null
          ? t(`${K}.missions.m1`, { passed: formatRate(pBlue), passedN: passed?.games ?? 0, failed: formatRate(fBlue), failedN: failed?.games ?? 0 })
          : null,
        kill && kill.games > 0 ? t(`${K}.missions.kill`, { rate: formatRate(kill.killPct), n: kill.games }) : null,
      ]}
      action={t(`${K}.missions.action`)}
      target="missions"
      onGo={onGo}
    />
  );
}

export function LakeHeadline({ onGo }: { onGo?: (tab: CoreTab) => void }): JSX.Element {
  const { t } = useTranslation('common');
  const { data, loading } = useLakeData();
  const first = data?.perLake?.[0];
  const blueH = first?.holderStats?.find(h => h.faction !== '紅方');
  const redH = first?.holderStats?.find(h => h.faction === '紅方');
  const b = blueH ? blueFinal(blueH.outcomes) : null;
  const r = redH ? blueFinal(redH.outcomes) : null;
  return (
    <HeadlineCard
      layer={2}
      icon={Droplets}
      title={t(`${K}.lake.title`)}
      loading={loading}
      findings={[
        b !== null && r !== null
          ? t(`${K}.lake.holder`, { blue: formatRate(b), blueN: gamesOf(blueH?.outcomes), red: formatRate(r), redN: gamesOf(redH?.outcomes) })
          : null,
      ]}
      action={t(`${K}.lake.action`)}
      target="lake"
      onGo={onGo}
    />
  );
}

export function TeamsVotesHeadline({ onGo }: { onGo?: (tab: CoreTab) => void }): JSX.Element {
  const { t } = useTranslation('common');
  const { players, loading } = useAnalysisPlayerRows();
  const pooled = useMemo(() => (players ? poolVoting(players) : null), [players]);
  const evil = pooled?.evilAll;
  const good = pooled?.goodAll;
  const evilR3 = pooled?.evilR3;
  return (
    <HeadlineCard
      layer={3}
      icon={Vote}
      title={t(`${K}.teamsVotes.title`)}
      loading={loading}
      findings={[
        evil?.rate != null && good?.rate != null
          ? t(`${K}.teamsVotes.votes`, { evil: formatRate(evil.rate), good: formatRate(good.rate) })
          : null,
        evilR3?.rate != null ? t(`${K}.teamsVotes.r3`, { evil: formatRate(evilR3.rate), n: evilR3.votes }) : null,
      ]}
      action={t(`${K}.teamsVotes.action`)}
      target="teamsVotes"
      onGo={onGo}
    />
  );
}

/** 總覽最上面：三層各一張卡，照核心優先序排（發言不是數據，不另外列；局勢樹在任務結果裡）。 */
export default function CoreHeadlines({ onGo, intro }: { onGo: (tab: CoreTab) => void; intro?: ReactNode }): JSX.Element {
  return (
    <div className="space-y-2" data-testid="core-headlines">
      {intro}
      <div className="grid gap-2 lg:grid-cols-3">
        <MissionsHeadline onGo={onGo} />
        <LakeHeadline onGo={onGo} />
        <TeamsVotesHeadline onGo={onGo} />
      </div>
    </div>
  );
}
