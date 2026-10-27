// Swift `Int` behaviour on top of IEEE-754 doubles.
//
// Swift's Int is a 64-bit two's-complement integer that traps on overflow and on division by
// zero. The engine keeps integers in JS numbers, which are exact up to 2^53; every count and
// duration the apps produce stays far below that (durations are clamped to ten years in
// minutes on import). The helpers below reproduce the *observable* Swift results:
//
// - `Int.max` (2^63 - 1) cannot be represented as a double. It is represented by 2^63, which
//   is exactly what `JSON.parse` yields for the reference value 9223372036854775807, so
//   parity comparisons of saturated values still match.
// - `Int.min` (-2^63) is exact.

/** Swift `Int.max` as the engine represents it (2^63; see the note above). */
export const INT_MAX = 2 ** 63;
/** Swift `Int.min` (-2^63, exact). */
export const INT_MIN = -(2 ** 63);

const BIG_INT_MAX = 2n ** 63n - 1n;
const BIG_INT_MIN = -(2n ** 63n);

/**
 * Swift integer division `a / b`: truncates toward zero.
 *
 * Swift traps on division by zero and on `Int.min / -1`; the Swift callers always guard
 * against both, so this throws a RangeError instead of silently returning a value.
 * Both operands must be integers.
 */
export function idiv(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new RangeError(`idiv needs integers, got ${a} / ${b}`);
  }
  if (b === 0) throw new RangeError("Swift traps on integer division by zero");
  if (a === INT_MIN && b === -1) throw new RangeError("Swift traps on Int.min / -1");
  const q = Math.trunc(a / b);
  // a / b in doubles is exact for |a| < 2^53; above that, correct with BigInt.
  if (Math.abs(a) < 2 ** 53 && Math.abs(b) < 2 ** 53) return q === 0 ? 0 : q;
  return Number(BigInt(a) / BigInt(b));
}

/** Swift `a % b` (the sign follows the dividend, like JS `%`), with Swift's traps. */
export function irem(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new RangeError(`irem needs integers, got ${a} % ${b}`);
  }
  if (b === 0) throw new RangeError("Swift traps on integer remainder by zero");
  const r = a % b;
  return r === 0 ? 0 : r;
}

/** Which app's `Int(saturating:)` to reproduce (the two differ near 2^63). */
export type SaturatingFlavor = "dojix" | "greenwick";

// Dojix (Numeric+Safe.swift:14,16) compares against the literal 9.223_372_036_854_775e18, which
// rounds to the double 2^63 - 1024. Greenwick (Int+Saturating.swift:12,14) compares against
// 2^63 exactly. So a value in [2^63 - 1024, 2^63) saturates in Dojix but converts exactly in
// Greenwick.
const DOJIX_UPPER = 9.223_372_036_854_775e18; // === 2 ** 63 - 1024
// Swift literal 9_223_372_036_854_775_807.0, which rounds to exactly 2^63.
const GREENWICK_UPPER = 2 ** 63;

/**
 * Swift `Int(saturating: value)` as both apps define it:
 * NaN → 0; values at or beyond the bounds → Int.max / Int.min; else rounded toward zero.
 *
 * Dojix: `Dojix/Extensions/Numeric+Safe.swift:11-21`.
 * Greenwick: `StockJournal/Extensions/Int+Saturating.swift:9-19`.
 */
export function intSaturating(value: number, flavor: SaturatingFlavor = "greenwick"): number {
  if (Number.isNaN(value)) return 0;
  const upper = flavor === "dojix" ? DOJIX_UPPER : GREENWICK_UPPER;
  if (value >= upper) return INT_MAX;
  if (value <= -upper) return INT_MIN;
  const t = Math.trunc(value);
  return t === 0 ? 0 : t;
}

function toBigIntChecked(value: number): bigint {
  if (!Number.isInteger(value)) throw new RangeError(`not an integer: ${value}`);
  if (value >= INT_MAX) return BIG_INT_MAX;
  if (value <= INT_MIN) return BIG_INT_MIN;
  return BigInt(value);
}

/**
 * Swift `saturatingSum()` (both apps): a running sum that, on overflow, *replaces* the total
 * with Int.max / Int.min (by the sign of the element being added) and keeps going, so
 * `[Int.max, 5, -10]` ends at `Int.max - 10`, not at `Int.max`.
 *
 * Dojix `Numeric+Safe.swift:26-32`, Greenwick `Int+Saturating.swift:24-30`.
 */
export function saturatingSum(values: Iterable<number>): number {
  let total = 0n;
  for (const v of values) {
    const next = toBigIntChecked(v);
    const sum = total + next;
    if (sum > BIG_INT_MAX || sum < BIG_INT_MIN) {
      total = next > 0n ? BIG_INT_MAX : BIG_INT_MIN;
    } else {
      total = sum;
    }
  }
  if (total === BIG_INT_MAX) return INT_MAX;
  return Number(total);
}

/**
 * Swift `saturatingAverage()` (Dojix) / `overflowSafeAverage()` (Greenwick): the mean computed
 * in Double, then `Int(saturating:)`; 0 when empty.
 *
 * Dojix `Numeric+Safe.swift:35-43`, Greenwick `Int+Saturating.swift:33-42`.
 */
export function saturatingAverage(values: Iterable<number>, flavor: SaturatingFlavor = "greenwick"): number {
  let total = 0;
  let count = 0;
  for (const v of values) {
    total += v;
    count += 1;
  }
  return count === 0 ? 0 : intSaturating(total / count, flavor);
}
