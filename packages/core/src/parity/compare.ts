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

export interface CompareOptions {
  /** Numbers are Swift Ints: compared exactly (no tolerance). */
  exactIntegers?: boolean;
  /**
   * Reference paths whose arrays are compared as unordered multisets (golden/README.md: the
   * reference's `nondeterministic` list, i.e. Swift dictionary order). A path covers itself and
   * everything below it.
   */
  unordered?: readonly string[];
}

/** True when `path` is `prefix` or lies below it (`prefix.x`, `prefix[i]`). */
export function pathWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}

/**
 * Compares a Swift reference value with the desktop value. `exactIntegers: true` (for counts
 * and other Int outputs) turns off the tolerance for numbers; `unordered` paths match array
 * elements as a multiset. `path` names the root in the mismatches ("$" by default; the parity
 * suite passes the reference path, e.g. "outputs.Metrics.winRate"). Returns the mismatches
 * (empty when equal).
 */
export function compareParity(expected: unknown, actual: unknown, options: CompareOptions = {}, path = "$"): ParityMismatch[] {
  const expNum = decodeReferenceNumber(expected);
  if (expNum !== undefined && (typeof actual === "number" || decodeReferenceNumber(actual) !== undefined)) {
    const actNum = decodeReferenceNumber(actual) as number;
    const ok = options.exactIntegers ? Object.is(expNum, actNum) || expNum === actNum : numbersEqual(expNum, actNum);
    return ok ? [] : [{ path, expected, actual }];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [{ path, expected, actual }];
    if (options.unordered?.some((p) => pathWithin(path, p))) return compareUnordered(expected, actual, options, path);
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

/**
 * Multiset comparison: every expected element must be matched by a distinct actual element
 * under the same equality rule. Unmatched elements are reported at `path[i]` (expected index).
 */
function compareUnordered(expected: readonly unknown[], actual: readonly unknown[], options: CompareOptions, path: string): ParityMismatch[] {
  const used = new Array<boolean>(actual.length).fill(false);
  const missing: number[] = [];
  expected.forEach((e, i) => {
    // The element at the same index first (the common, already-ordered case), then any other.
    const order = [i, ...actual.keys()];
    const hit = order.find((j) => j < actual.length && !used[j] && compareParity(e, actual[j], options, path).length === 0);
    if (hit === undefined) missing.push(i);
    else used[hit] = true;
  });
  const spare = actual.filter((_, j) => !used[j]);
  return missing.map((i, n) => ({ path: `${path}[${i}]`, expected: expected[i], actual: spare[n] }));
}
