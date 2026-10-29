import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ALL_BRANDS } from "@dojix-desktop/brands";
import { AppShell } from "./AppShell";
import { Screen } from "./Screen";

afterEach(cleanup);

describe("AppShell", () => {
  it("follows the Mac sidebar: headerless first section, collapsible others, hints, help", () => {
    const onNavigate = vi.fn();
    const onHelp = vi.fn();
    render(
      <AppShell
        brand={ALL_BRANDS.greenwick}
        active="browse"
        onNavigate={onNavigate}
        shortcutHints={{ journal: "Ctrl+1" }}
        onHelp={onHelp}
        helpHint="F1"
        sidebarExtras={<div data-testid="extras" />}
        status={<span>status</span>}
      >
        <p>content</p>
      </AppShell>,
    );
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main-content");
    expect(screen.getByRole("main").id).toBe("main-content");
    expect(screen.getByRole("list", { name: "Core" })).toBeTruthy();
    const market = screen.getByRole("button", { name: "Market" });
    expect(market.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("nav-browse").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("nav-journal").getAttribute("aria-keyshortcuts")).toBe("Control+1");
    expect(screen.getByTestId("nav-journal").textContent).toContain("Ctrl+1");
    fireEvent.click(market);
    expect(market.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("nav-watchlist").closest("ul")?.hidden).toBe(true);
    fireEvent.click(market);
    expect(screen.getByTestId("nav-watchlist").closest("ul")?.hidden).toBe(false);
    fireEvent.click(screen.getByTestId("nav-import"));
    expect(onNavigate).toHaveBeenCalledWith("import");
    fireEvent.click(screen.getByTestId("nav-help"));
    expect(onHelp).toHaveBeenCalled();
    expect(screen.getByTestId("extras")).toBeTruthy();
  });

  it("omits the help link without a handler", () => {
    render(
      <AppShell brand={ALL_BRANDS.dojix} active="help" onNavigate={() => undefined}>
        x
      </AppShell>,
    );
    expect(screen.queryByTestId("nav-help")).toBeNull();
  });
});

describe("Screen", () => {
  it("renders the h1 e2e reads, actions and subtitle", () => {
    render(
      <Screen title="Edge Report" subtitle="Needs 30 trades." actions={<button>Export</button>} wide testId="s">
        body
      </Screen>,
    );
    expect(screen.getByTestId("screen-title").textContent).toBe("Edge Report");
    expect(screen.getByTestId("s").className).toBe("screen screen-wide");
    expect(screen.getByRole("region", { name: "Edge Report" })).toBeTruthy();
    expect(screen.getByText("Needs 30 trades.")).toBeTruthy();
  });
});
