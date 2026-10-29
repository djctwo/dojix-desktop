import type { CSSProperties, ReactNode } from "react";
import { CircleAlert, Inbox } from "lucide-react";
import { errorMessage } from "@dojix-desktop/core";
import { Button, cx } from "../primitives/Button";

export interface EmptyStateProps {
  title: string;
  message?: ReactNode | undefined;
  icon?: ReactNode | undefined;
  /** A call to action ("Import trades"). */
  action?: { label: string; onClick: () => void } | undefined;
  /** Inside a card: no own border or background. */
  compact?: boolean | undefined;
  testId?: string | undefined;
}

/** Nothing to show yet (Mac `EmptyStateView`): icon, title, one sentence, optional action. */
export function EmptyState({ title, message, icon, action, compact = false, testId }: EmptyStateProps) {
  return (
    <div className={cx("empty", compact && "empty-compact")} data-testid={testId}>
      <span className="empty-icon" aria-hidden="true">
        {icon ?? <Inbox size={44} strokeWidth={1.5} />}
      </span>
      <h2 className="empty-title">{title}</h2>
      {message !== undefined && <p>{message}</p>}
      {action && (
        <Button variant="primary" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

export interface LoadingStateProps {
  /** Announced to screen readers and shown next to the spinner. */
  label?: string | undefined;
  compact?: boolean | undefined;
  testId?: string | undefined;
}

/** Work in progress. Announced politely; `aria-busy` marks the region. */
export function LoadingState({ label = "Loading…", compact = false, testId }: LoadingStateProps) {
  return (
    <div className={cx("loading", compact && "loading-compact")} role="status" aria-busy="true" data-testid={testId}>
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** A placeholder block while content loads. Decorative: pair it with a LoadingState label. */
export function Skeleton({ width = "100%", height = 14, style }: { width?: number | string; height?: number | string; style?: CSSProperties }) {
  return <span className="skeleton" aria-hidden="true" style={{ width, height, ...style }} />;
}

export interface ErrorStateProps {
  title?: string | undefined;
  /** An Error, an IPC OpError or text; shown with core's `errorMessage`. */
  error: unknown;
  onRetry?: (() => void) | undefined;
  compact?: boolean | undefined;
  testId?: string | undefined;
}

/** Something failed. Uses role="alert" so the failure is announced. */
export function ErrorState({ title = "Something went wrong", error, onRetry, compact = false, testId }: ErrorStateProps) {
  return (
    <div className={cx("empty", "state-error", compact && "empty-compact")} role="alert" data-testid={testId}>
      <span className="empty-icon" aria-hidden="true">
        <CircleAlert size={40} strokeWidth={1.5} />
      </span>
      <h2 className="empty-title">{title}</h2>
      <p>{errorMessage(error)}</p>
      {onRetry && <Button onClick={onRetry}>Try again</Button>}
    </div>
  );
}

/** The parts of a TanStack Query result that QueryState reads (structurally compatible). */
export interface QueryLike<T> {
  status: "pending" | "error" | "success";
  data: T | undefined;
  error: unknown;
  refetch?: (() => unknown) | undefined;
}

export interface QueryStateProps<T> {
  query: QueryLike<T>;
  /** Rendered with the data once it is there and not empty. */
  children: (data: T) => ReactNode;
  /** When true for the data, `empty` is shown instead of `children`. */
  isEmpty?: ((data: T) => boolean) | undefined;
  empty?: ReactNode | undefined;
  loading?: ReactNode | undefined;
  errorTitle?: string | undefined;
}

/**
 * The one way screens render async data: loading → error (with retry) → empty → content.
 * Keeps the three states consistent across every screen.
 */
export function QueryState<T>({ query, children, isEmpty, empty, loading, errorTitle }: QueryStateProps<T>) {
  if (query.status === "pending") return <>{loading ?? <LoadingState />}</>;
  if (query.status === "error") {
    const refetch = query.refetch;
    return <ErrorState title={errorTitle} error={query.error} onRetry={refetch ? () => void refetch() : undefined} />;
  }
  const data = query.data as T;
  if (isEmpty?.(data)) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return <>{children(data)}</>;
}
