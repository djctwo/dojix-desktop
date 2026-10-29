import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MOCK_PASSWORD } from "../mock/mockIpc";
import { renderApp } from "../test-support/render";

beforeEach(() => history.replaceState(null, "", "#"));
afterEach(cleanup);

const press = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, ...init })));

describe("launch gate", () => {
  it("opens on the Journal of an encrypted journal", async () => {
    await renderApp();
    await waitFor(() => expect(screen.getByTestId("journal-table").textContent).toContain("EURUSD"));
    expect(screen.getByTestId("screen-title").textContent).toBe("Journal");
    expect(screen.getByTestId("db-status").dataset["encrypted"]).toBe("true");
    expect(screen.getByTestId("app-version").textContent).toBe("v0.1.0-mock");
  });

  it("shows the empty journal", async () => {
    await renderApp({ fixture: "empty" });
    await waitFor(() => expect(screen.getByTestId("journal-empty")).toBeTruthy());
  });

  it("storage error: start-up error, the journal is never read", async () => {
    const { ipc } = await renderApp({ gate: "storageError" });
    await waitFor(() => expect(screen.getByTestId("startup-error").textContent).toContain("No system keyring"));
    expect(ipc.calls).not.toContain("journal_query");
    expect(ipc.calls).not.toContain("lock_status");
    expect(screen.getByTestId("db-status").dataset["encrypted"]).toBe("false");
  });

  it("a failed lock status shows the start-up error", async () => {
    await renderApp({ gate: "lockFailed" });
    await waitFor(() => expect(screen.getByTestId("startup-error").textContent).toContain("keyring did not answer"));
  });

  it("a failing shell call shows the start-up error", async () => {
    await renderApp({ fail: ["app_info"] });
    await waitFor(() => expect(screen.getByTestId("startup-error").textContent).toContain("told to fail app_info"));
  });

  it("locked: only the lock screen until the right password", async () => {
    const { ipc } = await renderApp({ gate: "locked" });
    await waitFor(() => expect(screen.getByTestId("lock-screen")).toBeTruthy());
    expect(screen.queryByTestId("brand-name")).toBeNull();
    expect(ipc.calls).not.toContain("journal_query");
    fireEvent.change(screen.getByTestId("lock-password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByTestId("lock-submit"));
    await waitFor(() => expect(screen.getByTestId("lock-message").textContent).toBe("Incorrect password (1/5)"));
    fireEvent.change(screen.getByTestId("lock-password"), { target: { value: MOCK_PASSWORD } });
    fireEvent.click(screen.getByTestId("lock-submit"));
    await waitFor(() => expect(screen.getByTestId("journal-table")).toBeTruthy());
    expect(screen.getByTestId("lock-status-on")).toBeTruthy();
  });

  it("older copy: nothing opens until confirmed", async () => {
    const { ipc } = await renderApp({ gate: "olderCopy" });
    await waitFor(() => expect(screen.getByTestId("older-copy")).toBeTruthy());
    expect(ipc.calls).not.toContain("journal_query");
    fireEvent.change(screen.getByTestId("older-password"), { target: { value: MOCK_PASSWORD } });
    fireEvent.click(screen.getByTestId("older-open"));
    await waitFor(() => expect(screen.getByTestId("journal-table")).toBeTruthy());
  });

  it("no keyring: a password first", async () => {
    await renderApp({ gate: "setup", brand: "greenwick" });
    await waitFor(() => expect(screen.getByTestId("setup-screen")).toBeTruthy());
    fireEvent.change(screen.getByTestId("setup-password"), { target: { value: MOCK_PASSWORD } });
    fireEvent.change(screen.getByTestId("setup-confirm"), { target: { value: MOCK_PASSWORD } });
    fireEvent.click(screen.getByTestId("setup-submit"));
    await waitFor(() => expect(screen.getByTestId("journal-table").textContent).toContain("FIXA"));
  });

  it("forgot password: erase opens an empty journal", async () => {
    await renderApp({ gate: "locked" });
    await waitFor(() => expect(screen.getByTestId("lock-screen")).toBeTruthy());
    fireEvent.click(screen.getByTestId("forgot-password"));
    fireEvent.change(screen.getByTestId("erase-confirm"), { target: { value: "Dojix" } });
    fireEvent.click(screen.getByTestId("erase-submit"));
    await waitFor(() => expect(screen.getByTestId("journal-empty")).toBeTruthy());
  });

  it("locking from Settings drops every journal query and shows the lock screen", async () => {
    const { ipc } = await renderApp({ gate: "locked" });
    await waitFor(() => expect(screen.getByTestId("lock-screen")).toBeTruthy());
    fireEvent.change(screen.getByTestId("lock-password"), { target: { value: MOCK_PASSWORD } });
    fireEvent.click(screen.getByTestId("lock-submit"));
    await waitFor(() => expect(screen.getByTestId("journal-table")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-settings"));
    await act(async () => {
      await ipc.call("lock_now");
    });
    await waitFor(() => expect(screen.getByTestId("lock-screen")).toBeTruthy());
    expect(screen.queryByTestId("journal-table")).toBeNull();
  });

  it("save failures show the banner; a close with unsaved changes asks first", async () => {
    const { ipc } = await renderApp();
    await waitFor(() => expect(screen.getByTestId("journal-table")).toBeTruthy());
    act(() => ipc.emit("save_failed", true));
    act(() => ipc.emit("unsaved_close", null));
    await waitFor(() => expect(screen.getByTestId("unsaved-dialog")).toBeTruthy());
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("unsaved-dialog")).toBeNull();
    act(() => ipc.emit("unsaved_close", null));
    fireEvent.click(await screen.findByText("Quit anyway"));
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(ipc.calls.filter((c) => c === "app_quit")).toHaveLength(2));
  });

  it("reports user activity to the idle timer, throttled", async () => {
    const { ipc } = await renderApp();
    await waitFor(() => expect(screen.getByTestId("journal-table")).toBeTruthy());
    const before = ipc.calls.filter((c) => c === "lock_activity").length;
    fireEvent.mouseDown(window);
    fireEvent.mouseDown(window);
    await waitFor(() => expect(ipc.calls.filter((c) => c === "lock_activity").length).toBe(before + 1));
  });
});

describe("main window", () => {
  it("navigates by sidebar and keeps the hash in sync", async () => {
    await renderApp({ brand: "greenwick" });
    await waitFor(() => expect(screen.getByTestId("journal-table")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-watchlist"));
    expect(screen.getByTestId("screen-title").textContent).toBe("Watchlist");
    expect(screen.getByTestId("screen-placeholder").textContent).toContain("ui-brand");
    expect(location.hash).toBe("#/watchlist");
    fireEvent.click(screen.getByTestId("nav-help"));
    expect(screen.getByTestId("shortcut-table").textContent).toContain("Ctrl+I");
    fireEvent.click(screen.getByTestId("nav-settings"));
    expect(screen.getByTestId("settings-security")).toBeTruthy();
  });

  it("keyboard shortcuts: Ctrl+digits, Ctrl+,, F1, Alt+digits on Analytics, Ctrl+N", async () => {
    await renderApp();
    await waitFor(() => expect(screen.getByTestId("journal-table")).toBeTruthy());
    press({ key: "5", code: "Digit5", ctrlKey: true });
    expect(screen.getByTestId("screen-title").textContent).toBe("Pulse");
    press({ key: ",", ctrlKey: true });
    expect(screen.getByTestId("screen-title").textContent).toBe("Settings");
    press({ key: "F1" });
    expect(screen.getByTestId("screen-title").textContent).toBe("Help");
    press({ key: "4", code: "Digit4", altKey: true });
    expect(screen.getByTestId("screen-title").textContent).toBe("Help");
    press({ key: "3", code: "Digit3", ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId("screen-title").textContent).toBe("Analytics"));
    press({ key: "4", code: "Digit4", altKey: true });
    await waitFor(() => expect(screen.getByTestId("analytics-tab-risk").getAttribute("aria-selected")).toBe("true"));
    expect(location.hash).toBe("#/analytics/risk");
    press({ key: "Enter", ctrlKey: true });
    press({ key: "n", ctrlKey: true });
    expect(screen.getByTestId("screen-title").textContent).toBe("Journal");
    press({ key: "6", code: "Digit6", ctrlKey: true });
    expect(screen.getByTestId("screen-title").textContent).toBe("Import");
    press({ key: "Enter", ctrlKey: true });
  });

  it("Settings drives App Lock, idle lock and backups through the IPC", async () => {
    const { ipc } = await renderApp();
    await waitFor(() => expect(screen.getByTestId("journal-table")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-settings"));
    fireEvent.change(screen.getByTestId("idle-select"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore backup…" }));
    await waitFor(() => expect(screen.getByTestId("restore-picked")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByTestId("restore-summary")).toBeTruthy());
    const protect = screen.queryByRole("checkbox", { name: /Protect the backup/ });
    if (protect && (protect as HTMLInputElement).checked) fireEvent.click(protect);
    fireEvent.click(screen.getByRole("button", { name: "Export backup…" }));
    await waitFor(() => expect(ipc.calls).toContain("backup_export"));
    fireEvent.click(screen.getByTestId("enable-lock"));
    fireEvent.change(screen.getByLabelText(/New password/), { target: { value: MOCK_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/Confirm new password/), { target: { value: MOCK_PASSWORD } });
    fireEvent.submit(screen.getByLabelText(/Confirm new password/).closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByTestId("lock-now")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    fireEvent.change(screen.getByLabelText(/Current password/), { target: { value: MOCK_PASSWORD } });
    fireEvent.change(screen.getByLabelText(/New password/), { target: { value: "fictional-pass-2" } });
    fireEvent.change(screen.getByLabelText(/Confirm new password/), { target: { value: "fictional-pass-2" } });
    fireEvent.submit(screen.getByLabelText(/Confirm new password/).closest("form") as HTMLFormElement);
    await waitFor(() => expect(ipc.calls).toContain("lock_change"));
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    fireEvent.change(screen.getByLabelText(/Current password/), { target: { value: "fictional-pass-2" } });
    fireEvent.submit(screen.getByLabelText(/Current password/).closest("form") as HTMLFormElement);
    await waitFor(() => expect(ipc.calls).toContain("lock_disable"));
    expect(ipc.calls).toEqual(expect.arrayContaining(["prefs_set_idle", "backup_export", "backup_pick", "backup_restore", "lock_enable"]));
  });

  it("opens the screen named in the location hash", async () => {
    history.replaceState(null, "", "#/analytics/advanced");
    await renderApp();
    await waitFor(() => expect(screen.getByTestId("analytics-tab-advanced").getAttribute("aria-selected")).toBe("true"));
  });

  it("shows the set-aside notice and the save banner until a retry works", async () => {
    await renderApp({ gate: "setAside" });
    await waitFor(() => expect(screen.getByTestId("set-aside-notice")).toBeTruthy());
    cleanup();
    const { ipc } = await renderApp({ gate: "saveFailing" });
    await waitFor(() => expect(screen.getByTestId("save-issue")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.queryByTestId("save-issue")).toBeNull());
    expect(ipc.calls).toContain("save_retry");
  });

  it("refetches the journal when the shell reports a change", async () => {
    const { ipc } = await renderApp();
    await waitFor(() => expect(screen.getByTestId("journal-table")).toBeTruthy());
    const before = ipc.calls.filter((c) => c === "journal_query").length;
    act(() => ipc.emit("trades_changed", null));
    await waitFor(() => expect(ipc.calls.filter((c) => c === "journal_query").length).toBe(before + 1));
  });

});
