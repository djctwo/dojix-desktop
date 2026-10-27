// Shared plumbing for the analytics components (SPEC Appendix A).
//
// Conventions every component file follows:
// - `computeX(ctx, trades, options?)` always returns the full model, even for 0 trades, with
//   one field per value the Mac component computes, **named exactly as the Swift member**
//   (so the parity resolver can read `<Component>.<member>` from it). Optional Swift values are
//   `| null`. Extra UI-only fields are allowed; the parity encoder lists members explicitly.
// - `xComponent = defineComponent(...)` wraps it for the registry and returns null where the
//   Mac view shows its empty state.
// - `xParity` describes how the Tier B harness reads it (see `ComponentParity`).
// - Dates in models are epoch ms; trades are the engine trade objects.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { isWin, profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { registerParityResolver } from "../parity/reference";
import { swiftMax, swiftMin } from "../swiftcompat/collections";

// --- small numeric helpers -------------------------------------------------------------------

/** `trades.reduce(0) { $0 + $1.profitDouble }` in input order. */
export function sumProfit(trades: readonly Trade[]): number {
  let total = 0;
  for (const t of trades) total += profitDouble(t);
  return total;
}

/** Number of wins (`isWin`, compared in Decimal). */
export function countWins(trades: readonly Trade[]): number {
  let n = 0;
  for (const t of trades) if (isWin(t)) n += 1;
  return n;
}

/** `Double(values.reduce(0, +)) / Double(count)`: the plain mean (NaN for an empty input, as in Swift). */
export function mean(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/**
 * Swift `min(max(x, lo), hi)`, literally (a NaN `x` stays NaN, as in Swift). Components that
 * map NaN to a value (Greenwick `clampedScore`) do so themselves.
 */
export function clamp(x: number, lo: number, hi: number): number {
  return swiftMin(swiftMax(x, lo), hi);
}

// --- Tier B encoding (tools/swift-ref/shared/RefSupport.swift) --------------------------------

/** A Swift `Date` as the harness writes it: `yyyy-MM-ddTHH:mm:ss.SSSZ` in UTC. */
export function refDate(ms: number): string {
  return new Date(ms).toISOString();
}

/** A `Trade` inside an analytics output: `"#<ticket>"`. */
export function refTrade(t: Trade): string {
  return `#${t.ticket}`;
}

function isTrade(v: unknown): v is Trade {
  return (
    typeof v === "object" &&
    v !== null &&
    "brand" in v &&
    "ticket" in v &&
    "netProfit" in v &&
    "closeTime" in v
  );
}

export interface RefOptions {
  /** Object keys whose numeric values are Dates (encoded with `refDate`). */
  dates?: readonly string[];
  /** Object keys to drop (UI-only fields the Swift type doesn't have). */
  omit?: readonly string[];
}

/**
 * Encodes a model value the way the harness encodes the Swift value: trades → "#ticket",
 * listed date keys → ISO text, `undefined` dropped, Maps → objects with string keys, everything
 * else recursively. Numbers (including ±∞ and NaN) pass through; the comparator reads both.
 */
export function toRef(value: unknown, options: RefOptions = {}): unknown {
  const dates = new Set(options.dates ?? []);
  const omit = new Set(options.omit ?? []);
  const enc = (v: unknown, key: string | null): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return key !== null && dates.has(key) ? refDate(v) : v;
    if (typeof v !== "object") return v;
    if (isTrade(v)) return refTrade(v);
    if (Array.isArray(v)) return v.map((x) => enc(x, key));
    if (v instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of v) out[String(k)] = enc(x, null);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined || omit.has(k)) continue;
      out[k] = enc(x, k);
    }
    return out;
  };
  return enc(value, null);
}

// --- parity resolvers -------------------------------------------------------------------------

/**
 * How the Tier B harness reads one component: it constructs the Swift view with the fixture's
 * trades (plus extra instances such as `PositionSizer[balance25k_risk2]`) and records each
 * computed member as `<Component>[<instance>].<member>`.
 */
export interface ComponentParity<M> {
  /** The Swift type name (key prefix). */
  component: string;
  brands: readonly BrandId[];
  /** Builds the model; `instance` is the bracketed suffix of the key, if any. */
  compute(ctx: EngineContext, trades: readonly Trade[], instance: string | undefined): M | undefined;
  /** Member name → its encoded value. A missing member means "no resolver" (skipped). */
  members: Readonly<Record<string, (model: M, ctx: EngineContext) => unknown>>;
  /** Members whose value is a Swift Int (compared exactly). */
  integerMembers?: readonly string[];
}

const KEY = /^([A-Za-z]+)(?:\[([^\]]+)\])?\.(\w+)$/;

/** Splits "Name[instance].member". */
export function parseComponentKey(key: string): { component: string; instance: string | undefined; member: string } | null {
  const m = KEY.exec(key);
  if (!m) return null;
  return { component: m[1] as string, instance: m[2], member: m[3] as string };
}

/** Registers the resolvers for one component (both `Name.` and `Name[` prefixes). */
export function registerComponentParity<M>(spec: ComponentParity<M>): void {
  const cache = new WeakMap<readonly Trade[], Map<string, M | undefined>>();
  const resolve = (key: string, ctx: EngineContext, trades: readonly Trade[]): { value: unknown } | undefined => {
    const parsed = parseComponentKey(key);
    if (!parsed || parsed.component !== spec.component || !spec.brands.includes(ctx.brand)) return undefined;
    const member = spec.members[parsed.member];
    if (!member) return undefined;
    let perTrades = cache.get(trades);
    if (!perTrades) {
      perTrades = new Map();
      cache.set(trades, perTrades);
    }
    const slot = `${ctx.brand}|${ctx.compat}|${ctx.now}|${parsed.instance ?? ""}`;
    if (!perTrades.has(slot)) perTrades.set(slot, spec.compute(ctx, trades, parsed.instance));
    const model = perTrades.get(slot);
    if (model === undefined) return undefined;
    return { value: member(model, ctx) };
  };
  const ints: string[] = [];
  for (const m of spec.integerMembers ?? []) ints.push(`${spec.component}.${m}`);
  registerParityResolver(`${spec.component}.`, resolve, ints);
  registerParityResolver(`${spec.component}[`, resolve);
}
