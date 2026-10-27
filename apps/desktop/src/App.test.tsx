import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ALL_BRANDS } from "@dojix-desktop/brands";
import type { AppInfo, JournalRow } from "@dojix-desktop/core";
import { App } from "./App";
import type { Ipc } from "./ipc";

afterEach(cleanup);

function mockIpc(info: AppInfo, rows: JournalRow[] = []): Ipc & { listCalls: number } {
  const ipc = {
    listCalls: 0,
    appInfo: () => Promise.resolve(info),
    listTrades: () => {
      ipc.listCalls += 1;
      return Promise.resolve(rows);
    },
  };
  return ipc;
}

const readyInfo: AppInfo = {
  brand: "dojix",
  productName: "Dojix",
  version: "0.1.0",
  dataDirSource: "override",
  vaultBackend: "memory",
  storage: { kind: "ready", encrypted: true, schemaVersion: 1, setAside: false },
};

describe("App", () => {
  it("opens on the empty Journal and reports the journal as encrypted", async () => {
    render(<App brand={ALL_BRANDS.dojix} ipc={mockIpc(readyInfo)} />);
    await waitFor(() => expect(screen.getByTestId("journal-empty")).toBeTruthy());
    expect(screen.getByTestId("db-status").dataset["encrypted"]).toBe("true");
    expect(screen.getByTestId("app-version").textContent).toBe("v0.1.0");
  });

  it("tells the user when an unreadable journal was set aside", async () => {
    const info: AppInfo = {
      ...readyInfo,
      storage: { kind: "ready", encrypted: true, schemaVersion: 1, setAside: true },
    };
    render(<App brand={ALL_BRANDS.dojix} ipc={mockIpc(info)} />);
    await waitFor(() => expect(screen.getByTestId("set-aside-notice")).toBeTruthy());
  });

  it("shows a placeholder for screens not built yet", async () => {
    render(<App brand={ALL_BRANDS.greenwick} ipc={mockIpc({ ...readyInfo, brand: "greenwick" })} />);
    await waitFor(() => expect(screen.getByTestId("journal-empty")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-watchlist"));
    expect(screen.getByTestId("screen-title").textContent).toBe("Watchlist");
    expect(screen.getByTestId("screen-placeholder")).toBeTruthy();
  });

  it("shows the startup error and never lists trades when storage failed", async () => {
    const ipc = mockIpc({
      ...readyInfo,
      storage: { kind: "error", code: "vault_unavailable", message: "No system keyring was found." },
    });
    render(<App brand={ALL_BRANDS.dojix} ipc={ipc} />);
    await waitFor(() => expect(screen.getByTestId("startup-error")).toBeTruthy());
    expect(screen.getByTestId("startup-error").textContent).toContain("No system keyring");
    expect(ipc.listCalls).toBe(0);
    expect(screen.getByTestId("db-status").dataset["encrypted"]).toBe("false");
  });

  it("shows the startup error when the shell call itself fails", async () => {
    const ipc: Ipc = {
      appInfo: () => Promise.reject(new Error("command app_info not found")),
      listTrades: () => Promise.resolve([]),
    };
    render(<App brand={ALL_BRANDS.dojix} ipc={ipc} />);
    await waitFor(() => expect(screen.getByTestId("startup-error")).toBeTruthy());
  });
});
