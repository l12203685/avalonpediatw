/**
 * 模擬瓦 /公布 要看哪一位 AI騎士（站長 2026-11-27：「模擬局好像還不能選自建的AI騎士？」）。
 * `/公布 藿藿`、`/公布 ED`、`/公布 AI騎士_ED`（舊名字 `AI騎士_ED_01` 也認得）→ 名冊 id；大小寫、全半形不論。
 * 名冊是伺服器內建的那一份（arena/knights.ts，練習台、房間同一份）。
 */
import { DEFAULT_KNIGHT_ID, knightBaseName, listKnights } from '../../arena/knights';

const PREFIX_RE = /^ai騎士[_＿\s]*/i;

function fold(word: string): string {
  return knightBaseName(word.normalize('NFKC').replace(/[\u200b-\u200f\u2060-\u2064\ufeff]/g, '').trim()).replace(PREFIX_RE, '').toLowerCase();
}

/** 打的名字 → 名冊 id；空的 → 預設（百科）；不認得 → null。 */
export function resolveSimKnight(word: string | null | undefined): string | null {
  const w = fold(word ?? '');
  if (w === '' || w === 'ai騎士') return DEFAULT_KNIGHT_ID;
  const hit = listKnights().find((k) => fold(k.baseName) === w || k.id === w);
  return hit ? hit.id : null;
}
