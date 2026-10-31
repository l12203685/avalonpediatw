import { useEffect, useState } from 'react';
import { recordsHash, parseRecordsHash } from '../../utils/records';

/**
 * 牌譜紀錄「打開哪一局」= 網址的 hash（#records=<貼文 id>），做法同特徵研究的 #study=（components/analytics/studyLink）：
 *  - openRecords：pushState 一筆 #records=…，瀏覽器「上一頁」就回到清單，連結可以複製分享；
 *  - closeRecords：是自己 push 的就 history.back()，從外部連結直接進來的就 replaceState 清掉 hash。
 */

export const RECORDS_EVENT = 'avalon:records-hash';

interface RecordsHistoryState {
  avalonRecords?: string;
}

function currentRecords(): string | null {
  return typeof window === 'undefined' ? null : parseRecordsHash(window.location.hash)?.id ?? null;
}

function notify(): void {
  window.dispatchEvent(new Event(RECORDS_EVENT));
}

function clearHash(): void {
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  } catch {
    window.location.hash = '';
  }
}

/** 打開一局（網址變成 #records=<id>）。 */
export function openRecords(id: string): void {
  const hash = recordsHash(id);
  if (window.location.hash === hash) return;
  try {
    const state: RecordsHistoryState = { avalonRecords: id };
    window.history.pushState(state, '', `${window.location.pathname}${window.location.search}${hash}`);
    notify();
  } catch {
    window.location.hash = hash;
  }
}

/** 回到清單。 */
export function closeRecords(): void {
  if (!currentRecords()) return;
  const state = window.history.state as RecordsHistoryState | null;
  if (state && typeof state.avalonRecords === 'string') {
    window.history.back();
    return;
  }
  clearHash();
  notify();
}

/** 離開牌譜紀錄頁籤時（SiteNav 換頁籤）清掉 #records…，免得重新整理又跳回來。 */
export function clearRecordsHash(): void {
  if (typeof window !== 'undefined' && parseRecordsHash(window.location.hash)) clearHash();
}

/** 目前打開的貼文 id；沒有打開時 null。跟著 hash、上一頁／下一頁更新。 */
export function useOpenRecords(): string | null {
  const [id, setId] = useState<string | null>(currentRecords);
  useEffect(() => {
    const sync = (): void => setId(currentRecords());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    window.addEventListener(RECORDS_EVENT, sync);
    return (): void => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
      window.removeEventListener(RECORDS_EVENT, sync);
    };
  }, []);
  return id;
}
