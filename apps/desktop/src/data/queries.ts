// TanStack Query over the IPC: the hooks screens use to read and change data. Keys live in
// `queryKeys`; every journal write invalidates `queryKeys.journal` (and with it the analytics,
// which hang off the trades query). On lock, everything under `journal` is removed from memory.

import {
  QueryClient,
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AppInfo, JournalRow, LockStatus, StoredTrade } from "@dojix-desktop/core";
import type { CallArgs, CommandName, JournalMutation, MutationResult, ResultOf } from "../ipc/contract";
import { useIpc } from "./IpcContext";

export const queryKeys = {
  appInfo: ["appInfo"] as const,
  lockStatus: ["lockStatus"] as const,
  /** Everything derived from the journal; removed on lock, invalidated on `trades_changed`. */
  journal: ["journal"] as const,
  journalRows: (limit: number) => ["journal", "rows", limit] as const,
  trades: ["journal", "trades"] as const,
  analytics: ["journal", "analytics"] as const,
  setting: (key: string) => ["journal", "setting", key] as const,
  prefs: ["prefs"] as const,
};

/** IPC errors are deterministic (validation, locked, unavailable): no automatic retries. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

export function useAppInfo(): UseQueryResult<AppInfo> {
  const ipc = useIpc();
  return useQuery({ queryKey: queryKeys.appInfo, queryFn: () => ipc.call("app_info") });
}

export function useLockStatus(enabled: boolean): UseQueryResult<LockStatus> {
  const ipc = useIpc();
  return useQuery({ queryKey: queryKeys.lockStatus, queryFn: () => ipc.call("lock_status"), enabled });
}

/** The Phase 1 journal list (5 columns, newest first). */
export function useJournalRows(limit: number, enabled: boolean): UseQueryResult<JournalRow[]> {
  const ipc = useIpc();
  return useQuery({ queryKey: queryKeys.journalRows(limit), queryFn: () => ipc.call("journal_query", { limit }), enabled });
}

/** Every trade as a full row (planned `journal_trades`): the Journal table and the analytics input. */
export function useTrades(enabled = true): UseQueryResult<StoredTrade[]> {
  const ipc = useIpc();
  return useQuery({ queryKey: queryKeys.trades, queryFn: () => ipc.call("journal_trades"), enabled });
}

/** A journal setting (planned `settings_get`), e.g. the prop-firm parameters. */
export function useSetting<T>(key: string, fallback: T): UseQueryResult<T> {
  const ipc = useIpc();
  return useQuery({
    queryKey: queryKeys.setting(key),
    queryFn: async () => ((await ipc.call("settings_get", { key })) as T | null) ?? fallback,
  });
}

/** Changes the journal; on success every journal query refetches. */
export function useJournalMutation(): UseMutationResult<MutationResult, unknown, JournalMutation> {
  const ipc = useIpc();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mutation: JournalMutation) => ipc.call("journal_mutate", { mutation }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.journal }),
  });
}

/**
 * A mutation for any command that returns the new LockStatus (unlock, setup, older copy, erase):
 * the result replaces the cached status, which moves the launch gate.
 */
export function useLockTransition<K extends CommandName>(
  name: K,
): UseMutationResult<ResultOf<K>, unknown, CallArgs<K>[0]> {
  const ipc = useIpc();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (args: CallArgs<K>[0]) => (ipc.call as (n: K, a: unknown) => Promise<ResultOf<K>>)(name, args),
    onSuccess: (result) => {
      if (result !== null && typeof result === "object" && "phase" in result) {
        client.setQueryData(queryKeys.lockStatus, result);
      }
    },
  });
}
