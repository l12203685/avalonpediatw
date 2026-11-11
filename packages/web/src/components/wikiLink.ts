import { useEffect, useState } from 'react';
import { resolveWikiRedirect } from '../data/wikiRedirects';
import { parseWikiHash, wikiHash } from '../utils/wikiHash';

/**
 * 百科「打開哪一篇」= 網址的 hash（#wiki=<文章 id>，可帶 &sec=<章節>），做法同牌譜紀錄的 #records=（records/recordsLink.ts）：
 *  - openWikiArticle：從清單／心智圖打開時 pushState 一筆 #wiki=…，瀏覽器「上一頁」就回到百科，連結可以複製分享；
 *    文章裡點「延伸閱讀」換到另一篇（或同一篇的另一節）時只換掉網址（replaceState），關閉時一樣回到打開前的百科；
 *  - closeWikiArticle：是自己 push 的就 history.back()，從外部連結（Threads 的分享頁）直接進來的就 replaceState 清掉 hash。
 *  - 2026-11-11 文章合併：#wiki=<被併入的舊 id> 打開主文、捲到併入的那一節（data/wikiRedirects.ts），網址列換成主文的網址。
 */

const EVENT = 'avalon:wiki-hash';

interface WikiHistoryState {
  avalonWiki?: string;
}

export interface OpenWikiTarget {
  id: string;
  section?: string;
}

/** The article (and section) the hash asks for, old merged-away ids already resolved to their main article. */
export function currentWikiTarget(): OpenWikiTarget | null {
  if (typeof window === 'undefined') return null;
  const parsed = parseWikiHash(window.location.hash);
  if (!parsed?.id) return null;
  const moved = resolveWikiRedirect(parsed.id);
  const section = parsed.section ?? moved?.section;
  const id = moved ? moved.id : parsed.id;
  return section ? { id, section } : { id };
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

/** An old id in the address bar (#wiki=wiki-62) becomes the main article's address (#wiki=wiki-26&sec=…), same history entry. */
export function canonicalizeWikiHash(): void {
  if (typeof window === 'undefined') return;
  const parsed = parseWikiHash(window.location.hash);
  if (!parsed?.id || !resolveWikiRedirect(parsed.id)) return;
  const target = currentWikiTarget();
  if (!target) return;
  const state = window.history.state as WikiHistoryState | null;
  const keep = state && typeof state.avalonWiki === 'string' ? { ...state, avalonWiki: target.id } : state;
  replaceHash(wikiHash(target.id, target.section), keep);
}

/** 打開一篇文章（網址變成 #wiki=<id>，給了章節時 #wiki=<id>&sec=<章節>）。 */
export function openWikiArticle(id: string, section?: string): void {
  const moved = resolveWikiRedirect(id);
  const targetId = moved ? moved.id : id;
  const hash = wikiHash(targetId, section ?? moved?.section);
  if (window.location.hash === hash) {
    // same address (e.g. the same section clicked twice): still scroll there
    notify();
    return;
  }
  if (currentWikiTarget()) {
    // 已經開著一篇：換文章只換網址，保留這筆歷史紀錄原本的 state（關閉時照樣回到打開前）
    replaceHash(hash, window.history.state);
    notify();
    return;
  }
  try {
    const state: WikiHistoryState = { avalonWiki: targetId };
    window.history.pushState(state, '', `${window.location.pathname}${window.location.search}${hash}`);
    notify();
  } catch {
    window.location.hash = hash;
  }
}

/** 關閉文章，回到百科。 */
export function closeWikiArticle(): void {
  if (!currentWikiTarget()) return;
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

export interface OpenWiki extends OpenWikiTarget {
  /** Bumps on every navigation event, so clicking the same section again still scrolls there. */
  nonce: number;
}

/** 目前打開的文章與章節；沒有打開時 null。跟著 hash、上一頁／下一頁更新；舊 id 已經換成主文（網址列也換掉）。 */
export function useOpenWiki(): OpenWiki | null {
  const [state, setState] = useState<OpenWiki | null>(() => {
    const t = currentWikiTarget();
    return t ? { ...t, nonce: 0 } : null;
  });
  useEffect(() => {
    let nonce = 0;
    const sync = (): void => {
      canonicalizeWikiHash();
      const t = currentWikiTarget();
      nonce += 1;
      setState(t ? { ...t, nonce } : null);
    };
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    window.addEventListener(EVENT, sync);
    return (): void => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
      window.removeEventListener(EVENT, sync);
    };
  }, []);
  return state;
}
