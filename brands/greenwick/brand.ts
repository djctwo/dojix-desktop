import type { BrandConfig } from "@dojix-desktop/core";

/** Greenwick: the stock journal. Colours match the Mac app's theme. */
export const greenwick: BrandConfig = {
  id: "greenwick",
  productName: "Greenwick",
  identifier: "io.github.djctwo.greenwick",
  tagline: "Stock trade journal",
  tokens: {
    bgApp: "#0c0d0e",
    bgSidebar: "#101214",
    bgContent: "#0e1012",
    bgCard: "#151718",
    accent: "#00d4aa",
    accentDim: "rgba(0, 212, 170, 0.10)",
    textPrimary: "#e0e4e8",
    textSecondary: "#7a8490",
    textTertiary: "#4a5560",
    border: "rgba(200, 210, 220, 0.08)",
  },
  instrument: { qtyLabel: "Shares", moveUnit: "points", symbolNoun: "Symbol" },
  sessionModel: "us-equities-et",
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
      title: "Market",
      items: [
        { id: "browse", label: "Browse" },
        { id: "watchlist", label: "Watchlist" },
      ],
    },
    {
      title: "Tools",
      items: [
        { id: "edgeReport", label: "Edge Report" },
        { id: "import", label: "Import" },
        { id: "settings", label: "Settings" },
      ],
    },
  ],
};
