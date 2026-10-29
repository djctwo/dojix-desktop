import {
  type ColumnDef,
  type ColumnOrderState,
  type OnChangeFn,
  type Row,
  type RowData,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cx } from "../primitives/Button";

declare module "@tanstack/react-table" {
  // Column options the design system reads. `TData`/`TValue` are required by the declaration.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Right-aligned, monospaced, tabular figures (money, counts, R). */
    numeric?: boolean | undefined;
    /** Extra class on the header and cells. */
    className?: string | undefined;
  }
}

/**
 * Any column definition. TanStack's `ColumnDef<T, TValue>` is invariant in `TValue`, so a list
 * of mixed columns needs `any` there (the library's own documented pattern).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataColumn<T> = ColumnDef<T, any>;

export interface DataTableProps<T> {
  data: readonly T[];
  columns: DataColumn<T>[];
  /** Names the table for screen readers. */
  label: string;
  /** Stable row ids (default: the index). Needed for selection that survives sorting. */
  getRowId?: ((row: T, index: number) => string) | undefined;
  /** Uncontrolled initial sort, or controlled with `sorting` + `onSortingChange`. */
  initialSorting?: SortingState | undefined;
  sorting?: SortingState | undefined;
  onSortingChange?: OnChangeFn<SortingState> | undefined;
  columnVisibility?: VisibilityState | undefined;
  onColumnVisibilityChange?: OnChangeFn<VisibilityState> | undefined;
  columnOrder?: ColumnOrderState | undefined;
  onColumnOrderChange?: OnChangeFn<ColumnOrderState> | undefined;
  /** Click, Enter or Space on a row. Makes rows focusable with arrow-key navigation. */
  onRowActivate?: ((row: T) => void) | undefined;
  selectedRowId?: string | null | undefined;
  /** Shown in the body when there are no rows. */
  empty?: ReactNode | undefined;
  /** Virtualise above this many rows (default 200). */
  virtualizeAbove?: number | undefined;
  /** Row height in px for virtualisation (default 38). */
  rowHeight?: number | undefined;
  /** Height of the scroll area; required for virtualisation to pay off (default 70vh). */
  maxHeight?: number | string | undefined;
  testId?: string | undefined;
}

const PAGE = 10;

/**
 * The app's table: TanStack Table for sorting/visibility/order, TanStack Virtual above
 * `virtualizeAbove` rows (100k-row journals), sticky header, aria-sort, and roving focus with
 * arrow keys when rows are activatable.
 */
export function DataTable<T>({
  data,
  columns,
  label,
  getRowId,
  initialSorting = [],
  sorting,
  onSortingChange,
  columnVisibility,
  onColumnVisibilityChange,
  columnOrder,
  onColumnOrderChange,
  onRowActivate,
  selectedRowId = null,
  empty,
  virtualizeAbove = 200,
  rowHeight = 38,
  maxHeight = "70vh",
  testId,
}: DataTableProps<T>) {
  const [ownSorting, setOwnSorting] = useState<SortingState>(initialSorting);
  const [active, setActive] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // TanStack Table returns functions that can't be memoised by the compiler; that is expected.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: data as T[],
    columns,
    state: {
      sorting: sorting ?? ownSorting,
      ...(columnVisibility ? { columnVisibility } : {}),
      ...(columnOrder ? { columnOrder } : {}),
    },
    onSortingChange: onSortingChange ?? setOwnSorting,
    ...(onColumnVisibilityChange ? { onColumnVisibilityChange } : {}),
    ...(onColumnOrderChange ? { onColumnOrderChange } : {}),
    ...(getRowId ? { getRowId } : {}),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;
  const virtual = rows.length > virtualizeAbove;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    enabled: virtual,
    initialRect: { width: 800, height: 600 },
  });

  const items = virtual ? virtualizer.getVirtualItems() : null;
  const visible: { row: Row<T>; index: number }[] = items
    ? items.map((v) => ({ row: rows[v.index] as Row<T>, index: v.index }))
    : rows.map((row, index) => ({ row, index }));
  const padTop = items && items.length > 0 ? (items[0]?.start ?? 0) : 0;
  const padBottom = items && items.length > 0 ? virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0) : 0;
  const interactive = onRowActivate !== undefined;
  const columnCount = table.getVisibleLeafColumns().length;
  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0));

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    setActive(clamped);
    if (virtual) virtualizer.scrollToIndex(clamped);
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`tr[data-index="${clamped}"]`)?.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (!interactive || rows.length === 0) return;
    const moves: Record<string, number> = {
      ArrowDown: activeIndex + 1,
      ArrowUp: activeIndex - 1,
      PageDown: activeIndex + PAGE,
      PageUp: activeIndex - PAGE,
      Home: 0,
      End: rows.length - 1,
    };
    const target = moves[e.key];
    if (target !== undefined) {
      e.preventDefault();
      focusRow(target);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) onRowActivate(row.original);
    }
  };

  return (
    <div
      ref={scrollRef}
      className="table-wrap"
      style={{ maxHeight }}
      data-testid={testId}
      // A scroll area must be reachable by keyboard when its rows are not (axe: scrollable-region-focusable).
      tabIndex={interactive ? undefined : 0}
      role={interactive ? undefined : "region"}
      aria-label={interactive ? undefined : label}
    >
      <table className="data-table" aria-label={label} aria-rowcount={rows.length + 1}>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} aria-rowindex={1}>
              {group.headers.map((header) => {
                const meta = header.column.columnDef.meta;
                const sorted = header.column.getIsSorted();
                const canSort = header.column.getCanSort();
                const content = header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext());
                return (
                  <th
                    key={header.id}
                    scope="col"
                    className={cx(meta?.numeric && "num", meta?.className)}
                    aria-sort={canSort ? (sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none") : undefined}
                  >
                    {canSort ? (
                      <button type="button" className="th-sort" onClick={header.column.getToggleSortingHandler()}>
                        {content}
                        {sorted === "asc" ? (
                          <ArrowUp size={12} aria-hidden="true" />
                        ) : sorted === "desc" ? (
                          <ArrowDown size={12} aria-hidden="true" />
                        ) : (
                          <ArrowUpDown size={12} aria-hidden="true" opacity={0.5} />
                        )}
                      </button>
                    ) : (
                      content
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody onKeyDown={onKeyDown}>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount} className="table-empty">
                {empty ?? "No rows"}
              </td>
            </tr>
          ) : (
            <>
              {padTop > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={columnCount} style={{ height: padTop, padding: 0, border: 0 }} />
                </tr>
              )}
              {visible.map(({ row, index }) => (
                <tr
                  key={row.id}
                  data-index={index}
                  aria-rowindex={index + 2}
                  aria-selected={interactive ? row.id === selectedRowId : undefined}
                  data-clickable={interactive || undefined}
                  tabIndex={interactive ? (index === activeIndex ? 0 : -1) : undefined}
                  onClick={
                    interactive
                      ? () => {
                          setActive(index);
                          onRowActivate(row.original);
                        }
                      : undefined
                  }
                  onFocus={interactive ? () => setActive(index) : undefined}
                  style={virtual ? { height: rowHeight } : undefined}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta;
                    return (
                      <td key={cell.id} className={cx(meta?.numeric && "num", meta?.className)}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {padBottom > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={columnCount} style={{ height: padBottom, padding: 0, border: 0 }} />
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
