import type { ComponentType } from "react";
import type { BrandConfig } from "@dojix-desktop/core";

/**
 * The state of one analytics card, as the app's analytics worker reports it:
 * - `belowMin`: fewer trades than the component's `minTrades` (compute never ran);
 * - `empty`: compute ran and returned null (the Mac card's own empty state);
 * - `error`: compute threw (or its model could not be sent from the worker).
 */
export type CardResult =
  | { status: "loading" }
  | { status: "ok"; model: unknown }
  | { status: "empty" }
  | { status: "belowMin"; minTrades: number; tradeCount: number }
  | { status: "error"; message: string };

export interface AnalyticsViewProps<M> {
  /** The component's model, exactly what `compute` returned (never null here). */
  model: M;
  brand: BrandConfig;
  /** Trades the tab was computed over (after filters). */
  tradeCount: number;
  /** Foundation locale id ("en_US"), for core's formatters (asCurrency, …). */
  locale: string;
}

/** How one registry component is drawn. Screen teams write one per component id. */
export interface AnalyticsView<M = unknown> {
  /** The registry id (the Mac component's type name, e.g. "WinLossDistribution"). */
  id: string;
  /** Card title as the Mac shows it. */
  title: string;
  /** One-line definition for the card's "?" button. */
  help?: string | undefined;
  view: ComponentType<AnalyticsViewProps<M>>;
  /** Grid width: one column (default), two, or the full row. */
  span?: 1 | 2 | "full" | undefined;
  /** Text when compute returns null (default: "Not enough data yet."). */
  emptyMessage?: string | undefined;
}

/** Identity helper that keeps the view's model type while storing it untyped. */
export function defineAnalyticsView<M>(view: AnalyticsView<M>): AnalyticsView {
  return view as unknown as AnalyticsView;
}

/** Views by component id. Registering an id twice throws, like the core registry. */
export class AnalyticsViewRegistry {
  private readonly views = new Map<string, AnalyticsView>();

  register(view: AnalyticsView): this {
    if (this.views.has(view.id)) throw new Error(`analytics view ${view.id} is registered twice`);
    this.views.set(view.id, view);
    return this;
  }

  get(id: string): AnalyticsView | undefined {
    return this.views.get(id);
  }

  has(id: string): boolean {
    return this.views.has(id);
  }

  ids(): string[] {
    return [...this.views.keys()];
  }
}

/** "WinLossDistribution" → "Win Loss Distribution", "HourlyPnLChart" → "Hourly P&L Chart". */
export function humanizeComponentId(id: string): string {
  return id
    .replace("MAEMFE", "MAE MFE ")
    .split("PnL")
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"))
    .join(" P&L ")
    .replace(/\s+/g, " ")
    .trim();
}
