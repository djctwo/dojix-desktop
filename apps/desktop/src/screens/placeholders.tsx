import type { BrandConfig, ScreenId } from "@dojix-desktop/core";
import { PlaceholderScreen } from "@dojix-desktop/ui";

/** Who builds each remaining screen (docs/UI.md "Who builds what"). */
const PLANNED: Partial<Record<ScreenId, string>> = {
  import: "Drop zone, Choose File, Scan Folder, column mapping and import history (ui-tools).",
  pulse: "Session hero, danger zone, session cards, economic calendar and live prices (ui-brand).",
  browse: "Ticker search, quote card, company profile and your history with the symbol (ui-brand).",
  watchlist: "Your symbols with stats from your own trades and live quotes (ui-brand).",
};

export function PlannedScreen({ brand, screen }: { brand: BrandConfig; screen: ScreenId }) {
  const label = brand.sidebar.flatMap((s) => s.items).find((i) => i.id === screen)?.label ?? screen;
  return <PlaceholderScreen title={label} message={PLANNED[screen]} />;
}
