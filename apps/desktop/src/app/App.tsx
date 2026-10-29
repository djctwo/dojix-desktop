import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppInfo, BrandConfig, LockStatus } from "@dojix-desktop/core";
import { LockScreen, OlderCopyScreen, SetupPasswordScreen, StartupError, AppShell, UnsavedQuitDialog } from "@dojix-desktop/ui";
import { useIpc, useIpcEvent } from "../data/IpcContext";
import { queryKeys, useAppInfo, useLockStatus } from "../data/queries";
import { MainWindow } from "./MainWindow";
import { NavigationProvider } from "./navigation";

/** At most one "activity" message to the idle timer per this many ms. */
const ACTIVITY_THROTTLE_MS = 10_000;
const ACTIVITY_EVENTS = ["keydown", "mousedown", "mousemove", "wheel", "touchstart"] as const;

export interface AppProps {
  brand: BrandConfig;
}

/**
 * The launch gate (SPEC 2.1, §6): storage error → older copy → lock screen → first password →
 * main window. Nothing reads the journal until the shell reports "unlocked", and every journal
 * query is dropped from memory as soon as it isn't.
 */
export function App({ brand }: AppProps) {
  const ipc = useIpc();
  const client = useQueryClient();
  const info = useAppInfo();
  const ready = info.data?.storage.kind === "ready";
  const lock = useLockStatus(ready);
  const [unsavedClose, setUnsavedClose] = useState(false);
  const status = lock.data;

  const apply = useCallback((next: LockStatus) => client.setQueryData(queryKeys.lockStatus, next), [client]);
  const refreshLock = useCallback(() => void client.invalidateQueries({ queryKey: queryKeys.lockStatus }), [client]);

  // Trade data never outlives an unlocked session in the web view.
  const unlocked = status?.phase === "unlocked";
  useEffect(() => {
    if (!unlocked) client.removeQueries({ queryKey: queryKeys.journal });
  }, [unlocked, client]);

  useIpcEvent("save_failed", refreshLock);
  useIpcEvent("locked", refreshLock);
  useIpcEvent("unsaved_close", () => setUnsavedClose(true));
  useIpcEvent("trades_changed", () => void client.invalidateQueries({ queryKey: queryKeys.journal }));

  // Input in the window resets the idle timer (SPEC 6.7), throttled.
  const lastActivity = useRef(0);
  useEffect(() => {
    const onInput = () => {
      const now = Date.now();
      if (now - lastActivity.current >= ACTIVITY_THROTTLE_MS) {
        lastActivity.current = now;
        ipc.call("lock_activity").catch(() => undefined);
      }
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onInput, { passive: true });
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onInput);
    };
  }, [ipc]);

  const failure =
    (info.status === "error" ? info.error : null) ??
    (info.data?.storage.kind === "error" ? info.data.storage.message : null) ??
    (lock.status === "error" ? lock.error : null) ??
    (status?.phase === "failed" ? status.message : null);

  const quitDialog = unsavedClose && (
    <UnsavedQuitDialog
      onRetry={async () => {
        await ipc.call("app_quit", { force: false });
      }}
      onQuitAnyway={() => void ipc.call("app_quit", { force: true })}
      onCancel={() => setUnsavedClose(false)}
    />
  );

  if (failure !== null) {
    return (
      <AppShell brand={brand} active="journal" onNavigate={() => undefined} status={<StatusLine info={info.data ?? null} lock={null} />}>
        <StartupError productName={brand.productName} message={failure instanceof Error ? failure.message : errorText(failure)} />
      </AppShell>
    );
  }
  if (status?.phase === "locked") {
    return (
      <>
        <LockScreen
          productName={brand.productName}
          status={status}
          onUnlock={async (password) => apply(await ipc.call("lock_unlock", { password }))}
          onErase={async (confirmation) => apply(await ipc.call("erase_all", { confirmation }))}
        />
        {quitDialog}
      </>
    );
  }
  if (status?.phase === "olderCopy") {
    return (
      <OlderCopyScreen
        productName={brand.productName}
        status={status}
        onOpen={async (password) => apply(await ipc.call("older_copy_open", { password, confirmed: true }))}
        onQuit={() => void ipc.call("app_quit", { force: true })}
      />
    );
  }
  if (status?.phase === "setup") {
    return (
      <SetupPasswordScreen
        productName={brand.productName}
        onSetup={async (password, confirmation) => apply(await ipc.call("lock_setup", { password, confirmation }))}
      />
    );
  }
  return (
    <NavigationProvider brand={brand}>
      <MainWindow brand={brand} info={info.data ?? null} lock={status ?? null} onLockChanged={refreshLock} statusLine={<StatusLine info={info.data ?? null} lock={status ?? null} />} />
      {quitDialog}
    </NavigationProvider>
  );
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

export function StatusLine({ info, lock }: { info: AppInfo | null; lock: LockStatus | null }) {
  if (info === null) return null;
  const encrypted = info.storage.kind === "ready" && info.storage.encrypted;
  return (
    <>
      <div data-testid="db-status" data-encrypted={encrypted ? "true" : "false"}>
        {encrypted ? <span className="ok">● Journal encrypted</span> : "Journal not open"}
      </div>
      {lock?.lockEnabled && <div data-testid="lock-status-on">App Lock on</div>}
      <div data-testid="app-version">v{info.version}</div>
    </>
  );
}
