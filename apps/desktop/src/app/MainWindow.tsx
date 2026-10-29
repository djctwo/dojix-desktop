import { lazy, type ReactNode, Suspense, useMemo } from "react";
import type { AppInfo, BrandConfig, LockStatus } from "@dojix-desktop/core";
import { AppShell, JournalScreen, LoadingState, SaveIssueBanner, SecuritySettings, type ShortcutBinding, useShortcuts } from "@dojix-desktop/ui";
import { useIpc } from "../data/IpcContext";
import { useJournalRows } from "../data/queries";
import { HelpScreen } from "../screens/HelpScreen";
import { PlannedScreen } from "../screens/placeholders";
import { useCommandBus } from "./commands";
import { useNavigation } from "./navigation";
import { shortcutsFor, sidebarHints } from "./shortcuts";

const JOURNAL_PAGE = 500;

// Screens with charts load on first visit, so ECharts and the views stay out of the start-up bundle.
const DashboardScreen = lazy(() => import("../screens/DashboardScreen").then((m) => ({ default: m.DashboardScreen })));
const AnalyticsScreen = lazy(() => import("../screens/AnalyticsScreen").then((m) => ({ default: m.AnalyticsScreen })));
const EdgeReportScreen = lazy(() => import("../screens/EdgeReportScreen").then((m) => ({ default: m.EdgeReportScreen })));

export interface MainWindowProps {
  brand: BrandConfig;
  info: AppInfo | null;
  lock: LockStatus | null;
  onLockChanged: () => void;
  statusLine: ReactNode;
}

/** The unlocked app: sidebar, the current screen, global shortcuts and banners. */
export function MainWindow({ brand, info, lock, onLockChanged, statusLine }: MainWindowProps) {
  const ipc = useIpc();
  const nav = useNavigation();
  const bus = useCommandBus();
  const unlocked = lock?.phase === "unlocked";
  const rows = useJournalRows(JOURNAL_PAGE, unlocked);

  const bindings = useMemo<ShortcutBinding[]>(
    () =>
      shortcutsFor(brand.id).map((s) => ({
        keys: s.keys,
        run: () => {
          if (s.scope === "analytics" && nav.screen !== "analytics") return;
          if (s.scope === "import" && nav.screen !== "import") return;
          const a = s.action;
          if (a.type === "navigate") nav.navigate(a.screen);
          else if (a.type === "analyticsTab") nav.showAnalyticsTab(a.tab);
          else {
            if (a.screen) nav.navigate(a.screen);
            bus.dispatch(a.command);
          }
        },
      })),
    [brand.id, nav, bus],
  );
  useShortcuts(bindings, unlocked);

  const setAside = info?.storage.kind === "ready" && info.storage.setAside;
  let screen: ReactNode;
  switch (nav.screen) {
    case "journal":
      screen = <JournalScreen brand={brand} rows={lock === null || rows.data === undefined ? null : rows.data} />;
      break;
    case "dashboard":
      screen = <DashboardScreen brand={brand} />;
      break;
    case "analytics":
      screen = <AnalyticsScreen brand={brand} />;
      break;
    case "edgeReport":
      screen = <EdgeReportScreen brand={brand} />;
      break;
    case "help":
      screen = <HelpScreen brand={brand} version={info?.version ?? null} />;
      break;
    case "settings":
      screen =
        lock !== null ? (
          <SecuritySettings
            productName={brand.productName}
            status={lock}
            onChanged={onLockChanged}
            actions={{
              enableLock: (password, confirmation) => ipc.call("lock_enable", { password, confirmation }),
              changePassword: (current, password, confirmation) => ipc.call("lock_change", { current, password, confirmation }),
              disableLock: (password) => ipc.call("lock_disable", { password }),
              lockNow: () => ipc.call("lock_now"),
              setIdleMinutes: async (minutes) => {
                await ipc.call("prefs_set_idle", { minutes });
              },
              exportBackup: (password, confirmation) => ipc.call("backup_export", { password, confirmation }),
              pickBackup: () => ipc.call("backup_pick"),
              restoreBackup: (password) => ipc.call("backup_restore", { password }),
              eraseAll: (confirmation) => ipc.call("erase_all", { confirmation }),
            }}
          />
        ) : null;
      break;
    default:
      screen = <PlannedScreen brand={brand} screen={nav.screen} />;
  }

  return (
    <AppShell
      brand={brand}
      active={nav.screen}
      onNavigate={nav.navigate}
      shortcutHints={sidebarHints(brand.id)}
      onHelp={() => nav.navigate("help")}
      helpHint="F1"
      status={statusLine}
    >
      {setAside && (
        <p className="notice" role="status" data-testid="set-aside-notice">
          The previous journal file could not be read, so it was moved to the set-aside folder and a new journal was
          started. Nothing was deleted.
        </p>
      )}
      {lock?.saveFailing && (
        <SaveIssueBanner
          onRetry={async () => {
            await ipc.call("save_retry");
            onLockChanged();
          }}
        />
      )}
      <Suspense fallback={<LoadingState label="Opening…" />}>{screen}</Suspense>
    </AppShell>
  );
}
