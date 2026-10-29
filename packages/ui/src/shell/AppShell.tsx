import { type ReactNode, useState } from "react";
import { ChevronRight, CircleHelp } from "lucide-react";
import type { BrandConfig, ScreenId } from "@dojix-desktop/core";
import { cx } from "../primitives/Button";
import { ScreenIcon } from "../primitives/icons";

export interface AppShellProps {
  brand: BrandConfig;
  active: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  /** Shortcut hints shown on hover ("Ctrl+1"), by screen. */
  shortcutHints?: Partial<Record<ScreenId, string>> | undefined;
  /** Brand widgets under the navigation (Dojix live ticker, session clock). */
  sidebarExtras?: ReactNode | undefined;
  /** Journal status, App Lock state, version. */
  status?: ReactNode | undefined;
  /** Shows the Help link in the sidebar footer. */
  onHelp?: (() => void) | undefined;
  helpHint?: string | undefined;
  children: ReactNode;
}

/**
 * Sidebar + content: the frame every screen renders in. Layout follows the Mac sidebar: the
 * first section has no header, the others ("Market", "Tools") collapse; the active item gets the
 * accent tint, border and left bar; hints appear on hover.
 */
export function AppShell({
  brand,
  active,
  onNavigate,
  shortcutHints = {},
  sidebarExtras,
  status,
  onHelp,
  helpHint,
  children,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (title: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <div className="wordmark">
          <span className="wordmark-mark" aria-hidden="true" />
          <span className="wordmark-name" data-testid="brand-name">
            {brand.productName}
          </span>
        </div>
        <div className="sidebar-scroll">
          {brand.sidebar.map((section, index) => {
            const open = !collapsed.has(section.title);
            const listId = `nav-section-${index}`;
            return (
              <div className="nav-section" key={section.title}>
                {index > 0 && (
                  <button
                    type="button"
                    className="nav-section-header"
                    aria-expanded={open}
                    aria-controls={listId}
                    onClick={() => toggle(section.title)}
                  >
                    {section.title}
                    <ChevronRight className="nav-section-chevron" size={12} aria-hidden="true" />
                  </button>
                )}
                <ul className="nav-list" id={listId} hidden={!open} aria-label={index === 0 ? section.title : undefined}>
                  {section.items.map((item) => {
                    const current = item.id === active;
                    const hint = shortcutHints[item.id];
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          className={cx("nav-item", current && "nav-item-active")}
                          aria-current={current ? "page" : undefined}
                          aria-keyshortcuts={hint?.replaceAll("Ctrl", "Control")}
                          data-testid={`nav-${item.id}`}
                          onClick={() => onNavigate(item.id)}
                        >
                          <ScreenIcon screen={item.id} className="nav-item-icon" />
                          <span className="nav-item-label">{item.label}</span>
                          {hint && (
                            <span className="nav-item-hint" aria-hidden="true">
                              {hint}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
        {sidebarExtras}
        <div className="sidebar-footer" data-testid="status">
          {onHelp && (
            <button
              type="button"
              className="sidebar-help"
              onClick={onHelp}
              data-testid="nav-help"
              aria-current={active === "help" ? "page" : undefined}
              aria-keyshortcuts={helpHint ? "F1" : undefined}
            >
              <CircleHelp size={16} aria-hidden="true" />
              Help{helpHint ? <span className="visually-hidden"> ({helpHint})</span> : null}
            </button>
          )}
          {status}
        </div>
      </nav>
      {/* Focusable so the keyboard can scroll it when a screen has no controls (axe scrollable-region-focusable). */}
      <main className="content" id="main-content" tabIndex={0}>
        {children}
      </main>
    </div>
  );
}
