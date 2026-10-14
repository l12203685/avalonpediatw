import { useEffect, useState } from 'react';
import { parseStudyHash, studyHash } from '../../utils/statsLinks';

/**
 * 特徵研究「查看完整研究」的開關 (2026-10-14 Edward：「查看完整研究」大多點不開)。
 *
 * 狀態就是網址的 hash：#study=l141 = 打開 L141 的完整研究，沒有 = 關閉。
 *  - openStudy：pushState 一筆 #study=…，瀏覽器「上一頁」就是關閉；同時發一個事件讓
 *    useOpenStudy 立刻更新 (pushState 不會觸發 hashchange)。
 *  - closeStudy：是自己 push 的就 history.back()，從外部連結直接進來的就 replaceState 清掉 hash
 *    (不留一筆會重新打開研究的歷史紀錄)。
 *  - App 的 #stats / #player= 解析也認得 #study= (utils/statsLinks)：從外部連結進來會先切到
 *    數據分析，但不清 hash，交給這裡。
 */

const STUDY_EVENT = 'avalon:study-hash';

interface StudyHistoryState {
  avalonStudy?: string;
}

function currentStudy(): string | null {
  return parseStudyHash(window.location.hash);
}

function notify(): void {
  window.dispatchEvent(new Event(STUDY_EVENT));
}

/** 打開某項研究的完整研究 (網址變成 #study=l141)。 */
export function openStudy(loopId: string): void {
  const hash = studyHash(loopId);
  if (window.location.hash.toLowerCase() === hash) return;
  try {
    const state: StudyHistoryState = { avalonStudy: loopId };
    window.history.pushState(state, '', `${window.location.pathname}${window.location.search}${hash}`);
    notify();
  } catch {
    window.location.hash = hash;
  }
}

/** 關閉完整研究。 */
export function closeStudy(): void {
  if (!currentStudy()) return;
  const state = window.history.state as StudyHistoryState | null;
  if (state && typeof state.avalonStudy === 'string') {
    window.history.back();
    return;
  }
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  } catch {
    window.location.hash = '';
  }
  notify();
}

/** 目前打開的研究 id ('L141')；沒有打開時 null。跟著 hash、上一頁／下一頁更新。 */
export function useOpenStudy(): string | null {
  const [loopId, setLoopId] = useState<string | null>(currentStudy);
  useEffect(() => {
    const sync = (): void => setLoopId(currentStudy());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    window.addEventListener(STUDY_EVENT, sync);
    return (): void => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
      window.removeEventListener(STUDY_EVENT, sync);
    };
  }, []);
  return loopId;
}

/** 研究卡片所在的「分析」子分頁 (從 #study= 連結進來時先切到這頁，關掉研究後就在卡片旁邊)。 */
export const STUDY_HOME_TAB: Readonly<Record<string, string>> = {
  L136: 'votes',
  L139: 'teams',
  L141: 'lake',
  L142: 'lake',
  L143: 'assassination',
};

/** 網址目前指向的研究 (給頁面初始分頁用)。 */
export function studyInLocation(): string | null {
  return typeof window === 'undefined' ? null : currentStudy();
}
