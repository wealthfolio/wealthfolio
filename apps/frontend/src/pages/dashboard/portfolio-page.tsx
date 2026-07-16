import { HealthStatusIndicator } from "@/components/health-status-icon";
import { SwipablePage, SwipablePageView } from "@/components/page";
import { PrivacyToggle } from "@/components/privacy-toggle";
import { AlternativeAssetQuickAddModal } from "@/pages/asset/alternative-assets/components";
import { useNavigationMode } from "@/pages/layouts/navigation/navigation-mode-context";
import { AlternativeAssetKind } from "@/lib/types";
import SpendingTabContent from "@/features/spending/components/spending-tab-content";
import { useSpendingSettings } from "@/features/spending/hooks/use-spending-settings";
import { Button, Icons, type Icon } from "@wealthfolio/ui";
import { HandCoinsIcon } from "@phosphor-icons/react/dist/csr/HandCoins";
import { TrendUpIcon } from "@phosphor-icons/react/dist/csr/TrendUp";
import { WalletIcon } from "@phosphor-icons/react/dist/csr/Wallet";
import { Card, CardContent, CardHeader } from "@wealthfolio/ui/components/ui/card";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Suspense, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NetWorthContent } from "../net-worth/net-worth-content";
import { DashboardActions } from "./dashboard-actions";
import { DashboardContent } from "./dashboard-content";

// Tab icons rendered as duotone Phosphor glyphs
const InvestmentsTabIcon: Icon = (props) => <TrendUpIcon weight="duotone" {...props} />;
const NetWorthTabIcon: Icon = (props) => <WalletIcon weight="duotone" {...props} />;
const SpendingTabIcon: Icon = (props) => <HandCoinsIcon weight="duotone" {...props} />;

// Loading skeleton
const PageLoader = () => (
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
  </div>
);

export default function PortfolioPage() {
  const { t } = useTranslation();
  const { isFocusMode, toggleFocusMode } = useNavigationMode();

  // Alternative asset quick-add modal state
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [modalDefaultKind, setModalDefaultKind] = useState<AlternativeAssetKind | undefined>();
  const [pendingLiabilityLink, setPendingLiabilityLink] = useState<string | null>(null);
  const [pendingLiabilityType, setPendingLiabilityType] = useState<string | undefined>();
  const [pendingMortgageName, setPendingMortgageName] = useState<string | undefined>();

  const handleAddAsset = useCallback(() => {
    setModalDefaultKind(undefined);
    setIsQuickAddOpen(true);
  }, []);

  const handleAddLiability = useCallback(() => {
    setModalDefaultKind(AlternativeAssetKind.LIABILITY);
    setIsQuickAddOpen(true);
  }, []);

  const handleOpenLiabilityQuickAdd = useCallback(
    (propertyId: string, _purchaseDate?: Date, propertyName?: string) => {
      setPendingLiabilityLink(propertyId);
      setPendingLiabilityType("mortgage");
      setPendingMortgageName(propertyName ? `${propertyName} Mortgage` : undefined);
      setModalDefaultKind(AlternativeAssetKind.LIABILITY);
      setIsQuickAddOpen(true);
    },
    [],
  );

  const commonActions = (
    <>
      <HealthStatusIndicator />
      {isFocusMode && (
        <Button
          variant="secondary"
          size="icon-xs"
          className="bg-secondary/50 rounded-full"
          onClick={toggleFocusMode}
        >
          <Icons.Fullscreen className="size-5" />
        </Button>
      )}
      <PrivacyToggle />
    </>
  );

  const investmentActions = (
    <>
      {commonActions}
      <DashboardActions />
    </>
  );

  const netWorthActions = (
    <>
      {commonActions}
      <DashboardActions onAddAsset={handleAddAsset} onAddLiability={handleAddLiability} />
    </>
  );

  const { isEnabled: spendingEnabled } = useSpendingSettings();

  const views: SwipablePageView[] = useMemo(() => {
    const items: SwipablePageView[] = [
      {
        value: "investments",
        label: t("dashboard:tabs.investments"),
        icon: InvestmentsTabIcon,
        content: (
          <Suspense fallback={<PageLoader />}>
            <DashboardContent />
          </Suspense>
        ),
        actions: investmentActions,
      },
      {
        value: "net-worth",
        label: t("dashboard:tabs.net_worth"),
        icon: NetWorthTabIcon,
        content: (
          <Suspense fallback={<PageLoader />}>
            <NetWorthContent />
          </Suspense>
        ),
        actions: netWorthActions,
      },
    ];
    if (spendingEnabled) {
      items.push({
        value: "spending",
        label: t("dashboard:tabs.spending"),
        icon: SpendingTabIcon,
        content: (
          <Suspense fallback={<PageLoader />}>
            <SpendingTabContent />
          </Suspense>
        ),
        actions: commonActions,
      });
    }
    return items;
  }, [
    t,
    investmentActions,
    netWorthActions,
    commonActions,
    handleAddAsset,
    handleAddLiability,
    spendingEnabled,
  ]);

  return (
    <>
      <SwipablePage
        className="pt-0"
        views={views}
        defaultView="investments"
        withPadding={false}
        withMobileNavOffset={false}
        mobileActionsPlacement="header"
        persistKey="dashboard-tab"
      />
      <AlternativeAssetQuickAddModal
        open={isQuickAddOpen}
        onOpenChange={(open) => {
          setIsQuickAddOpen(open);
          if (!open) {
            setModalDefaultKind(undefined);
            setPendingLiabilityLink(null);
            setPendingLiabilityType(undefined);
            setPendingMortgageName(undefined);
          }
        }}
        defaultKind={modalDefaultKind}
        linkedAssetId={pendingLiabilityLink ?? undefined}
        defaultLiabilityType={pendingLiabilityType}
        defaultName={pendingMortgageName}
        onOpenLiabilityQuickAdd={handleOpenLiabilityQuickAdd}
      />
    </>
  );
}
