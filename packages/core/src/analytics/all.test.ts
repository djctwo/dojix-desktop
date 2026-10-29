import { describe, expect, it } from "vitest";
import { createAnalyticsRegistry } from "./all";
import { E2_COMPONENTS } from "./e2";
import { E3_COMPONENTS } from "./e3";
import { GREENWICK_ONLY_COMPONENTS } from "./greenwick/components";

describe("createAnalyticsRegistry", () => {
  it("holds every engine component once, with a placement for each of its brands", () => {
    const registry = createAnalyticsRegistry();
    const all = [...E2_COMPONENTS, ...E3_COMPONENTS, ...GREENWICK_ONLY_COMPONENTS];
    for (const c of all) expect(registry.get(c.id)).toBe(c);
    const dojix = registry.list("dojix");
    const greenwick = registry.list("greenwick");
    expect(new Set([...dojix, ...greenwick].map((c) => c.id)).size).toBe(all.length);
    expect(greenwick.some((c) => c.id === "GapAnalysis")).toBe(true);
    expect(dojix.some((c) => c.id === "GapAnalysis")).toBe(false);
  });

  it("returns a fresh registry each time", () => {
    expect(createAnalyticsRegistry()).not.toBe(createAnalyticsRegistry());
  });
});
