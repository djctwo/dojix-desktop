import type { BrandConfig } from "@dojix-desktop/core";
import { Card, Kbd, Screen } from "@dojix-desktop/ui";
import { shortcutsFor } from "../app/shortcuts";

const SCOPES = { global: "Everywhere", analytics: "On Analytics", import: "On Import" } as const;

/** Help (F1 / Ctrl+?): every keyboard shortcut (the Mac page omits three), then the help topics (ui-tools). */
export function HelpScreen({ brand, version }: { brand: BrandConfig; version: string | null }) {
  const shortcuts = shortcutsFor(brand.id);
  return (
    <Screen title="Help" testId="screen-help">
      <Card title="Keyboard shortcuts">
        <table className="shortcut-table" data-testid="shortcut-table">
          <thead>
            <tr>
              <th scope="col">Keys</th>
              <th scope="col">Does</th>
              <th scope="col">Where</th>
            </tr>
          </thead>
          <tbody>
            {shortcuts.map((s) => (
              <tr key={s.keys.join(" ")}>
                <td>
                  <span className="shortcut-keys">
                    {s.keys.map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span className="muted"> or </span>}
                        <Kbd>{k}</Kbd>
                      </span>
                    ))}
                  </span>
                </td>
                <td>{s.description}</td>
                <td className="muted">{SCOPES[s.scope]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title={`About ${brand.productName}`}>
        <p className="muted" style={{ margin: 0 }}>
          {brand.tagline}
          {version ? ` · version ${version}` : ""}. Free and open source (GPL-3.0). Your journal stays encrypted on this
          computer. Not financial advice.
        </p>
      </Card>
    </Screen>
  );
}
