import { useEffect, useState } from 'react';
import { parseWikiHash, wikiHash } from '../utils/wikiHash';

/**
 * 百科「打開哪一篇」= 網址的 hash（#wiki=<文章 id>），做法同牌譜紀錄的 #records=（records/recordsLink.ts）：
 *  - openWikiArticle：從清單／心智圖打開時 pushState 一筆 #wiki=…，瀏覽器「上一頁」就回到百科，連結可以複製分享；
 *    文章裡點「延伸閱讀」換到另一篇時只換掉網址（replaceState），關閉時一樣回到打開前的百科；
 *  - closeWikiArticle：是自己 push 的就 history.back()，從外部連結（Threads 的分享頁）直接進來的就 replaceState 清掉 hash。
 */

const EVENT = 'avalon:wiki-hash';

interface WikiHistoryState {
  avalonWiki?: string;
}

function current(): string | null {
  return typeof window === 'undefined' ? null : parseWikiHash(window.location.hash)?.id ?? null;
}

function notify(): void {
  window.dispatchEvent(new Event(EVENT));
}

function replaceHash(hash: string, state: unknown = null): void {
  try {
    window.history.replaceState(state, '', `${window.location.pathname}${window.location.search}${hash}`);
  } catch {
    window.location.hash = hash;
  }
}

/** 打開一篇文章（網址變成 #wiki=<id>）。 */
export function openWikiArticle(id: string): void {
  const hash = wikiHash(id);
  if (window.location.hash === hash) return;
  if (current()) {
    // 已經開著一篇：換文章只換網址，保留這筆歷史紀錄原本的 state（關閉時照樣回到打開前）
    replaceHash(hash, window.history.state);
    notify();
    return;
  }
  try {
    const state: WikiHistoryState = { avalonWiki: id };
    window.history.pushState(state, '', `${window.location.pathname}${window.location.search}${hash}`);
    notify();
  } catch {
    window.location.hash = hash;
  }
}

/** 關閉文章，回到百科。 */
export function closeWikiArticle(): void {
  if (!current()) return;
  const state = window.history.state as WikiHistoryState | null;
  if (state && typeof state.avalonWiki === 'string') {
    window.history.back();
    return;
  }
  replaceHash('');
  notify();
}

/** 離開百科頁籤（SiteNav 換頁籤）或連結的文章不存在時，清掉 #wiki…，免得重新整理又跳回來。 */
export function clearWikiHash(): void {
  if (typeof window === 'undefined' || !parseWikiHash(window.location.hash)) return;
  replaceHash('');
  notify();
}

/** 目前打開的文章 id；沒有打開時 null。跟著 hash、上一頁／下一頁更新。 */
export function useOpenWikiId(): string | null {
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
