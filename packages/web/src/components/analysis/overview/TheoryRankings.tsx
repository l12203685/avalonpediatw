import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useGameStore } from '../../../store/gameStore';
import { fmtPct, theorySettings, type AnalysisOverview, type AnalysisTheorySettings } from '../../../services/api';
import { InfoTip, StatTable, Term, type StatColumn, type StatTermKey } from '../ui';

/**
 * 三種理論勝率排行並排 (2026-10-14 Edward：「角色理論勝率旁邊再呈現位置理論勝率（也是要 100 場）&
 * 整體理論勝率（可以看生涯，要求 250 場以上）」)。
 *
 *  - 角色理論 overview.topPlayersByRoleTheory：schemaVersion 4 = 各角色自己的最近場次 (特殊角色各近 10 場、
 *    忠臣近 40 場，每個角色都打滿才上榜)；schemaVersion 3 = 各人最近 100 場 (生涯 100 場以上)。
 *  - 位置理論 overview.topPlayersByPositionTheory：各人最近 100 場 (生涯 100 場以上)。
 *  - 整體理論 overview.topPlayersByOverallTheory：生涯全部場次的角色理論 (生涯 250 場以上)。
 *  視窗、門檻、補值場數一律讀 theorySettings(overview.theoryConfig)，不寫死。都不限近期出賽 (近期的在「排行」)。
 *  原本的長條圖改成數字表 (名次、名字、勝率 + n)：十個人差距只有幾個百分點，數字比長條清楚。
 *  桌機 (≥ lg) 三個表並排 (TheoryRankings)；手機／平板由 OverviewPanel 的小分頁一次放一個 (TheoryRankingPanel)。
 *  點一列 → 該玩家的玩家雷達。
 *  schemaVersion 3 的快取沒有後兩個欄位 → 那兩格併成一格「下次每日更新後提供」(附定義與期間)，角色理論照列今天的榜
 *  並註明下次更新後改成各角色視窗。
 *  名次：同分同名次 (例 1、2、3、3、5)。
 *  (2026-10-30 Edward：說明太冗長) 表名旁的期間小字、表下的定義段落、區塊副標收進 ⓘ (InfoTip)；表名本身是名詞說明 (Term)。
 */

export type TheoryKind = 'role' | 'position' | 'overall';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

interface RankRow {
  rank: number;
  name: string;
  value: number;
  n: number | null;
  tip: string;
}

export interface Ranking {
  kind: TheoryKind;
  label: string;
  /** 視窗與上榜門檻 (表格標題旁的小字)。 */
  window: string;
  definition: string;
  /** null = 快取沒有這個欄位 (下次每日更新後提供)；[] = 有欄位但沒人符合。 */
  rows: RankRow[] | null;
  /** 全體基準 (每格都打出全體平均的人)；低於基準的數字標紅。 */
  baseline: number | null;
}

/** 10 人局發牌：忠臣 4/10，其他角色各 1/10 (generate_cache.py ROLE_DEAL_TENTHS)。 */
const ROLE_DEAL_PROBABILITY: Record<string, number> = {
  刺客: 0.1, 莫甘娜: 0.1, 莫德雷德: 0.1, 奧伯倫: 0.1, 派西維爾: 0.1, 梅林: 0.1, 忠臣: 0.4,
};

const SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 角色理論的全體基準 = Σ 抽到該角色的機率 × 全體該角色最終勝率；缺角色時 null。 */
function roleBaseline(rates: Record<string, number> | undefined): number | null {
  if (!rates) return null;
  let sum = 0;
  for (const [role, p] of Object.entries(ROLE_DEAL_PROBABILITY)) {
    if (!isNum(rates[role])) return null;
    sum += p * rates[role];
  }
  return Math.round(sum * 10) / 10;
}

/** 位置理論的全體基準 = Σ 1/10 × 全體該位置最終勝率 (seatFinalWinRates，鍵 "1".."10")；缺位置時 null。 */
function seatBaseline(rates: Record<string, number> | undefined): number | null {
  if (!rates) return null;
  let sum = 0;
  for (const seat of SEATS) {
    if (!isNum(rates[seat])) return null;
    sum += rates[seat] / SEATS.length;
  }
  return Math.round(sum * 10) / 10;
}

/** 快取的排行列 → 表格列 (最多 10 名，同分同名次)；欄位不存在回 null。 */
function toRows<T extends { name: string }>(
  list: readonly T[] | undefined,
  value: (r: T) => unknown,
  n: (r: T) => unknown,
  tip: (r: T) => string,
): RankRow[] | null {
  if (!Array.isArray(list)) return null;
  const clean = list.filter(r => r && typeof r.name === 'string' && isNum(value(r))).slice(0, 10);
  const rows: RankRow[] = [];
  clean.forEach((r, i) => {
    const v = value(r) as number;
    const prev = rows[i - 1];
    const size = n(r);
    rows.push({
      rank: prev && prev.value === v ? prev.rank : i + 1,
      name: r.name,
      value: v,
      n: isNum(size) ? size : null,
      tip: tip(r),
    });
  });
  return rows;
}

/** 特殊角色的視窗 (都一樣時一個數字，不一樣時 a–b)。 */
function specialWindow(settings: AnalysisTheorySettings): string {
  const sizes = Object.entries(settings.roleWindowGames).filter(([role]) => role !== '忠臣').map(([, g]) => g);
  if (sizes.length === 0) return '—';
  const lo = Math.min(...sizes);
  const hi = Math.max(...sizes);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

/** schemaVersion 4 起 theoryConfig 有 roleWindowGames：角色理論改看各角色自己的最近場次。 */
function usesRoleWindows(overview: AnalysisOverview): boolean {
  const cfg = overview.theoryConfig;
  return !!cfg && typeof cfg.roleWindowGames === 'object' && cfg.roleWindowGames !== null;
}

function buildRankings(t: TFn, overview: AnalysisOverview, settings: AnalysisTheorySettings): Ranking[] {
  const k = 'analytics.r6.overview.theory';
  const perRoleWindows = usesRoleWindows(overview);
  const loyal = settings.roleWindowGames['忠臣'];
  const roleBase = roleBaseline(overview.roleFinalWinRates);
  const seatBase = seatBaseline(overview.seatFinalWinRates);
  const career = (count: unknown): string | null =>
    isNum(count) ? t('analytics.deep.overview.careerGames', { count }) : null;
  const join = (...parts: Array<string | null>): string =>
    [...parts.filter((p): p is string => !!p), t(`${k}.tipOpen`)].join(' · ');
  const lastPos = (v: unknown, games: number): string | null =>
    isNum(v) ? t(`${k}.tipPositionLast`, { games, value: fmtPct(v) }) : null;
  const lastFinal = (v: unknown, games: number): string | null =>
    isNum(v) ? t(`${k}.tipFinalLast`, { games, value: fmtPct(v) }) : null;

  return [
    {
      kind: 'role',
      label: t(`${k}.role`),
      window: perRoleWindows
        ? t(`${k}.windowRole`, { special: specialWindow(settings), loyal })
        : t(`${k}.windowLast`, { games: settings.mainGames }),
      definition: perRoleWindows ? t(`${k}.defRole`) : t(`${k}.defRoleLegacy`),
      baseline: roleBase,
      rows: toRows(
        overview.topPlayersByRoleTheory,
        r => r.roleTheory,
        r => r.games,
        r => join(
          lastPos(r.positionTheory, settings.mainGames),
          isNum(r.overallTheory) ? t(`${k}.tipOverall`, { value: fmtPct(r.overallTheory) }) : null,
          lastFinal(r.finalWinRate, settings.mainGames),
          career(r.careerGames),
        ),
      ),
    },
    {
      kind: 'position',
      label: t(`${k}.position`),
      window: t(`${k}.windowLast`, { games: settings.positionGames }),
      definition: t(`${k}.defPosition`),
      baseline: seatBase,
      rows: toRows(
        overview.topPlayersByPositionTheory,
        r => r.positionTheory,
        r => r.games,
        r => join(lastFinal(r.finalWinRate, settings.positionGames), career(r.careerGames)),
      ),
    },
    {
      kind: 'overall',
      label: t(`${k}.overall`),
      window: t(`${k}.windowCareer`, { min: settings.overallMinGames }),
      definition: t(`${k}.defOverall`),
      baseline: roleBase,
      rows: toRows(
        overview.topPlayersByOverallTheory,
        r => r.overallTheory,
        r => r.games,
        r => join(
          isNum(r.positionTheory) ? t(`${k}.tipPositionCareer`, { value: fmtPct(r.positionTheory) }) : null,
          isNum(r.finalWinRate) ? t(`${k}.tipFinalCareer`, { value: fmtPct(r.finalWinRate) }) : null,
          career(r.careerGames),
        ),
      ),
    },
  ];
}

const KIND_TERM: Record<TheoryKind, StatTermKey> = { role: 'roleTheory', position: 'positionTheory', overall: 'overallTheory' };

/** 表格標題：排行名稱 (名詞說明) + ⓘ (期間與門檻、定義、補值；手機另加區塊說明 scope)。 */
function TheoryCaption({ ranking, topUp, scope }: { ranking: Ranking; topUp: string | null; scope?: string }): JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-x-1 text-sm font-bold">
      <Term term={KIND_TERM[ranking.kind]} className="text-zinc-200">{ranking.label}</Term>
      <InfoTip title={ranking.label}>
        <p>{ranking.window}</p>
        <p>{ranking.definition}{topUp && <> {topUp}</>}</p>
        {scope && <p>{scope}</p>}
      </InfoTip>
    </span>
  );
}

/**
 * 一個排行的數字表。hideCaption：標題只留給螢幕閱讀器 (桌機把三個標題放在同一列格線裡，
 * 標題換行時三個表頭仍對齊)。
 */
function TheoryTable({ ranking, lowSample, topUp, scope, hideCaption = false }: {
  ranking: Ranking;
  lowSample: number;
  topUp: string | null;
  scope?: string;
  hideCaption?: boolean;
}): JSX.Element {
  const { t } = useTranslation('common');
  const openPlayerStats = useGameStore(s => s.openPlayerStats);
  const { baseline } = ranking;
  const columns: StatColumn<RankRow>[] = [
    {
      key: 'name',
      label: t('analytics.boards.col.name'),
      format: (_v, row) => (
        <>
          <span className={`mr-1.5 inline-block w-4 text-right font-normal tabular-nums ${row.rank === 1 ? 'text-amber-300' : 'text-zinc-500'}`}>
            {row.rank}
          </span>
          {row.name}
        </>
      ),
    },
    {
      key: 'value',
      label: t('analytics.r6.overview.theory.value'),
      title: t('analytics.r6.overview.theory.nHint'),
      format: 'pct',
      n: 'n',
      lowSample: lowSample > 0 ? lowSample : undefined,
      emphasis: true,
      tone: row => (baseline !== null && row.value < baseline ? 'red' : undefined),
    },
  ];
  return (
    <StatTable
      caption={hideCaption ? <span className="sr-only">{ranking.label} {ranking.window}</span> : <TheoryCaption ranking={ranking} topUp={topUp} scope={scope} />}
      columns={columns}
      rows={ranking.rows ?? []}
      rowKey={row => row.name}
      rowTitle={row => row.tip}
      onRowClick={row => openPlayerStats(row.name)}
      empty={ranking.rows === null ? t('analytics.r6.overview.theory.pending') : t('analytics.r6.overview.theory.empty')}
    />
  );
}

export interface TheoryRankingsInfo {
  rankings: Ranking[];
  /** 補值門檻 (theoryMinCellGames)，也是表格「樣本不足」變淡的門檻。 */
  lowSample: number;
  /** 「不限近期出賽…」＋ 全體基準。 */
  scope: string;
  /** 「不到 N 場的角色／位置補到 N 場」；不補值時 null。 */
  topUp: string | null;
  /** 舊快取 (schemaVersion 3)：角色理論下次每日更新後改看各角色近 10 場、忠臣近 40 場；新快取為 null。 */
  roleUpgrade: string | null;
}

/** 三個排行與說明文字 (桌機並排、手機小分頁共用)。 */
export function useTheoryRankings(overview: AnalysisOverview): TheoryRankingsInfo {
  const { t } = useTranslation('common');
  const k = 'analytics.r6.overview.theory';
  const settings = theorySettings(overview.theoryConfig);
  const rankings = buildRankings(t, overview, settings);
  const [role, position] = rankings;
  const lowSample = settings.theoryMinCellGames;
  const baselineParts = [
    role.baseline !== null ? t(`${k}.baselineRole`, { value: role.baseline.toFixed(1) }) : null,
    position.baseline !== null ? t(`${k}.baselineSeat`, { value: position.baseline.toFixed(1) }) : null,
  ].filter((p): p is string => !!p);
  const scope = baselineParts.length > 0
    ? `${t(`${k}.scope`)}${t(`${k}.sentenceSep`)}${t(`${k}.baseline`, { parts: baselineParts.join(t(`${k}.listSep`)) })}`
    : t(`${k}.scope`);
  return {
    rankings,
    lowSample,
    scope,
    topUp: lowSample > 0 ? t(`${k}.topUp`, { n: lowSample }) : null,
    // 視窗數字讀 theorySettings (舊快取沒有 roleWindowGames → 產生器預設 10 / 40)。
    roleUpgrade: usesRoleWindows(overview)
      ? null
      : t(`${k}.roleUpgrade`, { special: specialWindow(settings), loyal: settings.roleWindowGames['忠臣'] }),
  };
}

const CARD = 'h-full min-w-0 rounded-xl border border-gray-700 bg-avalon-card/30 p-3';
const SPAN = ['', 'col-span-1', 'col-span-2', 'col-span-3'];

/**
 * 快取還沒有的排行 (schemaVersion 3 的位置理論、整體理論) 併成一格：寫明下次每日更新後提供，
 * 順便放它們的定義與期間，表格的空位不浪費。
 */
function PendingPanel({ missing, roleUpgrade }: { missing: Ranking[]; roleUpgrade: string | null }): JSX.Element {
  const { t } = useTranslation('common');
  const k = 'analytics.r6.overview.theory';
  return (
    <div className={`${SPAN[missing.length] ?? 'col-span-3'} row-span-2 min-w-0 rounded-xl border border-dashed border-zinc-700 bg-zinc-950/60 p-3`}>
      <p className="text-xs font-semibold text-zinc-300">
        {t(`${k}.pendingTitle`, { names: missing.map(r => r.label).join(t(`${k}.listSep`)) })}
      </p>
      <ul className="mt-1.5 space-y-1 text-[11px] leading-snug text-zinc-400">
        {missing.map(r => (
          <li key={r.kind}>
            <span className="font-semibold text-zinc-300">{r.label}</span>
            <span className="ml-1.5 text-[10px] text-zinc-500">{r.window}</span>
            <br />
            {r.definition}
          </li>
        ))}
      </ul>
      {roleUpgrade && <p className="mt-2 text-[11px] leading-snug text-amber-300/80">{roleUpgrade}</p>}
    </div>
  );
}

/** 桌機：三個表並排，定義在各表名旁的 ⓘ；快取還沒有的排行併成一格說明。 */
export default function TheoryRankings({ overview }: { overview: AnalysisOverview }): JSX.Element {
  const { t } = useTranslation('common');
  const titleId = useId();
  const info = useTheoryRankings(overview);
  const present = info.rankings.filter(r => r.rows !== null);
  const missing = info.rankings.filter(r => r.rows === null);
  return (
    <section aria-labelledby={titleId} className={CARD}>
      <div className="mb-2 flex flex-wrap items-center gap-x-1">
        <h3 id={titleId} className="text-sm font-bold text-zinc-300">{t('analytics.r6.overview.theory.title')}</h3>
        <InfoTip title={t('analytics.r6.overview.theory.title')}>
          <p>{info.scope}</p>
          {present.map(r => (
            <p key={r.kind}>
              <span className="font-semibold text-zinc-100">{r.label}</span>
              <span className="ml-1.5 text-zinc-500">{r.window}</span>
              <br />
              {r.definition}
            </p>
          ))}
          {info.topUp && <p>{info.topUp}</p>}
        </InfoTip>
      </div>
      {/* 第一列三個標題、第二列三個表 (格線列高取最高的標題，表頭一定對齊)；缺的排行併成一格跨兩列 */}
      <div className="grid grid-cols-3 gap-x-3">
        {present.map(r => (
          <div key={`caption-${r.kind}`} className="min-w-0">
            <TheoryCaption ranking={r} topUp={info.topUp} />
          </div>
        ))}
        {missing.length > 0 && <PendingPanel missing={missing} roleUpgrade={info.roleUpgrade} />}
        {present.map(r => <TheoryTable key={r.kind} ranking={r} lowSample={info.lowSample} topUp={info.topUp} hideCaption />)}
      </div>
      {missing.length === 0 && info.roleUpgrade && <p className="mt-1.5 text-[10px] leading-snug text-amber-300/80">{info.roleUpgrade}</p>}
    </section>
  );
}

/** 手機／平板：小分頁的一頁 = 一個排行 + 它的定義與說明。 */
export function TheoryRankingPanel({ info, kind }: { info: TheoryRankingsInfo; kind: TheoryKind }): JSX.Element {
  const ranking = info.rankings.find(r => r.kind === kind) ?? info.rankings[0];
  return (
    <section aria-label={ranking.label} className={CARD}>
      <TheoryTable ranking={ranking} lowSample={info.lowSample} topUp={info.topUp} scope={info.scope} />
      {ranking.kind === 'role' && info.roleUpgrade && <p className="mt-1.5 text-[10px] leading-snug text-amber-300/80">{info.roleUpgrade}</p>}
    </section>
  );
}
