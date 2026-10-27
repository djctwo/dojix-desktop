import { useCallback, useEffect, useRef, useState } from "react";
import type { AppInfo, BrandConfig, JournalRow, LockStatus, ScreenId } from "@dojix-desktop/core";
import {
  AppShell,
  JournalScreen,
  LockScreen,
  OlderCopyScreen,
  PlaceholderScreen,
  SaveIssueBanner,
  SecuritySettings,
  SetupPasswordScreen,
  StartupError,
  UnsavedQuitDialog,
} from "@dojix-desktop/ui";
import type { Ipc } from "./ipc";

const JOURNAL_PAGE = 500;
/** At most one "activity" message to the idle timer per this many ms. */
const ACTIVITY_THROTTLE_MS = 10_000;
const ACTIVITY_EVENTS = ["keydown", "mousedown", "mousemove", "wheel", "touchstart"] as const;

export interface AppProps {
  brand: BrandConfig;
  ipc: Ipc;
}

export function App({ brand, ipc }: AppProps) {
  const [screen, setScreen] = useState<ScreenId>("journal");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [lock, setLock] = useState<LockStatus | null>(null);
  const [rows, setRows] = useState<JournalRow[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [unsavedClose, setUnsavedClose] = useState(false);

  /** Applies a new lock status; loads the journal when it is (or stays) unlocked. */
  const apply = useCallback(
    async (status: LockStatus) => {
      setLock(status);
      if (status.phase === "unlocked") {
        setRows(await ipc.listTrades(JOURNAL_PAGE));
      } else {
        setRows(null);
      }
    },
    [ipc],
  );

  const refresh = useCallback(() => {
    ipc
      .lockStatus()
      .then(apply)
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)));
  }, [ipc, apply]);

  useEffect(() => {
    let cancelled = false;
    ipc
      .appInfo()
      .then(async (loaded) => {
        if (cancelled) return;
        setInfo(loaded);
        if (loaded.storage.kind !== "ready") return;
        const status = await ipc.lockStatus();
        if (!cancelled) await apply(status);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailure(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [ipc, apply]);

  // Shell events: a save failed or recovered; a close with unsaved changes.
  useEffect(() => {
    const stopSave = ipc.onEvent("save_failed", () => refresh());
    const stopClose = ipc.onEvent("unsaved_close", () => setUnsavedClose(true));
    return () => {
      stopSave();
      stopClose();
    };
  }, [ipc, refresh]);

  // Input in the window resets the idle timer (SPEC 6.7), throttled.
  const lastActivity = useRef(0);
  useEffect(() => {
    const onInput = () => {
      const now = Date.now();
      if (now - lastActivity.current >= ACTIVITY_THROTTLE_MS) {
        lastActivity.current = now;
        ipc.activity();
      }
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onInput, { passive: true });
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onInput);
    };
  }, [ipc]);

  const storage = info?.storage;
  const lockFailure = lock?.phase === "failed" ? lock.message : null;
  const errorMessage =
    failure ?? (storage?.kind === "error" ? storage.message : null) ?? lockFailure;

  if (errorMessage !== null) {
    return (
      <AppShell brand={brand} active={screen} onNavigate={setScreen} status={<Status info={info} lock={lock} />}>
        <StartupError productName={brand.productName} message={errorMessage} />
      </AppShell>
    );
  }

  const quitDialog = unsavedClose && (
    <UnsavedQuitDialog
      onRetry={async () => {
        await ipc.quit(false);
      }}
      onQuitAnyway={() => void ipc.quit(true)}
      onCancel={() => setUnsavedClose(false)}
    />
  );

  if (lock?.phase === "locked") {
    return (
      <>
        <LockScreen
          productName={brand.productName}
          status={lock}
          onUnlock={async (password) => apply(await ipc.unlock(password))}
          onErase={async (confirmation) => apply(await ipc.eraseAll(confirmation))}
        />
        {quitDialog}
      </>
    );
  }
  if (lock?.phase === "olderCopy") {
    return (
      <OlderCopyScreen
        productName={brand.productName}
        status={lock}
        onOpen={async (password) => apply(await ipc.openOlderCopy(password, true))}
        onQuit={() => void ipc.quit(true)}
      />
    );
  }
  if (lock?.phase === "setup") {
    return (
      <SetupPasswordScreen
        productName={brand.productName}
        onSetup={async (password, confirmation) =>
          apply(await ipc.setupPassword(password, confirmation))
        }
      />
    );
  }

  const label = brand.sidebar.flatMap((s) => s.items).find((i) => i.id === screen)?.label ?? "";
  const setAside = storage?.kind === "ready" && storage.setAside;

  return (
    <AppShell brand={brand} active={screen} onNavigate={setScreen} status={<Status info={info} lock={lock} />}>
      {setAside && (
        <p className="notice" role="status" data-testid="set-aside-notice">
          The previous journal file could not be read, so it was moved to the set-aside folder
          and a new journal was started. Nothing was deleted.
        </p>
      )}
      {lock?.saveFailing && (
        <SaveIssueBanner
          onRetry={async () => {
            await ipc.saveRetry();
            refresh();
          }}
        />
      )}
      {screen === "journal" ? (
        <JournalScreen brand={brand} rows={lock === null ? null : rows} />
      ) : screen === "settings" && lock !== null ? (
        <SecuritySettings
          productName={brand.productName}
          status={lock}
          onChanged={refresh}
          actions={{
            enableLock: ipc.enableLock,
            changePassword: ipc.changePassword,
            disableLock: ipc.disableLock,
            lockNow: ipc.lockNow,
            setIdleMinutes: ipc.setIdleMinutes,
            exportBackup: ipc.exportBackup,
            pickBackup: ipc.pickBackup,
            restoreBackup: ipc.restoreBackup,
            eraseAll: ipc.eraseAll,
          }}
        />
      ) : (
        <PlaceholderScreen title={label} />
      )}
      {quitDialog}
    </AppShell>
  );
}

function Status({ info, lock }: { info: AppInfo | null; lock: LockStatus | null }) {
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
