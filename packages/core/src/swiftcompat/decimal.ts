// Foundation `Decimal`: parsing of stored decimal text, Decimal → Double, and exact sums.
//
// Money (prices, SL/TP, P&L, commission, swap) is stored as decimal text. The Mac apps read it
// with `Decimal(string:)` and convert with `NSDecimalNumber(decimal:).doubleValue` before any
// analytics math (`Trade.profitDouble`, Dojix `Models/Trade.swift:210`, Greenwick
// `Models/Trade.swift:197`). That conversion is *not* the correctly rounded `Number(text)`:
// Foundation accumulates the integer significand in 16-bit words and then divides by 10 once
// per decimal place, rounding at every step (swift-foundation
// `Sources/FoundationEssentials/Decimal/Decimal+Math.swift`, `doubleValue`). For example
// "0.07" → 7 / 10 / 10 = 0.06999999999999999, while Number("0.07") = 0.07.
//
// The parser follows swift-foundation `Decimal.__decimal(from:…)` (`Decimal.swift`): leading
// whitespace, an optional sign, "nan", digits, ".", digits, an optional exponent, a 128-bit
// significand with banker's rounding of dropped digits, exponents limited to -128…127.

/** Which Decimal → Double conversion to use. */
export type DecimalToDoubleMode =
  /** Foundation's algorithm (default; what the Mac apps run). */
  | "foundation"
  /** Correctly rounded (`Number(text)`); kept for the parity harness to compare against. */
  | "nearest";

const UINT128_MAX = (1n << 128n) - 1n;
const MIN_EXPONENT = -128;
const MAX_EXPONENT = 127;

/** A finite Foundation Decimal: (-1)^negative × significand × 10^exponent. */
interface FiniteParts {
  negative: boolean;
  significand: bigint;
  exponent: number;
}

/** Immutable Foundation-compatible decimal value. */
export class SwiftDecimal {
  private constructor(
    /** null = NaN */
    private readonly parts: FiniteParts | null,
  ) {}

  static readonly zero = new SwiftDecimal({ negative: false, significand: 0n, exponent: 0 });
  static readonly nan = new SwiftDecimal(null);

  /** `Decimal(string:)` with the POSIX locale. Returns null where Swift returns nil. */
  static parse(text: string, options: { matchEntireString?: boolean } = {}): SwiftDecimal | null {
    return parseDecimal(text, options.matchEntireString ?? false);
  }

  /** Builds a decimal from parts, normalising it into Decimal's range like Swift arithmetic. */
  static fromParts(negative: boolean, significand: bigint, exponent: number): SwiftDecimal {
    return normalize(negative, significand, exponent);
  }

  /** @internal A value already inside Decimal's range (used by the parser and arithmetic). */
  static unchecked(negative: boolean, significand: bigint, exponent: number): SwiftDecimal {
    return new SwiftDecimal({ negative, significand, exponent });
  }

  /** An exact integer. */
  static fromInteger(value: number | bigint): SwiftDecimal {
    const big = typeof value === "bigint" ? value : BigInt(value);
    return normalize(big < 0n, big < 0n ? -big : big, 0);
  }

  get isNaN(): boolean {
    return this.parts === null;
  }

  get isZero(): boolean {
    return this.parts !== null && this.parts.significand === 0n;
  }

  /** -1, 0 or 1 (NaN gives NaN). Foundation has no negative zero. */
  sign(): number {
    if (this.parts === null) return NaN;
    if (this.parts.significand === 0n) return 0;
    return this.parts.negative ? -1 : 1;
  }

  /** The raw parts (null for NaN). */
  toParts(): Readonly<FiniteParts> | null {
    return this.parts;
  }

  negate(): SwiftDecimal {
    if (this.parts === null || this.parts.significand === 0n) return this;
    return new SwiftDecimal({ ...this.parts, negative: !this.parts.negative });
  }

  add(other: SwiftDecimal): SwiftDecimal {
    if (this.parts === null || other.parts === null) return SwiftDecimal.nan;
    const a = this.parts;
    const b = other.parts;
    const exp = Math.min(a.exponent, b.exponent);
    const av = signedScaled(a, exp);
    const bv = signedScaled(b, exp);
    const sum = av + bv;
    return normalize(sum < 0n, sum < 0n ? -sum : sum, exp);
  }

  subtract(other: SwiftDecimal): SwiftDecimal {
    return this.add(other.negate());
  }

  multiply(other: SwiftDecimal): SwiftDecimal {
    if (this.parts === null || other.parts === null) return SwiftDecimal.nan;
    const a = this.parts;
    const b = other.parts;
    return normalize(a.negative !== b.negative, a.significand * b.significand, a.exponent + b.exponent);
  }

  /** -1 / 0 / 1, or NaN when either side is NaN (unordered). */
  compare(other: SwiftDecimal): number {
    if (this.parts === null || other.parts === null) return NaN;
    const exp = Math.min(this.parts.exponent, other.parts.exponent);
    const a = signedScaled(this.parts, exp);
    const b = signedScaled(other.parts, exp);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** `NSDecimalNumber(decimal:).doubleValue` (mode "foundation") or the nearest double. */
  toDouble(mode: DecimalToDoubleMode = "foundation"): number {
    const p = this.parts;
    if (p === null) return NaN;
    if (p.significand === 0n) return 0;
    if (mode === "nearest") return Number(this.toString());
    // Accumulate the significand 16 bits at a time, most significant word first (8 words max).
    const words: number[] = [];
    let s = p.significand;
    while (s > 0n) {
      words.push(Number(s & 0xffffn));
      s >>= 16n;
    }
    let d = 0;
    for (let idx = Math.min(words.length, 8) - 1; idx >= 0; idx--) {
      d = d * 65536 + (words[idx] as number);
    }
    if (p.exponent < 0) {
      for (let i = p.exponent; i < 0; i++) d /= 10;
    } else {
      for (let i = 0; i < p.exponent; i++) d *= 10;
    }
    return p.negative ? -d : d;
  }

  /**
   * Canonical decimal text: "." separator, no exponent, no trailing fractional zeros, "0" for
   * zero, "NaN" for NaN. (The desktop's own storage form, SPEC §3.1.)
   */
  toString(): string {
    const p = this.parts;
    if (p === null) return "NaN";
    if (p.significand === 0n) return "0";
    let digits = p.significand.toString();
    let exp = p.exponent;
    while (exp < 0 && digits.endsWith("0")) {
      digits = digits.slice(0, -1);
      exp += 1;
    }
    let body: string;
    if (exp >= 0) body = digits + "0".repeat(exp);
    else {
      const point = digits.length + exp;
      body = point > 0 ? `${digits.slice(0, point)}.${digits.slice(point)}` : `0.${"0".repeat(-point)}${digits}`;
    }
    return p.negative ? `-${body}` : body;
  }
}

function signedScaled(p: FiniteParts, exp: number): bigint {
  const v = p.significand * 10n ** BigInt(p.exponent - exp);
  return p.negative ? -v : v;
}

/** Plain (half away from zero) rounding into Decimal's 128-bit significand and exponent range. */
function normalize(negative: boolean, significand: bigint, exponent: number): SwiftDecimal {
  let s = significand;
  let e = exponent;
  const dropOne = () => {
    const q = s / 10n;
    const r = s % 10n;
    s = r >= 5n ? q + 1n : q;
    e += 1;
  };
  while (s > UINT128_MAX) dropOne();
  while (e < MIN_EXPONENT && s !== 0n) dropOne();
  if (s === 0n) return SwiftDecimal.zero;
  while (e > MAX_EXPONENT) {
    if (s * 10n > UINT128_MAX) return SwiftDecimal.nan; // overflow
    s *= 10n;
    e -= 1;
  }
  return SwiftDecimal.unchecked(negative, s, e);
}

const isWs = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

/**
 * swift-foundation `Decimal.__decimal(from:decimalSeparator:matchEntireString:)` for the
 * POSIX locale (separator "."), including its quirks: "e5" alone is zero; "0e1000" is
 * rejected; underflow below 10^-128 (after rounding to zero) is rejected.
 */
function parseDecimal(text: string, matchEntireString: boolean): SwiftDecimal | null {
  const n = text.length;
  if (n === 0) return null;
  const code = (i: number) => text.charCodeAt(i);
  let index = 0;
  while (index < n && isWs(code(index))) index++;

  let isNegative = false;
  if (index < n && (text[index] === "+" || text[index] === "-")) {
    isNegative = text[index] === "-";
    index++;
  }

  if (text.slice(index, index + 3).toLowerCase() === "nan") {
    index += 3;
    if (matchEntireString) {
      while (index < n && isWs(code(index))) index++;
      if (index !== n) return null;
    }
    return SwiftDecimal.nan;
  }

  let significand = 0n;
  let low = 0n;
  let full = false;
  let halfFull = false;
  let guardDigit = 0;
  let roundBit: boolean | null = null;
  let sticky = false;
  let exponent = 0;

  const consume = (digit: number, fraction: boolean) => {
    if (full) {
      if (roundBit === null) {
        roundBit = digit >= 5;
        sticky = digit !== 0 && digit !== 5;
      } else if (digit !== 0) {
        sticky = true;
      }
      if (!fraction) exponent += 1;
      return;
    }
    if (!halfFull) {
      if (low === 0n && digit === 0) {
        if (fraction) exponent -= 1;
        return;
      }
      if (low < 1_000_000_000_000_000_000n) {
        low = low * 10n + BigInt(digit);
        if (fraction) exponent -= 1;
        return;
      }
      significand = low;
      halfFull = true;
    }
    const sum = significand * 10n + BigInt(digit);
    if (sum > UINT128_MAX) {
      full = true;
      guardDigit = digit;
      if (!fraction) exponent += 1;
      return;
    }
    significand = sum;
    if (fraction) exponent -= 1;
  };

  while (index < n && isDigit(code(index))) {
    consume(code(index) - 0x30, false);
    index++;
  }
  if (index < n && text[index] === ".") {
    index++;
    while (index < n && isDigit(code(index))) {
      consume(code(index) - 0x30, true);
      index++;
    }
  }
  if (!halfFull) significand = low;

  if (index < n && (text[index] === "e" || text[index] === "E")) {
    index++;
    let eNeg = false;
    let overlarge = false;
    let e = 0;
    if (index < n && (text[index] === "-" || text[index] === "+")) {
      eNeg = text[index] === "-";
      index++;
    }
    let combined = exponent;
    while (index < n && isDigit(code(index))) {
      if (!overlarge) {
        e = e * 10 + (code(index) - 0x30);
        combined = eNeg ? exponent - e : exponent + e;
        if (eNeg ? combined < -32768 : combined > 32767) overlarge = true;
      }
      index++;
    }
    exponent = overlarge ? (eNeg ? -32768 : 32767) : combined;
  }

  if (matchEntireString) {
    while (index < n && isWs(code(index))) index++;
    if (index !== n) return null;
  }
  if (index === 0) return null;
  if (significand === 0n) {
    return exponent >= -128 && exponent <= 127 ? SwiftDecimal.zero : null;
  }
  const rb = roundBit as boolean | null;
  const tailNumerator = (guardDigit << 2) | (rb === true ? 2 : 0) | (sticky ? 1 : 0);
  return assemble(isNegative, significand, tailNumerator, 40, exponent);
}

/** `Decimal._assemble` for a significand that already fits in 128 bits (banker's rounding). */
function assemble(
  isNegative: boolean,
  significand: bigint,
  tailNum: number,
  tailDen: number,
  exponentIn: number,
): SwiftDecimal | null {
  let low = significand;
  let exponent = exponentIn;
  let num = BigInt(tailNum);
  let den = BigInt(tailDen);
  let underflowed = false;

  if (exponent < MIN_EXPONENT) {
    const k = MIN_EXPONENT - exponent;
    let guard = 0n;
    let roundBit = false;
    let sticky = num !== 0n;
    if (k > 39) {
      if (low !== 0n) sticky = true;
      low = 0n;
    } else if (k === 1) {
      const complement = den - num;
      sticky = num !== 0n && num !== complement;
      roundBit = num >= complement;
      guard = low % 10n;
      low = low / 10n;
    } else {
      const p = 10n ** BigInt(k - 1);
      const q = low / p;
      const r = low % p;
      const half = p >> 1n;
      if (r !== 0n && r !== half) sticky = true;
      roundBit = r >= half;
      guard = q % 10n;
      low = q / 10n;
    }
    exponent = MIN_EXPONENT;
    underflowed = true;
    num = (guard << 2n) | (roundBit ? 2n : 0n) | (sticky ? 1n : 0n);
    den = 40n;
  }

  if (num !== 0n) {
    const cmp = num === den - num ? 0 : num > den - num ? 1 : -1;
    const odd = (low & 1n) === 1n;
    if (cmp > 0 || (cmp === 0 && odd)) {
      if (low === UINT128_MAX) {
        low = 34028236692093846346337460743176821146n;
        exponent += 1;
      } else {
        low += 1n;
      }
    }
  }

  if (low === 0n) return underflowed ? null : SwiftDecimal.zero;
  while (exponent > MAX_EXPONENT) {
    if (low * 10n > UINT128_MAX) return null; // overflow
    low *= 10n;
    exponent -= 1;
  }
  return SwiftDecimal.unchecked(isNegative, low, exponent);
}

/**
 * Decimal text → Double the way the Mac apps do it (`Decimal(string:)` then
 * `NSDecimalNumber(decimal:).doubleValue`). Unparseable text gives NaN; callers that read
 * validated storage never see it.
 */
export function decimalToDouble(text: string, mode: DecimalToDoubleMode = "foundation"): number {
  const d = SwiftDecimal.parse(text);
  return d === null ? NaN : d.toDouble(mode);
}

/** Sign of stored decimal text: -1, 0, 1, or NaN when it is not a number. */
export function decimalSign(text: string): number {
  const d = SwiftDecimal.parse(text);
  return d === null ? NaN : d.sign();
}

/** Exact Decimal sum in order (DailyBrief sums in Decimal on the Mac, SPEC App. A). */
export function decimalSum(texts: Iterable<string | SwiftDecimal>): SwiftDecimal {
  let total = SwiftDecimal.zero;
  for (const t of texts) {
    const d = typeof t === "string" ? SwiftDecimal.parse(t) : t;
    total = total.add(d ?? SwiftDecimal.nan);
  }
  return total;
}
