import { useEffect, useState } from 'react';
import { aiGamesHash, parseAiGamesHash } from '../../utils/aiGames';

/**
 * 百科AI 對局「打開哪一局」= 網址的 hash（#ai-games=<DC 討論串 id>），做法同牌譜紀錄的 #records=（records/recordsLink.ts）：
 *  - openAiGame：pushState 一筆 #ai-games=…，瀏覽器「上一頁」回到清單，連結可以複製分享（DC 討論串裡也貼這個網址）；
 *  - closeAiGame：是自己 push 的就 history.back()，從外部連結直接進來的就 replaceState 換成 #ai-games。
 */

const EVENT = 'avalon:ai-games-hash';

interface AiGamesHistoryState { avalonAiGame?: string }

function current(): string | null {
  return typeof window === 'undefined' ? null : parseAiGamesHash(window.location.hash)?.id ?? null;
}

function replaceHash(hash: string): void {
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  } catch {
    window.location.hash = hash;
  }
}

export function openAiGame(id: string): void {
  const hash = aiGamesHash(id);
  if (window.location.hash === hash) return;
  try {
    const state: AiGamesHistoryState = { avalonAiGame: id };
    window.history.pushState(state, '', `${window.location.pathname}${window.location.search}${hash}`);
    window.dispatchEvent(new Event(EVENT));
  } catch {
    window.location.hash = hash;
  }
}

export function closeAiGame(): void {
  if (!current()) return;
  const state = window.history.state as AiGamesHistoryState | null;
  if (state && typeof state.avalonAiGame === 'string') {
    window.history.back();
    return;
  }
  replaceHash(aiGamesHash());
  window.dispatchEvent(new Event(EVENT));
}

/** 離開這頁時（導覽列換頁）清掉 #ai-games…，免得重新整理又跳回來。 */
export function clearAiGamesHash(): void {
  if (typeof window !== 'undefined' && parseAiGamesHash(window.location.hash)) replaceHash('');
}

/** 目前打開的那一局；沒有打開時 null。跟著 hash、上一頁／下一頁更新。 */
export function useOpenAiGame(): string | null {
  const [id, setId] = useState<string | null>(current);
  useEffect(() => {
    const sync = (): void => setId(current());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    window.addEventListener(EVENT, sync);
    return (): void => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
      window.removeEventListener(EVENT, sync);
    };
  }, []);
  return id;
}
