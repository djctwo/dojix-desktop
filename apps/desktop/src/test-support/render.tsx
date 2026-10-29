// Renders the app (or one screen) on the mock IPC and the in-thread analytics engine, as the
// unit tests need it. Fictional fixtures only.
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { ALL_BRANDS } from "@dojix-desktop/brands";
import type { BrandConfig, BrandId, StoredTrade } from "@dojix-desktop/core";
import { createInlineClient } from "../analytics/inline";
import type { EngineSettings } from "../analytics/protocol";
import { App } from "../app/App";
import { AppProviders } from "../app/AppProviders";
import { NavigationProvider } from "../app/navigation";
import { createQueryClient } from "../data/queries";
import { loadFixture, type MockFixture } from "../mock/fixtures";
import { createMockIpc, MOCK_DEFAULT_NOW, type MockGate, type MockIpc, type MockOptions } from "../mock/mockIpc";

export const TEST_SETTINGS: EngineSettings = {
  tz: "UTC",
  weekStart: 1,
  minDaysInFirstWeek: 1,
  locale: "en_US",
  compat: "fixed",
  brokerOffset: "utc",
};

export interface Harness extends RenderResult {
  ipc: MockIpc;
  brand: BrandConfig;
  trades: StoredTrade[];
}

export interface HarnessOptions {
  brand?: BrandId;
  fixture?: MockFixture;
  gate?: MockGate;
  fail?: MockOptions["fail"];
  /** Render this instead of the whole App (inside the providers and navigation). */
  screen?: (brand: BrandConfig) => ReactNode;
}

export async function renderApp(options: HarnessOptions = {}): Promise<Harness> {
  const brand = ALL_BRANDS[options.brand ?? "dojix"];
  const trades = await loadFixture(options.fixture ?? "f1", brand.id);
  const ipc = createMockIpc(
    {
      brand: brand.id,
      productName: brand.productName,
      fixture: options.fixture ?? "f1",
      gate: options.gate ?? "none",
      now: MOCK_DEFAULT_NOW,
      latencyMs: 0,
      fail: options.fail ?? [],
    },
    trades,
  );
  const ui = (
    <AppProviders
      ipc={ipc}
      queryClient={createQueryClient()}
      createAnalyticsClient={() => createInlineClient()}
      now={() => MOCK_DEFAULT_NOW}
      engineSettings={TEST_SETTINGS}
    >
      {options.screen ? <NavigationProvider brand={brand}>{options.screen(brand)}</NavigationProvider> : <App brand={brand} />}
    </AppProviders>
  );
  return { ...render(ui), ipc, brand, trades };
}
