import { type BrandConfig, type BrandTokens, tokenVar } from "@dojix-desktop/core";

/** Writes a brand's colour tokens onto an element as CSS custom properties (bgApp → --bg-app). */
export function applyBrandTokens(brand: BrandConfig, root: HTMLElement): void {
  for (const name of Object.keys(brand.tokens) as (keyof BrandTokens)[]) {
    root.style.setProperty(tokenVar(name), brand.tokens[name]);
  }
  root.dataset["brand"] = brand.id;
}

/** The shared semantic colours (theme/theme.css), by meaning. */
export const SEMANTIC_COLORS = ["green", "red", "blue", "purple", "amber", "cyan", "pink"] as const;
export type SemanticColor = (typeof SEMANTIC_COLORS)[number];

/** The colours a chart or canvas needs, resolved from the custom properties at run time. */
export interface ThemeColors {
  accent: string;
  accentDim: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  bgCard: string;
  border: string;
  borderSubtle: string;
  breakeven: string;
  profit: string;
  loss: string;
  semantic: Record<SemanticColor, string>;
  fontUi: string;
  fontMono: string;
}

/** Fallbacks for environments without computed styles (unit tests): neutral greys only. */
const FALLBACK = "#888888";

function read(style: CSSStyleDeclaration, name: string): string {
  const value = style.getPropertyValue(name).trim();
  return value === "" ? FALLBACK : value;
}

/** Reads the resolved theme from an element (default: <html>). */
export function readThemeColors(root: Element = document.documentElement): ThemeColors {
  const style = getComputedStyle(root);
  const semantic = Object.fromEntries(SEMANTIC_COLORS.map((c) => [c, read(style, `--${c}`)])) as Record<
    SemanticColor,
    string
  >;
  return {
    accent: read(style, "--accent"),
    accentDim: read(style, "--accent-dim"),
    textPrimary: read(style, "--text-primary"),
    textSecondary: read(style, "--text-secondary"),
    textTertiary: read(style, "--text-tertiary"),
    bgCard: read(style, "--bg-card"),
    border: read(style, "--border"),
    borderSubtle: read(style, "--border-subtle"),
    breakeven: read(style, "--breakeven"),
    profit: semantic.green,
    loss: semantic.red,
    semantic,
    fontUi: style.getPropertyValue("--font-ui").trim() || "sans-serif",
    fontMono: style.getPropertyValue("--font-mono").trim() || "monospace",
  };
}

/** CSS colour for a P&L value (Mac `Color.forPnL`): profit, loss, or the flat text colour. */
export function pnlTone(value: number): "profit" | "loss" | "flat" {
  if (value > 0) return "profit";
  if (value < 0) return "loss";
  return "flat";
}

/** Session colours (Mac `Color.forSession`), as custom-property references. */
const SESSION_VARS: Readonly<Record<string, string>> = {
  // Dojix (forex)
  ASIAN: "var(--purple)",
  LONDON: "var(--blue)",
  NY_OVERLAP: "var(--amber)",
  NY: "var(--cyan)",
  LATE: "var(--text-tertiary)",
  // Greenwick (US equities)
  PRE_MARKET: "var(--purple)",
  REGULAR: "var(--blue)",
  AFTER_HOURS: "var(--amber)",
  EXTENDED: "var(--text-tertiary)",
};

export function sessionColorVar(session: string): string {
  return SESSION_VARS[session] ?? "var(--text-secondary)";
}

/** Dojix pair colours (Mac `Color.forPair`); other symbols get the secondary text colour. */
export function pairColorVar(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.includes("GBPUSD")) return "var(--purple)";
  if (s.includes("AUDUSD")) return "var(--amber)";
  if (s.includes("USDJPY")) return "var(--blue)";
  if (s.includes("EURUSD")) return "var(--green)";
  if (s.includes("GBPJPY")) return "var(--red)";
  return "var(--text-secondary)";
}
