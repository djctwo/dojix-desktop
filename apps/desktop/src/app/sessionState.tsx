import { createContext, type ReactNode, useCallback, useContext, useState, useSyncExternalStore } from "react";

/**
 * UI state that should survive switching screens but not a restart or a lock (filters, the
 * Essential/All choice until prefs exist, column layouts): the Mac keeps it in view models that
 * live as long as the window. Nothing here is written to disk or browser storage.
 */
export class SessionStore {
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Set<() => void>();

  get<T>(key: string, initial: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : initial;
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value);
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

const SessionContext = createContext<SessionStore | null>(null);

export function SessionStateProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SessionStore());
  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}

/** Like useState, but kept for the session under `key` (e.g. "dashboard.mode"). */
export function useSessionState<T>(key: string, initial: T): [T, (value: T) => void] {
  const store = useContext(SessionContext);
  if (!store) throw new Error("useSessionState needs a <SessionStateProvider> above it");
  const value = useSyncExternalStore(store.subscribe, () => store.get(key, initial));
  const set = useCallback((v: T) => store.set(key, v), [store, key]);
  return [value, set];
}
