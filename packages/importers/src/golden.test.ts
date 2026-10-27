// The parity team's fixtures (golden/fixtures/**) and the Swift reference values
// (golden/reference/**). Both are optional here: each block skips with a reason until the
// files exist. GOLDEN_DIR points at another checkout of golden/ (local runs).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BrandId } from "@dojix-desktop/core";
import { ImportError, type MacTrade } from "./model";
import { importTradeFile, type ImportResult } from "./pipeline";
import { dojixContentKey } from "./tickets";

const here = fileURLToPath(new URL(".", import.meta.url));
const GOLDEN = process.env.GOLDEN_DIR ?? resolve(here, "../../../golden");
const MANIFEST = join(GOLDEN, "fixtures", "manifest.json");
const REFERENCE = join(GOLDEN, "reference");

interface FixtureEntry {
  id: string;
  brand: BrandId;
  path: string;
  kind: string;
  format: string;
  sha256?: string;
}

const manifest: FixtureEntry[] = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as { fixtures: FixtureEntry[] }).fixtures : [];
// Large generated sets (F9) are not committed; only files present on disk are run.
const files = manifest.filter((f) => f.kind === "file" && existsSync(join(GOLDEN, "fixtures", f.path)));

function run(f: FixtureEntry, compat: "swift" | "fixed", now = Date.UTC(2026, 9, 1)): ImportResult | ImportError {
  try {
    const fileName = f.path.split("/").pop() as string;
    return importTradeFile(new Uint8Array(readFileSync(join(GOLDEN, "fixtures", f.path))), { brand: f.brand, compat, now, fileName });
  } catch (e) {
    if (e instanceof ImportError) return e;
    throw e;
  }
}

describe.skipIf(files.length === 0)("golden fixtures", () => {
  it.each(files.map((f) => [f.id, f] as const))("%s imports without crashing, idempotently", (_id, f) => {
    const bytes = readFileSync(join(GOLDEN, "fixtures", f.path));
    if (f.sha256) expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.sha256);
    for (const compat of ["swift", "fixed"] as const) {
      const r = run(f, compat);
      if (r instanceof ImportError) {
        expect(["empty_file", "no_trade_section"]).toContain(r.code);
        continue;
      }
      expect(new Set(r.trades.map((t) => t.ticket)).size).toBe(r.trades.length);
      const again = run(f, compat, Date.UTC(2026, 9, 2));
      expect(again instanceof ImportError ? [] : again.trades.map((t) => t.ticket)).toEqual(r.trades.map((t) => t.ticket));
      for (const t of r.trades) {
        for (const v of [t.quantity, t.rMultiple, t.slDist ?? 0, t.mae ?? 0, t.mfe ?? 0]) expect(Number.isFinite(v)).toBe(true);
        expect(t.netProfit).toMatch(/^-?\d+(\.\d+)?$/);
      }
    }
  });
});

// --- Swift reference values ---------------------------------------------------------------------

function referenceDocs(): { file: string; doc: Record<string, unknown> }[] {
  if (!existsSync(REFERENCE)) return [];
  const out: { file: string; doc: Record<string, unknown> }[] = [];
  for (const brand of readdirSync(REFERENCE)) {
    const dir = join(REFERENCE, brand);
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      out.push({ file: `${brand}/${name}`, doc: JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown> });
    }
  }
  return out;
}

/** A parsed Mac trade as the Swift harness dumps it (`refEncode`): Mac names, Decimal descriptions, ISO dates. */
export function macView(t: MacTrade): Record<string, unknown> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const ticket = t.ticket > 9_007_199_254_740_992n || t.ticket < -9_007_199_254_740_992n ? t.ticket.toString() : Number(t.ticket);
  const common = {
    ticket, symbol: t.symbol, direction: t.direction, openTime: iso(t.openTime), closeTime: iso(t.closeTime), durationMin: t.durationMin,
    openPrice: t.openPrice.toString(), closePrice: t.closePrice.toString(), sl: t.sl.toString(), tp: t.tp.toString(), netProfit: t.netProfit.toString(),
    commission: t.commission.toString(), swap: t.swap.toString(), rMultiple: t.rMultiple, dayOfWeek: t.dayOfWeek, hour: t.hour, session: t.session, comment: t.comment,
  };
  return t.brand === "dojix"
    ? { ...common, lots: t.lots, maePips: t.maePips, mfePips: t.mfePips, slDistPips: t.slDistPips, contentKey: dojixContentKey(t) }
    : { ...common, shares: t.shares, maePoints: t.maePoints, mfePoints: t.mfePoints, slDistPoints: t.slDistPoints };
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  if (typeof b === "string" && (b === "NaN" || b === "Infinity" || b === "-Infinity")) return String(a) === b;
  return String(a) === String(b);
}

const docs = referenceDocs().filter(({ doc }) => Array.isArray((doc.import as { parsed?: unknown } | undefined)?.parsed));

describe.skipIf(docs.length === 0)("Swift reference: import.parsed and import.journal (swift compat)", () => {
  it.each(docs.map((d) => [d.file, d] as const))("%s", (_file, { doc }) => {
    const fixture = manifest.find((f) => f.id === doc.fixture);
    // swift compat reproduces the Mac exactly, including what it can't read (UTF-16, BOM, desktop formats).
    if (!fixture || fixture.kind !== "file") return;
    const now = typeof doc.now === "string" ? Date.parse(doc.now) : Date.UTC(2026, 9, 1);
    const r = run(fixture, "swift", now);
    const expected = (doc.import as { parsed: Record<string, unknown>[] }).parsed;
    const actual = r instanceof ImportError ? [] : r.mac.map(macView);
    expect(actual.length, "parsed count").toBe(expected.length);
    expected.forEach((e, i) => {
      const a = actual[i] as Record<string, unknown>;
      for (const key of Object.keys(a)) {
        if (!(key in e)) continue;
        expect(same(a[key], e[key]), `${doc.fixture} trade ${i} ${key}: ${String(a[key])} vs ${String(e[key])}`).toBe(true);
      }
    });
    // import.journal: what the Mac stored after Trade+Sanitize / TradeLimits and the insert's ticket dedupe.
    const journal = ((doc.import as { journal?: Record<string, unknown>[] }).journal ?? []);
    const mine = new Map((r instanceof ImportError ? [] : r.trades).map((t) => [t.ticket, t]));
    expect(mine.size, "journal count").toBe(journal.length);
    for (const e of journal) {
      const t = mine.get(String(e.ticket));
      expect(t, `${doc.fixture}: ticket ${String(e.ticket)} stored`).toBeDefined();
      if (!t) continue;
      const pairs: [string, unknown, unknown][] = [
        ["symbol", t.symbol, e.symbol], ["netProfit", t.netProfit, e.netProfit], ["quantity", t.quantity, e.lots ?? e.shares], ["hour", t.hour, e.hour],
        ["dayOfWeek", t.dayOfWeek, e.dayOfWeek], ["durationMin", t.durationMin, e.durationMin], ["openTime", `${t.openTime.replace(" ", "T")}Z`, e.openTime],
        ["closeTime", `${t.closeTime.replace(" ", "T")}Z`, e.closeTime], ["rMultiple", t.rMultiple, e.rMultiple], ["mae", t.mae, e.maePips ?? e.maePoints],
        ["slDist", t.slDist, e.slDistPips ?? e.slDistPoints], ["comment", t.comment, e.comment], ["openPrice", t.openPrice, e.openPrice],
        ["commission", t.commission, e.commission], ["session", t.session, e.session],
      ];
      for (const [k, a, b] of pairs) expect(same(a, b), `${doc.fixture} ${String(e.ticket)}.${k}: ${String(a)} vs ${String(b)}`).toBe(true);
    }
  });
});

if (files.length === 0) {
  describe("golden fixtures", () => {
    it.skip(`skipped: ${MANIFEST} not found (Phase 0 fixtures not merged yet)`, () => {});
  });
}
if (docs.length === 0) {
  describe("Swift reference", () => {
    it.skip(`skipped: no import.parsed in ${REFERENCE} yet (Tier B harness pending)`, () => {});
  });
}
