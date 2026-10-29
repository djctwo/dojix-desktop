// Screen icons: the Lucide glyphs the Mac Dojix sidebar uses (Resources/Assets.xcassets/Icons),
// and Lucide equivalents of Greenwick's SF Symbols for the screens Dojix doesn't have.
import {
  Activity,
  BookOpen,
  CircleHelp,
  Crosshair,
  LayoutGrid,
  type LucideIcon,
  Radio,
  Search,
  Settings,
  Star,
  Upload,
} from "lucide-react";
import type { ScreenId } from "@dojix-desktop/core";

export const SCREEN_ICONS: Readonly<Record<ScreenId, LucideIcon>> = {
  journal: BookOpen,
  dashboard: LayoutGrid,
  analytics: Activity,
  edgeReport: Crosshair,
  pulse: Radio,
  browse: Search,
  watchlist: Star,
  import: Upload,
  settings: Settings,
  help: CircleHelp,
};

export function ScreenIcon({ screen, size = 18, className }: { screen: ScreenId; size?: number; className?: string }) {
  const Icon = SCREEN_ICONS[screen];
  return <Icon size={size} className={className} aria-hidden="true" />;
}
