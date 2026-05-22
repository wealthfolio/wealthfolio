import { AccountScopeSelector } from "@/components/account-filter-selector";
import { SwipablePage, SwipablePageView } from "@/components/page";

import type { AccountScope } from "@/lib/types";
import IncomePage from "@/pages/income/income-page";
import PerformancePage from "@/pages/performance/performance-page";
import { Icons } from "@wealthfolio/ui";
import { Card, CardContent, CardHeader } from "@wealthfolio/ui/components/ui/card";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Suspense, useMemo, useState } from "react";
import HoldingsInsightsPage from "../holdings/holdings-insights-page";

// Loading skeleton to show while the dashboard is loading
const DashboardLoader = () => (
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
      <span className="text-muted-foreground text-sm">Loading dashboard...</span>
    </div>
  </div>
);

export default function PortfolioInsightsPage() {
  const [accountFilter, setAccountScope] = useState<AccountScope>({ type: "all" });

  const holdingsActions = useMemo(
    () => <AccountScopeSelector value={accountFilter} onChange={setAccountScope} />,
    [accountFilter],
  );

  // Define the views with icons
  const views: SwipablePageView[] = useMemo(
    () => [
      {
        value: "holdings",
        label: "Holdings",
        icon: Icons.PieChart,
        content: (
          <Suspense fallback={<DashboardLoader />}>
            <HoldingsInsightsPage filter={accountFilter} />
          </Suspense>
        ),
        actions: holdingsActions,
      },
      {
        value: "performance",
        label: "Performance",
        icon: Icons.TrendingUp,
        content: (
          <Suspense fallback={<DashboardLoader />}>
            <PerformancePage />
          </Suspense>
        ),
      },
      {
        value: "income",
        label: "Income",
        icon: Icons.HandCoins,
        content: (
          <Suspense fallback={<DashboardLoader />}>
            <IncomePage />
          </Suspense>
        ),
      },
    ],
    [accountFilter, holdingsActions],
  );

  return <SwipablePage views={views} defaultView="holdings" withPadding={true} />;
}
