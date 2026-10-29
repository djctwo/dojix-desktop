import type { AnalyticsPlacement, BrandConfig } from "@dojix-desktop/core";
import { AnalyticsGrid, type AnalyticsView, EmptyState, ErrorState, Skeleton } from "@dojix-desktop/ui";
import { useAnalyticsEnvironment } from "./context";
import { useAnalyticsRun } from "./hooks";
import type { TradeFilter } from "./protocol";
import { analyticsViews } from "./views";

export interface AnalyticsTabProps {
  brand: BrandConfig;
  placement: AnalyticsPlacement;
  filter?: TradeFilter | undefined;
  /** Names the card group for screen readers ("Timing analytics"). */
  label: string;
  views?: { get(id: string): AnalyticsView | undefined } | undefined;
}

/**
 * Every registry component placed on `placement` for the brand, as cards. This is all a screen
 * needs: the registry decides which components appear, the worker computes them, the views
 * registry draws them.
 */
export function AnalyticsTab({ brand, placement, filter, label, views = analyticsViews }: AnalyticsTabProps) {
  const { settings } = useAnalyticsEnvironment();
  const run = useAnalyticsRun({ brand: brand.id, placement, filter });
  if (run.status === "pending") {
    return (
      <div className="grid-cards" aria-busy="true" data-testid={`analytics-${placement}-loading`}>
        <span className="visually-hidden" role="status">
          Calculating…
        </span>
        {[0, 1, 2, 3].map((i) => (
          <div className="card analytics-card" key={i} aria-hidden="true">
            <Skeleton height={18} width="45%" />
            <Skeleton height={110} style={{ marginTop: 12 }} />
          </div>
        ))}
      </div>
    );
  }
  if (run.status === "error") {
    return <ErrorState title="Analytics could not be calculated" error={run.error} onRetry={() => void run.refetch()} testId={`analytics-${placement}-error`} />;
  }
  const result = run.data;
  if (result.cards.length === 0) {
    return <EmptyState title="Nothing on this tab" message="No analytics are placed here for this app." testId={`analytics-${placement}-none`} />;
  }
  return (
    <AnalyticsGrid
      items={result.cards}
      views={views}
      brand={brand}
      tradeCount={result.tradeCount}
      locale={settings.locale}
      label={label}
      testId={`analytics-${placement}`}
    />
  );
}
