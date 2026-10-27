import type { ReactNode } from "react";
import type { BrandConfig, ScreenId } from "@dojix-desktop/core";

export interface AppShellProps {
  brand: BrandConfig;
  active: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  status?: ReactNode;
  children: ReactNode;
}

/** Sidebar + content area, the frame every screen renders inside. */
export function AppShell({ brand, active, onNavigate, status, children }: AppShellProps) {
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="wordmark">
          <span className="wordmark-mark" aria-hidden="true" />
          <span className="wordmark-name" data-testid="brand-name">
            {brand.productName}
          </span>
        </div>
        {brand.sidebar.map((section) => (
          <div className="nav-section" key={section.title}>
            <div className="nav-section-title">{section.title}</div>
            <ul>
              {section.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={item.id === active ? "nav-item nav-item-active" : "nav-item"}
                    aria-current={item.id === active ? "page" : undefined}
                    data-testid={`nav-${item.id}`}
                    onClick={() => onNavigate(item.id)}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="sidebar-footer" data-testid="status">
          {status}
        </div>
      </nav>
      <main className="content">{children}</main>
    </div>
  );
}
