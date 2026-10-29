import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { AnalyticsPlacement, BrandConfig, ScreenId } from "@dojix-desktop/core";
import { ANALYTICS_TABS } from "./shortcuts";

export interface Navigation {
  screen: ScreenId;
  analyticsTab: AnalyticsPlacement;
  navigate(screen: ScreenId): void;
  showAnalyticsTab(tab: AnalyticsPlacement): void;
}

const NavigationContext = createContext<Navigation | null>(null);

/** Screens this brand can show: its sidebar plus Help. */
export function screensOf(brand: BrandConfig): ScreenId[] {
  return [...brand.sidebar.flatMap((s) => s.items.map((i) => i.id)), "help"];
}

/** "#/analytics/risk" → { screen: "analytics", tab: "risk" } for this brand; anything else → null. */
export function parseLocationHash(hash: string, brand: BrandConfig): { screen: ScreenId; tab: AnalyticsPlacement | null } | null {
  const [screen, tab] = hash.replace(/^#\/?/, "").split("/");
  if (!screen || !screensOf(brand).includes(screen as ScreenId)) return null;
  const validTab = tab && (ANALYTICS_TABS as readonly string[]).includes(tab) ? (tab as AnalyticsPlacement) : null;
  return { screen: screen as ScreenId, tab: validTab };
}

/**
 * Which screen and analytics tab are shown. The app opens on Journal, as on the Mac; the
 * location hash mirrors the state (`#/analytics/risk`) so the mock build can deep-link screens
 * for development and tests. State survives screen switches for the session only.
 */
export function NavigationProvider({ brand, children }: { brand: BrandConfig; children: ReactNode }) {
  const [state, setState] = useState<{ screen: ScreenId; tab: AnalyticsPlacement }>(() => {
    const parsed = typeof location !== "undefined" ? parseLocationHash(location.hash, brand) : null;
    return { screen: parsed?.screen ?? "journal", tab: parsed?.tab ?? "timing" };
  });

  useEffect(() => {
    const target = state.screen === "analytics" ? `#/analytics/${state.tab}` : `#/${state.screen}`;
    if (location.hash !== target) history.replaceState(null, "", target);
  }, [state]);

  const navigate = useCallback(
    (screen: ScreenId) => setState((s) => (screensOf(brand).includes(screen) ? { ...s, screen } : s)),
    [brand],
  );
  const showAnalyticsTab = useCallback((tab: AnalyticsPlacement) => setState({ screen: "analytics", tab }), []);
  const value = useMemo<Navigation>(
    () => ({ screen: state.screen, analyticsTab: state.tab, navigate, showAnalyticsTab }),
    [state, navigate, showAnalyticsTab],
  );
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): Navigation {
  const nav = useContext(NavigationContext);
  if (!nav) throw new Error("useNavigation needs a <NavigationProvider> above it");
  return nav;
}
