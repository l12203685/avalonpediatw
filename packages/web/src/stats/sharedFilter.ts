/**
 * 篩選的分享連結 (#stats?f=1.<base64url>、#stats?preset=online)：開連結 = 套用那個篩選；在數據分析頁時，
 * 網址列的 hash 跟著篩選更新，直接複製網址就能分享 (#study=… 打開研究時不動它)。
 */
import { useEffect } from 'react';
import { loadFilterVocab } from './statsEngine';
import { filterFromParams, filterHash, useStatsFilter, type StatsHashParams } from './statsFilter';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 套用連結裡的篩選 (preset 的「近一年」依資料集的基準日展開；拿不到時用今天)。 */
export function applySharedFilter(params: StatsHashParams): void {
  const set = (asOf: string): void => {
    const { filter, warnings } = filterFromParams(params, asOf);
    useStatsFilter.getState().setFilter(filter, warnings);
  };
  if (params.filter) {
    set(today());
    return;
  }
  loadFilterVocab().then((v) => set(v.asOf), () => set(today()));
}

function writeHash(hash: string): void {
  const current = window.location.hash;
  if (current && !/^#(stats|analytics|leaderboard|rank)\b/i.test(current)) return;
  if (current === hash || (!current && hash === '#stats')) return;
  try {
    const url = `${window.location.pathname}${window.location.search}${hash === '#stats' ? '' : hash}`;
    window.history.replaceState(window.history.state, '', url);
  } catch {
    // 不能改網址 (沙箱等) 就算了：分享按鈕照樣能複製連結
  }
}

/** 數據分析頁：網址列的 hash = 目前篩選；離開頁面時拿掉。 */
export function useFilterHashSync(): void {
  const filter = useStatsFilter((s) => s.filter);
  const key = useStatsFilter((s) => s.key);
  useEffect(() => {
    writeHash(filterHash(key ? filter : null));
  }, [filter, key]);
  useEffect(() => (): void => writeHash('#stats'), []);
}

/** 分享用的完整網址。 */
export function shareUrl(): string {
  const { filter, key } = useStatsFilter.getState();
  return `${window.location.origin}${window.location.pathname}${filterHash(key ? filter : null)}`;
}
