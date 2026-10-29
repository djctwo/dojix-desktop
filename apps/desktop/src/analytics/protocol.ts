// Messages between the UI thread and the analytics worker. Plain data only (structured clone).

import type { AnalyticsPlacement, BrandId, CompatMode, DateRangeFilter, PortfolioMetrics, StoredTrade } from "@dojix-desktop/core";
import type { CardResult } from "@dojix-desktop/ui";

/** The user's calendar and locale the engine computes in (EngineContext, SPEC 3.2). */
export interface EngineSettings {
  /** IANA zone of the display calendar (Dojix buckets; Greenwick's local-calendar components). */
  tz: string;
  /** 1 = Sunday … 7 = Saturday (Foundation `firstWeekday`). */
  weekStart: number;
  minDaysInFirstWeek: number;
  /** Foundation locale id ("en_US"). */
  locale: string;
  compat: CompatMode;
  /** Dojix 32-column MT5 files: "utc" or the broker's IANA zone. */
  brokerOffset: "utc" | string;
}

export interface TradeFilter {
  dateRange?: DateRangeFilter | undefined;
  symbol?: string | null | undefined;
}

export interface LoadRequest {
  type: "load";
  requestId: number;
  datasetId: number;
  brand: BrandId;
  rows: readonly StoredTrade[];
}

export interface RunRequest {
  type: "run";
  requestId: number;
  datasetId: number;
  now: number;
  settings: EngineSettings;
  filter: TradeFilter;
  /** Run every component of this placement for the brand, in registry order… */
  placement?: AnalyticsPlacement | undefined;
  /** …or exactly these components, in this order. */
  componentIds?: readonly string[] | undefined;
  /** Also compute MetricsCalculator over the filtered trades. */
  metrics?: boolean | undefined;
}

export type WorkerRequest = LoadRequest | RunRequest;

export interface LoadResult {
  datasetId: number;
  count: number;
  /** Rows the engine could not read (should be none: Rust validates every row). */
  skipped: { id: number; reason: string }[];
}

export interface RunResult {
  datasetId: number;
  /** Trades after the filter. */
  tradeCount: number;
  cards: { id: string; minTrades: number; result: CardResult }[];
  metrics?: PortfolioMetrics | undefined;
  /** Compute time in ms (the budget is ~300 ms per tab for 10k trades, SPEC 7.4). */
  ms: number;
}

export type WorkerResponse =
  | { type: "loaded"; requestId: number; result: LoadResult }
  | { type: "ran"; requestId: number; result: RunResult }
  | { type: "failed"; requestId: number; message: string };
