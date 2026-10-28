import { useState, useEffect, type ReactNode } from 'react';
import { Loader, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchAnalysisLake, getErrorMessage, roleFaction } from '../../services/api';
import type { LakeAnalysisData, LakeRoleStat, OutcomeBreakdown } from '../../services/api';
import { SectionTabs, Takeaway, Term, VerdictText, formatRate } from './ui';
import { outcomeChiSquare, outcomeRow, redFinalRate } from './outcomeTest';
import OutcomeBlocksTable, { type OutcomeGroup } from './OutcomeBlocksTable';
import { roleOrderIndex, useRoleLabel } from './roleLabels';
import { filterScopedLoader } from '../../stats/filterScopedLoader';

/**
 * 湖中女神分析 — Edward 2026-04-26 spec
 *
 * Tab labels: 首湖/二湖/三湖 → 首位接湖者/第二位接湖者/第三位接湖者
 *   The original labels were too cryptic for non-veteran players. The full
 *   names spell out "first / second / third lake holder" so anyone can read
 *   the chart without prior knowledge of the slang.
 *
 * Every percentage is now expanded into the three game outcomes
 *   (三紅 / 三藍死 / 三藍活) in fixed display order, matching the rank
 *   baseline. Single redWinRate numbers were collapsing too much
 *   information — knowing red wins 52% doesn't tell you the structure of
 *   the remaining 48%.
 *
 * All hard-coded English strings (`holder=target faction`, etc.) have been
 *   replaced with translated keys so the bilingual switch covers them.
 *
 * (2026-10-14 Edward：一頁一屏、表格優先、比率用條件機率並附 n)
 *   - 原本一頁往下排 持湖陣營卡 → 同／跨陣營卡 → 陣營組合 → 持湖角色 → 被湖角色 (約 5 個螢幕高)，
 *     現在拆成三個視圖 (view)，由 LakeTab 的 SectionTabs 切換；第幾次湖的選擇在三個視圖間共用。
 *   - 每個視圖一張 OutcomeBlocksTable：任務結果 (三紅率)、刺殺結果 (三藍死 ÷ 三藍局，附三藍局數)、
 *     遊戲結果 (紅方最終勝)。舊的堆疊長條把三藍死除以全部局，不是條件機率。
 *   - 陣營視圖：紅方持湖、藍方持湖、四種「持湖者 → 被湖者」陣營組合，最上面是這次湖的全部局；
 *     「同陣營／跨陣營」兩列就是組合兩兩相加，省略。
 *   - 角色視圖：七個角色都列 (舊版藏掉 < 5 場的角色)，少樣本用 theoryMinCellGames 變淡。
 *   - 資料只抓一次 (module 級快取)，切換視圖不重抓。
 * (2026-10-28 Edward：結果更直觀、名詞白話) 每個視圖最上面一句話 (數字從資料當下算)：
 *   陣營 = 紅方／藍方持湖時紅方最終勝率 + 卡方檢定；角色 = 紅方勝率最高／最低的角色 + 卡方檢定 (七個角色的三種結局比例)。
 *   「持湖者 → 被湖者」表頭可點開看定義。
 */

export type LakeView = 'faction' | 'holderRole' | 'targetRole';

const lakeLoader = filterScopedLoader(fetchAnalysisLake);

function useLakeData(): { data: LakeAnalysisData | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<LakeAnalysisData | null>(lakeLoader.peek);
  const [loading, setLoading] = useState(() => lakeLoader.peek() === null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    lakeLoader.load()
      .then(d => { if (!cancelled) setData(d); })
      .catch(err => { if (!cancelled) setError(getErrorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return (): void => { cancelled = true; };
  }, []);
  return { data, loading, error };
}

const RED = '紅方';

/** 這組的局數 (三種結果加總，跟表上的「局數」同一個數)。 */
function gamesOf(o: OutcomeBreakdown | undefined): number {
  return o ? outcomeRow(o).reduce((a, b) => a + b, 0) : 0;
}

/** 幾組 OutcomeBreakdown 相加 (例：紅方持湖 + 藍方持湖 = 這次湖的全部局)。 */
function sumOutcomes(list: Array<OutcomeBreakdown | undefined>): { threeRed: number; threeBlueDead: number; threeBlueAlive: number } {
  const sum = { threeRed: 0, threeBlueDead: 0, threeBlueAlive: 0 };
  for (const o of list) {
    if (!o) continue;
    sum.threeRed += o.threeRed ?? 0;
    sum.threeBlueDead += o.threeBlueDead ?? 0;
    sum.threeBlueAlive += o.threeBlueAlive ?? 0;
  }
  return sum;
}

function FactionText({ faction }: { faction: string }): JSX.Element {
  const { t } = useTranslation('common');
  const red = faction === RED;
  return (
    <span className={red ? 'text-red-300' : 'text-blue-300'}>
      {t(red ? 'analytics.r6.tabsa.faction.red' : 'analytics.r6.tabsa.faction.blue')}
    </span>
  );
}

export interface LakeAnalysisProps {
  view: LakeView;
  /** 第幾次湖 (0 = 首位接湖者)。 */
  lake: number;
  onLakeChange: (lake: number) => void;
}

export default function LakeAnalysis({ view, lake, onLakeChange }: LakeAnalysisProps): JSX.Element {
  const { t } = useTranslation('common');
  const roleLabel = useRoleLabel();
  const { data, loading, error } = useLakeData();
  const k = 'analytics.r6.tabsa.lake';

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
        <Loader size={20} className="animate-spin" /> {t('analytics.deep.lake.loading')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400 gap-3">
        <AlertCircle size={20} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  const tabLabels: string[] = [
    t('analytics.deep.lake.tabFirst'),
    t('analytics.deep.lake.tabSecond'),
    t('analytics.deep.lake.tabThird'),
  ];
  const perLake = data.perLake ?? [];
  const selected = perLake[lake] ? lake : 0;
  const current = perLake[selected];
  const detail = (data.allLakeRoleStats ?? [])[selected];
  const lakeLabel = tabLabels[selected];

  const picker = (
    <SectionTabs
      items={tabLabels.map((label, i) => ({
        id: String(i),
        label,
        badge: perLake[i] ? t(`${k}.gamesBadge`, { count: perLake[i].totalGames }) : undefined,
        disabled: !perLake[i],
      }))}
      value={String(selected)}
      onChange={id => onLakeChange(Number(id))}
      ariaLabel={t(`${k}.picker`)}
      className="mb-2"
    />
  );

  if (!current) {
    return <p className="py-8 text-center text-xs text-zinc-500">{t('analytics.ui.table.empty')}</p>;
  }

  const allRow: OutcomeGroup = {
    key: 'all',
    label: t(`${k}.allGames`),
    counts: sumOutcomes(current.holderStats.map(h => h.outcomes)),
    reference: true,
  };

  let table: ReactNode;
  let takeaway: ReactNode = null;
  if (view === 'faction') {
    const holderOrder = (f: string): number => (f === RED ? 0 : 1);
    const holders = [...current.holderStats].sort((a, b) => holderOrder(a.faction) - holderOrder(b.faction));
    const combos = current.comboStats
      .filter(c => c.targetFaction !== '')
      .sort((a, b) => holderOrder(a.holderFaction) - holderOrder(b.holderFaction) || holderOrder(a.targetFaction) - holderOrder(b.targetFaction));
    const rows: OutcomeGroup[] = [
      allRow,
      ...holders.map((h): OutcomeGroup => ({
        key: `h-${h.faction}`,
        label: t(h.faction === RED ? `${k}.redHolder` : `${k}.blueHolder`),
        tone: h.faction === RED ? 'red' : 'blue',
        counts: h.outcomes,
      })),
      ...combos.map((c): OutcomeGroup => ({
        key: `c-${c.holderFaction}-${c.targetFaction}`,
        label: (
          <span className="font-normal">
            <FactionText faction={c.holderFaction} />
            <span className="mx-1 text-zinc-500">→</span>
            <FactionText faction={c.targetFaction} />
          </span>
        ),
        title: t(`${k}.comboTitle`),
        counts: c.outcomes,
      })),
    ];
    const redH = holders.find(h => h.faction === RED);
    const blueH = holders.find(h => h.faction !== RED);
    if (redH && blueH) {
      takeaway = (
        <p>
          {t('analytics.r7.lake.faction', {
            lake: lakeLabel,
            red: formatRate(redFinalRate(redH.outcomes)), redN: gamesOf(redH.outcomes),
            blue: formatRate(redFinalRate(blueH.outcomes)), blueN: gamesOf(blueH.outcomes),
          })}
          <VerdictText result={outcomeChiSquare([redH.outcomes, blueH.outcomes])} />
          {t('analytics.r7.lake.end')}
        </p>
      );
    }
    table = (
      <OutcomeBlocksTable
        caption={t(`${k}.factionCaption`, { lake: lakeLabel })}
        groupLabel={<Term term="lakeCombo">{t(`${k}.group`)}</Term>}
        rows={rows}
        footnote={t(`${k}.factionNote`)}
      />
    );
  } else {
    const stats: LakeRoleStat[] = (view === 'holderRole' ? detail?.holderRoleStats : detail?.targetRoleStats) ?? [];
    const sorted = [...stats].sort((a, b) => roleOrderIndex(a.role) - roleOrderIndex(b.role));
    const rows: OutcomeGroup[] = [
      allRow,
      ...sorted.map((r): OutcomeGroup => ({
        key: r.role,
        label: roleLabel(r.role),
        tone: roleFaction(r.role) === 'red' ? 'red' : 'blue',
        counts: r.outcomes,
      })),
    ];
    const rated = sorted
      .map(r => ({ role: r.role, rate: redFinalRate(r.outcomes), n: gamesOf(r.outcomes) }))
      .filter((r): r is { role: string; rate: number; n: number } => r.rate !== null);
    if (rated.length > 1) {
      const hi = rated.reduce((a, b) => (b.rate > a.rate ? b : a));
      const lo = rated.reduce((a, b) => (b.rate < a.rate ? b : a));
      takeaway = (
        <p>
          {t(view === 'holderRole' ? 'analytics.r7.lake.holderRole' : 'analytics.r7.lake.targetRole', {
            lake: lakeLabel, hi: roleLabel(hi.role), hiRate: formatRate(hi.rate), hiN: hi.n, lo: roleLabel(lo.role), loRate: formatRate(lo.rate), loN: lo.n,
          })}
          <VerdictText result={outcomeChiSquare(sorted.map(r => r.outcomes))} />
          {t('analytics.r7.lake.end')}
        </p>
      );
    }
    table = (
      <OutcomeBlocksTable
        caption={t(view === 'holderRole' ? `${k}.holderRoleCaption` : `${k}.targetRoleCaption`, { lake: lakeLabel })}
        groupLabel={t(view === 'holderRole' ? `${k}.holderRole` : `${k}.targetRole`)}
        rows={rows}
      />
    );
  }

  return (
    <div>
      {picker}
      {takeaway && <Takeaway className="mb-2">{takeaway}</Takeaway>}
      {table}
    </div>
  );
}
