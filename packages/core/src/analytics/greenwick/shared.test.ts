import { describe, expect, it } from "vitest";
import { stableSorted } from "../../swiftcompat/collections";
import { groupByString, swiftStringKey, swiftStringLess } from "./shared";

describe("Swift String semantics for grouping and sorting", () => {
  it("compares Unicode scalars of the NFC forms", () => {
    expect(swiftStringLess("A", "B")).toBe(true);
    expect(swiftStringLess("B", "A")).toBe(false);
    expect(swiftStringLess("AB", "ABC")).toBe(true);
    expect(swiftStringLess("ABC", "AB")).toBe(false);
    expect(swiftStringLess("Café", "Café")).toBe(false); // canonically equal
    expect(swiftStringLess("�", "\u{1F600}")).toBe(true); // JS `<` says the opposite
    expect("�" < "\u{1F600}").toBe(false);
    expect(stableSorted(["b", "a", "c"], swiftStringLess)).toEqual(["a", "b", "c"]);
    expect(swiftStringKey("é")).toBe("é");
  });

  it("groups canonical equivalents under the first spelling", () => {
    const groups = groupByString(["Zé", "X", "Zé"], (s) => s);
    expect(groups).toEqual([
      { label: "Zé", items: ["Zé", "Zé"] },
      { label: "X", items: ["X"] },
    ]);
  });
});
