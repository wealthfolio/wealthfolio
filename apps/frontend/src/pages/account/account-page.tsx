import { getHoldings, getSnapshots, searchActivities } from "@/adapters";
import { HistoryChart } from "@/components/history-chart";
import type { ActivityDetails } from "@/lib/types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  GainAmount,
  GainPercent,
  AnimatedToggleGroup,
  IntervalSelector,
  Page,
  PageContent,
  PageHeader,
  PrivacyAmount,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui";
import { useMemo, useState } from "react";

import { ActionPalette, type ActionPaletteGroup } from "@/components/action-palette";
import { PrivacyToggle } from "@/components/privacy-toggle";
import { useAccounts } from "@/hooks/use-accounts";
import { useRecalculatePortfolioMutation } from "@/hooks/use-calculate-portfolio";
import { useValuationHistory } from "@/hooks/use-valuation-history";
import { canAddHoldings } from "@/lib/activity-restrictions";
import { AccountType, HoldingType } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import {
  Account,
  AccountValuation,
  DateRange,
  Holding,
  SnapshotInfo,
  TimePeriod,
  TrackedItem,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { ActivityTableMobile } from "@/pages/activity/components/activity-table/activity-table-mobile";
import { BulkHoldingsModal } from "@/pages/activity/components/forms/bulk-holdings-modal";
import { PortfolioUpdateTrigger } from "@/pages/dashboard/portfolio-update-trigger";
import { HoldingsEditMode } from "@/pages/holdings/components/holdings-edit-mode";
import { useCalculatePerformanceHistory } from "@/pages/performance/hooks/use-performance-data";
import { useQuery } from "@tanstack/react-query";
import { Icons, type Icon } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@wealthfolio/ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@wealthfolio/ui/components/ui/sheet";
import { format, parseISO, subMonths } from "date-fns";
import { useNavigate, useParams } from "react-router-dom";
import { AccountContributionLimit } from "./account-contribution-limit";
import AccountHoldings from "./account-holdings";
import AccountMetrics from "./account-metrics";
import AccountSnapshotHistory from "./account-snapshot-history";

interface HistoryChartData {
  date: string;
  totalValue: number;
  netContribution: number;
  currency: string;
}

type AccountDetailTab = "holdings" | "snapshots";

// Map account types to icons for visual distinction
const accountTypeIcons: Record<AccountType, Icon> = {
  SECURITIES: Icons.Briefcase,
  CASH: Icons.DollarSign,
  CRYPTOCURRENCY: Icons.Bitcoin,
};

// Helper function to get the initial date range (copied from dashboard)
const getInitialDateRange = (): DateRange => ({
  from: subMonths(new Date(), 3),
  to: new Date(),
});

// Format date for display
const formatDate = (dateStr: string): string => {
  try {
    return format(parseISO(dateStr), "MMMM d, yyyy");
  } catch {
    return dateStr;
  }
};

// Define the initial interval code (consistent with other pages)
const INITIAL_INTERVAL_CODE: TimePeriod = "3M";

const AccountPage = () => {
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [dateRange, setDateRange] = useState<DateRange | undefined>(getInitialDateRange());
  const [selectedIntervalCode, setSelectedIntervalCode] =
    useState<TimePeriod>(INITIAL_INTERVAL_CODE);
  const [desktopSelectorOpen, setDesktopSelectorOpen] = useState(false);
  const [mobileSelectorOpen, setMobileSelectorOpen] = useState(false);
  const [actionPaletteOpen, setActionPaletteOpen] = useState(false);
  const [isEditingHoldings, setIsEditingHoldings] = useState(false);
  const [showSnapshotMarkers, setShowSnapshotMarkers] = useState(false);
  const [editingSnapshotDate, setEditingSnapshotDate] = useState<string | null>(null);
  const [selectedActivityDate, setSelectedActivityDate] = useState<string | null>(null);
  const [isActivitySheetOpen, setIsActivitySheetOpen] = useState(false);
  const [showBulkHoldingsForm, setShowBulkHoldingsForm] = useState(false);
  const [accountDetailTab, setAccountDetailTab] = useState<AccountDetailTab>("holdings");

  const recalculatePortfolioMutation = useRecalculatePortfolioMutation();
  const { accounts, isLoading: isAccountsLoading } = useAccounts();
  const account = useMemo(() => accounts?.find((acc) => acc.id === id), [accounts, id]);

  // Check if this account is in HOLDINGS tracking mode
  const isHoldingsMode = useMemo(() => {
    if (!account) return false;
    return account.trackingMode === "HOLDINGS";
  }, [account]);

  // Check if user can directly edit holdings (manual HOLDINGS-mode accounts only)
  const canEditHoldingsDirectly = useMemo(() => {
    return canAddHoldings(account);
  }, [account]);

  // Query holdings to check if account has any assets
  const { data: holdings, isLoading: isHoldingsLoading } = useQuery<Holding[], Error>({
    queryKey: [QueryKeys.HOLDINGS, id],
    queryFn: () => getHoldings({ type: "account", accountId: id }),
  });

  // Check if account has any holdings (including cash)
  const hasHoldings = useMemo(() => {
    if (!holdings) return false;
    return holdings.length > 0;
  }, [holdings]);

  const hasNonCashHoldings = useMemo(() => {
    if (!holdings) return false;
    return holdings.some((holding) => holding.holdingType !== HoldingType.CASH);
  }, [holdings]);

  const shouldShowSnapshotHistory = isHoldingsMode && hasHoldings && !isHoldingsLoading;

  const accountDetailTabs = useMemo(() => {
    if (!shouldShowSnapshotHistory) return [];

    const tabs: { value: AccountDetailTab; label: string }[] = [];
    if (hasNonCashHoldings) {
      tabs.push({ value: "holdings", label: "Holdings" });
    }
    tabs.push({ value: "snapshots", label: "Snapshots" });
    return tabs;
  }, [shouldShowSnapshotHistory, hasNonCashHoldings]);

  const activeAccountDetailTab = accountDetailTabs.some((tab) => tab.value === accountDetailTab)
    ? accountDetailTab
    : (accountDetailTabs[0]?.value ?? "holdings");

  // Format date range for snapshot query
  const snapshotDateFrom = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
  const snapshotDateTo = dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;

  // Query snapshots for chart markers (only when toggle is on)
  // Filtered by the chart's visible date range
  const { data: snapshots } = useQuery<SnapshotInfo[], Error>({
    queryKey: [...QueryKeys.snapshots(id), snapshotDateFrom, snapshotDateTo],
    queryFn: () => getSnapshots(id, snapshotDateFrom, snapshotDateTo),
    enabled: showSnapshotMarkers && !!account,
  });

  // Extract snapshot dates for chart markers (used in HOLDINGS mode)
  const snapshotDates = useMemo(() => {
    if (!snapshots) return [];
    return snapshots.map((s) => s.snapshotDate);
  }, [snapshots]);

  // In TRANSACTIONS mode, fetch activity dates for markers (snapshot dates include
  // carry-forward days with no activities, so we need actual activity dates instead)
  const { data: activityMarkerDates } = useQuery<string[], Error>({
    queryKey: ["activities", "markerDates", id, snapshotDateFrom, snapshotDateTo],
    queryFn: async () => {
      const response = await searchActivities(
        0,
        1000,
        { accountIds: [id], dateFrom: snapshotDateFrom, dateTo: snapshotDateTo },
        "",
        { id: "date", desc: true },
      );
      const dates = new Set<string>();
      response.data.forEach((a) => {
        const d = typeof a.date === "string" ? a.date : a.date.toISOString();
        dates.add(d.split("T")[0]);
      });
      return [...dates];
    },
    enabled: showSnapshotMarkers && !isHoldingsMode && !!account,
  });

  // Use activity dates for TRANSACTIONS mode, snapshot dates for HOLDINGS mode
  const markerDates = isHoldingsMode ? snapshotDates : (activityMarkerDates ?? []);

  // Query activities for selected date (Transactions mode marker click)
  const { data: dateActivities, isLoading: isDateActivitiesLoading } = useQuery<
    ActivityDetails[],
    Error
  >({
    queryKey: ["activities", "byDate", id, selectedActivityDate],
    queryFn: async () => {
      if (!selectedActivityDate) return [];
      const response = await searchActivities(
        0,
        100,
        { accountIds: [id], dateFrom: selectedActivityDate, dateTo: selectedActivityDate },
        "",
        { id: "date", desc: true },
      );
      return response.data;
    },
    enabled: isActivitySheetOpen && !!selectedActivityDate,
  });

  // Group accounts by type for the selector
  const accountsByType = useMemo(() => {
    const grouped: Record<string, Account[]> = {};
    accounts.forEach((acc) => {
      if (!grouped[acc.accountType]) {
        grouped[acc.accountType] = [];
      }
      grouped[acc.accountType].push(acc);
    });
    return Object.entries(grouped);
  }, [accounts]);

  const accountTrackedItem: TrackedItem | undefined = useMemo(() => {
    if (account) {
      return { id: account.id, type: "account", name: account.name };
    }
    return undefined;
  }, [account]);

  // Pass tracking mode to the performance hook for SOTA calculations
  const {
    data: performanceResponse,
    isLoading: isPerformanceHistoryLoading,
    hasErrors: hasPerformanceError,
    errorMessages: performanceErrorMessages,
  } = useCalculatePerformanceHistory({
    selectedItems: accountTrackedItem ? [accountTrackedItem] : [],
    dateRange: dateRange,
    trackingMode: isHoldingsMode ? "HOLDINGS" : "TRANSACTIONS",
  });

  const accountPerformance = performanceResponse?.[0] || null;

  const { valuationHistory, isLoading: isValuationHistoryLoading } = useValuationHistory(
    dateRange,
    id,
  );

  const currentValuation = valuationHistory?.[valuationHistory.length - 1];

  // Use period gain and return from backend (SOTA calculations for HOLDINGS mode)
  const frontendGainLossAmount = accountPerformance?.periodGain ?? 0;
  const frontendSimpleReturn = accountPerformance?.periodReturn ?? 0;

  const chartData: HistoryChartData[] = useMemo(() => {
    if (!valuationHistory) return [];
    return valuationHistory.map((valuation: AccountValuation) => ({
      date: valuation.valuationDate,
      totalValue: valuation.totalValue,
      netContribution: valuation.netContribution,
      currency: valuation.accountCurrency,
    }));
  }, [valuationHistory]);

  const isLoading = isAccountsLoading || isValuationHistoryLoading;

  // Callback for IntervalSelector
  const handleIntervalSelect = (
    code: TimePeriod,
    _description: string,
    range: DateRange | undefined,
  ) => {
    setSelectedIntervalCode(code);
    setDateRange(range);
  };

  const percentageToDisplay = useMemo(() => {
    // For HOLDINGS mode, always use simple return since TWR/MWR are not meaningful
    // (they require transaction history to track cash flows)
    if (isHoldingsMode) {
      return frontendSimpleReturn;
    }
    if (selectedIntervalCode === "ALL") {
      return frontendSimpleReturn;
    }
    // For other intervals, if accountPerformance is available, use cumulativeMwr
    if (accountPerformance) {
      return accountPerformance.cumulativeMwr ?? 0;
    }
    return 0; // Default if no specific logic matches or data is unavailable
  }, [accountPerformance, selectedIntervalCode, frontendSimpleReturn, isHoldingsMode]);

  const handleAccountSwitch = (selectedAccount: Account) => {
    navigate(`/accounts/${selectedAccount.id}`);
    setDesktopSelectorOpen(false);
    setMobileSelectorOpen(false);
  };

  return (
    <Page>
      <PageHeader
        onBack={() => navigate(-1)}
        actions={
          <ActionPalette
            open={actionPaletteOpen}
            onOpenChange={setActionPaletteOpen}
            groups={
              canEditHoldingsDirectly
                ? ([
                    {
                      title: "Holdings",
                      items: [
                        {
                          icon: Icons.Pencil,
                          label: "Update Holdings",
                          onClick: () => {
                            setEditingSnapshotDate(null);
                            setIsEditingHoldings(true);
                          },
                        },
                        {
                          icon: Icons.Import,
                          label: "Import CSV",
                          onClick: () => navigate(`/import?account=${id}`),
                        },
                      ],
                    },
                    {
                      title: "Manage",
                      items: [
                        {
                          icon: Icons.Clock,
                          label: "Recalculate History",
                          onClick: () => recalculatePortfolioMutation.mutate(),
                        },
                      ],
                    },
                  ] satisfies ActionPaletteGroup[])
                : ([
                    {
                      title: "Transactions",
                      items: [
                        {
                          icon: Icons.Plus,
                          label: "Record Transaction",
                          onClick: () => navigate(`/activities/manage?account=${id}`),
                        },
                        ...(isHoldingsMode
                          ? []
                          : [
                              {
                                icon: Icons.Holdings,
                                label: "Transfer Holdings",
                                onClick: () => setShowBulkHoldingsForm(true),
                              },
                            ]),
                        {
                          icon: Icons.Import,
                          label: "Import CSV",
                          onClick: () => navigate(`/import?account=${id}`),
                        },
                      ],
                    },
                    {
                      title: "Manage",
                      items: [
                        {
                          icon: Icons.Clock,
                          label: "Recalculate History",
                          onClick: () => recalculatePortfolioMutation.mutate(),
                        },
                      ],
                    },
                  ] satisfies ActionPaletteGroup[])
            }
          />
        }
      >
        <div className="flex items-center gap-2" data-tauri-drag-region="true">
          {/* Tracking mode avatar */}
          {account && (
            <div className="bg-primary/10 dark:bg-primary/20 flex size-9 shrink-0 items-center justify-center rounded-full">
              {account.trackingMode === "HOLDINGS" ? (
                <Icons.Holdings className="text-primary h-5 w-5" />
              ) : (
                <Icons.Activity className="text-primary h-5 w-5" />
              )}
            </div>
          )}
          <div className="flex min-w-0 flex-col justify-center">
            <div className="flex items-center gap-1">
              <h1 className="truncate text-base font-semibold leading-tight md:text-lg">
                {account?.name ?? "Account"}
              </h1>
              {/* Desktop account selector */}
              <div className="hidden sm:block">
                <Popover open={desktopSelectorOpen} onOpenChange={setDesktopSelectorOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full"
                      aria-label="Switch account"
                    >
                      <Icons.ChevronDown className="text-muted-foreground size-5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-60 p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search accounts..." />
                      <CommandList>
                        <CommandEmpty>No accounts found.</CommandEmpty>
                        {accountsByType.map(([type, typeAccounts]) => (
                          <CommandGroup key={type} heading={type}>
                            {typeAccounts.map((acc) => {
                              const IconComponent =
                                accountTypeIcons[acc.accountType] ?? Icons.CreditCard;
                              return (
                                <CommandItem
                                  key={acc.id}
                                  value={`${acc.name} ${acc.currency}`}
                                  onSelect={() => handleAccountSwitch(acc)}
                                  className="flex items-center py-1.5"
                                >
                                  <IconComponent className="mr-2 h-4 w-4" />
                                  <span>
                                    {acc.name} ({acc.currency})
                                  </span>
                                  <Icons.Check
                                    className={cn(
                                      "ml-auto h-4 w-4",
                                      account?.id === acc.id ? "opacity-100" : "opacity-0",
                                    )}
                                  />
                                </CommandItem>
                              );
                            })}
                          </CommandGroup>
                        ))}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              {/* Mobile account selector */}
              <div className="block sm:hidden">
                <Sheet open={mobileSelectorOpen} onOpenChange={setMobileSelectorOpen}>
                  <SheetTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full"
                      aria-label="Switch account"
                    >
                      <Icons.ChevronDown className="text-muted-foreground h-5 w-5" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="bottom" className="rounded-t-4xl mx-1 h-[80vh] p-0">
                    <SheetHeader className="border-border border-b px-6 py-4">
                      <SheetTitle>Switch Account</SheetTitle>
                      <SheetDescription>Choose an account to view</SheetDescription>
                    </SheetHeader>
                    <ScrollArea className="h-[calc(80vh-5rem)] px-6 py-4">
                      <div className="space-y-6">
                        {accountsByType.map(([type, typeAccounts]) => (
                          <div key={type}>
                            <h3 className="text-muted-foreground mb-3 text-sm font-medium">
                              {type}
                            </h3>
                            <div className="space-y-2">
                              {typeAccounts.map((acc) => {
                                const IconComponent =
                                  accountTypeIcons[acc.accountType] ?? Icons.CreditCard;
                                return (
                                  <button
                                    key={acc.id}
                                    onClick={() => handleAccountSwitch(acc)}
                                    className={cn(
                                      "hover:bg-accent active:bg-accent/80 flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors focus:outline-none",
                                      account?.id === acc.id
                                        ? "border-primary bg-accent"
                                        : "border-transparent",
                                    )}
                                  >
                                    <div className="bg-primary/10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
                                      <IconComponent className="text-primary h-5 w-5" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="text-foreground truncate font-medium">
                                        {acc.name}
                                      </div>
                                      <div className="text-muted-foreground text-sm">
                                        {acc.currency}
                                      </div>
                                    </div>
                                    {account?.id === acc.id && (
                                      <Icons.Check className="text-primary h-5 w-5 shrink-0" />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </SheetContent>
                </Sheet>
              </div>
            </div>
            <p className="text-muted-foreground text-xs leading-tight md:text-sm">
              {account?.group ?? account?.currency}
            </p>
          </div>
        </div>
      </PageHeader>
      <PageContent>
        {hasHoldings && !isHoldingsLoading ? (
          <>
            <div className="grid grid-cols-1 gap-4 pt-0 md:grid-cols-3">
              <Card className="col-span-1 md:col-span-2">
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-md">
                    <PortfolioUpdateTrigger lastCalculatedAt={currentValuation?.calculatedAt}>
                      <div className="flex items-start gap-2">
                        <div>
                          <p className="pt-3 text-xl font-bold">
                            <PrivacyAmount
                              value={currentValuation?.totalValue ?? 0}
                              currency={account?.currency ?? baseCurrency}
                            />
                          </p>
                          {!hasPerformanceError && (
                            <div className="flex items-center gap-2 text-sm">
                              <GainAmount
                                className="text-sm font-light"
                                value={frontendGainLossAmount}
                                currency={account?.currency ?? baseCurrency}
                                displayCurrency={false}
                              />
                              <GainPercent
                                value={percentageToDisplay}
                                variant="badge"
                                className="text-xs"
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </PortfolioUpdateTrigger>
                  </CardTitle>
                  <div className="-mt-3 flex items-center gap-1 self-start">
                    <PrivacyToggle />
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant={showSnapshotMarkers ? "default" : "secondary"}
                            size="icon-xs"
                            className={cn(
                              "rounded-full",
                              !showSnapshotMarkers && "bg-secondary/50",
                            )}
                            onClick={() => setShowSnapshotMarkers(!showSnapshotMarkers)}
                          >
                            <Icons.History className="size-5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{showSnapshotMarkers ? "Hide" : "Show"} snapshot markers</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="w-full p-0">
                    <div className="flex w-full flex-col">
                      <div className="h-120 w-full">
                        <HistoryChart
                          data={chartData}
                          isLoading={false}
                          showMarkers={showSnapshotMarkers}
                          snapshotDates={markerDates}
                          onMarkerClick={(date) => {
                            if (isHoldingsMode) {
                              // Holdings mode: open edit holdings sheet
                              setEditingSnapshotDate(date);
                              setIsEditingHoldings(true);
                            } else {
                              // Transactions mode: open activities sheet for this date
                              setSelectedActivityDate(date);
                              setIsActivitySheetOpen(true);
                            }
                          }}
                        />
                        <IntervalSelector
                          className="relative bottom-10 left-0 right-0 z-10"
                          onIntervalSelect={handleIntervalSelect}
                          isLoading={isValuationHistoryLoading}
                          defaultValue={INITIAL_INTERVAL_CODE}
                        />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="flex flex-col space-y-4">
                <AccountMetrics
                  valuation={currentValuation}
                  performance={accountPerformance}
                  className="grow"
                  isLoading={isLoading}
                  isPerformanceLoading={isPerformanceHistoryLoading}
                  performanceError={hasPerformanceError ? performanceErrorMessages[0] : undefined}
                  hideBalanceEdit={isHoldingsMode}
                  isHoldingsMode={isHoldingsMode}
                />
                <AccountContributionLimit accountId={id} />
              </div>
            </div>

            {shouldShowSnapshotHistory && account ? (
              <div className="space-y-4">
                <AnimatedToggleGroup<AccountDetailTab>
                  items={accountDetailTabs}
                  value={activeAccountDetailTab}
                  onValueChange={setAccountDetailTab}
                  className="text-sm"
                />

                {activeAccountDetailTab === "holdings" ? (
                  <AccountHoldings
                    accountId={id}
                    showEmptyState={false}
                    onAddHoldings={() => setIsEditingHoldings(true)}
                  />
                ) : (
                  <AccountSnapshotHistory
                    account={account}
                    canEditSnapshots={canEditHoldingsDirectly}
                    onAddSnapshot={() => {
                      setEditingSnapshotDate(null);
                      setIsEditingHoldings(true);
                    }}
                  />
                )}
              </div>
            ) : (
              <AccountHoldings accountId={id} onAddHoldings={() => setIsEditingHoldings(true)} />
            )}
          </>
        ) : (
          <AccountHoldings
            accountId={id}
            showEmptyState={true}
            onAddHoldings={() => setIsEditingHoldings(true)}
          />
        )}
      </PageContent>

      {/* Holdings Edit Mode Sheet for manual HOLDINGS-mode accounts */}
      {account && canEditHoldingsDirectly && (
        <Sheet open={isEditingHoldings} onOpenChange={setIsEditingHoldings}>
          <SheetContent side="right" className="flex h-full w-full flex-col p-0 sm:max-w-2xl">
            <SheetHeader className="border-b px-6 py-4">
              <SheetTitle>Update Holdings</SheetTitle>
              <SheetDescription>
                Edit positions and cash balances for {account.name}
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-hidden px-6">
              <HoldingsEditMode
                holdings={holdings ?? []}
                account={account}
                isLoading={isHoldingsLoading}
                onClose={() => {
                  setIsEditingHoldings(false);
                  setEditingSnapshotDate(null);
                }}
                existingSnapshotDate={editingSnapshotDate}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Activities Sheet for Transactions mode marker click */}
      <Sheet open={isActivitySheetOpen} onOpenChange={setIsActivitySheetOpen}>
        <SheetContent side="right" className="flex h-full w-full flex-col p-0 sm:max-w-md">
          <SheetHeader className="border-b px-6 py-4">
            <SheetTitle>
              Activities on {selectedActivityDate ? formatDate(selectedActivityDate) : ""}
            </SheetTitle>
            <SheetDescription>
              {dateActivities?.length ?? 0} activities recorded on this date
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-auto px-4 py-4">
            {isDateActivitiesLoading ? (
              <div className="flex items-center justify-center py-8">
                <Icons.Spinner className="size-6 animate-spin" />
              </div>
            ) : (
              <ActivityTableMobile
                activities={dateActivities ?? []}
                isCompactView={true}
                handleEdit={() => {}}
                handleDelete={() => {}}
                onDuplicate={async () => {}}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Bulk Holdings Modal for Transfer Holdings */}
      <BulkHoldingsModal
        open={showBulkHoldingsForm}
        onClose={() => setShowBulkHoldingsForm(false)}
        defaultAccount={account}
        onSuccess={() => {
          setShowBulkHoldingsForm(false);
        }}
      />
    </Page>
  );
};

export default AccountPage;
