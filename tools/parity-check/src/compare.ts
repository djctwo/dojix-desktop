// Equality rules for reference values (SPEC §10.1):
// - integers, counts, strings and labels: exact;
// - doubles: |a − b| ≤ 1e-9 · max(1, |a|) (a = the Swift reference);
// - ±∞ and NaN, written by the harness as "Infinity" / "-Infinity" / "NaN", must match exactly;
// - Decimal values are decimal strings and compare exactly as text;
// - a JSON number in the reference may be matched by an engine number only.

export const DOUBLE_TOLERANCE = 1e-9;

export interface Mismatch {
  path: string;
  expected: unknown;
  actual: unknown;
  reason: string;
}

export interface CompareOptions {
  /** Paths (prefixes) whose arrays are compared as unordered multisets (dictionary order in Swift). */
  unordered?: readonly string[];
  /** Paths (prefixes) that are not compared at all (randomness, clock reads). */
  ignored?: readonly string[];
  tolerance?: number;
  /** Stop after this many mismatches. */
  limit?: number;
}

const SPECIAL = new Set(["Infinity", "-Infinity", "NaN"]);

/** Converts an engine value to the harness's JSON conventions (non-finite numbers → strings). */
export function normalise(value: unknown): unknown {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = normalise(v);
    return out;
  }
  return value;
}

export function numbersEqual(expected: number, actual: number, tolerance = DOUBLE_TOLERANCE): boolean {
  if (Number.isInteger(expected) && Number.isInteger(actual) && Math.abs(expected) <= 2 ** 53) {
    if (expected === actual) return true;
  }
  return Math.abs(expected - actual) <= tolerance * Math.max(1, Math.abs(expected));
}

const matches = (path: string, prefixes: readonly string[] | undefined): boolean =>
  !!prefixes?.some((p) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));

const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x);

export function compareValues(expected: unknown, actualRaw: unknown, path = "", opts: CompareOptions = {},
  out: Mismatch[] = []): Mismatch[] {
  const limit = opts.limit ?? 50;
  if (out.length >= limit || matches(path, opts.ignored)) return out;
  const actual = normalise(actualRaw);
  const push = (reason: string): Mismatch[] => {
    out.push({ path: path || "$", expected, actual, reason });
    return out;
  };

  if (typeof expected === "number") {
    if (typeof actual !== "number") return push(`expected a number, got ${typeof actual}`);
    return numbersEqual(expected, actual, opts.tolerance) ? out : push(`|Δ| = ${Math.abs(expected - actual)}`);
  }
  if (typeof expected === "string") {
    if (SPECIAL.has(expected) || typeof actual === "string") {
      return expected === actual ? out : push("different text");
    }
    return push(`expected text, got ${typeof actual}`);
  }
  if (expected === null || typeof expected === "boolean") {
    return expected === actual ? out : push("different value");
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return push("expected an array");
    if (expected.length !== actual.length) return push(`length ${expected.length} ≠ ${actual.length}`);
    let exp: unknown[] = expected;
    let act: unknown[] = actual;
    if (matches(path, opts.unordered)) {
      exp = [...expected].sort((a, b) => (stable(a) < stable(b) ? -1 : 1));
      act = [...actual].sort((a, b) => (stable(a) < stable(b) ? -1 : 1));
    }
    exp.forEach((e, i) => compareValues(e, act[i], `${path}[${i}]`, opts, out));
    return out;
  }
  if (typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return push("expected an object");
    const a = actual as Record<string, unknown>;
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      if (!(k in a)) {
        push(`missing key ${k}`);
        continue;
      }
      compareValues(v, a[k], path ? `${path}.${k}` : k, opts, out);
    }
    return out;
  }
  return expected === actual ? out : push("different value");
}
