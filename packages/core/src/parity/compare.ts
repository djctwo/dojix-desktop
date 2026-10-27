// The parity equality rule (SPEC §10.1):
// - integers, counts, strings, labels, booleans: exact;
// - doubles: |a − b| ≤ 1e-9 · max(1, |a|) with `a` the Swift reference;
// - ±∞ must match ±∞ (and NaN matches NaN);
// - arrays and objects compare element-wise / key-wise.
// JSON has no ∞ or NaN, so reference files may carry them as strings; `decodeReferenceNumber`
// reads the spellings Swift encoders produce.

export type ParityValue = null | boolean | number | string | readonly ParityValue[] | { readonly [k: string]: ParityValue };

const NON_FINITE: Readonly<Record<string, number>> = {
  inf: Infinity,
  "+inf": Infinity,
  infinity: Infinity,
  "+infinity": Infinity,
  "-inf": -Infinity,
  "-infinity": -Infinity,
  nan: NaN,
};

/** A reference number, decoding "inf" / "-inf" / "nan" (any case, also "Infinity"). */
export function decodeReferenceNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const hit = NON_FINITE[v.toLowerCase()];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export interface ParityMismatch {
  path: string;
  expected: unknown;
  actual: unknown;
}

function numbersEqual(expected: number, actual: number): boolean {
  if (Number.isNaN(expected)) return Number.isNaN(actual);
  if (!Number.isFinite(expected)) return expected === actual;
  if (!Number.isFinite(actual)) return false;
  return Math.abs(expected - actual) <= 1e-9 * Math.max(1, Math.abs(expected));
}

/**
 * Compares a Swift reference value with the desktop value. `exactIntegers: true` (for counts
 * and other Int outputs) turns off the tolerance for numbers. Returns the mismatches (empty
 * when equal).
 */
export function compareParity(
  expected: unknown,
  actual: unknown,
  options: { exactIntegers?: boolean } = {},
  path = "$",
): ParityMismatch[] {
  const expNum = decodeReferenceNumber(expected);
  if (expNum !== undefined && (typeof actual === "number" || decodeReferenceNumber(actual) !== undefined)) {
    const actNum = decodeReferenceNumber(actual) as number;
    const ok = options.exactIntegers ? Object.is(expNum, actNum) || expNum === actNum : numbersEqual(expNum, actNum);
    return ok ? [] : [{ path, expected, actual }];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [{ path, expected, actual }];
    return expected.flatMap((e, i) => compareParity(e, actual[i], options, `${path}[${i}]`));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return [{ path, expected, actual }];
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
    return [...keys].sort().flatMap((k) => compareParity(e[k], a[k], options, `${path}.${k}`));
  }
  return Object.is(expected, actual) ? [] : [{ path, expected, actual }];
}
