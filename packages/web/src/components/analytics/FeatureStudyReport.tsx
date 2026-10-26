import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Link2, Loader, X } from 'lucide-react';
import type { FeatureStudyEntry } from '../../services/api';
import { SectionTabs } from '../analysis/ui';
import { useAnalysisOverview } from '../analysis/useAnalysisOverview';
import {
  FeatureVisual, LoadFailed, StudyErrorBoundary, studyMinSample, useFeatureStudies,
} from './FeatureStudiesPanel';
import { closeStudy, useOpenStudy } from './studyLink';
import NotFilteredNote from '../analysis/filter/NotFilteredNote';
import { isFilterableStudy } from '../../stats/filteredRoutes';

/**
 * 完整研究 (2026-10-14 Edward：「查看完整研究」大多點不開)。
 *
 * 以前卡片的「查看完整研究」連到不存在的 /docs/feature-study-*，又 preventDefault，永遠打不開。
 * 現在是站內的全螢幕對話框，網址 #study=l141 (可直接分享；上一頁 / Esc / 返回鍵 關閉)：
 *  - 頁首：研究代號、標題 (快取文字)、樣本數與日期 (L141 每天從牌譜重算；其餘四項是一次性研究，
 *    數字停在 2146 局快照，每日更新只改寫結論文字)、複製連結。
 *  - 問題 + 三個小分頁 (一頁一屏)：
 *      結論與資料  快取的結論 + 完整數字表 (FeatureVisual full：n、95% 區間、原始欄位、次要表)
 *      方法與定義  依 generate_cache.py (L141 compute_lake_claim_feature、其餘 annotate_feature_studies
 *                  與 scripts/build_feature_studies.py) 寫的計算方式；原始報告不在 repo 裡的，明講
 *                  哪些定義網站無法驗證，不自己編
 *      怎麼讀與注意  讀法、選擇偏誤、小樣本、多重比較等注意事項、來源
 *  - 文字在 analytics.r6.tabsa.study.<loopId>.*，數字一律從快取帶入 (不寫死)。
 * 由 AnalyticsPage 掛一個 <FeatureStudyReportHost />；派隊 L139、投票 L136、湖中 L141/L142、
 * 刺殺 L143 的卡片 (FeatureStudyCard → StudyLink) 都打開同一個。
 */

const SNAPSHOT_SINCE = '2026-04-27';

type ReportTab = 'data' | 'method' | 'read';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmt(v: number | null | undefined, digits = 1): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
}

function int(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toLocaleString() : '—';
}

/** t(key, { returnObjects }) 的字串陣列；缺鍵或形狀不對時空陣列。 */
function useList(): (key: string, vars: Record<string, unknown>) => string[] {
  const { t } = useTranslation('common');
  return (key, vars) => {
    const v: unknown = t(key, { ...vars, returnObjects: true });
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
  };
}

/** 研究文字裡帶入的數字 (都從快取來)。 */
function studyVars(feature: FeatureStudyEntry, currentThreeRed: number | null): Record<string, unknown> {
  const s = feature.sampleSize ?? { games: 0 };
  const data = (feature.data ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(data.rows) ? (data.rows as Array<Record<string, unknown>>) : [];
  const vars: Record<string, unknown> = {
    games: int(s.games),
    links: int(s.links),
    chances: int(s.chances),
    attempts: int(s.attempts),
    leaderEvents: int(s.leaderEvents),
    source: feature.sourceReport,
    date: feature.computedAt ?? '—',
    min: studyMinSample(feature),
  };
  switch (feature.loopId) {
    case 'L141': {
      const ex = rows.find(r => r.declaredEn === 'evil' || r.declared === '紅');
      vars.undeclared = int(num(data.undeclared));
      vars.exLake = ex ? String(ex.lake ?? '') : '—';
      vars.exLakeEn = ex ? String(ex.lakeEn ?? ex.lake ?? '') : '—';
      vars.exRate = fmt(num(ex?.hitRate));
      vars.exLo = fmt(num(ex?.ciLow));
      vars.exHi = fmt(num(ex?.ciHigh));
      vars.exN = int(num(ex?.n));
      break;
    }
    case 'L142': {
      const cells = Array.isArray(data.highEvCells) ? (data.highEvCells as Array<Record<string, unknown>>) : [];
      const c = cells.find(x => num(x.threeRedPct) !== null && num(x.deltaThreeRed) !== null);
      vars.baseline = c ? fmt((c.threeRedPct as number) - (c.deltaThreeRed as number), 2) : '—';
      vars.cellCount = cells.length;
      break;
    }
    case 'L143': {
      const tiers = Array.isArray(data.leaderTierRows) ? (data.leaderTierRows as Array<Record<string, unknown>>) : [];
      const seats = Array.isArray(data.topSeatRows) ? (data.topSeatRows as unknown[]) : [];
      vars.tierTotal = int(tiers.reduce((a, r) => a + (num(r.n) ?? 0), 0));
      vars.seatCount = seats.length;
      break;
    }
    case 'L136': {
      const summary = (data.summary ?? {}) as Record<string, unknown>;
      const games = num(s.games);
      const chances = num(s.chances);
      const perPlayerGame = games && chances ? chances / games / 10 : null;
      const delta = num(summary.delta);
      const evs = rows.map(r => num(r.signedEv)).filter((v): v is number => v !== null);
      vars.blue = fmt(num(summary.blueOverall), 2);
      vars.red = fmt(num(summary.redOverall), 2);
      vars.delta = fmt(delta, 2);
      vars.perPlayerGame = fmt(perPlayerGame);
      vars.perGameDiff = perPlayerGame !== null && delta !== null ? fmt((perPlayerGame * delta) / 100, 2) : '—';
      vars.span = evs.length ? `${fmt(Math.min(...evs), 2)} ～ +${fmt(Math.max(...evs), 2)}` : '—';
      break;
    }
    case 'L139': {
      const byRound = (r: string): Record<string, unknown> | undefined => rows.find(x => x.round === r);
      const cmp = (data.comparison ?? {}) as Record<string, Record<string, unknown> | undefined>;
      vars.baseline = fmt(num(data.baselineRedPct), 2);
      const r3delta = num(byRound('R3')?.deltaThreeRed);
      vars.r3delta = r3delta === null ? '—' : `${r3delta > 0 ? '+' : ''}${fmt(r3delta)}`;
      vars.r4n = int(num(byRound('R4')?.n));
      vars.r5n = int(num(byRound('R5')?.n));
      vars.withN = int(num(cmp.withR3Forced?.n));
      vars.withoutN = int(num(cmp.withoutR3Forced?.n));
      vars.currentThreeRed = fmt(currentThreeRed);
      break;
    }
    default:
      break;
  }
  return vars;
}

function Bullets({ items, ordered = false }: { items: string[]; ordered?: boolean }): JSX.Element | null {
  if (items.length === 0) return null;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className={`space-y-1.5 pl-5 text-xs leading-relaxed text-zinc-300 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-zinc-600`}>
      {items.map((s, i) => <li key={i}>{s}</li>)}
    </Tag>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

function CopyLinkButton(): JSX.Element {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1600);
    return (): void => window.clearTimeout(id);
  }, [copied]);
  const copy = (): void => {
    try {
      void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true), () => undefined);
    } catch {
      // 剪貼簿不可用 (非 https、權限) — 網址列本身就是連結
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] font-semibold text-zinc-300 hover:border-zinc-500 hover:text-white"
    >
      {copied ? <Check size={12} aria-hidden /> : <Link2 size={12} aria-hidden />}
      {copied ? t('analytics.r6.tabsa.study.copied') : t('analytics.r6.tabsa.study.copyLink')}
    </button>
  );
}

function StudyBody({ feature }: { feature: FeatureStudyEntry }): JSX.Element {
  const { t, i18n } = useTranslation('common');
  const list = useList();
  const { overview } = useAnalysisOverview();
  const isEn = i18n.language?.toLowerCase().startsWith('en') ?? false;
  const k = `analytics.r6.tabsa.study.${feature.loopId}`;
  // 舊快取的 L141 是另一個研究 (各角色說謊率，bar)：方法文字只描述新版 (lakeClaim)，不能套用
  const legacyL141 = feature.loopId === 'L141' && feature.visualType !== 'lakeClaim';
  const known = !legacyL141 && i18n.exists(`${k}.question`, { ns: 'common' });
  const currentThreeRed = num(overview?.outcomeBreakdown?.threeRedPct);
  const vars = studyVars(feature, currentThreeRed);
  const takeaway = isEn ? feature.takeawayEn : feature.takeaway;
  const hook = isEn ? feature.oneLineHookEn : feature.oneLineHook;

  const caveats = list(`${k}.caveats`, vars);
  if (feature.loopId === 'L139' && currentThreeRed !== null) {
    caveats.splice(1, 0, t(`${k}.baselineNow`, vars));
  }

  const items = [
    { id: 'data' as ReportTab, label: t('analytics.r6.tabsa.study.tabs.data') },
    { id: 'method' as ReportTab, label: t('analytics.r6.tabsa.study.tabs.method') },
    { id: 'read' as ReportTab, label: t('analytics.r6.tabsa.study.tabs.read') },
  ];

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <p className="text-[11px] font-bold text-zinc-500">{t('analytics.r6.tabsa.study.question')}</p>
        <p className="text-sm leading-relaxed text-zinc-100">{known ? t(`${k}.question`, vars) : hook}</p>
      </div>

      <SectionTabs
        items={items}
        defaultValue="data"
        ariaLabel={t('analytics.r6.tabsa.study.tabsLabel')}
        animate={false}
        panelClassName="space-y-3"
      >
        {(tab) => {
          if (tab === 'data') {
            return (
              <>
                <Block title={t('analytics.r6.tabsa.study.takeaway')}>
                  <p className="text-xs leading-relaxed text-zinc-200">{takeaway}</p>
                </Block>
                <Block title={t('analytics.r6.tabsa.study.fullData')}>
                  <StudyErrorBoundary
                    fallback={<p className="text-xs text-amber-300">{t('analytics.featureStudies.chartError')}</p>}
                  >
                    <FeatureVisual feature={feature} full />
                  </StudyErrorBoundary>
                </Block>
              </>
            );
          }
          if (tab === 'method') {
            return (
              <>
                <Block title={t('analytics.r6.tabsa.study.method')}>
                  {known
                    ? <Bullets ordered items={list(`${k}.method`, vars)} />
                    : <p className="text-xs text-zinc-400">{t(legacyL141 ? 'analytics.r6.tabsa.study.legacyL141' : 'analytics.r6.tabsa.study.noMethod')}</p>}
                </Block>
                <Block title={t('analytics.r6.tabsa.study.sampleTitle')}>
                  <p className="text-xs leading-relaxed text-zinc-300">
                    <SampleLine feature={feature} />
                  </p>
                </Block>
              </>
            );
          }
          return (
            <>
              <Block title={t('analytics.r6.tabsa.study.howToRead')}>
                {known
                  ? <Bullets items={list(`${k}.read`, vars)} />
                  : <p className="text-xs text-zinc-400">{t(legacyL141 ? 'analytics.r6.tabsa.study.legacyL141' : 'analytics.r6.tabsa.study.noMethod')}</p>}
              </Block>
              {known && (
                <Block title={t('analytics.r6.tabsa.study.caveats')}>
                  <Bullets items={caveats} />
                </Block>
              )}
              <p className="text-[11px] text-zinc-500 break-all">
                {t('analytics.r6.tabsa.study.source', { source: feature.sourceReport })}
              </p>
            </>
          );
        }}
      </SectionTabs>
    </div>
  );
}

/** 樣本數 + 日期 + 計算方式 (每日重算 / 一次性研究)。 */
function SampleLine({ feature }: { feature: FeatureStudyEntry }): JSX.Element {
  const { t } = useTranslation('common');
  const s = feature.sampleSize ?? { games: 0 };
  const parts: string[] = [t('analytics.featureStudies.sampleSize', { games: int(s.games) })];
  const unit = (key: 'links' | 'chances' | 'attempts' | 'leaderEvents'): void => {
    const v = num(s[key]);
    if (v !== null) parts.push(t(`analytics.r6.tabsa.study.units.${key}`, { count: v, value: int(v) }));
  };
  unit('links');
  unit('leaderEvents');
  unit('attempts');
  unit('chances');
  const live = feature.sourceReport === 'generate_cache.py' || Boolean(feature.computedAt);
  parts.push(live
    ? t('analytics.r6.tabsa.study.live', { date: feature.computedAt ?? '—' })
    : t('analytics.r6.tabsa.study.snapshot', { games: int(s.games), since: SNAPSHOT_SINCE }));
  return <>{parts.join(' · ')}</>;
}

function StudyDialog({ loopId }: { loopId: string }): JSX.Element {
  const { t, i18n } = useTranslation('common');
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const { data, loading, error, notGenerated, reload } = useFeatureStudies();
  const feature = data?.features.find(f => f.loopId === loopId);
  const isEn = i18n.language?.toLowerCase().startsWith('en') ?? false;

  // Esc 關閉、打開時鎖住背後的頁面捲動、焦點移進對話框，關閉後還給原本的元素。
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeStudy();
      }
    };
    document.addEventListener('keydown', onKey);
    return (): void => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, []);

  const title = feature ? (isEn ? feature.titleEn : feature.title) : loopId;

  let body: ReactNode;
  if (loading) {
    body = (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-400">
        <Loader size={16} className="animate-spin" /> {t('analytics.featureStudies.loading')}
      </div>
    );
  } else if (error || !data) {
    body = <LoadFailed error={error} notGenerated={notGenerated} onRetry={reload} />;
  } else if (!feature) {
    body = <p className="py-10 text-center text-sm text-zinc-400">{t('analytics.featureStudies.notFound', { loopId })}</p>;
  } else {
    body = (
      <>
        {!isFilterableStudy(feature.loopId) && <NotFilteredNote />}
        <StudyBody feature={feature} />
      </>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-stretch justify-center bg-black/80 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeStudy();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex w-full max-w-4xl flex-col border-zinc-800 bg-zinc-950 shadow-2xl focus:outline-none sm:max-h-[min(94vh,900px)] sm:rounded-2xl sm:border"
      >
        <header className="flex items-start gap-2 border-b border-zinc-800 px-3 py-2.5 sm:px-4">
          <button
            type="button"
            onClick={closeStudy}
            className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs font-semibold text-zinc-300 hover:border-white hover:text-white"
          >
            <ArrowLeft size={14} aria-hidden /> {t('analytics.r6.tabsa.study.back')}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="shrink-0 rounded border border-blue-800/50 bg-blue-900/40 px-1.5 py-0.5 font-mono text-[10px] text-blue-300">
                {loopId}
              </span>
              <h2 id={titleId} className="truncate text-base font-black text-white">
                {t('analytics.r6.tabsa.study.dialogTitle', { title })}
              </h2>
            </div>
            {feature && (
              <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">
                <SampleLine feature={feature} />
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="hidden sm:inline-flex"><CopyLinkButton /></span>
            <button
              type="button"
              onClick={closeStudy}
              aria-label={t('analytics.r6.tabsa.study.close')}
              className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/5 hover:text-white"
            >
              <X size={18} aria-hidden />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">{body}</div>
      </div>
    </div>
  );
}

/** 掛在 AnalyticsPage 一次：網址是 #study=<id> 時顯示那項研究的完整研究。 */
export default function FeatureStudyReportHost(): JSX.Element | null {
  const loopId = useOpenStudy();
  if (!loopId || typeof document === 'undefined') return null;
  return createPortal(<StudyDialog key={loopId} loopId={loopId} />, document.body);
}
