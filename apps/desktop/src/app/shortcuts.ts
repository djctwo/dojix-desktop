// Keyboard shortcuts per brand (SPEC 2.1): Ctrl replaces Cmd, Alt replaces Option, F1 is added;
// both brands get Ctrl+N (Add Trade) and Alt+1–6 (analytics tabs). The Help page lists every
// entry of `shortcutsFor`, so this table is the single source.

import type { AnalyticsPlacement, BrandId, ScreenId } from "@dojix-desktop/core";

/** App-wide commands a screen handles (see commands.tsx). */
export type AppCommand = "addTrade" | "exportPdf" | "toggleEssential" | "confirmMapping";

export type ShortcutAction =
  | { type: "navigate"; screen: ScreenId }
  | { type: "analyticsTab"; tab: AnalyticsPlacement }
  | { type: "command"; command: AppCommand; screen?: ScreenId };

export interface ShortcutDef {
  /** Spellings as shown on the Help page; the first is the primary one. */
  keys: readonly string[];
  description: string;
  action: ShortcutAction;
  /** Where it works: everywhere, only on Analytics, or only on Import. */
  scope: "global" | "analytics" | "import";
}

/** Ctrl+1 … in the Mac menu order (Dojix 1–6, Greenwick 1–5; Browse/Watchlist have none). */
export const NUMBERED_SCREENS: Readonly<Record<BrandId, readonly ScreenId[]>> = {
  dojix: ["journal", "dashboard", "analytics", "edgeReport", "pulse", "import"],
  greenwick: ["journal", "dashboard", "analytics", "edgeReport", "import"],
};

/** The Analytics sub-tabs, in the Mac order (Alt+1 … Alt+6). */
export const ANALYTICS_TABS: readonly AnalyticsPlacement[] = ["timing", "sessions", "pairs", "risk", "behavioral", "advanced"];

const SCREEN_NAMES: Readonly<Record<ScreenId, string>> = {
  journal: "Journal",
  dashboard: "Dashboard",
  analytics: "Analytics",
  edgeReport: "Edge Report",
  pulse: "Pulse",
  browse: "Browse",
  watchlist: "Watchlist",
  import: "Import",
  settings: "Settings",
  help: "Help",
};

export function analyticsTabLabel(tab: AnalyticsPlacement, brand: BrandId): string {
  if (tab === "pairs") return brand === "dojix" ? "Pairs" : "Symbols";
  return tab.charAt(0).toUpperCase() + tab.slice(1);
}

export function shortcutsFor(brand: BrandId): ShortcutDef[] {
  const list: ShortcutDef[] = NUMBERED_SCREENS[brand].map((screen, i) => ({
    keys: [`Ctrl+${i + 1}`],
    description: `Show ${SCREEN_NAMES[screen]}`,
    action: { type: "navigate", screen },
    scope: "global",
  }));
  list.push(
    { keys: ["Ctrl+,"], description: "Show Settings", action: { type: "navigate", screen: "settings" }, scope: "global" },
    { keys: ["Ctrl+N"], description: "Add a trade", action: { type: "command", command: "addTrade", screen: "journal" }, scope: "global" },
  );
  if (brand === "greenwick") {
    list.push({ keys: ["Ctrl+I"], description: "Import trades", action: { type: "navigate", screen: "import" }, scope: "global" });
  }
  if (brand === "dojix") {
    list.push(
      { keys: ["Ctrl+E"], description: "Export PDF (Journal, Dashboard, Edge Report)", action: { type: "command", command: "exportPdf" }, scope: "global" },
      {
        keys: ["Ctrl+Shift+E"],
        description: "Switch between Essential and All analytics",
        action: { type: "command", command: "toggleEssential" },
        scope: "global",
      },
    );
  }
  list.push({ keys: ["F1", "Ctrl+?"], description: "Open Help", action: { type: "navigate", screen: "help" }, scope: "global" });
  ANALYTICS_TABS.forEach((tab, i) =>
    list.push({
      keys: [`Alt+${i + 1}`],
      description: `Analytics: ${analyticsTabLabel(tab, brand)} tab`,
      action: { type: "analyticsTab", tab },
      scope: "analytics",
    }),
  );
  list.push({
    keys: ["Ctrl+Enter"],
    description: "Confirm the column mapping",
    action: { type: "command", command: "confirmMapping" },
    scope: "import",
  });
  return list;
}

/** The hint shown next to a sidebar item ("Ctrl+1"). */
export function sidebarHints(brand: BrandId): Partial<Record<ScreenId, string>> {
  const hints: Partial<Record<ScreenId, string>> = {};
  for (const s of shortcutsFor(brand)) {
    if (s.action.type === "navigate" && s.scope === "global" && hints[s.action.screen] === undefined) {
      hints[s.action.screen] = s.keys[0] as string;
    }
  }
  return hints;
}
