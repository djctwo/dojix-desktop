import type { ReactNode } from "react";
import { cx } from "./Button";
import { HelpTip } from "./HelpTip";

export type MetricTone = "default" | "profit" | "loss" | "flat" | "accent" | "warning";

export interface MetricCardProps {
  label: string;
  /** Already formatted (core's asCurrency, asPercent, …): the card never formats numbers. */
  value: ReactNode;
  subtitle?: ReactNode | undefined;
  tone?: MetricTone | undefined;
  icon?: ReactNode | undefined;
  /** Definition shown by the "?" button. */
  help?: string | undefined;
  /** The smaller variant for secondary KPI rows (Mac `MetricCardSmall`). */
  small?: boolean | undefined;
  testId?: string | undefined;
}

/** One KPI (Mac `MetricCard`): uppercase label, large mono value, optional subtitle. */
export function MetricCard({ label, value, subtitle, tone = "default", icon, help, small = false, testId }: MetricCardProps) {
  return (
    <div className={cx("metric", small && "metric-small")} data-testid={testId}>
      <div className="metric-label">
        {icon}
        <span>{label}</span>
        {help !== undefined && <HelpTip term={label} definition={help} />}
      </div>
      <div className={cx("metric-value", tone !== "default" && `tone-${tone}`)}>{value}</div>
      {subtitle !== undefined && <div className="metric-subtitle">{subtitle}</div>}
    </div>
  );
}

/** A responsive grid of MetricCards. */
export function MetricGrid({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="metric-grid" role="group" aria-label={label}>
      {children}
    </div>
  );
}
