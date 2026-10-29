import type { BrandConfig } from "@dojix-desktop/core";
import { PillTabs, Screen, TabPanel } from "@dojix-desktop/ui";
import { AnalyticsTab } from "../analytics/AnalyticsTab";
import { useNavigation } from "../app/navigation";
import { ANALYTICS_TABS, analyticsTabLabel } from "../app/shortcuts";

/** Analytics: the Mac's pill sub-navigation (Alt+1–6) over the registry placements. */
export function AnalyticsScreen({ brand }: { brand: BrandConfig }) {
  const { analyticsTab, showAnalyticsTab } = useNavigation();
  const items = ANALYTICS_TABS.map((id, i) => ({ id, label: analyticsTabLabel(id, brand.id), hint: `Alt+${i + 1}` }));
  const label = analyticsTabLabel(analyticsTab, brand.id);
  return (
    <Screen title="Analytics" wide testId="screen-analytics">
      <PillTabs items={items} selected={analyticsTab} onSelect={showAnalyticsTab} label="Analytics categories" idPrefix="analytics" />
      <TabPanel idPrefix="analytics" selected={analyticsTab}>
        <AnalyticsTab key={analyticsTab} brand={brand} placement={analyticsTab} label={`${label} analytics`} />
      </TabPanel>
    </Screen>
  );
}
