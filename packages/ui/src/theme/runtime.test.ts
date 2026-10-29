import { describe, expect, it } from "vitest";
import { ALL_BRANDS } from "@dojix-desktop/brands";
import { applyBrandTokens, pairColorVar, pnlTone, readThemeColors, sessionColorVar } from "./tokens";
import { chartTheme } from "../charts/theme";

describe("runtime theme", () => {
  it("applies every brand token and reads them back for charts", () => {
    const root = document.createElement("div");
    document.body.append(root);
    applyBrandTokens(ALL_BRANDS.greenwick, root);
    root.style.setProperty("--green", "#5cc98a");
    const colors = readThemeColors(root);
    expect(colors.accent).toBe("#00d4aa");
    expect(colors.profit).toBe("#5cc98a");
    expect(colors.loss).toBe("#888888");
    expect(root.dataset["brand"]).toBe("greenwick");
    const theme = chartTheme(colors) as { color: string[]; backgroundColor: string };
    expect(theme.color[0]).toBe("#00d4aa");
    expect(theme.backgroundColor).toBe("transparent");
    root.remove();
  });

  it("maps P&L, sessions and pairs to colour roles like the Mac", () => {
    expect(pnlTone(1)).toBe("profit");
    expect(pnlTone(-0.01)).toBe("loss");
    expect(pnlTone(0)).toBe("flat");
    expect(sessionColorVar("LONDON")).toBe("var(--blue)");
    expect(sessionColorVar("AFTER_HOURS")).toBe("var(--amber)");
    expect(sessionColorVar("OTHER")).toBe("var(--text-secondary)");
    expect(pairColorVar("eurusd.m")).toBe("var(--green)");
    expect(pairColorVar("GBPJPY")).toBe("var(--red)");
    expect(pairColorVar("GBPUSD")).toBe("var(--purple)");
    expect(pairColorVar("AUDUSD")).toBe("var(--amber)");
    expect(pairColorVar("USDJPY")).toBe("var(--blue)");
    expect(pairColorVar("XAUUSD")).toBe("var(--text-secondary)");
  });
});
