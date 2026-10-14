import { Swords, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatInt, formatRate } from '../ui';
import type { StageSummaries } from '../useAnalysisOverview';

/**
 * 總覽最上面的一列：總場次、玩家數、三段結算 (任務結算 → 刺殺結算 → 最終)。
 *
 * (2026-10-14 Edward：「頁面不要拉太長，最好一頁顯示全部」) 原本三張大卡 (約 170 px 高) 收成一列
 * (≥ 1280 一行，字太長時換行不撐寬；更窄時三段各三行小字，手機另把總數放第一行)。
 * 每段都附分母 n —— 刺殺結算的分母是三藍局 (三紅的局沒有刺殺)，所以 n 比另外兩段小；
 * 數字直接讀 deriveStages() (快取的 missionStage / assassinationStage / final，舊快取現場算)。
 */

interface Side {
  label: string;
  pct: number;
  className: string;
}

function Stage({ label, scope, n, a, b, arrow }: {
  label: string;
  /** 分母的範圍 (刺殺結算 = 三藍局)。 */
  scope?: string;
  n: number;
  a: Side;
  b: Side;
  arrow?: boolean;
}): JSX.Element {
  const { t } = useTranslation('common');
  const nText = t('analytics.ui.table.n', { n: formatInt(n) });
  return (
    <>
      {/* 箭頭自己佔一格 (手機的 5 欄格線 / 桌機的 flex)，不疊在數字上 */}
      {arrow && <span aria-hidden className="self-center text-xs text-zinc-600">→</span>}
      <div className="min-w-0">
        {/* 手機到 lg：三行置中 (標籤／兩個比率／陣營與 n) */}
        <div className="xl:hidden text-center">
          <p className="text-[10px] font-semibold text-zinc-400 whitespace-nowrap">
            {label}
            {scope && <span className="font-normal text-zinc-500">・{scope}</span>}
          </p>
          <p className="text-[13px] font-black tabular-nums whitespace-nowrap">
            <span className={a.className}>{formatRate(a.pct)}</span>
            <span className="mx-0.5 text-[10px] text-zinc-600">/</span>
            <span className={b.className}>{formatRate(b.pct)}</span>
          </p>
          <p className="text-[9px] text-zinc-500 whitespace-nowrap">
            {a.label} / {b.label} · <span className="tabular-nums">{nText}</span>
          </p>
        </div>
        {/* xl (1280) 以上：一行 */}
        <p className="hidden xl:flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-[11px] font-semibold text-zinc-400">
            {label}
            {scope && <span className="font-normal text-zinc-500">・{scope}</span>}
          </span>
          <span className={`text-sm font-black tabular-nums ${a.className}`}>
            <span className="text-[11px] font-semibold">{a.label}</span> {formatRate(a.pct)}
          </span>
          <span className="text-[10px] text-zinc-600">/</span>
          <span className={`text-sm font-black tabular-nums ${b.className}`}>
            <span className="text-[11px] font-semibold">{b.label}</span> {formatRate(b.pct)}
          </span>
          <span className="text-[10px] text-zinc-500 tabular-nums">{nText}</span>
        </p>
      </div>
    </>
  );
}

export default function SummaryStrip({ totalGames, totalPlayers, stages }: {
  totalGames: number;
  totalPlayers: number;
  stages: StageSummaries;
}): JSX.Element {
  const { t } = useTranslation('common');
  const rule = t('analytics.deep.overview.stages.rule');
  const red = t('analytics.deep.overview.stages.red');
  const blue = t('analytics.deep.overview.stages.blue');
  return (
    <section
      aria-label={t('analytics.r6.overview.summary.label')}
      title={rule}
      className="rounded-xl border border-gray-700 bg-avalon-card/30 px-3 py-2 flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-6"
    >
      <div className="flex items-baseline justify-center gap-5 shrink-0">
        <span className="inline-flex items-baseline gap-1.5">
          <Swords size={14} className="self-center text-blue-300/70" aria-hidden />
          <span className="text-base font-black text-blue-300 tabular-nums">{formatInt(totalGames)}</span>
          <span className="text-[11px] text-zinc-500">{t('analytics.deep.common.totalGames')}</span>
        </span>
        <span className="inline-flex items-baseline gap-1.5">
          <Users size={14} className="self-center text-purple-300/70" aria-hidden />
          <span className="text-base font-black text-purple-300 tabular-nums">{formatInt(totalPlayers)}</span>
          <span className="text-[11px] text-zinc-500">{t('analytics.deep.common.totalPlayers')}</span>
        </span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-1 min-w-0 lg:flex-1 xl:flex xl:flex-wrap xl:items-center xl:gap-x-2.5 xl:gap-y-1">
        <Stage
          label={t('analytics.deep.overview.stages.mission')}
          n={stages.mission.games}
          a={{ label: red, pct: stages.mission.redPct, className: 'text-red-300' }}
          b={{ label: blue, pct: stages.mission.bluePct, className: 'text-blue-300' }}
        />
        <Stage
          arrow
          label={t('analytics.deep.overview.stages.assassination')}
          scope={t('analytics.r6.overview.summary.threeBlueOnly')}
          n={stages.assassination.games}
          a={{ label: t('analytics.deep.overview.stages.killed'), pct: stages.assassination.killPct, className: 'text-amber-300' }}
          b={{ label: t('analytics.deep.overview.stages.survived'), pct: stages.assassination.survivePct, className: 'text-blue-300' }}
        />
        <Stage
          arrow
          label={t('analytics.deep.overview.stages.final')}
          n={stages.final.games}
          a={{ label: red, pct: stages.final.redPct, className: 'text-red-300' }}
          b={{ label: blue, pct: stages.final.bluePct, className: 'text-blue-300' }}
        />
      </div>
      <p className="sr-only">{rule}</p>
      {stages.derived && (
        <p className="text-[10px] text-zinc-500 text-center lg:text-left">{t('analytics.deep.overview.stages.derived')}</p>
      )}
    </section>
  );
}
