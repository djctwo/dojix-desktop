import type { BrandConfig } from "@dojix-desktop/core";
import type { Ipc } from "../ipc/contract";
import { loadFixture } from "./fixtures";
import { createMockIpc, type MockIpc, mockOptionsFromSearch } from "./mockIpc";

declare global {
  interface Window {
    /** Mock builds only: lets Playwright send shell events and inspect calls. */
    __mockIpc?: MockIpc;
  }
}

/** Builds the mock IPC from the page's query string and the brand's fixture journal. */
export async function startMock(brand: BrandConfig): Promise<{ ipc: Ipc; now: () => number }> {
  const options = mockOptionsFromSearch(location.search, brand.id, brand.productName);
  const trades = await loadFixture(options.fixture, brand.id);
  const ipc = createMockIpc(options, trades);
  window.__mockIpc = ipc;
  document.documentElement.dataset["mock"] = "true";
  return { ipc, now: () => options.now };
}
