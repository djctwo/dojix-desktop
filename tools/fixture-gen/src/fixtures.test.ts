import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cents } from "./fx.ts";
import { allFixtures } from "./index.ts";
import { Rng } from "./rng.ts";
import { et, partsET } from "./time.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../golden/fixtures");
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("fixture generator", () => {
  it("is deterministic", () => {
    const a = allFixtures().map((f) => sha(f.bytes));
    const b = allFixtures().map((f) => sha(f.bytes));
    expect(a).toEqual(b);
  });

  it("matches the committed fixtures and manifest", () => {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { fixtures: { path: string; sha256: string; committed: boolean }[] };
    for (const f of allFixtures()) {
      expect(sha(readFileSync(join(root, f.path))), f.path).toBe(sha(f.bytes));
      expect(manifest.fixtures.find((m) => m.path === f.path)?.sha256).toBe(sha(f.bytes));
    }
  });

  it("covers every set and every import format of both apps", () => {
    const fixtures = allFixtures();
    const sets = new Set(fixtures.map((f) => `${f.brand}:${f.set}`));
    for (const s of ["F1", "F2", "F3", "F4", "F5", "F7", "F8"]) expect(sets).toContain(`dojix:${s}`);
    for (const s of ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8"]) expect(sets).toContain(`greenwick:${s}`);
    const dojixFormats = new Set(fixtures.filter((f) => f.brand === "dojix").map((f) => f.format));
    for (const fmt of ["sa32", "mt4", "ctrader", "tradingview", "oanda", "ibkr", "tos", "ninjatrader", "generic",
      "dojix_export", "mt5_report", "journal"]) expect(dojixFormats).toContain(fmt);
    const gwFormats = new Set(fixtures.filter((f) => f.brand === "greenwick").map((f) => f.format));
    for (const fmt of ["ibkr", "tos", "tradingview", "ninjatrader", "webull", "robinhood", "schwab", "fidelity",
      "etrade", "tastytrade", "generic", "journal"]) expect(gwFormats).toContain(fmt);
  });

  it("writes the F1 tiny set the SPEC hand-checks (ascending close: 100, 50, -30, -20, 80)", () => {
    const tiny = allFixtures().find((f) => f.id === "dojix/f1-tiny");
    const rows = new TextDecoder().decode(tiny?.bytes).trim().split("\n").slice(1);
    expect(rows.map((r) => r.split(",")[11])).toEqual(["100.00", "50.00", "-30.00", "-20.00", "80.00"]);
  });

  it("contains nothing that looks like personal data", () => {
    for (const f of allFixtures()) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(f.bytes);
      expect(text, f.path).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i); // e-mail addresses
      expect(text, f.path).not.toMatch(/\/Users\/|C:\\Users\\|\/home\//); // machine paths
    }
  });
});

describe("helpers", () => {
  it("converts US Eastern wall time across both 2026 DST switches", () => {
    expect(new Date(et(2026, 3, 6, 18, 50) * 1000).toISOString()).toBe("2026-03-06T23:50:00.000Z"); // EST
    expect(new Date(et(2026, 3, 9, 9, 30) * 1000).toISOString()).toBe("2026-03-09T13:30:00.000Z"); // EDT
    expect(new Date(et(2026, 10, 30, 18, 50) * 1000).toISOString()).toBe("2026-10-30T22:50:00.000Z"); // EDT
    expect(new Date(et(2026, 11, 2, 9, 31) * 1000).toISOString()).toBe("2026-11-02T14:31:00.000Z"); // EST
    expect(partsET(et(2026, 11, 2, 9, 31)).h).toBe(9);
  });

  it("parses money text to cents without floating-point drift", () => {
    expect(cents("-5000000000000.50")).toBe(-500000000000050);
    expect(cents("0.07")).toBe(7);
  });

  it("produces the same random stream for the same seed", () => {
    const a = new Rng("seed");
    const b = new Rng("seed");
    expect([a.u32(), a.u32(), a.u32()]).toEqual([b.u32(), b.u32(), b.u32()]);
  });
});
