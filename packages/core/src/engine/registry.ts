// Analytics registry models (SPEC §7.3). Each analytics component is registered once with the
// brands it ships in, the tab it sits on, its minimum trade count and a pure `compute`.
// The UI pairs each id with a view; `compute` stays here so it is testable headless.

import type { BrandId } from "../brand";
import type { TradeOf } from "../model/trade";
import type { EngineContext } from "./context";

/** Where a component is shown: the Mac Dashboard categories, plus Edge Report and Pulse. */
export type AnalyticsPlacement =
  | "overview"
  | "timing"
  | "sessions"
  | "pairs" // "Pairs" (Dojix) / "Symbols" (Greenwick)
  | "risk"
  | "behavioral"
  | "advanced"
  | "propFirm"
  | "edgeReport"
  | "pulse";

export interface AnalyticsComponent<B extends BrandId = BrandId, M = unknown> {
  /** Stable id, the Mac component's type name (e.g. "WinLossDistribution"). */
  id: string;
  brands: readonly B[];
  /** One placement for every brand, or per brand (e.g. DrawdownChart: Dojix overview, Greenwick risk). */
  tab: AnalyticsPlacement | Partial<Record<B, AnalyticsPlacement>>;
  /** The Mac's own guard (e.g. n ≥ 5); `compute` is not called below it. */
  minTrades: number;
  /**
   * Pure computation. `trades` arrive in repository order (close time descending), the order
   * the Mac sums in. Return null for the component's empty state.
   */
  compute(ctx: EngineContext, trades: readonly TradeOf<B>[]): M | null;
}

/** The placement of a component in one brand (undefined when the brand doesn't ship it). */
export function placementFor<B extends BrandId>(
  component: Pick<AnalyticsComponent<B>, "brands" | "tab">,
  brand: BrandId,
): AnalyticsPlacement | undefined {
  if (!(component.brands as readonly BrandId[]).includes(brand)) return undefined;
  if (typeof component.tab === "string") return component.tab;
  return (component.tab as Partial<Record<BrandId, AnalyticsPlacement>>)[brand];
}

/** Identity helper that keeps the component's types precise. */
export function defineComponent<B extends BrandId, M>(component: AnalyticsComponent<B, M>): AnalyticsComponent<B, M> {
  return component;
}

/** A registry of components; ids are unique. */
export class AnalyticsRegistry {
  private readonly components = new Map<string, AnalyticsComponent<BrandId, unknown>>();

  register<B extends BrandId, M>(component: AnalyticsComponent<B, M>): this {
    if (this.components.has(component.id)) {
      throw new Error(`analytics component ${component.id} is registered twice`);
    }
    if (component.brands.length === 0) throw new Error(`analytics component ${component.id} has no brand`);
    for (const brand of component.brands) {
      if (placementFor(component, brand) === undefined) {
        throw new Error(`analytics component ${component.id} has no placement for ${brand}`);
      }
    }
    if (!Number.isInteger(component.minTrades) || component.minTrades < 0) {
      throw new Error(`analytics component ${component.id} has an invalid minTrades`);
    }
    this.components.set(component.id, component as unknown as AnalyticsComponent<BrandId, unknown>);
    return this;
  }

  get(id: string): AnalyticsComponent<BrandId, unknown> | undefined {
    return this.components.get(id);
  }

  /** Components for a brand (and optionally one placement), in registration order. */
  list(brand: BrandId, tab?: AnalyticsPlacement): AnalyticsComponent<BrandId, unknown>[] {
    return [...this.components.values()].filter((c) => {
      const placement = placementFor(c, brand);
      return placement !== undefined && (tab === undefined || placement === tab);
    });
  }

  /**
   * Runs one component: null when the brand doesn't ship it or there are fewer trades than
   * `minTrades`; otherwise its `compute` result.
   */
  run<B extends BrandId>(id: string, ctx: EngineContext & { brand: B }, trades: readonly TradeOf<B>[]): unknown {
    const c = this.components.get(id);
    if (!c) throw new Error(`unknown analytics component ${id}`);
    if (!c.brands.includes(ctx.brand) || trades.length < c.minTrades) return null;
    return c.compute(ctx, trades as readonly TradeOf<BrandId>[]);
  }
}
