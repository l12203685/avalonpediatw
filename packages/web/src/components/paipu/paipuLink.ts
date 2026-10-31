import { useEffect, useState } from 'react';
import { paipuHash, parsePaipuHash } from '../../utils/paipu';

/**
 * 牌譜紀錄「打開哪一局」= 網址的 hash（#paipu=<貼文 id>），做法同特徵研究的 #study=（components/analytics/studyLink）：
 *  - openPaipu：pushState 一筆 #paipu=…，瀏覽器「上一頁」就回到清單，連結可以複製分享；
 *  - closePaipu：是自己 push 的就 history.back()，從外部連結直接進來的就 replaceState 清掉 hash。
 */

export const PAIPU_EVENT = 'avalon:paipu-hash';

interface PaipuHistoryState {
  avalonPaipu?: string;
}

function currentPaipu(): string | null {
  return typeof window === 'undefined' ? null : parsePaipuHash(window.location.hash)?.id ?? null;
}

function notify(): void {
  window.dispatchEvent(new Event(PAIPU_EVENT));
}

function clearHash(): void {
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  } catch {
    window.location.hash = '';
  }
}

/** 打開一局（網址變成 #paipu=<id>）。 */
export function openPaipu(id: string): void {
  const hash = paipuHash(id);
  if (window.location.hash === hash) return;
  try {
    const state: PaipuHistoryState = { avalonPaipu: id };
    window.history.pushState(state, '', `${window.location.pathname}${window.location.search}${hash}`);
    notify();
  } catch {
    window.location.hash = hash;
  }
}

/** 回到清單。 */
export function closePaipu(): void {
  if (!currentPaipu()) return;
  const state = window.history.state as PaipuHistoryState | null;
  if (state && typeof state.avalonPaipu === 'string') {
    window.history.back();
    return;
  }
  clearHash();
  notify();
}

/** 離開牌譜紀錄頁籤時清掉 #paipu…，免得重新整理又跳回來。 */
export function clearPaipuHash(): void {
  if (typeof window !== 'undefined' && parsePaipuHash(window.location.hash)) clearHash();
}

/** 目前打開的貼文 id；沒有打開時 null。跟著 hash、上一頁／下一頁更新。 */
export function useOpenPaipu(): string | null {
  const [id, setId] = useState<string | null>(currentPaipu);
  useEffect(() => {
    const sync = (): void => setId(currentPaipu());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    window.addEventListener(PAIPU_EVENT, sync);
    return (): void => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
      window.removeEventListener(PAIPU_EVENT, sync);
    };
  }, []);
  return id;
}
