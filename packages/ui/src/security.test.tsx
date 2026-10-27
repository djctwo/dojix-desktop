import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LockStatus } from "@dojix-desktop/core";
import { EraseForm, LockScreen, SecuritySettings, type SecurityActions } from "./index";

afterEach(cleanup);

const status: LockStatus = {
  phase: "unlocked",
  lockEnabled: false,
  lockRequired: false,
  vaultBackend: "memory",
  throttle: { attempts: 0, waitSeconds: 0, unreadable: false, message: null },
  idleLockMinutes: 15,
  saveFailing: false,
  setAside: false,
};

function actions(overrides: Partial<SecurityActions> = {}): SecurityActions {
  return {
    enableLock: vi.fn(() => Promise.resolve("complete" as const)),
    changePassword: vi.fn(() => Promise.resolve("complete" as const)),
    disableLock: vi.fn(() => Promise.resolve(status)),
    lockNow: vi.fn(() => Promise.resolve(true)),
    setIdleMinutes: vi.fn(() => Promise.resolve()),
    exportBackup: vi.fn(() => Promise.resolve("Dojix backup.dxbk")),
    pickBackup: vi.fn(() => Promise.resolve(null)),
    restoreBackup: vi.fn(() =>
      Promise.resolve({ source: "desktop" as const, trades: 2, checkpoints: 0, settings: 0, notices: [] }),
    ),
    eraseAll: vi.fn(() => Promise.resolve(status)),
    ...overrides,
  };
}

const passwordInputs = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'));

describe("erase", () => {
  it("needs the product name typed exactly", async () => {
    const onErase = vi.fn(() => Promise.resolve());
    render(<EraseForm productName="Greenwick" onErase={onErase} />);
    const submit = screen.getByTestId("erase-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("erase-confirm"), { target: { value: "greenwick" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("erase-confirm"), { target: { value: "Greenwick" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onErase).toHaveBeenCalledWith("Greenwick"));
  });

  it("is reachable from the lock screen as 'Forgot password?'", () => {
    const locked: LockStatus = { ...status, phase: "locked", vaultUnreadable: true, held: false };
    render(<LockScreen productName="Dojix" status={locked} onUnlock={vi.fn()} onErase={vi.fn()} />);
    expect(screen.getByTestId("lock-screen").textContent).toContain("can't read the system keyring");
    fireEvent.click(screen.getByTestId("forgot-password"));
    expect(screen.getByTestId("erase-form").textContent).toContain("no way to recover");
  });
});

describe("security settings", () => {
  it("turns App Lock on only with a valid, confirmed password", async () => {
    const a = actions({ enableLock: vi.fn(() => Promise.resolve("finishesOnNextUnlock" as const)) });
    const onChanged = vi.fn();
    render(<SecuritySettings productName="Dojix" status={status} actions={a} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("enable-lock"));
    const [pw, confirm] = passwordInputs();
    fireEvent.change(pw!, { target: { value: "fictional-pass-1" } });
    fireEvent.change(confirm!, { target: { value: "fictional-pass-2" } });
    fireEvent.submit(screen.getByTestId("lock-form-enable"));
    await waitFor(() => expect(screen.getByTestId("security-message").textContent).toMatch(/do not match/));
    expect(a.enableLock).not.toHaveBeenCalled();
    fireEvent.change(confirm!, { target: { value: "fictional-pass-1" } });
    fireEvent.submit(screen.getByTestId("lock-form-enable"));
    await waitFor(() => expect(screen.getByTestId("security-note").textContent).toMatch(/next unlock/));
    expect(a.enableLock).toHaveBeenCalledWith("fictional-pass-1", "fictional-pass-1");
    expect(onChanged).toHaveBeenCalled();
  });

  it("hides 'Turn off' when App Lock is required and offers Lock now", () => {
    const required: LockStatus = { ...status, lockEnabled: true, lockRequired: true };
    render(<SecuritySettings productName="Dojix" status={required} actions={actions()} onChanged={vi.fn()} />);
    expect(screen.queryByText("Turn off")).toBeNull();
    expect(screen.getByTestId("lock-required")).toBeTruthy();
    expect(screen.getByTestId("lock-now")).toBeTruthy();
    expect((screen.getByTestId("idle-select") as HTMLSelectElement).value).toBe("15");
  });

  it("protects backups with a password by default when App Lock is on", async () => {
    const a = actions();
    render(
      <SecuritySettings productName="Dojix" status={{ ...status, lockEnabled: true }} actions={a} onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Export backup…"));
    await waitFor(() => expect(screen.getByTestId("backup-message").textContent).toMatch(/empty/));
    expect(a.exportBackup).not.toHaveBeenCalled();
  });

  it("asks for the backup password when the picked file needs one", async () => {
    const a = actions({
      pickBackup: vi.fn(() =>
        Promise.resolve({ fileName: "old.dojixbackup", kind: "macDojix" as const, needsPassword: true }),
      ),
    });
    render(<SecuritySettings productName="Dojix" status={status} actions={a} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByText("Restore backup…"));
    await waitFor(() => expect(screen.getByTestId("restore-picked").textContent).toContain("Dojix for Mac"));
    fireEvent.change(screen.getByPlaceholderText("Backup password"), { target: { value: "fixture-password-1" } });
    fireEvent.click(screen.getByText("Restore"));
    await waitFor(() => expect(screen.getByTestId("restore-summary").textContent).toContain("2 trades"));
    expect(a.restoreBackup).toHaveBeenCalledWith("fixture-password-1");
  });
});
