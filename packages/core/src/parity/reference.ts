// Reference files from the Tier B Swift harness (SPEC §10.2, golden/README.md):
// `golden/reference/<brand>/<fixture>[@<zone>_<locale>].json` =
//   { schema, brand, fixture, source_sha, xcode, tz, locale, firstWeekday,
//     minimumDaysInFirstWeek, now, import: {…}, outputs: { "Metrics.profitFactor": … },
//     skipped: {…}, nondeterministic: ["outputs.…"] }
// and the resolvers that compute the desktop's value for each output key.

import type { BrandId } from "../brand";
import { isBrandId } from "../brand";
import { parityContext, type EngineContext } from "../engine/context";
import type { CompatMode } from "../engine/compat";
import { calculateMetrics, type PortfolioMetrics } from "../metrics/metrics-calculator";
import type { Trade } from "../model/trade";

export interface ReferenceFile {
  brand: BrandId;
  /** File name without ".json", e.g. "f7-ctrader-utc@Europe-Berlin_en_GB". */
  fixture: string;
  /** The fixture id ("<brand>/<id>", without the environment variant), as the manifest and divergences.yaml name it. */
  fixtureId: string;
  sourceSha: string;
  xcode: string;
  tz: string;
  locale: string;
  /** Foundation `firstWeekday` of the run's calendar (1 = Sunday). */
  firstWeekday: number;
  minimumDaysInFirstWeek: number;
  /** "Now" of the Swift run, epoch ms. */
  now: number;
  /** The import section (`parsed`, `journal`, counts) for import-format fixtures. */
  import: Readonly<Record<string, unknown>>;
  outputs: Readonly<Record<string, unknown>>;
  /** Keys the harness could not compute, with the reason. */
  skipped: Readonly<Record<string, string>>;
  /**
   * Reference paths ("outputs.CommissionAnalytics.symbolCosts") that depend on Swift
   * dictionary order, unseeded randomness or the clock: compared unordered, warn only.
   */
  nondeterministic: readonly string[];
}

/** Reads "now": epoch seconds (Swift `timeIntervalSince1970`), epoch ms, or ISO-8601 text. */
export function decodeReferenceNow(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.abs(v) < 1e11 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  throw new TypeError(`reference "now" is not a time: ${JSON.stringify(v)}`);
}

/**
 * Validates one reference file. `path` is its repository path
 * (".../golden/reference/<brand>/<fixture>.json"), which names the brand and the fixture.
 */
export function parseReferenceFile(path: string, json: unknown): ReferenceFile {
  const m = /golden\/reference\/([^/]+)\/(.+)\.json$/.exec(path.replace(/\\/g, "/"));
  if (!m) throw new TypeError(`not a reference path: ${path}`);
  const [, brand, fixture] = m as unknown as [string, string, string];
  if (!isBrandId(brand)) throw new TypeError(`unknown brand folder ${brand} in ${path}`);
  if (json === null || typeof json !== "object") throw new TypeError(`${path}: not an object`);
  const o = json as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof o[k] !== "string") throw new TypeError(`${path}: ${k} must be a string`);
    return o[k] as string;
  };
  if (o.outputs === null || typeof o.outputs !== "object" || Array.isArray(o.outputs)) {
    throw new TypeError(`${path}: outputs must be an object`);
  }
  const int = (k: string, fallback: number) => {
    if (o[k] === undefined) return fallback;
    if (!Number.isInteger(o[k])) throw new TypeError(`${path}: ${k} must be an integer`);
    return o[k] as number;
  };
  const record = (k: string): Record<string, never> => {
    if (o[k] === undefined) return {};
    if (o[k] === null || typeof o[k] !== "object" || Array.isArray(o[k])) throw new TypeError(`${path}: ${k} must be an object`);
    return o[k] as Record<string, never>;
  };
  const nondeterministic = o.nondeterministic ?? [];
  if (!Array.isArray(nondeterministic) || nondeterministic.some((p) => typeof p !== "string")) {
    throw new TypeError(`${path}: nondeterministic must be a list of paths`);
  }
  return {
    brand,
    fixture,
    fixtureId: typeof o.fixture === "string" ? o.fixture : `${brand}/${fixture.split("@")[0] as string}`,
    sourceSha: str("source_sha"),
    xcode: str("xcode"),
    tz: str("tz"),
    locale: str("locale"),
    firstWeekday: int("firstWeekday", 1),
    minimumDaysInFirstWeek: int("minimumDaysInFirstWeek", 1),
    now: decodeReferenceNow(o.now),
    import: record("import"),
    outputs: o.outputs as Record<string, unknown>,
    skipped: record("skipped"),
    nondeterministic: nondeterministic as string[],
  };
}

/**
 * The engine context a reference was computed in: its "now", zone, locale and week rules
 * (variant files `@<zone>_<locale>` carry their own), in `swift` compat unless asked otherwise.
 */
export function referenceContext(ref: ReferenceFile, compat: CompatMode = "swift"): EngineContext {
  return parityContext(
    ref.brand,
    ref.now,
    { tz: ref.tz, locale: ref.locale, firstWeekday: ref.firstWeekday, minimumDaysInFirstWeek: ref.minimumDaysInFirstWeek },
    compat,
  );
}

// --- resolvers ---------------------------------------------------------------------------

export type ParityResolver = (key: string, ctx: EngineContext, trades: readonly Trade[]) => { value: unknown } | undefined;

interface ResolverEntry {
  prefix: string;
  resolve: ParityResolver;
  /** Keys whose values are Swift Ints (compared exactly). */
  integerKeys?: ReadonlySet<string>;
}

const resolvers: ResolverEntry[] = [];

/**
 * Registers how to compute the desktop's value for reference keys starting with `prefix`
 * (e.g. "WinLossDistribution."). Analytics teams add theirs next to their component.
 */
export function registerParityResolver(prefix: string, resolve: ParityResolver, integerKeys?: Iterable<string>): void {
  if (resolvers.some((r) => r.prefix === prefix)) throw new Error(`parity resolver ${prefix} registered twice`);
  resolvers.push({ prefix, resolve, ...(integerKeys ? { integerKeys: new Set(integerKeys) } : {}) });
}

/** The desktop value for a reference key, or undefined when no resolver covers it yet. */
export function resolveParityOutput(
  key: string,
  ctx: EngineContext,
  trades: readonly Trade[],
): { value: unknown; integer: boolean } | undefined {
  for (const r of resolvers) {
    if (key.startsWith(r.prefix)) {
      const hit = r.resolve(key, ctx, trades);
      if (hit) return { value: hit.value, integer: r.integerKeys?.has(key) ?? false };
    }
  }
  return undefined;
}

const METRIC_INT_FIELDS = ["totalTrades", "wins", "losses", "maxWinStreak", "maxLossStreak", "currentStreak", "averageDuration"];

const metricsCache = new WeakMap<readonly Trade[], PortfolioMetrics>();

registerParityResolver(
  "Metrics.",
  (key, ctx, trades) => {
    let m = metricsCache.get(trades);
    if (!m) {
      m = calculateMetrics(trades, ctx);
      metricsCache.set(trades, m);
    }
    const field = key.slice("Metrics.".length);
    return Object.hasOwn(m, field) ? { value: (m as unknown as Record<string, unknown>)[field] } : undefined;
  },
  METRIC_INT_FIELDS.map((f) => `Metrics.${f}`),
);
