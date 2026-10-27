// Swift number parsing and printing that the importers depend on, reproduced exactly.
//
// - `Double(String)` (stdlib FloatingPointParsing): rejects empty input and leading whitespace,
//   then runs C `strtod` and succeeds only when it consumed everything up to the C string's end
//   (so the text is cut at the first NUL, as `withCString` does). strtod accepts decimal and
//   hexadecimal floats, "inf"/"infinity", "nan" and "nan(...)", case-insensitively, with a sign.
//   Overflow gives ±infinity.
// - `Int(String)` / `Int64(String)`: an optional sign and ASCII digits, within 64 bits.
// - `Double.description` (`"\(x)"`): the shortest round-trip digits; decimal notation unless
//   the decimal exponent is below -3 or |x| > 2^54 (SwiftDtoa `swift_dtoa_optimal_double`).
// - `Decimal(Double)` (Foundation `Decimal.init(_: Double)`): scales by repeated ×10 / ÷10 in
//   doubles until the value is just under 2^64, truncates to UInt64, then compacts.

import { SwiftDecimal } from "@dojix-desktop/core";

/** strtod's decimal grammar, checked in one pass (a regex like `\d+\.?\d*` backtracks quadratically). */
function isDecimalFloat(s: string): boolean {
  let i = 0;
  const n = s.length;
  const digit = (k: number) => {
    const c = s.charCodeAt(k);
    return c >= 48 && c <= 57;
  };
  if (s[i] === "+" || s[i] === "-") i++;
  let mantissaDigits = 0;
  while (i < n && digit(i)) {
    i++;
    mantissaDigits++;
  }
  if (s[i] === ".") {
    i++;
    while (i < n && digit(i)) {
      i++;
      mantissaDigits++;
    }
  }
  if (mantissaDigits === 0) return false;
  if (s[i] === "e" || s[i] === "E") {
    i++;
    if (s[i] === "+" || s[i] === "-") i++;
    let expDigits = 0;
    while (i < n && digit(i)) {
      i++;
      expDigits++;
    }
    if (expDigits === 0) return false;
  }
  return i === n;
}
const HEX_FLOAT = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/;
const INFINITY_TEXT = /^([+-]?)(?:inf|infinity)$/i;
const NAN_TEXT = /^[+-]?nan(?:\([0-9A-Za-z_]*\))?$/i;

/** Swift `Double(text)`: null where Swift returns nil. */
export function swiftDouble(text: string): number | null {
  const nul = text.indexOf("\0");
  const s = nul >= 0 ? text.slice(0, nul) : text;
  if (s.length === 0) return null;
  const first = s.charCodeAt(0);
  if (first === 32 || (first >= 9 && first <= 13)) return null;
  if (isDecimalFloat(s)) return Number(s);
  const inf = INFINITY_TEXT.exec(s);
  if (inf) return inf[1] === "-" ? -Infinity : Infinity;
  if (NAN_TEXT.test(s)) return NaN;
  const hex = HEX_FLOAT.exec(s);
  if (hex) return parseHexFloat(hex[1] === "-", hex[2] ?? "", hex[3] ?? "", hex[4]);
  return null;
}

function parseHexFloat(negative: boolean, intDigits: string, fracDigits: string, exp: string | undefined): number | null {
  if (intDigits.length + fracDigits.length === 0) return null;
  // Leading zeros carry no value; cap the work on absurdly long digit strings.
  const digits = (intDigits + fracDigits).replace(/^0+/, "");
  let binaryExponent = exp === undefined ? 0 : clampExponent(exp);
  binaryExponent -= 4 * fracDigits.length;
  let value: number;
  if (digits.length === 0) value = 0;
  else {
    // Keep 32 significant hex digits (128 bits) plus a sticky bit: more than a double needs.
    const kept = digits.slice(0, 32);
    const dropped = digits.length - kept.length;
    let mantissa = BigInt(`0x${kept}`);
    if (dropped > 0 && /[1-9a-fA-F]/.test(digits.slice(32))) mantissa = (mantissa << 1n) | 1n;
    else if (dropped > 0) mantissa <<= 1n;
    const shift = dropped > 0 ? 4 * dropped - 1 : 0;
    value = scaleByPowerOfTwo(mantissa, binaryExponent + shift);
  }
  return negative ? -value : value;
}

function clampExponent(text: string): number {
  const n = Number(text);
  if (!Number.isFinite(n)) return n > 0 ? 100_000 : -100_000;
  return Math.max(-100_000, Math.min(100_000, n));
}

/** mantissa × 2^exponent, correctly rounded to a double (ties to even). */
function scaleByPowerOfTwo(mantissa: bigint, exponent: number): number {
  if (mantissa === 0n) return 0;
  const bits = mantissa.toString(2).length;
  // Value is in [2^(bits-1+exponent), 2^(bits+exponent)).
  const top = bits - 1 + exponent;
  if (top > 1023) return Infinity;
  if (top < -1100) return 0;
  // Reduce the mantissa to 53 significant bits (or fewer for subnormals) with exact rounding.
  const minExponentForNormal = -1022;
  const precision = top >= minExponentForNormal ? 53 : Math.max(0, 53 - (minExponentForNormal - top));
  let m = mantissa;
  let e = exponent;
  const excess = bits - precision;
  if (excess > 0) {
    const big = BigInt(excess);
    const q = m >> big;
    const r = m - (q << big);
    const half = 1n << (big - 1n);
    m = q;
    if (r > half || (r === half && (q & 1n) === 1n)) m += 1n;
    e += excess;
  }
  // m < 2^54 now: the product below is exact unless it overflows.
  let result = Number(m);
  // Multiply by 2^e in safe steps (each step exact while in range).
  while (e > 0) {
    const step = Math.min(e, 1000);
    result *= 2 ** step;
    e -= step;
  }
  while (e < 0) {
    const step = Math.min(-e, 1000);
    result /= 2 ** step;
    e += step;
  }
  return result;
}

/** Swift `Int64(text)` (and `Int(text)` on 64-bit platforms) as a bigint; null where Swift returns nil. */
export function swiftInt64(text: string): bigint | null {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const body = text.replace(/^[+-]?0*/, "");
  if (body.length > 19) return null;
  const value = BigInt(text);
  if (value > 9223372036854775807n || value < -9223372036854775808n) return null;
  return value;
}

/** Swift `Int(text)` as a JS number (exact below 2^53; larger values are rounded, as stored values are clamped). */
export function swiftInt(text: string): number | null {
  const v = swiftInt64(text);
  return v === null ? null : Number(v);
}

/** Swift `Double.description` / `"\(x)"`. */
export function doubleDescription(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const negative = x < 0;
  // toExponential() without an argument gives the shortest round-trip digits.
  const [mant, expText] = Math.abs(x).toExponential().split("e") as [string, string];
  const digits = mant.replace(".", "");
  const exp10 = Number(expText); // value = d.ddd × 10^exp10
  const decimalExponent = exp10 + 1; // value = 0.ddd × 10^decimalExponent
  let body: string;
  if (decimalExponent < -3 || Math.abs(x) > 2 ** 54) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = Math.abs(exp10);
    body = `${m}e${exp10 < 0 ? "-" : "+"}${e < 10 ? `0${e}` : e}`;
  } else if (decimalExponent <= 0) {
    body = `0.${"0".repeat(-decimalExponent)}${digits}`;
  } else if (decimalExponent >= digits.length) {
    body = `${digits}${"0".repeat(decimalExponent - digits.length)}.0`;
  } else {
    body = `${digits.slice(0, decimalExponent)}.${digits.slice(decimalExponent)}`;
  }
  return negative ? `-${body}` : body;
}

const TWO_POW_64 = 2 ** 64; // Double(UInt64.max - 1) rounds to 2^64

/**
 * Foundation `Decimal(value)` for a finite Double. Swift traps on infinity; callers only pass
 * finite values (null is returned for a non-finite input).
 */
export function decimalFromDouble(value: number): SwiftDecimal | null {
  if (Number.isNaN(value)) return SwiftDecimal.nan;
  if (!Number.isFinite(value)) return null;
  if (value === 0) return SwiftDecimal.zero;
  const negative = value < 0;
  let val = negative ? -1 * value : value;
  let exponent = 0;
  while (val < TWO_POW_64) {
    if (exponent <= -128) break; // Int8 exponent floor
    val *= 10.0;
    exponent -= 1;
  }
  while (TWO_POW_64 < val) {
    if (exponent >= 127) break;
    val /= 10.0;
    exponent += 1;
  }
  if (!(val < TWO_POW_64)) val = TWO_POW_64 - 2048; // UInt64(2^64) would trap; never reached by real data
  const mantissa = BigInt(Math.trunc(val));
  return SwiftDecimal.fromParts(negative, mantissa, exponent);
}

/** Swift `Decimal.description` (compacted form; see README "Decimal description"). */
export function decimalDescription(d: SwiftDecimal): string {
  return d.isNaN ? "NaN" : d.toString();
}
