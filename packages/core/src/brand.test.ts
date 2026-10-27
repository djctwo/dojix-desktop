import { describe, expect, it } from "vitest";
import {
  type BrandConfig,
  isBrandId,
  journalIsReadyAndEncrypted,
  parseBrandId,
  tokenVar,
  validateBrand,
} from "./index";

const sample: BrandConfig = {
  id: "dojix",
  productName: "Sample",
  identifier: "io.example.sample",
  tagline: "Fictional brand for tests",
  tokens: {
    bgApp: "#000000",
    bgSidebar: "#111111",
    bgContent: "#222222",
    bgCard: "#333333",
    accent: "#e8b44c",
    accentDim: "rgba(232, 180, 76, 0.14)",
    textPrimary: "#ffffff",
    textSecondary: "#aaaaaa",
    textTertiary: "#777777",
    border: "rgba(255, 255, 255, 0.06)",
  },
  instrument: { qtyLabel: "Lots", moveUnit: "pips", symbolNoun: "Pair" },
  sessionModel: "fx-utc",
  sidebar: [{ title: "Core", items: [{ id: "journal", label: "Journal" }] }],
};

describe("brand ids", () => {
  it("accepts only the two brands", () => {
    expect(isBrandId("dojix")).toBe(true);
    expect(isBrandId("greenwick")).toBe(true);
    expect(isBrandId("Dojix")).toBe(false);
    expect(isBrandId(undefined)).toBe(false);
  });

  it("throws on an unknown build brand", () => {
    expect(parseBrandId("greenwick")).toBe("greenwick");
    expect(() => parseBrandId("other")).toThrow(/Unknown brand/);
  });
});

describe("validateBrand", () => {
  it("passes a well-formed brand", () => {
    expect(validateBrand(sample)).toEqual([]);
  });

  it("rejects the Mac apps' bundle identifiers", () => {
    expect(validateBrand({ ...sample, identifier: "com.dojix.app" })).toContain(
      "identifier com.dojix.app collides with a Mac app",
    );
  });

  it("rejects malformed colours and a missing journal", () => {
    const broken: BrandConfig = {
      ...sample,
      tokens: { ...sample.tokens, accent: "gold" },
      sidebar: [{ title: "Core", items: [{ id: "dashboard", label: "Dashboard" }] }],
    };
    const problems = validateBrand(broken);
    expect(problems.some((p) => p.startsWith("token accent"))).toBe(true);
    expect(problems).toContain("sidebar has no journal screen");
  });

  it("rejects duplicate screens", () => {
    const dup: BrandConfig = {
      ...sample,
      sidebar: [
        { title: "A", items: [{ id: "journal", label: "Journal" }] },
        { title: "B", items: [{ id: "journal", label: "Journal again" }] },
      ],
    };
    expect(validateBrand(dup)).toContain("sidebar lists a screen twice");
  });
});

describe("tokenVar", () => {
  it("kebab-cases token names", () => {
    expect(tokenVar("bgApp")).toBe("--bg-app");
    expect(tokenVar("accent")).toBe("--accent");
    expect(tokenVar("textSecondary")).toBe("--text-secondary");
  });
});

describe("journalIsReadyAndEncrypted", () => {
  const base = {
    brand: "dojix",
    productName: "Sample",
    version: "0.0.0",
    dataDirSource: "override" as const,
    vaultBackend: "memory",
  };

  it("is true only for an open, encrypted journal", () => {
    expect(
      journalIsReadyAndEncrypted({ ...base, storage: { kind: "ready", encrypted: true, schemaVersion: 1, setAside: false } }),
    ).toBe(true);
    expect(
      journalIsReadyAndEncrypted({ ...base, storage: { kind: "ready", encrypted: false, schemaVersion: 1, setAside: false } }),
    ).toBe(false);
    expect(
      journalIsReadyAndEncrypted({ ...base, storage: { kind: "error", code: "vault", message: "x" } }),
    ).toBe(false);
  });
});
