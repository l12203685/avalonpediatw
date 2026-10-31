import { useMemo, useState } from 'react';
import { AlertCircle, Loader } from 'lucide-react';
import { useStatsFilter } from '../../../stats/statsFilter';
import { useMediaQuery } from '../overview/useMediaQuery';
import { SectionTabs } from '../ui';
import NodeDetail, { pct } from '../stateTree/NodeDetail';
import StateTreeChart from '../stateTree/StateTreeChart';
import StateTreeList from '../stateTree/StateTreeList';
import StateTreeSummary from '../stateTree/StateTreeSummary';
import { allExpandable, ancestry, findNode } from '../stateTree/layout';
import {
  buildStateTree, defaultExpanded, divergingColor, foldSmall, mergeNodeClauses, metricRate, stateTreeFindings,
  type ColorMetric, type LakeMode, type StateNode,
} from '../stateTree/stateTree';
import { useStateTreeGames } from '../stateTree/useStateTreeGames';
import { branchOfNode } from '../stateTree/recordBranch';
import { RECORDS_FILTER_KEY, parseRecordsFilter } from '../../../utils/records';
import { useGameStore } from '../../../store/gameStore';

const MODES: { id: LakeMode; label: string }[] = [
  { id: 'claim', label: '湖的宣告' },
  { id: 'truth', label: '宣告 × 真假' },
  { id: 'holder', label: '持湖陣營 × 宣告' },
  { id: 'none', label: '只看任務' },
];

const MIN_N_OPTIONS = [5, 10, 20, 30];

/** 預設展開到第幾個任務：有湖時看到第 2 局後的湖，只看任務時看到第 3 局。 */
function defaultRound(mode: LakeMode): number {
  return mode === 'none' ? 3 : 2;
}

function Legend({ metric, mid }: { metric: ColorMetric; mid: number | null }): JSX.Element {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const m = mid ?? 0.5;
    const rate = t < 0.5 ? m * (t * 2) : m + (1 - m) * ((t - 0.5) * 2);
    return divergingColor(rate, mid, metric);
  });
  const name = metric === 'blueWin' ? '藍方最終勝率' : '三紅率';
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-400">
      <span>{name}</span>
      <span>0%</span>
      <span className="h-2.5 w-28 rounded-sm" style={{ background: `linear-gradient(to right, ${stops.join(',')})` }} aria-hidden />
      <span>100%</span>
      <span className="text-zinc-500">（灰＝全體 {pct(mid)}）</span>
      <span className="ml-2 inline-block h-2.5 w-4 rounded-sm border border-dashed border-zinc-500" aria-hidden />
      <span className="text-zinc-500">其他＝不到門檻的分支合計</span>
    </div>
  );
}

/**
 * 局勢樹（Edward 2026-10-31：「或許你可以做個類似局勢走勢樹狀分支分類圖，再結合湖中女神的宣告，用這個角度去分析看看」）。
 * 第 1→5 局一層一層分支（藍／紅），第 2、3、4 局後（還沒分出勝負）插一層湖的宣告；每個節點有局數、佔比、三種結果，
 * 點一下看細節（藍方勝率、刺中率、下一局的派隊、最常見的下一步），可以把這條分支套用成上方的篩選。
 * 資料跟著上方的篩選，在統計 Worker 裡整理（stateTree/stateTree.ts）。桌機橫向樹、手機縮排清單。
 */
export default function StateTreeTab(): JSX.Element {
  const state = useStateTreeGames();
  const desktop = useMediaQuery('(min-width: 1024px)');
  const filter = useStatsFilter((s) => s.filter);
  const setFilter = useStatsFilter((s) => s.setFilter);
  const setGameState = useGameStore((s) => s.setGameState);
  const [mode, setMode] = useState<LakeMode>('claim');
  const [metric, setMetric] = useState<ColorMetric>('blueWin');
  const [minN, setMinN] = useState(10);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [expandedFor, setExpandedFor] = useState<{ key: string; ids: Set<string> } | null>(null);

  const games = state.status === 'ok' ? state.result.games : null;
  const root = useMemo(() => (games ? foldSmall(buildStateTree(games, mode), minN) : null), [games, mode, minN]);
  const findings = useMemo(() => (games ? stateTreeFindings(games) : null), [games]);
  const treeKey = `${mode}|${minN}`;
  const expanded = useMemo(() => {
    if (!root) return new Set<string>();
    return expandedFor?.key === treeKey ? expandedFor.ids : defaultExpanded(root, defaultRound(mode));
  }, [root, expandedFor, treeKey, mode]);

  if (state.status === 'loading') {
    return <div className="flex items-center justify-center gap-3 py-12 text-gray-400"><Loader size={20} className="animate-spin" />整理局勢樹…</div>;
  }
  if (state.status === 'error' || !root || !findings) {
    return (
      <div className="flex items-center justify-center gap-3 py-12 text-red-400">
        <AlertCircle size={20} />局勢樹暫時算不出來（每局資料集還沒載入或版本不符），請稍後重新整理。
      </div>
    );
  }

  const setExpanded = (ids: Set<string>): void => setExpandedFor({ key: treeKey, ids });
  const toggle = (id: string): void => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };
  const mid = metricRate(root.outcomes, metric);
  const apply = (node: StateNode): void => {
    const clauses = mergeNodeClauses(filter?.clauses ?? [], node);
    if (!clauses) return;
    setFilter({ v: 1, clauses, ...(filter?.options ? { options: filter.options } : {}) });
  };
  // 牌譜紀錄的篩選記在瀏覽器（RecordsPage 打開時讀）：保留原本的條件、換上這條分支，再切到牌譜紀錄頁籤
  const openRecords = (node: StateNode): void => {
    const branch = branchOfNode(node);
    if (!branch) return;
    try {
      const current = parseRecordsFilter(window.localStorage.getItem(RECORDS_FILTER_KEY));
      window.localStorage.setItem(RECORDS_FILTER_KEY, JSON.stringify({ ...current, branch }));
      window.localStorage.setItem('avalon.site.tab', 'records'); // 同 SiteNav 記住的頁籤
    } catch {
      return; // 無痕／封鎖儲存：帶不過去
    }
    setGameState('records');
    window.scrollTo({ top: 0 });
  };
  const recordsFor = (node: StateNode): boolean => branchOfNode(node) !== null;
  const shownId = (desktop ? hoverId : null) ?? selectedId;
  const shown = findNode(root, shownId) ?? root;
  const chain = ancestry(root, shown.id);
  const excluded = state.status === 'ok' ? state.result.excluded : 0;

  return (
    <div className="space-y-3">
      <StateTreeSummary f={findings} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SectionTabs items={MODES} value={mode} onChange={(m) => { setMode(m); setSelectedId(null); }} size="sm" ariaLabel="湖的分支方式" />
        <label className="flex items-center gap-1.5 text-xs text-zinc-400">
          顏色
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as ColorMetric)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-200"
          >
            <option value="blueWin">藍方最終勝率</option>
            <option value="threeRed">三紅率</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-400">
          少於
          <select
            value={minN}
            onChange={(e) => { setMinN(Number(e.target.value)); setSelectedId(null); }}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-200"
          >
            {MIN_N_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          局併成其他
        </label>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => setExpanded(allExpandable(root))} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">全部展開</button>
          <button type="button" onClick={() => setExpanded(defaultExpanded(root, defaultRound(mode)))} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">收合</button>
        </div>
      </div>
      <Legend metric={metric} mid={mid} />
      <p className="text-[11px] leading-snug text-zinc-500">
        每一層是一局任務（藍＝成功、紅＝失敗；第 4 局要兩張失敗），第 2、3、4 局後是那一次湖中女神的宣告（說好／說壞；藍方持湖照慣例說真話，紅方可能說謊）。
        邊越粗局數越多；節點下的細條是三紅／三藍被刀／三藍躲刺。{desktop ? '滑過或點節點看細節，點 +／− 展開收合。' : '點一列展開並看細節。'}
        {excluded > 0 && ` 另有 ${excluded} 局任務沒打完、不是 10 人標準隊伍人數或結果與任務對不上，沒有列入。`}
      </p>

      {desktop ? (
        <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-4">
          <div className="rounded-xl border border-zinc-700/60 bg-avalon-card/30 p-3">
            <StateTreeChart
              root={root}
              expanded={expanded}
              onToggle={toggle}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onHover={setHoverId}
              metric={metric}
              mid={mid}
            />
          </div>
          <aside className="self-start rounded-xl border border-zinc-700/60 bg-zinc-900/60 p-3 lg:sticky lg:top-4">
            <NodeDetail
              node={shown} chain={chain} rootN={root.n} baseline={root.outcomes} onApply={apply}
              onRecords={recordsFor(shown) ? openRecords : null}
            />
          </aside>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-700/60 bg-avalon-card/30 p-2">
          <StateTreeList
            root={root}
            expanded={expanded}
            onToggle={toggle}
            selectedId={selectedId}
            onSelect={setSelectedId}
            metric={metric}
            mid={mid}
            baseline={root.outcomes}
            onApply={apply}
            onRecords={openRecords}
          />
        </div>
      )}
    </div>
  );
}
