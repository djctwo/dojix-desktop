import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { AnalyticsPlacement, BrandId } from "@dojix-desktop/core";
import { queryKeys, useTrades } from "../data/queries";
import { useAnalyticsEnvironment } from "./context";
import type { RunResult, TradeFilter } from "./protocol";

/**
 * Loads the journal's trades into the analytics engine once per version of the trades query.
 * Returns the dataset id to run against (undefined until loaded).
 */
export function useAnalyticsDataset(brand: BrandId): UseQueryResult<number> & { tradesError: unknown } {
  const { client } = useAnalyticsEnvironment();
  const trades = useTrades();
  const version = trades.dataUpdatedAt;
  const dataset = useQuery({
    queryKey: [...queryKeys.analytics, "dataset", brand, version],
    queryFn: async () => (await client.load(version, brand, trades.data ?? [])).datasetId,
    enabled: trades.status === "success",
    staleTime: Infinity,
  });
  return Object.assign(dataset, { tradesError: trades.status === "error" ? trades.error : null });
}

export interface AnalyticsRunOptions {
  brand: BrandId;
  placement?: AnalyticsPlacement | undefined;
  componentIds?: readonly string[] | undefined;
  filter?: TradeFilter | undefined;
  metrics?: boolean | undefined;
}

interface RunQueryCommon {
  refetch: () => unknown;
  isFetching: boolean;
}

/** The run's state, shaped like a TanStack Query result (QueryState accepts it). */
export type AnalyticsRunQuery = RunQueryCommon &
  (
    | { status: "pending"; data: undefined; error: null }
    | { status: "error"; data: undefined; error: unknown }
    | { status: "success"; data: RunResult; error: null }
  );

/**
 * Runs analytics in the worker: every component of `placement` (or `componentIds`) over the
 * journal, filtered. Re-runs when the trades change; failures of the trades load surface here.
 */
export function useAnalyticsRun({ brand, placement, componentIds, filter = {}, metrics = false }: AnalyticsRunOptions): AnalyticsRunQuery {
  const { client, now, settings } = useAnalyticsEnvironment();
  const dataset = useAnalyticsDataset(brand);
  const datasetId = dataset.data;
  const run = useQuery({
    queryKey: [...queryKeys.analytics, "run", brand, datasetId, placement ?? null, componentIds ?? null, filter, metrics, settings],
    queryFn: () => client.run({ datasetId: datasetId as number, now: now(), settings, filter, placement, componentIds, metrics }),
    enabled: datasetId !== undefined,
    staleTime: 5 * 60_000,
  });
  if (dataset.tradesError !== null) {
    return { data: undefined, status: "error", error: dataset.tradesError, refetch: dataset.refetch, isFetching: false };
  }
  if (dataset.status === "error") {
    return { data: undefined, status: "error", error: dataset.error, refetch: dataset.refetch, isFetching: false };
  }
  const common = { refetch: run.refetch, isFetching: run.isFetching };
  if (run.status === "success") return { ...common, status: "success", data: run.data, error: null };
  if (run.status === "error") return { ...common, status: "error", data: undefined, error: run.error };
  return { ...common, status: "pending", data: undefined, error: null };
}
