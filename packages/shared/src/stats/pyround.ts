/**
 * 與 Python 完全相同的捨入、加總、排序（Edward 2026-10-14 複合篩選：不篩選時引擎必須與
 * generate_cache.py 寫的快取逐欄相同，差 0.1 也不行）。
 *
 *   rnd1          round(n * 10) / 10 —— Python 的 round 是「四捨六入五成雙」，Math.round 是五入
 *   rate          generate_cache._rate：count / total * 100（先除再乘，運算順序也照抄）
 *   sumLtr        由左而右逐項相加（Python 3.11 的 sum()；產生器改用 _sum_ltr，3.12+ 也一樣）
 *   cmpCodePoint  依 Unicode 碼位比較字串（Python str 比較）；JS 的 < 比的是 UTF-16 單元
 *   compareKeys   Python tuple 比較（sorted(key=...) 的鍵）
 *   pySlice       Python 的 list[start:end]（負索引）
 *   pyFormatFixed f"{x:.Nf}"：double 的精確值在第 N 位五成雙（toFixed 遇到剛好一半時往大的方向）
 */

/** Python round(x)（float → int，剛好一半時取偶數）。x - floor(x) 在 |x| < 2^52 時是精確的。 */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff === 0.5) return f % 2 === 0 ? f : f + 1;
  return diff < 0.5 ? f : f + 1;
}

/** generate_cache.rnd1：round(n * 10) / 10。 */
export function rnd1(n: number): number {
  return roundHalfEven(n * 10) / 10;
}

/** generate_cache._rate：total 為 0 時是 0.0。 */
export function rate(count: number, total: number): number {
  return total ? rnd1((count / total) * 100) : 0;
}

/** 由左而右的浮點加總（generate_cache._sum_ltr）。 */
export function sumLtr(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** Python str 的比較：依碼位，不依 UTF-16 單元（名字含擴充區字或 emoji 時兩者不同）。 */
export function cmpCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(j) as number;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

export type SortKey = ReadonlyArray<number | string | boolean>;

/** Python tuple 比較：逐項，數字比數值、字串比碼位、布林 false < true。 */
export function compareKeys(a: SortKey, b: SortKey): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === 'string' && typeof y === 'string') {
      const c = cmpCodePoint(x, y);
      if (c !== 0) return c;
      continue;
    }
    const xn = Number(x);
    const yn = Number(y);
    if (xn < yn) return -1;
    if (xn > yn) return 1;
  }
  return a.length - b.length;
}

/** 穩定排序（Array.prototype.sort 自 ES2019 起穩定），鍵照 Python sorted(key=...)。回傳新陣列。 */
export function sortByKey<T>(items: readonly T[], key: (item: T) => SortKey): T[] {
  const keyed = items.map((item, index) => ({ item, index, k: key(item) }));
  keyed.sort((p, q) => compareKeys(p.k, q.k) || p.index - q.index);
  return keyed.map((e) => e.item);
}

/** min(items, key=...)：同鍵取第一個（Python 的 min 也是）。 */
export function minByKey<T>(items: readonly T[], key: (item: T) => SortKey): T | undefined {
  let best: T | undefined;
  let bestKey: SortKey | undefined;
  for (const item of items) {
    const k = key(item);
    if (bestKey === undefined || compareKeys(k, bestKey) < 0) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

/** Python 的 seq[start:end]（負索引從尾端算；超出範圍截斷）。 */
export function pySlice<T>(seq: readonly T[], start?: number, end?: number): T[] {
  const n = seq.length;
  const norm = (i: number | undefined, dflt: number): number => {
    if (i === undefined) return dflt;
    if (i < 0) return Math.max(n + i, 0);
    return Math.min(i, n);
  };
  const s = norm(start, 0);
  const e = norm(end, n);
  return e > s ? seq.slice(s, e) : [];
}

/** double 的精確值 = num / den（den 為 2 的冪）。 */
function exactRatio(x: number): { num: bigint; den: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const exp = (hi >>> 20) & 0x7ff;
  const mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (exp === 0) return { num: sign * mant, den: 1n << 1074n };
  const m = mant | (1n << 52n);
  const e = exp - 1075;
  return e >= 0 ? { num: sign * (m << BigInt(e)), den: 1n } : { num: sign * m, den: 1n << BigInt(-e) };
}

/** Python 的 f"{x:.{digits}f}"（有限值）：精確值在第 digits 位五成雙。 */
export function pyFormatFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return String(x);
  const { num, den } = exactRatio(x);
  const negative = num < 0n || Object.is(x, -0);
  const scale = 10n ** BigInt(digits);
  const abs = (num < 0n ? -num : num) * scale;
  let q = abs / den;
  const r2 = (abs - q * den) * 2n;
  if (r2 > den || (r2 === den && q % 2n === 1n)) q += 1n;
  let text = q.toString();
  if (digits > 0) {
    text = text.padStart(digits + 1, '0');
    text = `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  }
  return negative ? `-${text}` : text;
}
