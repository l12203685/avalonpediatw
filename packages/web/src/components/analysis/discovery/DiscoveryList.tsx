import { useState } from 'react';
import { Loader, Search } from 'lucide-react';
import { UNIT_LABELS, type DiscoveryPage, type DiscoveryUnit } from '@avalon/shared/stats';
import DiscoveryCard from './DiscoveryCard';
import DiscoveryHelp from './DiscoveryHelp';
import { useDiscovery } from './useDiscovery';
import { useDiscoveryNav } from './discoveryNav';
import { EMPTY_DISCOVERY_QUERY, PAGE_LABELS, queryFindings, type DiscoveryQuery } from './discoveryText';
import { Takeaway } from '../ui';
import { useMediaQuery, WIDE_BOARD_QUERY } from '../../../hooks/useMediaQuery';

/** 一次列幾張卡：桌機 30；手機 10（2026-11-25 第四批：手機上一次 30 張卡有五千多像素高，先看最前面的）。 */
const PAGE_SIZE = 30;
const PHONE_PAGE_SIZE = 10;
const selectClass = 'rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 focus:border-blue-500 focus:outline-none';

/** 自動發現的完整清單：關鍵字、分頁、單位、要不要列結構性差異、排序。 */
export default function DiscoveryList(): JSX.Element {
  const state = useDiscovery();
  const navPage = useDiscoveryNav((s) => s.page);
  const nonce = useDiscoveryNav((s) => s.nonce);
  const [q, setQ] = useState<DiscoveryQuery>({ ...EMPTY_DISCOVERY_QUERY, page: navPage ?? 'all' });
  const wide = useMediaQuery(WIDE_BOARD_QUERY);
  const pageSize = wide ? PAGE_SIZE : PHONE_PAGE_SIZE;
  const [shown, setShown] = useState(pageSize);
  const [seenNonce, setSeenNonce] = useState(nonce);
  if (nonce !== seenNonce) {
    setSeenNonce(nonce);
    if (navPage) setQ((x) => ({ ...x, page: navPage }));
  }
  const update = (next: DiscoveryQuery): void => {
    setQ(next);
    setShown(pageSize);
  };
  if (state.status === 'loading') return <p className="flex items-center gap-2 py-8 text-sm text-zinc-400"><Loader size={16} className="animate-spin" />掃描全部維度 × 指標中（約幾秒）…</p>;
  if (state.status === 'error') return <p className="py-8 text-sm text-zinc-400">自動發現暫時算不出來，請稍後重新整理。</p>;
  const list = queryFindings(state.result.findings, q);
  return (
    <div className="space-y-2" data-testid="discovery-list">
      <Takeaway>
        <p className="text-sm font-semibold text-white sm:text-[15px]" data-testid="discovery-lead">
          電腦把每一種分法（座位、角色、年份、實力…）跟每一個數字都比過一遍，下面是差得比較多、而且不太像運氣的 {list.length} 項。
        </p>
        <p className="text-zinc-400">每張卡：上面那組跟「其他情況」比；長條越長數字越大。這些是相關，不是因果。</p>
      </Takeaway>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-300">
        <span className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={q.text}
            onChange={(e) => update({ ...q, text: e.target.value })}
            placeholder="搜尋維度或指標（例：梅林、外白）"
            className="w-56 rounded-md border border-zinc-700 bg-zinc-900 py-1 pl-7 pr-2 text-xs text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
            data-testid="discovery-search"
          />
        </span>
        <select className={selectClass} value={q.page} onChange={(e) => update({ ...q, page: e.target.value as DiscoveryPage | 'all' })} aria-label="分頁" data-testid="discovery-page">
          <option value="all">全部分頁</option>
          {(Object.keys(PAGE_LABELS) as DiscoveryPage[]).map((p) => <option key={p} value={p}>{PAGE_LABELS[p]}</option>)}
        </select>
        <select className={selectClass} value={q.unit} onChange={(e) => update({ ...q, unit: e.target.value as DiscoveryUnit | 'all' })} aria-label="單位">
          <option value="all">全部單位</option>
          {(Object.keys(UNIT_LABELS) as DiscoveryUnit[]).map((u) => <option key={u} value={u}>以{UNIT_LABELS[u]}為單位</option>)}
        </select>
        <select className={selectClass} value={q.sort} onChange={(e) => update({ ...q, sort: e.target.value as DiscoveryQuery['sort'] })} aria-label="排序">
          <option value="effect">依效果量</option>
          <option value="diff">依差距</option>
          <option value="q">依 q 值</option>
        </select>
        <label className="inline-flex items-center gap-1 text-zinc-400" title="局勢（任務順序、比分、加上湖中宣告）、第幾輪、第幾次提議、隊長座位這類遊戲結構造成的差異">
          <input type="checkbox" checked={q.structural} onChange={(e) => update({ ...q, structural: e.target.checked })} data-testid="discovery-structural" />包含局勢（任務順序）與輪次差異
        </label>
        <DiscoveryHelp tests={state.result.tests} />
        <span className="ml-auto text-[11px] text-zinc-500">{list.length} 項（{state.result.tests} 個檢定，q ≤ 0.05）</span>
      </div>
      {list.length === 0
        ? <p className="py-6 text-center text-sm text-zinc-500">沒有符合的發現</p>
        : <ul className="grid gap-2 md:grid-cols-2">{list.slice(0, shown).map((f) => <DiscoveryCard key={f.id} finding={f} />)}</ul>}
      {list.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + pageSize)} className="w-full rounded-lg border border-zinc-700 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
          顯示更多（還有 {list.length - shown} 項）
        </button>
      )}
      <p className="text-[11px] text-zinc-500">這些是相關，不是因果。跟著上方的篩選重算；樣本少的篩選會少很多發現。</p>
    </div>
  );
}
