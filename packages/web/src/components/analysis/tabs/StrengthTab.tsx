import { useEffect, useState } from 'react';
import { AlertCircle, Loader } from 'lucide-react';
import type { StrengthGrouping } from '@avalon/shared/stats';
import StrengthTrend from '../strength/StrengthTrend';
import StrengthOutcome from '../strength/StrengthOutcome';
import StrengthTiers from '../strength/StrengthTiers';
import StrengthCompare, { buildGrouping, type GroupingKind } from '../strength/StrengthCompare';
import { useStrengthReport } from '../strength/useStrengthReport';
import DiscoveryList from '../discovery/DiscoveryList';
import { useDiscoveryNav } from '../discovery/discoveryNav';
import { SectionTabs, useSectionTab } from '../ui';

type StrengthView = 'trend' | 'outcome' | 'tiers' | 'compare' | 'discovery';

const ITEMS: { id: StrengthView; label: string }[] = [
  { id: 'trend', label: '走勢' },
  { id: 'outcome', label: '強度與結果' },
  { id: 'tiers', label: '分層結果' },
  { id: 'compare', label: '組成比較' },
  { id: 'discovery', label: '自動發現' },
];

/**
 * 陣容強度（Edward 2026-10-31）：走勢（河流圖）、強度與結果（結果 vs S 曲線＋收縮後的半年 × S 熱度圖）、分層結果、
 * 組成比較、自動發現（全部分析分頁的發現清單）。全部跟著上方的篩選，在瀏覽器的統計 Worker 裡算。
 * 其他分頁的自動發現「看全部」「在組成比較打開」經 discoveryNav 切到這裡的小分頁。
 */
export default function StrengthTab(): JSX.Element {
  const [kind, setKind] = useState<GroupingKind>('tier');
  const [pr, setPr] = useState(70);
  const [count, setCount] = useState(6);
  const [weak, setWeak] = useState(30);
  const [dim, setDim] = useState('s');
  const [custom, setCustom] = useState<StrengthGrouping | null>(null);
  const [active, setView] = useSectionTab<StrengthView>(ITEMS, { defaultValue: 'trend', persistKey: 'analysis.strength' });
  const view: StrengthView = active ?? 'trend';
  const nav = useDiscoveryNav();
  // 剛掛載時若有還沒處理的跳轉（這一頁就是因為它才打開的），也要處理
  const [seenNonce, setSeenNonce] = useState(() => (nav.view ? -1 : nav.nonce));
  if (nav.nonce !== seenNonce) {
    // 別的分頁按了「看全部」或「在組成比較打開」（render 時處理，同 AnalysisSection 的 focus）
    setSeenNonce(nav.nonce);
    if (nav.grouping) {
      setCustom(nav.grouping);
      setKind(nav.grouping.kind);
      if (nav.grouping.kind === 'tertile') setDim(nav.grouping.dim);
    }
  }
  useEffect(() => {
    if (!nav.view) return;
    setView(nav.view);
    nav.consumeView();
  }, [nav.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const grouping = custom ?? buildGrouping(kind, pr, count, weak, dim);
  const state = useStrengthReport(grouping);
  const clearCustom = <T,>(f: (v: T) => void) => (v: T): void => { setCustom(null); f(v); };
  const body = (v: StrengthView): JSX.Element => {
    if (v === 'discovery') return <DiscoveryList />;
    if (state.status === 'loading') {
      return <div className="flex items-center justify-center gap-3 py-12 text-gray-400"><Loader size={20} className="animate-spin" />載入陣容強度…</div>;
    }
    if (state.status === 'error') {
      return (
        <div className="flex items-center justify-center gap-3 py-12 text-red-400">
          <AlertCircle size={20} />陣容強度暫時算不出來（每局資料集還沒載入或版本不符），請稍後重新整理。
        </div>
      );
    }
    const { report } = state;
    if (v === 'outcome') return <StrengthOutcome report={report} />;
    if (v === 'tiers') return <StrengthTiers report={report} />;
    if (v === 'compare') {
      return (
        <StrengthCompare
          report={report}
          kind={kind} setKind={clearCustom(setKind)}
          pr={pr} setPr={clearCustom(setPr)}
          count={count} setCount={clearCustom(setCount)}
          weak={weak} setWeak={clearCustom(setWeak)}
          dim={dim} setDim={clearCustom(setDim)}
        />
      );
    }
    return <StrengthTrend report={report} />;
  };
  return (
    <SectionTabs items={ITEMS} value={view} onChange={setView} ariaLabel="陣容強度">
      {body}
    </SectionTabs>
  );
}
