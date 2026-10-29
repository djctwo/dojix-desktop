import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ALL_BRANDS } from "@dojix-desktop/brands";
import { CommandProvider, createCommandBus, useAppCommand, useCommandBus } from "./commands";
import { NavigationProvider, parseLocationHash, screensOf, useNavigation } from "./navigation";
import { SessionStateProvider, useSessionState } from "./sessionState";
import { ANALYTICS_TABS, analyticsTabLabel, NUMBERED_SCREENS, shortcutsFor, sidebarHints } from "./shortcuts";

afterEach(cleanup);

describe("shortcuts (SPEC 2.1)", () => {
  it("Dojix: Ctrl+1–6, Ctrl+, Ctrl+N, Ctrl+E, Ctrl+Shift+E, F1 / Ctrl+?, Alt+1–6, Ctrl+Enter", () => {
    const keys = shortcutsFor("dojix").flatMap((s) => s.keys);
    expect(keys).toEqual([
      "Ctrl+1",
      "Ctrl+2",
      "Ctrl+3",
      "Ctrl+4",
      "Ctrl+5",
      "Ctrl+6",
      "Ctrl+,",
      "Ctrl+N",
      "Ctrl+E",
      "Ctrl+Shift+E",
      "F1",
      "Ctrl+?",
      "Alt+1",
      "Alt+2",
      "Alt+3",
      "Alt+4",
      "Alt+5",
      "Alt+6",
      "Ctrl+Enter",
    ]);
    expect(NUMBERED_SCREENS.dojix[4]).toBe("pulse");
  });

  it("Greenwick: Ctrl+1–5, Ctrl+, Ctrl+N, Ctrl+I, F1 / Ctrl+?, Alt+1–6, Ctrl+Enter (no Ctrl+E)", () => {
    const keys = shortcutsFor("greenwick").flatMap((s) => s.keys);
    expect(keys).toContain("Ctrl+I");
    expect(keys).toContain("Ctrl+5");
    expect(keys).not.toContain("Ctrl+6");
    expect(keys).not.toContain("Ctrl+E");
    expect(NUMBERED_SCREENS.greenwick[4]).toBe("import");
  });

  it("hints and tab labels", () => {
    expect(sidebarHints("greenwick")).toEqual({
      journal: "Ctrl+1",
      dashboard: "Ctrl+2",
      analytics: "Ctrl+3",
      edgeReport: "Ctrl+4",
      import: "Ctrl+5",
      settings: "Ctrl+,",
      help: "F1",
    });
    expect(ANALYTICS_TABS.map((t) => analyticsTabLabel(t, "greenwick"))).toEqual(["Timing", "Sessions", "Symbols", "Risk", "Behavioral", "Advanced"]);
    expect(analyticsTabLabel("pairs", "dojix")).toBe("Pairs");
  });
});

describe("command bus", () => {
  it("runs subscribers and keeps a command until one subscribes", async () => {
    const bus = createCommandBus();
    const early = vi.fn();
    bus.dispatch("addTrade");
    const stop = bus.subscribe("addTrade", early);
    await Promise.resolve();
    expect(early).toHaveBeenCalledTimes(1);
    bus.dispatch("addTrade");
    expect(early).toHaveBeenCalledTimes(2);
    stop();
    bus.dispatch("addTrade");
    expect(early).toHaveBeenCalledTimes(2);
  });

  it("useAppCommand handles commands while mounted", () => {
    const handler = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => <CommandProvider>{children}</CommandProvider>;
    const { result } = renderHook(
      () => {
        useAppCommand("exportPdf", handler);
        return useCommandBus();
      },
      { wrapper },
    );
    act(() => result.current.dispatch("exportPdf"));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(() => renderHook(() => useCommandBus())).toThrow(/CommandProvider/);
  });
});

describe("navigation", () => {
  const brand = ALL_BRANDS.dojix;

  it("parses deep links for the brand only", () => {
    expect(screensOf(brand)).toContain("help");
    expect(parseLocationHash("#/analytics/risk", brand)).toEqual({ screen: "analytics", tab: "risk" });
    expect(parseLocationHash("#/analytics/nope", brand)).toEqual({ screen: "analytics", tab: null });
    expect(parseLocationHash("#/watchlist", brand)).toBeNull();
    expect(parseLocationHash("", brand)).toBeNull();
  });

  it("ignores screens the brand doesn't have", () => {
    history.replaceState(null, "", "#");
    const wrapper = ({ children }: { children: ReactNode }) => <NavigationProvider brand={brand}>{children}</NavigationProvider>;
    const { result } = renderHook(() => useNavigation(), { wrapper });
    expect(result.current.screen).toBe("journal");
    act(() => result.current.navigate("watchlist"));
    expect(result.current.screen).toBe("journal");
    act(() => result.current.showAnalyticsTab("advanced"));
    expect(result.current.screen).toBe("analytics");
    expect(location.hash).toBe("#/analytics/advanced");
    expect(() => renderHook(() => useNavigation())).toThrow(/NavigationProvider/);
  });
});

describe("session state", () => {
  it("survives remounts within the provider", () => {
    function Probe() {
      const [v, set] = useSessionState("k", 1);
      return (
        <button data-testid="b" onClick={() => set(v + 1)}>
          {v}
        </button>
      );
    }
    const { rerender } = render(
      <SessionStateProvider>
        <Probe />
      </SessionStateProvider>,
    );
    act(() => screen.getByTestId("b").click());
    rerender(
      <SessionStateProvider>
        <div>
          <Probe />
        </div>
      </SessionStateProvider>,
    );
    expect(screen.getByTestId("b").textContent).toBe("2");
    expect(() => render(<Probe />)).toThrow(/SessionStateProvider/);
  });
});
