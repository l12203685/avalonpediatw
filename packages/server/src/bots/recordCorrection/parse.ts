/**
 * /更正 的解析（沒有其他 import：reports/commands 的 isCommunityCommandText 也用，避免循環相依）。見 ./commands.ts。
 */

const CORRECTION_RE = /^[/／][\s\u3000]*(?:更正|牌譜更正|牌谱更正)(?=[\s\u3000]|$)([\s\S]*)$/u;

export interface CorrectionCommand {
  /** 打的局號（原樣；'' = 沒寫）。 */
  id: string;
  /** 更正內容（頭尾去空白、保留換行；'' = 只是查詢）。 */
  content: string;
}

/** "/更正 S1794" → { id: 'S1794', content: '' }；"/更正 S1794 第一局是 158" → 內容；不是指令 → null。 */
export function parseCorrectionText(text: string): CorrectionCommand | null {
  const m = CORRECTION_RE.exec((text ?? '').trim());
  if (!m) return null;
  const body = m[1].replace(/^[\s\u3000]+/u, '');
  const first = /^(\S+)(?:[\s\u3000]+([\s\S]*))?$/u.exec(body);
  if (!first) return { id: '', content: '' };
  return { id: first[1], content: (first[2] ?? '').trim() };
}

export function isCorrectionCommandText(text: string): boolean {
  return parseCorrectionText(text) !== null;
}
