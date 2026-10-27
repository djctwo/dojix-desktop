// The importer entries of core's FORMULA_INDEX point at real exports here (the drift test for
// `package: "importers"`; core's own test covers the rest).
import { describe, expect, it } from "vitest";
import { FORMULA_INDEX } from "@dojix-desktop/core";

const modules = import.meta.glob<Record<string, unknown>>(["./**/*.ts", "!./**/*.test.ts"], { eager: true });

describe("FORMULA_INDEX importer entries", () => {
  const entries = FORMULA_INDEX.filter((f) => f.package === "importers");
  it("exist, belong to I1/I2 and are implemented", () => {
    expect(entries.length).toBeGreaterThan(10);
    for (const f of entries) {
      expect(["I1", "I2"]).toContain(f.owner);
      expect(f.status).toBe("implemented");
    }
    expect(FORMULA_INDEX.filter((f) => f.owner === "I1" || f.owner === "I2").every((f) => f.package === "importers")).toBe(true);
  });
  it("point at existing exports", () => {
    for (const f of entries) {
      const mod = modules[`./${f.module}`];
      expect(mod, `${f.id}: ${f.module}`).toBeDefined();
      for (const name of f.exports ?? []) expect(mod?.[name], `${f.id}: ${name}`).toBeDefined();
    }
  });
});
