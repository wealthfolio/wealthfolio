import { AccountScopeSelector } from "@/components/account-filter-selector";
import { SwipablePage, SwipablePageView } from "@/components/page";

import type { AccountScope } from "@/lib/types";
import IncomePage from "@/pages/income/income-page";
import PerformancePage from "@/pages/performance/performance-page";
import { useI18n } from "@/i18n/i18n-provider";
import { Icons } from "@wealthfolio/ui";
import { Card, CardContent, CardHeader } from "@wealthfolio/ui/components/ui/card";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Suspense, useMemo, useState, type ReactNode } from "react";
import { OverviewPage } from "./overview/overview-page";

// Loading skeleton to show while the dashboard is loading
const DashboardLoader = () => {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";

  return (
    <div className="flex h-full w-full flex-col space-y-4 p-4">
      <Card>
        <CardHeader className="space-y-2">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
      <div className="flex items-center justify-center py-8">
        <span className="text-muted-foreground text-sm">
          {isChinese ? "正在加载仪表盘..." : "Loading dashboard..."}
        </span>
      </div>
    </div>
  );
};

export default function PortfolioInsightsPage() {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const [accountFilter, setAccountScope] = useState<AccountScope>({ type: "all" });
  const [overviewToolbarActions, setOverviewToolbarActions] = useState<ReactNode | null>(null);

  const holdingsActions = useMemo(
    () =>
      overviewToolbarActions ?? (
        <AccountScopeSelector value={accountFilter} onChange={setAccountScope} />
      ),
    [accountFilter, overviewToolbarActions],
  );

  // Define the views with icons
  const views: SwipablePageView[] = useMemo(
    () => [
      {
        value: "overview",
        label: isChinese ? "概览" : "Overview",
        icon: Icons.PieChart,
        content: (
          <Suspense fallback={<DashboardLoader />}>
            <OverviewPage
              filter={accountFilter}
              onFilterChange={setAccountScope}
              onToolbarActionsChange={setOverviewToolbarActions}
            />
          </Suspense>
        ),
        actions: holdingsActions,
      },
      {
        value: "performance",
        label: isChinese ? "绩效" : "Performance",
        icon: Icons.TrendingUp,
        content: (
          <Suspense fallback={<DashboardLoader />}>
            <PerformancePage />
          </Suspense>
        ),
      },
      {
        value: "income",
        label: isChinese ? "收入" : "Income",
        icon: Icons.HandCoins,
        content: (
          <Suspense fallback={<DashboardLoader />}>
            <IncomePage />
          </Suspense>
        ),
      },
    ],
    [accountFilter, holdingsActions, isChinese],
  );

  return <SwipablePage views={views} defaultView="overview" withPadding={true} />;
}
