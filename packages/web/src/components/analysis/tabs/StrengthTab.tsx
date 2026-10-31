import { useState } from 'react';
import { AlertCircle, Loader } from 'lucide-react';
import StrengthTrend from '../strength/StrengthTrend';
import StrengthHeatmap from '../strength/StrengthHeatmap';
import StrengthTiers from '../strength/StrengthTiers';
import StrengthCompare, { buildGrouping, type GroupingKind } from '../strength/StrengthCompare';
import { useStrengthReport } from '../strength/useStrengthReport';
import { SectionTabs } from '../ui';

type StrengthView = 'trend' | 'heatmap' | 'tiers' | 'compare';

/**
 * 陣容強度（Edward 2026-10-31：「我要你做到網站內呀，加到數據分析裡面。理論上你應該可以再針對不同組成、不同強度去分析
 * 遊戲過程跟內容吧」）。四個小分頁：走勢（時間散點）、季 × S 熱度圖、S 分層表、不同組成的過程比較。全部跟著上方的篩選，
 * 在瀏覽器的統計 Worker 裡算（@avalon/shared computeStrengthReport）。
 */
export default function StrengthTab(): JSX.Element {
  const [kind, setKind] = useState<GroupingKind>('tier');
  const [pr, setPr] = useState(70);
  const [count, setCount] = useState(6);
  const [weak, setWeak] = useState(30);
  const state = useStrengthReport(buildGrouping(kind, pr, count, weak));
  const items: { id: StrengthView; label: string }[] = [
    { id: 'trend', label: '走勢' },
    { id: 'heatmap', label: '季 × 強度' },
    { id: 'tiers', label: '分層結果' },
    { id: 'compare', label: '組成比較' },
  ];
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
  return (
    <SectionTabs items={items} persistKey="analysis.strength" ariaLabel="陣容強度">
      {(view) => {
        if (view === 'heatmap') return <StrengthHeatmap report={report} />;
        if (view === 'tiers') return <StrengthTiers report={report} />;
        if (view === 'compare') {
          return (
            <StrengthCompare
              report={report} kind={kind} setKind={setKind} pr={pr} setPr={setPr} count={count} setCount={setCount} weak={weak} setWeak={setWeak}
            />
          );
        }
        return <StrengthTrend report={report} />;
      }}
    </SectionTabs>
  );
}
