import type { BrandConfig } from "@dojix-desktop/core";
import { Screen } from "@dojix-desktop/ui";
import { AnalyticsTab } from "../analytics/AnalyticsTab";

/** Edge Report skeleton (ui-tools): the registry's Edge Report components; header metrics, "where you make / lose money", AI card and PDF come next. */
export function EdgeReportScreen({ brand }: { brand: BrandConfig }) {
  return (
    <Screen title="Edge Report" subtitle="Needs 30 trades or more." wide testId="screen-edgeReport">
      <AnalyticsTab brand={brand} placement="edgeReport" label="Edge report" />
    </Screen>
  );
}
