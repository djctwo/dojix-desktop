import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { AnalyticsClient } from "./client";
import type { EngineSettings } from "./protocol";
import { environmentSettings } from "./settings";

export interface AnalyticsEnvironment {
  client: AnalyticsClient;
  /** "Now" for every computation (the mock fixes it so screenshots are stable). */
  now: () => number;
  settings: EngineSettings;
}

const AnalyticsContext = createContext<AnalyticsEnvironment | null>(null);

export interface AnalyticsProviderProps {
  /** Creates the client once (a worker in the app, in-thread in tests); disposed on unmount. */
  createClient: () => AnalyticsClient;
  now?: (() => number) | undefined;
  settings?: EngineSettings | undefined;
  children: ReactNode;
}

export function AnalyticsProvider({ createClient, now = Date.now, settings, children }: AnalyticsProviderProps) {
  const [client] = useState(createClient);
  const [defaults] = useState(environmentSettings);
  useEffect(() => () => client.dispose(), [client]);
  return (
    <AnalyticsContext.Provider value={{ client, now, settings: settings ?? defaults }}>{children}</AnalyticsContext.Provider>
  );
}

export function useAnalyticsEnvironment(): AnalyticsEnvironment {
  const env = useContext(AnalyticsContext);
  if (!env) throw new Error("analytics hooks need an <AnalyticsProvider> above them");
  return env;
}
