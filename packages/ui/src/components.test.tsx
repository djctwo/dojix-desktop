import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ALL_BRANDS } from "@dojix-desktop/brands";
import { BRAND_IDS, type JournalRow } from "@dojix-desktop/core";
import { AppShell, JournalScreen, PlaceholderScreen, StartupError, applyBrandTokens } from "./index";

afterEach(cleanup);

describe.each(BRAND_IDS)("%s shell", (id) => {
  const brand = ALL_BRANDS[id];

  it("shows the brand name and every sidebar item, with Journal active", () => {
    const onNavigate = vi.fn();
    render(
      <AppShell brand={brand} active="journal" onNavigate={onNavigate}>
        <p>content</p>
      </AppShell>,
    );
    expect(screen.getByTestId("brand-name").textContent).toBe(brand.productName);
    for (const item of brand.sidebar.flatMap((s) => s.items)) {
      expect(screen.getByTestId(`nav-${item.id}`).textContent).toBe(item.label);
    }
    expect(screen.getByTestId("nav-journal").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByTestId("nav-settings"));
    expect(onNavigate).toHaveBeenCalledWith("settings");
  });

  it("renders the empty journal", () => {
    render(<JournalScreen brand={brand} rows={[]} />);
    expect(screen.getByTestId("screen-title").textContent).toBe("Journal");
    expect(screen.getByTestId("journal-empty").textContent).toContain("No trades yet");
    expect(screen.getByTestId("journal-empty").textContent).toContain(brand.productName);
  });

  it("applies the brand tokens as CSS variables", () => {
    const root = document.createElement("div");
    applyBrandTokens(brand, root);
    expect(root.style.getPropertyValue("--accent")).toBe(brand.tokens.accent);
    expect(root.style.getPropertyValue("--bg-app")).toBe(brand.tokens.bgApp);
    expect(root.dataset["brand"]).toBe(id);
  });
});

describe("JournalScreen", () => {
  it("shows a loading line before rows arrive", () => {
    render(<JournalScreen brand={ALL_BRANDS.dojix} rows={null} />);
    expect(screen.getByTestId("journal-loading")).toBeTruthy();
  });

  it("renders rows with the brand's symbol noun (fictional data)", () => {
    const rows: JournalRow[] = [
      { id: 1, symbol: "TEST1", direction: "BUY", closeTime: "2026-01-02 10:00:00.000", netProfit: "12.5" },
    ];
    render(<JournalScreen brand={ALL_BRANDS.greenwick} rows={rows} />);
    expect(screen.getByTestId("journal-table").textContent).toContain("Symbol");
    expect(screen.getByTestId("journal-table").textContent).toContain("TEST1");
  });
});

describe("other screens", () => {
  it("renders a placeholder and a startup error", () => {
    render(<PlaceholderScreen title="Dashboard" />);
    expect(screen.getByTestId("screen-title").textContent).toBe("Dashboard");
    cleanup();
    render(<StartupError productName="Dojix" message="The system keyring is not available." />);
    expect(screen.getByRole("alert").textContent).toContain("keyring");
  });
});
