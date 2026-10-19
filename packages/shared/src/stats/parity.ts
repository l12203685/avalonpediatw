/**
 * 引擎輸出與 Python 快取的逐欄比對（r9 設計 §4.6）：數字用數值比（Python 的 1080.0 = JS 的 1080，
 * 不允許任何容差）、null 相同、物件比鍵集合（不比順序；座位鍵 "0".."9" 在 JS 物件一定排在前面）、陣列依序、
 * 字串完全相同。回報的路徑不含名字：playerDetails 的鍵換成 #索引（CI 日誌是公開的）。
 */

export interface ParityReport {
  /** 不同的葉子數（可能超過 paths 的長度）。 */
  differences: number;
  paths: string[];
}

const NAME_KEYED = new Set(['playerDetails', 'aliases']);

function walk(a: unknown, b: unknown, path: string, out: ParityReport, limit: number, parentKey: string): void {
  const note = (p: string): void => {
    out.differences += 1;
    if (out.paths.length < limit) out.paths.push(p);
  };
  if (typeof a === 'number' && typeof b === 'number') {
    if (!(Number(a) === Number(b) || (Number.isNaN(a) && Number.isNaN(b)))) note(path);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) note(path);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      note(path);
      return;
    }
    if (a.length !== b.length) {
      note(`${path} (length ${a.length} vs ${b.length})`);
      return;
    }
    a.forEach((x, i) => walk(x, b[i], `${path}[${i}]`, out, limit, ''));
    return;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort();
  const masked = NAME_KEYED.has(parentKey);
  keys.forEach((k, i) => {
    const label = masked ? `#${i}` : k;
    const p = path ? `${path}.${label}` : label;
    const inA = Object.prototype.hasOwnProperty.call(ao, k);
    const inB = Object.prototype.hasOwnProperty.call(bo, k);
    if (!inA || !inB) note(`${p} (only in ${inA ? 'expected' : 'actual'})`);
    else walk(ao[k], bo[k], p, out, limit, k);
  });
}

/** expected（Python）與 actual（引擎）的差異；完全相同時 differences = 0。 */
export function diffSections(expected: unknown, actual: unknown, path = '', limit = 50): ParityReport {
  const out: ParityReport = { differences: 0, paths: [] };
  const parent = path.split('.').pop() ?? '';
  walk(expected, actual, path, out, limit, parent);
  return out;
}
