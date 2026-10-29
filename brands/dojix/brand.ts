import type { BrandConfig } from "@dojix-desktop/core";

/** Dojix: the forex journal. Colours match the Mac app's theme (Dojix `Extensions/Color+Theme.swift`). */
export const dojix: BrandConfig = {
  id: "dojix",
  productName: "Dojix",
  identifier: "io.github.djctwo.dojix",
  tagline: "Forex trade journal",
  tokens: {
    bgApp: "#0e0d0b",
    bgSidebar: "#141310",
    bgContent: "#111110",
    bgCard: "#1c1b18",
    bgCardHover: "#232220",
    bgInset: "rgba(255, 220, 160, 0.03)",
    accent: "#e8b44c",
    accentDim: "rgba(232, 180, 76, 0.14)",
    accentDark: "#d49a30",
    onAccent: "#0e0d0b",
    textPrimary: "#ece8df",
    textSecondary: "#918d82",
    textTertiary: "#5e5b52",
    border: "rgba(255, 220, 160, 0.08)",
    borderSubtle: "rgba(255, 220, 160, 0.06)",
    borderActive: "rgba(232, 180, 76, 0.35)",
    breakeven: "#808080",
  },
  instrument: { qtyLabel: "Lots", moveUnit: "pips", symbolNoun: "Pair" },
  sessionModel: "fx-utc",
  sidebar: [
    {
      title: "Core",
      items: [
        { id: "journal", label: "Journal" },
        { id: "dashboard", label: "Dashboard" },
        { id: "analytics", label: "Analytics" },
      ],
    },
    {
      title: "Tools",
      items: [
        { id: "edgeReport", label: "Edge Report" },
        { id: "pulse", label: "Pulse" },
        { id: "import", label: "Import" },
        { id: "settings", label: "Settings" },
      ],
    },
  ],
};
