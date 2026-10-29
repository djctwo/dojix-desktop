import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyBrandTokens } from "@dojix-desktop/ui";
import "@dojix-desktop/ui/styles.css";
import { createDefaultClient } from "./analytics/client";
import { App } from "./app/App";
import { AppProviders } from "./app/AppProviders";
import { brand } from "./brand";
import { createQueryClient } from "./data/queries";
import { tauriIpc } from "./ipc";
import type { Ipc } from "./ipc/contract";

applyBrandTokens(brand, document.documentElement);
document.title = brand.productName;

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");
const root = createRoot(container);

async function start(): Promise<void> {
  let ipc: Ipc = tauriIpc;
  let now: (() => number) | undefined;
  // Mock builds only (VITE_IPC=mock): the branch is constant-folded away in release builds, and
  // ci.yml checks that no fixture text reaches dist/.
  if (import.meta.env.VITE_IPC === "mock") {
    const mock = await import("./mock/start");
    const started = await mock.startMock(brand);
    ipc = started.ipc;
    now = started.now;
  }
  root.render(
    <StrictMode>
      <AppProviders ipc={ipc} queryClient={createQueryClient()} createAnalyticsClient={createDefaultClient} now={now}>
        <App brand={brand} />
      </AppProviders>
    </StrictMode>,
  );
}

void start();
