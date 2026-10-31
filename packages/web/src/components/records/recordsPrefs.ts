import { useCallback, useEffect, useState } from 'react';
import { RECORDS_PREF_KEYS, readRecordsPrefs, type RecordDisplayPrefs } from '../../utils/records';

/**
 * 牌譜紀錄的「顯示角色」「顯示名稱」（Edward 2026-10-31，預設都關）。記在 localStorage（讀寫都包 try/catch：
 * 無痕或封鎖儲存時只是不記住）；同一頁的清單與整局畫面用事件同步。
 */

const PREFS_EVENT = 'avalon:records-prefs';

/** 這次瀏覽設過的值（儲存被封鎖時靠它在頁面之間保持一致）。 */
const memory: Record<string, string> = {};

function storedPrefs(): RecordDisplayPrefs {
  return readRecordsPrefs((key) => {
    try {
      return window.localStorage.getItem(key) ?? memory[key] ?? null;
    } catch {
      return memory[key] ?? null;
    }
  });
}

export function useRecordsPrefs(): [RecordDisplayPrefs, (key: keyof RecordDisplayPrefs, on: boolean) => void] {
  const [prefs, setPrefs] = useState<RecordDisplayPrefs>(storedPrefs);
  useEffect(() => {
    const sync = (): void => setPrefs(storedPrefs());
    window.addEventListener(PREFS_EVENT, sync);
    window.addEventListener('storage', sync);
    return (): void => {
      window.removeEventListener(PREFS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const set = useCallback((key: keyof RecordDisplayPrefs, on: boolean): void => {
    memory[RECORDS_PREF_KEYS[key]] = on ? '1' : '0';
    try {
      window.localStorage.setItem(RECORDS_PREF_KEYS[key], on ? '1' : '0');
    } catch { /* 無痕／封鎖儲存：只是不記住 */ }
    setPrefs((p) => ({ ...p, [key]: on }));
    window.dispatchEvent(new Event(PREFS_EVENT));
  }, []);
  return [prefs, set];
}
