import { type KeyboardEvent, type ReactNode, useRef } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode | undefined;
  /** Shortcut shown in the tooltip ("Alt+1"). */
  hint?: string | undefined;
}

function moveFocus<T extends string>(
  e: KeyboardEvent,
  items: readonly TabItem<T>[],
  current: T,
  select: (id: T) => void,
  refs: Map<T, HTMLButtonElement>,
): void {
  const index = items.findIndex((i) => i.id === current);
  let next: number | null = null;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % items.length;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  if (next === null) return;
  e.preventDefault();
  const item = items[next] as TabItem<T>;
  select(item.id);
  refs.get(item.id)?.focus();
}

export interface PillTabsProps<T extends string> {
  items: readonly TabItem<T>[];
  selected: T;
  onSelect: (id: T) => void;
  /** Names the tab list for screen readers. */
  label: string;
  /** Prefix for ids: tabs are `${idPrefix}-tab-${id}`, the panel is `${idPrefix}-panel`. */
  idPrefix: string;
}

/**
 * The Mac's capsule sub-navigation (Analytics: Timing, Sessions, …). ARIA tabs with automatic
 * activation: arrow keys, Home and End move and select. Render the panel with `TabPanel`.
 */
export function PillTabs<T extends string>({ items, selected, onSelect, label, idPrefix }: PillTabsProps<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  return (
    <div className="pill-tabs" role="tablist" aria-label={label}>
      {items.map((item) => {
        const active = item.id === selected;
        return (
          <button
            key={item.id}
            ref={(el) => {
              if (el) refs.current.set(item.id, el);
              else refs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.id}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={active ? 0 : -1}
            className="pill-tab"
            title={item.hint}
            data-testid={`${idPrefix}-tab-${item.id}`}
            onClick={() => onSelect(item.id)}
            onKeyDown={(e) => moveFocus(e, items, selected, onSelect, refs.current)}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idPrefix, selected, children }: { idPrefix: string; selected: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel`} aria-labelledby={`${idPrefix}-tab-${selected}`} tabIndex={0}>
      {children}
    </div>
  );
}

export interface SegmentedControlProps<T extends string> {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  testId?: string | undefined;
}

/** A small radio group drawn as joined buttons (Essential / All, date ranges). */
export function SegmentedControl<T extends string>({ options, value, onChange, label, testId }: SegmentedControlProps<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  return (
    <div className="segmented" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.id}
          ref={(el) => {
            if (el) refs.current.set(o.id, el);
            else refs.current.delete(o.id);
          }}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          tabIndex={o.id === value ? 0 : -1}
          className="segmented-option"
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => moveFocus(e, options, value, onChange, refs.current)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
