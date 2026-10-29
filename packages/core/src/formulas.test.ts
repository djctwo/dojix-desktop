// Keeps FORMULA_INDEX honest: every implemented entry points at a real module that exports
// the names it lists.
import { describe, expect, it } from "vitest";
import { FORMULA_INDEX, formulasOwnedBy } from "./formulas";

const modules = import.meta.glob<Record<string, unknown>>(["./**/*.ts", "!./**/*.test.ts"], { eager: true });

describe("FORMULA_INDEX", () => {
  it("has unique ids", () => {
    const ids = FORMULA_INDEX.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points implemented entries at existing exports", () => {
    // Importer entries live in packages/importers and are checked by its own formulas test.
    for (const f of FORMULA_INDEX.filter((x) => x.status === "implemented" && (x.package ?? "core") === "core")) {
      expect(f.module, f.id).toBeDefined();
      const mod = modules[`./${f.module}`];
      expect(mod, `${f.id}: ${f.module}`).toBeDefined();
      for (const name of f.exports ?? []) expect(mod?.[name], `${f.id}: ${name}`).toBeDefined();
    }
  });

  it("names a placement for each brand of a planned component", () => {
    for (const f of FORMULA_INDEX.filter((x) => x.status === "planned" && x.spec === "App. A" && x.id !== "TradeGrader")) {
      for (const b of f.brands) expect(f.placement?.[b], `${f.id} (${b})`).toBeDefined();
    }
  });

  it("only cites known divergences", () => {
    const known = new Set(["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-08", "D-09", "D-15", "D-16", "D-17", "D-18", "D-19", "D-20", "D-21", "D-22", "D-23", "D-24", "D-25", "D-26", "D-27", "D-28", "D-29", "D-30", "D-31", "D-32"]);
    for (const f of FORMULA_INDEX) for (const d of f.divergences ?? []) expect(known.has(d), `${f.id}: ${d}`).toBe(true);
  });

  it("splits the remaining work by team", () => {
    expect(formulasOwnedBy("E1").every((f) => f.status === "implemented")).toBe(true);
    expect(formulasOwnedBy("E2").length).toBeGreaterThan(0);
    expect(formulasOwnedBy("E4").every((f) => f.brands.length === 1 && f.brands[0] === "greenwick")).toBe(true);
  });
});
