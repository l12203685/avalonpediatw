/**
 * 百科文章的深連結（2026-11-11 Edward：之後要把百科文章一篇篇發到 Threads，連結要直接打開那篇文章）。
 *
 *   #wiki                 → 百科攻略頁籤
 *   #wiki=<文章 id>        → 百科攻略，打開那篇文章（也接受 #wiki/<id>；同 #records=：打開時留在網址列、
 *                            換文章時跟著換、關閉時清掉，見 components/wikiLink.ts）
 *
 * 分享用的網址是 /w/<id>/（build 時產生的靜態頁，帶那篇文章自己的 Open Graph 預覽，見 wikiSharePages.ts），
 * 打開後立刻轉到這裡的 #wiki=<id>。
 * 純函式放這裡，packages/server/src/__tests__/WebWikiShare.test.ts 測（web 沒有測試執行器）。
 */

/** 文章 id：wiki-24、faq-basic、strategy-merlin-data… 只收英數字、-、_，最長 64 字。 */
const WIKI_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isWikiArticleId(id: string | null | undefined): boolean {
  return WIKI_ID_RE.test(id ?? '');
}

/** #wiki → { id: null }；#wiki=<id>、#wiki/<id> → { id }；id 不像文章 id 時當成 #wiki；其他 hash → null。 */
export function parseWikiHash(hash: string | null | undefined): { id: string | null } | null {
  const raw = (hash ?? '').replace(/^#/, '').trim();
  if (/^wiki\/?$/i.test(raw)) return { id: null };
  const m = /^wiki[=/](.*)$/i.exec(raw);
  if (!m) return null;
  let id = m[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    // a lone "%" — not an article id
  }
  id = id.trim().replace(/\/+$/, '');
  return { id: isWikiArticleId(id) ? id : null };
}

/** 文章的 hash（#wiki=<id>）；沒有 id 時 #wiki。 */
export function wikiHash(id?: string | null): string {
  return id ? `#wiki=${encodeURIComponent(id)}` : '#wiki';
}

/** 分享頁的目錄（/w/<id>/），build 時產生，見 wikiSharePages.ts。 */
export const WIKI_SHARE_DIR = 'w';

/** 分享頁在 build 輸出裡的檔名：w/<id>/index.html（Firebase Hosting 與 Cloudflare Pages 都直接當成 /w/<id>/ 提供，不經過 SPA 的 index.html）。 */
export function wikiSharePath(id: string): string {
  return `${WIKI_SHARE_DIR}/${encodeURIComponent(id)}/index.html`;
}

/** 分享網址（貼到 Threads 的那個）：<site>/w/<id>/。 */
export function wikiShareUrl(siteUrl: string, id: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/${WIKI_SHARE_DIR}/${encodeURIComponent(id)}/`;
}
