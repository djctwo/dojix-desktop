import { Component, type ReactNode } from "react";
import { type BrandConfig, formatFixed } from "@dojix-desktop/core";
import { cx } from "../primitives/Button";
import { HelpTip } from "../primitives/HelpTip";
import { EmptyState, ErrorState, Skeleton } from "../states/States";
import { type AnalyticsView, type CardResult, humanizeComponentId } from "./types";

export interface AnalyticsCardProps {
  componentId: string;
  /** The registered view; without one the card shows a field preview (FallbackView). */
  view: AnalyticsView | undefined;
  result: CardResult;
  brand: BrandConfig;
  tradeCount: number;
  locale: string;
  /** Heading level of the card title: 2 on a tab, 3 inside a titled section (default 2). */
  headingLevel?: 2 | 3 | undefined;
}

class CardBoundary extends Component<{ children: ReactNode; resetKey: unknown }, { failed: Error | null; key: unknown }> {
  override state: { failed: Error | null; key: unknown } = { failed: null, key: this.props.resetKey };

  static getDerivedStateFromError(failed: Error) {
    return { failed };
  }

  static getDerivedStateFromProps(props: { resetKey: unknown }, state: { failed: Error | null; key: unknown }) {
    return props.resetKey === state.key ? null : { failed: null, key: props.resetKey };
  }

  // No componentDidCatch: the failure is shown in the card, and nothing is logged or sent
  // from the web view (no telemetry).

  override render() {
    if (this.state.failed) {
      return <ErrorState compact title="This card could not be drawn" error={this.state.failed} />;
    }
    return this.props.children;
  }
}

/**
 * One analytics card: title, "?" help, and the body for each state (loading, below the
 * component's minimum, empty, error, ready). A view that throws only breaks its own card.
 */
export function AnalyticsCard({ componentId, view, result, brand, tradeCount, locale, headingLevel = 2 }: AnalyticsCardProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const title = view?.title ?? humanizeComponentId(componentId);
  const span = view?.span === 2 ? "span-2" : view?.span === "full" ? "span-full" : undefined;
  let body: ReactNode;
  switch (result.status) {
    case "loading":
      body = (
        <div aria-hidden="true" style={{ display: "grid", gap: 10 }}>
          <Skeleton height={18} width="40%" />
          <Skeleton height={90} />
        </div>
      );
      break;
    case "belowMin":
      body = (
        <EmptyState
          compact
          title="Needs more trades"
          message={`This appears once you have ${result.minTrades} trades (you have ${result.tradeCount}).`}
        />
      );
      break;
    case "empty":
      body = <EmptyState compact title="Not enough data yet" message={view?.emptyMessage} />;
      break;
    case "error":
      body = <ErrorState compact title="This card could not be calculated" error={result.message} />;
      break;
    case "ok": {
      const View = view?.view;
      body = (
        <CardBoundary resetKey={result.model}>
          {View ? (
            <View model={result.model} brand={brand} tradeCount={tradeCount} locale={locale} />
          ) : (
            <FallbackView model={result.model} />
          )}
        </CardBoundary>
      );
      break;
    }
  }
  return (
    <section
      className={cx("card", "analytics-card", span)}
      aria-labelledby={`card-${componentId}-title`}
      aria-busy={result.status === "loading" || undefined}
      data-testid={`analytics-card-${componentId}`}
      data-status={result.status}
    >
      <header className="card-header">
        <Heading className="card-title" id={`card-${componentId}-title`}>
          {title}
        </Heading>
        {view?.help !== undefined && (
          <div className="card-actions">
            <HelpTip term={title} definition={view.help} />
          </div>
        )}
      </header>
      <div className="card-body">{body}</div>
    </section>
  );
}

function scalar(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value) ? String(value) : formatFixed(value, 2);
  }
  if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return `${value.length} items`;
  return null;
}

/** Placeholder until a screen team registers the component's view: its top-level fields. */
export function FallbackView({ model }: { model: unknown }) {
  const entries =
    model !== null && typeof model === "object"
      ? Object.entries(model as Record<string, unknown>)
          .map(([k, v]) => [k, scalar(v)] as const)
          .filter((e): e is readonly [string, string] => e[1] !== null)
          .slice(0, 10)
      : [["value", scalar(model) ?? "—"] as const];
  return (
    <div className="analytics-fallback" data-testid="analytics-fallback">
      <dl>
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{humanizeComponentId(k.charAt(0).toUpperCase() + k.slice(1))}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export interface AnalyticsGridItem {
  id: string;
  result: CardResult;
}

export interface AnalyticsGridProps {
  items: readonly AnalyticsGridItem[];
  views: { get(id: string): AnalyticsView | undefined };
  brand: BrandConfig;
  tradeCount: number;
  locale: string;
  label: string;
  testId?: string | undefined;
  headingLevel?: 2 | 3 | undefined;
}

/** The responsive grid of cards for one tab or section. */
export function AnalyticsGrid({ items, views, brand, tradeCount, locale, label, testId, headingLevel }: AnalyticsGridProps) {
  return (
    <div className="grid-cards" role="group" aria-label={label} data-testid={testId}>
      {items.map((item) => (
        <AnalyticsCard
          key={item.id}
          componentId={item.id}
          view={views.get(item.id)}
          result={item.result}
          brand={brand}
          tradeCount={tradeCount}
          locale={locale}
          headingLevel={headingLevel}
        />
      ))}
    </div>
  );
}
