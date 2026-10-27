import { describe, expect, it } from "vitest";
import { graphemes, macTagList, swiftCount, swiftPrefix, swiftSplit, swiftSuffix, trimSwiftWhitespaces } from "./strings";

describe("Swift String = Characters", () => {
  it("counts grapheme clusters, not UTF-16 units", () => {
    expect(swiftCount("EURUSD")).toBe(6);
    expect(swiftCount("🇪🇺USD")).toBe(4);
    expect("🇪🇺USD".length).toBe(7);
    expect(swiftCount("é")).toBe(1);
    expect(graphemes("ab")).toEqual(["a", "b"]);
  });

  it("prefix / suffix take whole Characters (Trade.baseCurrency / quoteCurrency)", () => {
    expect(swiftPrefix("GBPUSD", 3)).toBe("GBP");
    expect(swiftSuffix("GBPUSD", 3)).toBe("USD");
    expect(swiftPrefix("🇪🇺🇺🇸X", 2)).toBe("🇪🇺🇺🇸");
    expect(swiftSuffix("X🇯🇵", 1)).toBe("🇯🇵");
    expect(swiftPrefix("AB", 5)).toBe("AB");
    expect(swiftPrefix("AB", -1)).toBe("");
    expect(swiftSuffix("AB", 0)).toBe("");
  });
});

describe("trimSwiftWhitespaces (.whitespaces)", () => {
  it("trims spaces, tabs and Zs, but keeps newlines unlike JS trim()", () => {
    expect(trimSwiftWhitespaces(" \t a b  ")).toBe("a b");
    expect(trimSwiftWhitespaces("　x ")).toBe("x");
    expect(trimSwiftWhitespaces("\nx\n")).toBe("\nx\n");
    expect("\nx\n".trim()).toBe("x");
    expect(trimSwiftWhitespaces("﻿x")).toBe("﻿x");
  });
});

describe("split and tag lists", () => {
  it("omits empty pieces like split(separator:)", () => {
    expect(swiftSplit(",a,,b,", ",")).toEqual(["a", "b"]);
    expect(swiftSplit("", ",")).toEqual([]);
    // "," + combining mark is one Character, so it doesn't split
    expect(swiftSplit("a,́b", ",")).toEqual(["a,́b"]);
  });

  it("macTagList matches Trade.tagList", () => {
    expect(macTagList(" breakout , news,, ,A+ ")).toEqual(["breakout", "news", "A+"]);
    expect(macTagList("")).toEqual([]);
  });
});
