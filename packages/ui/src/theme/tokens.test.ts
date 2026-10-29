// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_BRANDS } from "@dojix-desktop/brands";
import { BRAND_IDS } from "@dojix-desktop/core";
import { composite, contrastRatio, relativeLuminance } from "./contrast";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

/** A shared token's value from theme.css (the single source). */
function shared(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`--${name} missing from theme.css`);
  return (m[1] as string).trim();
}

const AA = 4.5;

describe("contrast helpers", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    expect(composite("rgba(255, 255, 255, 0.5)", "#000000")).toEqual([128, 128, 128]);
    expect(() => contrastRatio("gold", "#000000")).toThrow(/unsupported/);
  });
});

describe.each(BRAND_IDS)("%s tokens", (id) => {
  const t = ALL_BRANDS[id].tokens;
  const surfaces = { bgApp: t.bgApp, bgSidebar: t.bgSidebar, bgContent: t.bgContent, bgCard: t.bgCard };
  const text = {
    textPrimary: t.textPrimary,
    textSecondary: t.textSecondary,
    accent: t.accent,
    profit: shared("green"),
    loss: shared("red"),
    info: shared("blue"),
    warning: shared("amber"),
    purple: shared("purple"),
    cyan: shared("cyan"),
  };

  it.each(Object.entries(text))("%s text meets AA (4.5:1) on every surface", (_name, color) => {
    for (const [surface, bg] of Object.entries(surfaces)) {
      expect(contrastRatio(color, bg), surface).toBeGreaterThanOrEqual(AA);
    }
  });

  it("text on solid accent and danger fills meets AA", () => {
    expect(contrastRatio(t.onAccent, t.accent)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(t.onAccent, t.accentDark)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(t.onAccent, shared("red"))).toBeGreaterThanOrEqual(AA);
  });

  it("the selected sidebar item (accent on the accent tint) meets AA", () => {
    const tint = composite(t.accentDim, t.bgSidebar);
    const hex = `#${tint.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    expect(contrastRatio(t.accent, hex)).toBeGreaterThanOrEqual(AA);
  });

  it("keeps the Mac's tertiary grey for non-text marks only (it is below 3:1)", () => {
    expect(contrastRatio(t.textTertiary, t.bgCard)).toBeLessThan(3);
    expect(css).toContain("--flat-text: var(--text-secondary)");
  });

  it("focus rings (accent) stand out from every surface by 3:1 (WCAG 1.4.11)", () => {
    for (const bg of Object.values(surfaces)) expect(contrastRatio(t.accent, bg)).toBeGreaterThanOrEqual(3);
  });
});

describe("fonts", () => {
  it("are bundled locally with their licences, never loaded from the network", () => {
    const fonts = readFileSync(new URL("../fonts/fonts.css", import.meta.url), "utf8");
    expect(fonts).not.toMatch(/https?:/);
    expect(fonts).toMatch(/url\("\.\/DMSans-Variable\.ttf"\)/);
    for (const f of ["OFL-DMSans.txt", "OFL-JetBrainsMono.txt", "JetBrainsMono-Regular.ttf"]) {
      expect(readFileSync(new URL(`../fonts/${f}`, import.meta.url)).length).toBeGreaterThan(1000);
    }
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(styles).not.toMatch(/@import\s+url\(["']?https?:/);
    expect(styles).not.toMatch(/https?:\/\//);
  });
});
