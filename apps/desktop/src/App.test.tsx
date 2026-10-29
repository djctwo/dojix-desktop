import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ALL_BRANDS } from "@dojix-desktop/brands";
import type { AppInfo, JournalRow, LockStatus, Mt5ImportSummary, Mt5Status } from "@dojix-desktop/core";
import { App } from "./App";
import type { Ipc } from "./ipc";

afterEach(cleanup);

const readyInfo: AppInfo = {
  brand: "dojix",
  productName: "Dojix",
  version: "0.1.0",
  dataDirSource: "override",
  vaultBackend: "memory",
  storage: { kind: "ready", encrypted: true, schemaVersion: 1, setAside: false },
};

const base = {
  lockEnabled: false,
  lockRequired: false,
  vaultBackend: "memory",
  throttle: { attempts: 0, waitSeconds: 0, unreadable: false, message: null },
  idleLockMinutes: 15,
  saveFailing: false,
  setAside: false,
};
const unlocked: LockStatus = { phase: "unlocked", ...base };
const locked: LockStatus = { phase: "locked", vaultUnreadable: false, held: false, ...base, lockEnabled: true };

const row: JournalRow = {
  id: 1,
  symbol: "TESTSYM",
  direction: "BUY",
  closeTime: "2026-01-05 10:30:00.000",
  netProfit: "12.5",
};

type MockIpc = Ipc & { listCalls: number };

const emptyMt5Status: Mt5Status = { active: false, prefix32: "", folders: [], files: [], pending: [], lastImport: null };

function mockIpc(info: AppInfo, status: LockStatus = unlocked, rows: JournalRow[] = []): MockIpc {
  const fail = () => Promise.reject({ code: "unexpected", message: "not mocked" });
  const ipc: MockIpc = {
    listCalls: 0,
    appInfo: () => Promise.resolve(info),
    listTrades: () => {
      ipc.listCalls += 1;
      return Promise.resolve(rows);
    },
    lockStatus: () => Promise.resolve(status),
    unlock: fail,
    setupPassword: fail,
    enableLock: fail,
    changePassword: fail,
    disableLock: fail,
    lockNow: () => Promise.resolve(true),
    activity: () => undefined,
    openOlderCopy: fail,
    setIdleMinutes: () => Promise.resolve(),
    eraseAll: fail,
    saveRetry: () => Promise.resolve(),
    quit: () => Promise.resolve(),
    exportBackup: () => Promise.resolve(null),
    pickBackup: () => Promise.resolve(null),
    restoreBackup: fail,
    onEvent: () => () => undefined,
    mt5Discover: () => Promise.resolve([]),
    mt5Status: () => Promise.resolve(emptyMt5Status),
    mt5WatchSet: fail,
    mt5AddFolder: () => Promise.resolve(null),
    mt5RemoveFolder: fail,
    mt5SetPrefix: fail,
    mt5Rescan: fail,
    mt5Read: fail,
    mt5ImportCommit: fail,
  };
  return ipc;
}

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
    const ipc = mockIpc(readyInfo);
    ipc.appInfo = () => Promise.reject(new Error("command app_info not found"));
    render(<App brand={ALL_BRANDS.dojix} ipc={ipc} />);
    await waitFor(() => expect(screen.getByTestId("startup-error")).toBeTruthy());
  });

  it("locked: shows only the lock screen, lists nothing, then unlocks", async () => {
    const ipc = mockIpc(readyInfo, locked, [row]);
    ipc.unlock = vi.fn((password: string) =>
      password === "fictional-pass-1"
        ? Promise.resolve({ ...unlocked, lockEnabled: true })
        : Promise.reject({ code: "wrong_password", message: "Incorrect password (1/5)" }),
    );
    render(<App brand={ALL_BRANDS.dojix} ipc={ipc} />);
    await waitFor(() => expect(screen.getByTestId("lock-screen")).toBeTruthy());
    expect(screen.queryByTestId("journal-table")).toBeNull();
    expect(screen.queryByTestId("brand-name")).toBeNull();
    expect(ipc.listCalls).toBe(0);

    fireEvent.change(screen.getByTestId("lock-password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByTestId("lock-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("lock-message").textContent).toBe("Incorrect password (1/5)"),
    );
    expect((screen.getByTestId("lock-password") as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByTestId("lock-password"), { target: { value: "fictional-pass-1" } });
    fireEvent.click(screen.getByTestId("lock-submit"));
    await waitFor(() => expect(screen.getByTestId("journal-table").textContent).toContain("TESTSYM"));
    expect(screen.getByTestId("lock-status-on")).toBeTruthy();
  });

  it("shows the throttle wait from the shell on the lock screen", async () => {
    const waiting: LockStatus = {
      ...locked,
      throttle: {
        attempts: 5,
        waitSeconds: 30,
        unreadable: false,
        message: "Too many attempts. Try again in 30 seconds.",
      },
    };
    render(<App brand={ALL_BRANDS.dojix} ipc={mockIpc(readyInfo, waiting)} />);
    await waitFor(() => expect(screen.getByTestId("lock-message").textContent).toContain("30 seconds"));
  });

  it("older copy: nothing opens until confirmed", async () => {
    const older: LockStatus = {
      phase: "olderCopy",
      fileSavedAtMs: 1_767_225_600_000,
      fileGeneration: 3,
      recordSavedAtMs: 1_767_312_000_000,
      recordGeneration: 9,
      needsPassword: false,
      ...base,
    };
    const ipc = mockIpc(readyInfo, older, [row]);
    ipc.openOlderCopy = vi.fn(() => Promise.resolve(unlocked));
    render(<App brand={ALL_BRANDS.dojix} ipc={ipc} />);
    await waitFor(() => expect(screen.getByTestId("older-copy")).toBeTruthy());
    expect(ipc.listCalls).toBe(0);
    const open = screen.getByTestId("older-open") as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("older-confirm"));
    fireEvent.click(open);
    await waitFor(() => expect(screen.getByTestId("journal-table")).toBeTruthy());
    expect(ipc.openOlderCopy).toHaveBeenCalledWith(null, true);
  });

  it("no keyring: asks for a password before anything is created", async () => {
    const ipc = mockIpc(readyInfo, { phase: "setup", ...base, lockRequired: true });
    ipc.setupPassword = vi.fn(() => Promise.resolve({ ...unlocked, lockEnabled: true, lockRequired: true }));
    render(<App brand={ALL_BRANDS.greenwick} ipc={ipc} />);
    await waitFor(() => expect(screen.getByTestId("setup-screen")).toBeTruthy());
    fireEvent.change(screen.getByTestId("setup-password"), { target: { value: "short" } });
    fireEvent.change(screen.getByTestId("setup-confirm"), { target: { value: "short" } });
    fireEvent.click(screen.getByTestId("setup-submit"));
    await waitFor(() => expect(screen.getByTestId("setup-message").textContent).toMatch(/at least 8/));
    expect(ipc.setupPassword).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("setup-password"), { target: { value: "fictional-pass-1" } });
    fireEvent.change(screen.getByTestId("setup-confirm"), { target: { value: "fictional-pass-1" } });
    fireEvent.click(screen.getByTestId("setup-submit"));
    await waitFor(() => expect(screen.getByTestId("journal-empty")).toBeTruthy());
  });

  it("settings shows App Lock and the save-issue banner when a save failed", async () => {
    const ipc = mockIpc(readyInfo, { ...unlocked, saveFailing: true });
    render(<App brand={ALL_BRANDS.dojix} ipc={ipc} />);
    await waitFor(() => expect(screen.getByTestId("save-issue")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-settings"));
    expect(screen.getByTestId("settings-security")).toBeTruthy();
    expect(screen.getByTestId("enable-lock")).toBeTruthy();
  });

  it("a close with unsaved changes asks first", async () => {
    let fire: (() => void) | null = null;
    const ipc = mockIpc(readyInfo);
    ipc.onEvent = (event, handler) => {
      if (event === "unsaved_close") fire = () => handler(null);
      return () => undefined;
    };
    ipc.quit = vi.fn(() => Promise.resolve());
    render(<App brand={ALL_BRANDS.dojix} ipc={ipc} />);
    await waitFor(() => expect(screen.getByTestId("journal-empty")).toBeTruthy());
    expect(fire).not.toBeNull();
    (fire as unknown as () => void)();
    await waitFor(() => expect(screen.getByTestId("unsaved-dialog")).toBeTruthy());
    fireEvent.click(screen.getByText("Quit anyway"));
    expect(ipc.quit).toHaveBeenCalledWith(true);
  });

  it("Dojix, unlocked: MT5 auto-import imports queued files and refreshes the journal", async () => {
    const ipc = mockIpc(readyInfo, unlocked, []);
    const summary: Mt5ImportSummary = {
      fileName: "DojixExport_10000001_20261028.csv",
      folderId: "f1",
      format: "dojix_export",
      result: "imported",
      message: null,
      parsed: 1,
      inserted: 1,
      duplicates: 0,
      skipped: 0,
      atMs: 0,
    };
    let rows: JournalRow[] = [];
    ipc.listTrades = () => Promise.resolve(rows);
    ipc.mt5Status = vi.fn(() =>
      Promise.resolve({
        ...emptyMt5Status,
        active: true,
        pending: rows.length === 0 ? [{ token: 1, folderId: "f1", fileName: summary.fileName, size: 10 }] : [],
      }),
    );
    ipc.mt5Read = vi.fn(() => Promise.resolve(new TextEncoder().encode("not a trade file\n")));
    ipc.mt5ImportCommit = vi.fn(() => {
      rows = [row];
      return Promise.resolve(summary);
    });
    render(<App brand={ALL_BRANDS.dojix} ipc={ipc} />);
    await waitFor(() => expect(screen.getByTestId("journal-table").textContent).toContain("TESTSYM"));
    expect(ipc.mt5ImportCommit).toHaveBeenCalledWith(1, expect.objectContaining({ kind: "not_trade_file" }));
  });

  it("Greenwick and locked journals never start MT5 auto-import", async () => {
    const ipc = mockIpc({ ...readyInfo, brand: "greenwick" });
    ipc.mt5Status = vi.fn(() => Promise.resolve(emptyMt5Status));
    render(<App brand={ALL_BRANDS.greenwick} ipc={ipc} />);
    await waitFor(() => expect(screen.getByTestId("journal-empty")).toBeTruthy());
    cleanup();
    const lockedIpc = mockIpc(readyInfo, locked);
    lockedIpc.mt5Status = vi.fn(() => Promise.resolve(emptyMt5Status));
    render(<App brand={ALL_BRANDS.dojix} ipc={lockedIpc} />);
    await waitFor(() => expect(screen.getByTestId("lock-screen")).toBeTruthy());
    expect(ipc.mt5Status).not.toHaveBeenCalled();
    expect(lockedIpc.mt5Status).not.toHaveBeenCalled();
  });
});
