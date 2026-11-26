/**
 * AI騎士的名字（網站這一側；站長 2026-11-26：「以後整個系統裡面的百科AI 都改名成 AI騎士_{風格}_{##} / 如果風格沒指定
 * 就是「百科」 就是目前訓練出來的」）。舊名字（百科AI、百科AI_3、百科AI看房1460）還在舊紀錄、DC 貼文、排行榜檔裡：
 * 存下來的不改，網站顯示時換成新名字。規則同 @avalon/shared knights.ts 的 knightDisplayName（伺服器那一側），
 * 兩邊都對 packages/server/src/__tests__/fixtures/knight_names.json 測。
 */

const LEGACY_NAME_RE = /^百科ai(?:_(\d+))?$/i;
const LEGACY_WATCH_RE = /^百科ai看房(\d*)$/i;

/** 顯示用：`百科AI` → `AI騎士_百科`、`百科AI_3` → `AI騎士_百科_03`、`百科AI看房1460` → `AI騎士看房1460`；其他照原樣。 */
export function knightDisplayName(name: string): string {
  const t = name.normalize('NFKC').replace(/[\u200b-\u200f\u2060-\u2064\ufeff]/g, '').trim();
  const legacy = LEGACY_NAME_RE.exec(t);
  if (legacy) {
    if (legacy[1] === undefined) return 'AI騎士_百科';
    const n = Number(legacy[1]);
    return `AI騎士_百科_${n < 10 ? `0${n}` : n}`;
  }
  const watch = LEGACY_WATCH_RE.exec(t);
  if (watch) return `AI騎士看房${watch[1]}`;
  return name;
}
