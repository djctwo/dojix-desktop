// The analytics engine as the worker runs it, kept free of worker plumbing so it is unit-tested
// directly (and used in-thread where Workers don't exist, e.g. jsdom).

import {
  type AnalyticsRegistry,
  type BrandId,
  type EngineContext,
  type Trade,
  calculateMetrics,
  createAnalyticsRegistry,
  createEngineContext,
  createRng,
  dateRangeCutoff,
  errorMessage,
  toEngineTrade,
} from "@dojix-desktop/core";
import type { CardResult } from "@dojix-desktop/ui";
import type { LoadResult, RunRequest, RunResult } from "./protocol";

/** Seed of the per-component random generator (Monte Carlo): deterministic per run (PARITY D-05). */
export const ANALYTICS_SEED = 0x5eed;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class AnalyticsEngine {
  private brand: BrandId | null = null;
  private datasetId = -1;
  private trades: Trade[] = [];

  constructor(private readonly registry: AnalyticsRegistry = createAnalyticsRegistry()) {}

  /** Replaces the dataset. Rows arrive close time descending (repository order). */
  load(datasetId: number, brand: BrandId, rows: readonly Parameters<typeof toEngineTrade>[0][]): LoadResult {
    const trades: Trade[] = [];
    const skipped: LoadResult["skipped"] = [];
    for (const row of rows) {
      try {
        trades.push(toEngineTrade(row, brand));
      } catch (e) {
        skipped.push({ id: row.id, reason: errorMessage(e) });
      }
    }
    this.brand = brand;
    this.datasetId = datasetId;
    this.trades = trades;
    return { datasetId, count: trades.length, skipped };
  }

  run(req: Omit<RunRequest, "type" | "requestId">): RunResult {
    if (this.brand === null || req.datasetId !== this.datasetId) {
      throw new Error(`analytics dataset ${req.datasetId} is not loaded`);
    }
    const started = now();
    const brand = this.brand;
    const ctx: EngineContext = createEngineContext({
      brand,
      now: req.now,
      local: { tz: req.settings.tz, weekStart: req.settings.weekStart, minDaysInFirstWeek: req.settings.minDaysInFirstWeek },
      locale: req.settings.locale,
      brokerOffset: req.settings.brokerOffset,
      compat: req.settings.compat,
    });
    const filtered = this.filter(ctx, req);
    const components = req.componentIds
      ? req.componentIds.map((id) => {
          const c = this.registry.get(id);
          if (!c) throw new Error(`unknown analytics component ${id}`);
          return c;
        })
      : this.registry.list(brand, req.placement);
    const cards = components.map((c) => {
      let result: CardResult;
      if (!c.brands.includes(brand)) {
        result = { status: "error", message: `${c.id} is not part of this app` };
      } else if (filtered.length < c.minTrades) {
        result = { status: "belowMin", minTrades: c.minTrades, tradeCount: filtered.length };
      } else {
        try {
          // A fresh generator per component keeps each card's numbers independent of the tab layout.
          const model = c.compute({ ...ctx, rng: createRng(ANALYTICS_SEED) }, filtered);
          result = model === null || model === undefined ? { status: "empty" } : { status: "ok", model };
        } catch (e) {
          result = { status: "error", message: errorMessage(e) };
        }
      }
      return { id: c.id, minTrades: c.minTrades, result };
    });
    const metrics = req.metrics ? calculateMetrics(filtered, { brand, compat: req.settings.compat }) : undefined;
    return { datasetId: req.datasetId, tradeCount: filtered.length, cards, metrics, ms: now() - started };
  }

  private filter(ctx: EngineContext, req: Pick<RunRequest, "filter" | "now">): Trade[] {
    const { dateRange, symbol } = req.filter;
    if ((dateRange === undefined || dateRange === "all") && !symbol) return this.trades;
    const cutoff = dateRange && dateRange !== "all" ? dateRangeCutoff(dateRange, req.now, ctx.calendar) : null;
    return this.trades.filter((t) => (cutoff === null || t.closeTime >= cutoff) && (!symbol || t.symbol === symbol));
  }
}

/** Replaces models the structured-clone algorithm can't send with an error card. */
export function cloneSafe(result: RunResult): RunResult {
  return {
    ...result,
    cards: result.cards.map((card) => {
      if (card.result.status !== "ok") return card;
      try {
        structuredClone(card.result.model);
        return card;
      } catch (e) {
        return { ...card, result: { status: "error", message: `model can't be sent from the worker: ${errorMessage(e)}` } };
      }
    }),
  };
}
