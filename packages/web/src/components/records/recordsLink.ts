import { useEffect, useState } from 'react';
import { recordsHash, parseRecordsHash, type RecordCut } from '../../utils/records';

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

/** 「只到出題的那一刻」的連結（#records=<id>&upto=…）按「看完整牌譜」：同一筆歷史紀錄換成整局的網址。 */
export function showFullRecord(id: string): void {
  try {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${recordsHash(id)}`);
  } catch {
    window.location.hash = recordsHash(id);
    return;
  }
  notify();
}

/**
 * 網址用的是同一局的另一個局號（#records=S1629，那一局在清單上是 DC 貼文那一篇）：同一筆歷史紀錄換成那一篇的局號，
 * 「只到出題的那一刻」（&upto=…&seat=…）照留，分享出去的是正式局號。
 */
export function replaceRecordsId(id: string, cut: RecordCut | null): void {
  const hash = recordsHash(id, cut);
  if (window.location.hash === hash) return;
  try {
    const state = window.history.state as RecordsHistoryState | null;
    const next = state && typeof state.avalonRecords === 'string' ? { ...state, avalonRecords: id } : state;
    window.history.replaceState(next, '', `${window.location.pathname}${window.location.search}${hash}`);
  } catch {
    return; // 換不了就留原網址：一樣打得開
  }
  notify();
}

/** 目前網址的「只到出題的那一刻」（沒有就 null）。跟著 hash 更新。 */
export function useRecordsCut(): RecordCut | null {
  const read = (): string => (typeof window === 'undefined' ? '' : JSON.stringify(parseRecordsHash(window.location.hash)?.cut ?? null));
  const [raw, setRaw] = useState<string>(read);
  useEffect(() => {
    const sync = (): void => setRaw(read());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    window.addEventListener(RECORDS_EVENT, sync);
    return (): void => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
      window.removeEventListener(RECORDS_EVENT, sync);
    };
  }, []);
  return JSON.parse(raw) as RecordCut | null;
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
