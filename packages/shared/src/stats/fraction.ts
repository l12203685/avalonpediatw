/**
 * 精確有理數（BigInt），對應 generate_cache.py 的 fractions.Fraction：理論勝率每一格與加總都是精確分數，
 * 最後只四捨五入一次（_round_exact：分數上的五成雙）。浮點運算會在最後一位差一點，進位後偶爾差 0.1。
 */

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** 數學上的 floor(a / b)（BigInt 的 / 是向零取整）。 */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

export class Rational {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static of(num: bigint | number, den: bigint | number = 1n): Rational {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new RangeError('Rational with denominator 0');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    return g > 1n ? new Rational(n / g, d / g) : new Rational(n, d);
  }

  static readonly ZERO = Rational.of(0n);

  /**
   * Fraction(str(x))：族群率是 rnd1 的輸出（一位小數），JS 的 String(x) 與 Python 的 repr 在這個範圍都是
   * 「最短可還原」表示（45 與 45.0 同值）。也接受指數寫法。
   */
  static fromDecimalString(text: string): Rational {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
    if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new RangeError(`not a decimal number: ${text}`);
    const sign = m[1] === '-' ? -1n : 1n;
    const intPart = m[2] || '0';
    const fracPart = m[3] ?? '';
    const exp = m[4] ? Number(m[4]) : 0;
    let num = BigInt(intPart + fracPart) * sign;
    let den = 10n ** BigInt(fracPart.length);
    if (exp > 0) num *= 10n ** BigInt(exp);
    else if (exp < 0) den *= 10n ** BigInt(-exp);
    return Rational.of(num, den);
  }

  /** 將有限浮點數轉為 Python Fraction(str(x)) 的精確分數。 */
  static fromNumber(x: number): Rational {
    return Rational.fromDecimalString(String(x));
  }

  add(other: Rational): Rational {
    return Rational.of(this.num * other.den + other.num * this.den, this.den * other.den);
  }

  mul(other: Rational): Rational {
    return Rational.of(this.num * other.num, this.den * other.den);
  }

  div(other: Rational): Rational {
    return Rational.of(this.num * other.den, this.den * other.num);
  }

  /** Python round(Fraction)：最接近的整數，剛好一半時取偶數。 */
  roundHalfEven(): bigint {
    const q = floorDiv(this.num, this.den);
    const r2 = (this.num - q * this.den) * 2n;
    if (r2 > this.den) return q + 1n;
    if (r2 < this.den) return q;
    return q % 2n === 0n ? q : q + 1n;
  }

  /** generate_cache._round_exact：round(value * 10) / 10（int / 10 是正確捨入的浮點除法）。 */
  roundTenth(): number {
    return Number(this.mul(Rational.of(10n)).roundHalfEven()) / 10;
  }

  compare(other: Rational): number {
    const l = this.num * other.den;
    const r = other.num * this.den;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }
}
