import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ReferenceDoc, loadReferences, runParity, verifyChecksums } from "./check.ts";
import { compareValues, numbersEqual } from "./compare.ts";
import { coveredBy, coveringIds, isProposal, parseDivergences, unapprovedHeadlineFixes, type Divergence } from "./divergences.ts";

const golden = resolve(dirname(fileURLToPath(import.meta.url)), "../../../golden");
const divergences = parseDivergences(readFileSync(join(golden, "divergences.yaml"), "utf8"));

describe("equality rules (SPEC §10.1)", () => {
  it("compares doubles with a relative tolerance of 1e-9", () => {
    expect(numbersEqual(0.6872431934890912, 0.6872431934890912 + 1e-12)).toBe(true);
    expect(numbersEqual(1e6, 1e6 + 1e-4)).toBe(true);
    expect(numbersEqual(1e6, 1e6 + 1e-2)).toBe(false);
    expect(numbersEqual(0, 1e-10)).toBe(true);
    expect(numbersEqual(0, 1e-8)).toBe(false);
  });

  it("matches ±∞ and NaN only exactly", () => {
    expect(compareValues("Infinity", Infinity)).toEqual([]);
    expect(compareValues("Infinity", 1e308)).toHaveLength(1);
    expect(compareValues("NaN", NaN)).toEqual([]);
    expect(compareValues(99.99, Infinity)).toHaveLength(1);
  });

  it("keeps integers, labels and decimal text exact", () => {
    expect(compareValues({ n: 5, label: "9:00", pnl: "1.2345" }, { n: 5, label: "9:00", pnl: "1.2345" })).toEqual([]);
    expect(compareValues({ pnl: "1.2345" }, { pnl: "1.23450" })).toHaveLength(1);
    expect(compareValues({ label: "Mon" }, { label: "mon" })).toHaveLength(1);
  });

  it("compares arrays in order unless the path is unordered (Swift dictionary order)", () => {
    expect(compareValues([1, 2], [2, 1], "outputs.X")).toHaveLength(2);
    expect(compareValues([1, 2], [2, 1], "outputs.X", { unordered: ["outputs.X"] })).toEqual([]);
  });

  it("reports a missing key", () => {
    expect(compareValues({ a: 1, b: 2 }, { a: 1 })[0]?.reason).toBe("missing key b");
  });
});

describe("divergences.yaml", () => {
  it("lists every intentional fix from PARITY.md, headline ones approved", () => {
    const ids = divergences.map((d) => d.id);
    for (const id of ["D-01", "D-04", "D-05", "D-06", "D-15", "D-16", "D-18", "D-22", "D-23", "D-27"]) expect(ids).toContain(id);
    const approvedHeadline = divergences.filter((d) => d.headline && d.approved).map((d) => d.id).sort();
    // D-16…D-27: DECISIONS.md #8 (2026-10-27); D-24 (with D-32), D-30, D-31, D-32: #10 (2026-10-29).
    expect(approvedHeadline).toEqual(["D-16", "D-18", "D-22", "D-23", "D-24", "D-27", "D-30", "D-31", "D-32"]);
    expect(unapprovedHeadlineFixes(divergences)).toEqual([]);
  });

  it("has no open proposals; D-30…D-32 are approved fixes whose tests exist", () => {
    expect(divergences.filter(isProposal).map((d) => d.id)).toEqual([]);
    for (const id of ["D-30", "D-31", "D-32"]) {
      const d = divergences.find((x) => x.id === id) as Divergence;
      expect(d, id).toMatchObject({ approved: true, headline: true });
      expect(existsSync(join(golden, "..", d.test as string)), `${id}: ${String(d.test)}`).toBe(true);
    }
    expect(coveringIds(divergences, "dojix/f5-ctrader-compact", "outputs.Metrics.totalTrades")).toContain("D-31");
    expect(coveringIds(divergences, "greenwick/f6-fidelity-no-price", "outputs.Metrics.totalTrades")).toEqual(expect.arrayContaining(["D-24", "D-32"]));
    // D-30 changes no reference value (no fixture has a gap-time row), so it covers nothing.
    expect(coveringIds(divergences, "greenwick/f7-et-boundaries-ninjatrader", "import.parsed")).not.toContain("D-30");
  });

  it("every test path in divergences.yaml exists", () => {
    for (const d of divergences.filter((x) => x.test !== null)) expect(existsSync(join(golden, "..", d.test as string)), `${d.id}: ${String(d.test)}`).toBe(true);
  });

  it("refuses a headline fix that is implemented without approval, and keeps proposals out of the coverage", () => {
    const unapproved = { ...(divergences.find((d) => d.id === "D-31") as Divergence), approved: false };
    expect(unapprovedHeadlineFixes([unapproved])).toEqual(["D-31"]);
    expect(runParity([], {}, [unapproved]).errors).toEqual(["D-31: changes a headline number but is not approved"]);
    const proposal = { ...unapproved, test: null };
    expect(isProposal(proposal)).toBe(true);
    expect(coveredBy([proposal], "dojix/f5-ctrader-compact", "import.parsed")).toBeUndefined();
  });

  it("scopes an entry to its app, fixtures and paths", () => {
    expect(coveredBy(divergences, "dojix/f3-bucket-edges", "outputs.WinLossDistribution.buckets[0]")?.id).toBe("D-01");
    expect(coveringIds(divergences, "greenwick/f6-schwab-no-footer", "outputs.SessionHeatmap.cells")).toContain("D-23");
    expect(coveredBy(divergences, "greenwick/f2-stocks-year-journal", "outputs.Metrics.totalTrades")).toBeUndefined();
    expect(coveredBy(divergences, "greenwick/f3-bucket-edges-journal", "outputs.KillZoneOptimizer.windows")).toBeUndefined();
  });
});

/** A reference document shaped like the harness output, for the F1 tiny set. */
function tinyDoc(): ReferenceDoc {
  const profits = [80, -20, -30, 50, 100]; // close time descending, as the Mac returns them
  return {
    schema: 1, brand: "dojix", fixture: "dojix/f1-tiny", source_sha: "", tz: "UTC", locale: "en_US_POSIX",
    firstWeekday: 1, minimumDaysInFirstWeek: 1, now: "2026-10-27T00:00:00.000Z",
    import: { journal: profits.map((p, i) => ({ ticket: String(i + 1), netProfit: `${p}.00` })) },
    outputs: { Metrics: { expectancy: 36, maxDrawdown: 50, sharpeRatio: 0.6872431934890912, calmarRatio: 3.6, totalTrades: 5 } },
    skipped: {}, nondeterministic: [],
  };
}

/** A toy engine for the check itself (the real engine arrives in Phase 2). */
function toyMetrics(doc: ReferenceDoc): Record<string, number> {
  const p = (doc.import.journal ?? []).map((t) => Number(t.netProfit));
  const n = p.length;
  const wins = p.filter((x) => x > 0);
  const losses = p.filter((x) => x < 0);
  const gp = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  const wr = (wins.length / n) * 100;
  const total = p.reduce((a, b) => a + b, 0);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const x of [...p].reverse()) {
    cum += x;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const mean = total / n;
  const sd = Math.sqrt(p.map((x) => (x - mean) ** 2).reduce((a, b) => a + b, 0) / n);
  return {
    expectancy: (wr / 100) * (gp / wins.length) - (1 - wr / 100) * (gl / losses.length),
    maxDrawdown: dd,
    sharpeRatio: sd > 0 ? mean / sd : 0,
    calmarRatio: dd > 0 ? total / dd : total > 0 ? 10 : 0,
    totalTrades: n,
  };
}

describe("runParity", () => {
  it("passes when the engine matches the reference (F1 tiny)", () => {
    const r = runParity([{ file: "f1-tiny.json", doc: tinyDoc() }], { "outputs.Metrics": toyMetrics }, divergences);
    expect(r.failures).toEqual([]);
    expect(r.compared).toBe(1);
  });

  it("fails on a headline difference that no DIVERGENCE entry covers", () => {
    const wrong = (doc: ReferenceDoc): Record<string, number> => ({ ...toyMetrics(doc), maxDrawdown: 49 });
    const r = runParity([{ file: "f1-tiny.json", doc: tinyDoc() }], { "outputs.Metrics": wrong }, divergences);
    expect(r.failures.map((f) => f.mismatch.path)).toEqual(["outputs.Metrics.maxDrawdown"]);
  });

  it("counts reference keys that have no engine function yet", () => {
    const r = runParity([{ file: "f1-tiny.json", doc: tinyDoc() }], {}, divergences);
    expect(r.notImplemented).toBeGreaterThan(0);
    expect(r.failures).toEqual([]);
  });

  it("fails strict mode while a divergence has no test", () => {
    const r = runParity([], {}, divergences, { strict: true });
    expect(r.errors.some((e) => e.includes("no red→green test"))).toBe(true);
  });
});

describe("committed reference files", () => {
  for (const brand of ["dojix", "greenwick"]) {
    it(`${brand}: checksums match the CI run and every file parses`, () => {
      expect(verifyChecksums(golden, brand)).toEqual([]);
      const { errors } = loadReferences(join(golden, "reference", brand));
      expect(errors).toEqual([]);
    });
  }
});
