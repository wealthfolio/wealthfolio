import { TopMoversCard, ConcentrationCard } from "./holdings-highlight-cards";
import { useAccounts } from "@/hooks/use-accounts";
import { useCurrentValuation } from "@/hooks/use-current-account-valuations";
import { useHoldings } from "@/hooks/use-holdings";
import { usePortfolioAllocations } from "@/hooks/use-portfolio-allocations";
import { usePortfolios } from "@/hooks/use-portfolios";
import { HoldingType, isAlternativeAssetKind } from "@/lib/constants";
import { useSettingsContext } from "@/lib/settings-provider";
import type { AccountScope, AllocationTarget, TaxonomyAllocation } from "@/lib/types";
import { OverviewTab } from "@/pages/allocation-targets/components/overview-tab";
import { RebalanceTab } from "@/pages/allocation-targets/components/rebalance-tab";
import {
  TargetDetailHeader,
  TargetToolbarActions,
} from "@/pages/allocation-targets/components/target-detail-header";
import {
  accountScopeFromTarget,
  accountScopeKey,
  filterTargetsByScope,
} from "@/pages/allocation-targets/components/target-scope";
import { TargetsTab } from "@/pages/allocation-targets/components/targets-tab";
import { UnsavedTargetChangesDialog } from "@/pages/allocation-targets/components/unsaved-target-changes-dialog";
import { useAllocationTargetDrift } from "@/pages/allocation-targets/hooks/use-allocation-target-drift";
import { useAllocationTargets } from "@/pages/allocation-targets/hooks/use-allocation-targets";
import { AllocationDetailSheet } from "@/pages/holdings/components/allocation-detail-sheet";
import { Button, EmptyPlaceholder, Icons, Skeleton } from "@wealthfolio/ui";
import { PortfolioComposition } from "@/pages/holdings/components/composition-chart";
import { DrillableAccountChart } from "@/pages/holdings/components/drillable-account-chart";
import { DrillableDonutChart } from "@/pages/holdings/components/drillable-donut-chart";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { computeValueStrip, valueStripFromCurrentSummary } from "./allocation-derivations";
import { PortfolioExplorer } from "./portfolio-explorer";
import { TargetRailsCard } from "./target-rails-card";
import { ValueWidget } from "./value-strip";
import { InsightsDashboard } from "./insights-dashboard";

interface OverviewPageProps {
  filter?: AccountScope;
  onFilterChange?: (filter: AccountScope) => void;
  onToolbarActionsChange?: (actions: ReactNode | null) => void;
  onCustomizeActionChange?: (action: ReactNode | null) => void;
}

type WorkspaceView = "current" | "details" | "targets" | "rebalance";
type TargetEditorMode = "create" | "edit";

export function OverviewPage({
  filter: filterProp,
  onFilterChange,
  onToolbarActionsChange,
  onCustomizeActionChange,
}: OverviewPageProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const accountFilter: AccountScope = useMemo(() => filterProp ?? { type: "all" }, [filterProp]);
  const selectedAccountScopeKey = accountScopeKey(accountFilter);

  const {
    holdings,
    dataUpdatedAt: holdingsUpdatedAt,
    isLoading: holdingsLoading,
  } = useHoldings(accountFilter);
  const { currentValuation, isLoading: currentValuationLoading } = useCurrentValuation(
    accountFilter,
    { includeAccounts: true },
  );
  const { allocations, isLoading: allocationsLoading } = usePortfolioAllocations(accountFilter);
  const { accounts } = useAccounts();
  const { data: portfolios = [] } = usePortfolios();
  const { targets, isLoading: targetsLoading } = useAllocationTargets();

  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("current");
  const [targetEditorMode, setTargetEditorMode] = useState<TargetEditorMode>("edit");
  const [targetEditorDirty, setTargetEditorDirty] = useState(false);
  const [pendingWorkspaceView, setPendingWorkspaceView] = useState<WorkspaceView | null>(null);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedTargetId(null);
  }, [selectedAccountScopeKey]);

  const scopedTargets = useMemo(
    () => filterTargetsByScope(targets, accountFilter),
    [targets, accountFilter],
  );
  const scopedLiveTargets = useMemo(
    () => scopedTargets.filter((p) => !p.archivedAt),
    [scopedTargets],
  );
  const isCreatingTarget = workspaceView === "targets" && targetEditorMode === "create";
  const effectiveTargetId =
    !isCreatingTarget &&
    selectedTargetId &&
    scopedLiveTargets.some((p) => p.id === selectedTargetId)
      ? selectedTargetId
      : !isCreatingTarget
        ? (scopedLiveTargets[0]?.id ?? null)
        : null;
  const effectiveTarget = targets.find((p) => p.id === effectiveTargetId) ?? null;
  const targetEditorAccountScope = isCreatingTarget
    ? accountFilter
    : (accountScopeFromTarget(effectiveTarget) ?? accountFilter);

  const {
    driftReport,
    dataUpdatedAt: driftUpdatedAt,
    isLoading: driftLoading,
  } = useAllocationTargetDrift(effectiveTargetId, accountFilter, {
    includeHoldings: workspaceView === "details",
  });

  const isLoading = holdingsLoading || allocationsLoading || currentValuationLoading;
  const targetLoading = targetsLoading || driftLoading;

  const filteredAccountIds = useMemo(() => {
    if (accountFilter.type === "account") return [accountFilter.accountId];
    if (accountFilter.type === "accounts") return accountFilter.accountIds;
    if (accountFilter.type === "portfolio") {
      return portfolios.find((p) => p.id === accountFilter.portfolioId)?.accountIds ?? [];
    }
    return undefined; // "all" → every account
  }, [accountFilter, portfolios]);

  const portfolioHoldings = useMemo(
    () =>
      holdings?.filter((h) => {
        if (h.assetKind && isAlternativeAssetKind(h.assetKind)) return false;
        return true;
      }) ?? [],
    [holdings],
  );

  const nonCashHoldings = useMemo(
    () => portfolioHoldings.filter((h) => h.holdingType?.toLowerCase() !== "cash"),
    [portfolioHoldings],
  );
  const totalCash = useMemo(
    () =>
      holdings
        .filter((h) => h.holdingType === HoldingType.CASH)
        .reduce((sum, h) => sum + (h.marketValue.base ?? 0), 0),
    [holdings],
  );
  const availableCash = driftReport?.deployableCash ?? totalCash;
  const rebalanceSourceVersion = `${holdingsUpdatedAt}:${driftUpdatedAt}:${effectiveTarget?.updatedAt ?? ""}`;

  const valueStrip = useMemo(
    () =>
      currentValuation?.summary
        ? valueStripFromCurrentSummary(currentValuation.summary, portfolioHoldings)
        : computeValueStrip(portfolioHoldings, accounts),
    [currentValuation?.summary, portfolioHoldings, accounts],
  );

  // Detail sheet
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [selectedAllocation, setSelectedAllocation] = useState<TaxonomyAllocation | undefined>();
  const [initialCategoryId, setInitialCategoryId] = useState<string | null>(null);

  function openAllocationSheet(allocation: TaxonomyAllocation | undefined, categoryId?: string) {
    if (!allocation) return;
    setSelectedAllocation(allocation);
    setInitialCategoryId(categoryId ?? null);
    setIsSheetOpen(true);
  }

  const startCreateTarget = useCallback(() => {
    setTargetEditorMode("create");
    setWorkspaceView("targets");
  }, []);

  const handleCreateTarget = useCallback(() => {
    if (targetEditorDirty) {
      setPendingTargetId(null);
      setPendingWorkspaceView("targets");
      return;
    }
    startCreateTarget();
  }, [startCreateTarget, targetEditorDirty]);

  const handleEditTarget = useCallback(() => {
    setTargetEditorMode("edit");
    setWorkspaceView("targets");
  }, []);

  const requestTargetChange = useCallback(
    (targetId: string) => {
      if (targetEditorDirty) {
        setPendingTargetId(targetId);
        return;
      }
      setTargetEditorMode("edit");
      setSelectedTargetId(targetId);
    },
    [targetEditorDirty],
  );

  function backTo(view: WorkspaceView) {
    if (targetEditorDirty) {
      setPendingWorkspaceView(view);
      return;
    }
    setTargetEditorDirty(false);
    setWorkspaceView(view);
  }

  function discardTargetChanges() {
    setTargetEditorDirty(false);
    if (pendingTargetId) {
      setTargetEditorMode("edit");
      setSelectedTargetId(pendingTargetId);
      setPendingTargetId(null);
      setPendingWorkspaceView(null);
      return;
    }
    if (!pendingWorkspaceView) return;
    if (pendingWorkspaceView === "targets") {
      startCreateTarget();
    } else {
      setWorkspaceView(pendingWorkspaceView);
    }
    setPendingWorkspaceView(null);
  }

  function handleTargetEditorCancel() {
    const fallbackTargetId =
      selectedTargetId && scopedLiveTargets.some((target) => target.id === selectedTargetId)
        ? selectedTargetId
        : (scopedLiveTargets[0]?.id ?? null);
    setTargetEditorDirty(false);
    setTargetEditorMode("edit");
    setWorkspaceView(fallbackTargetId ? "details" : "current");
  }

  function handleTargetEditorSaved(target: AllocationTarget) {
    const savedScope = accountScopeFromTarget(target);
    if (savedScope && accountScopeKey(savedScope) !== selectedAccountScopeKey) {
      onFilterChange?.(savedScope);
    }
    setTargetEditorDirty(false);
    setTargetEditorMode("edit");
    setSelectedTargetId(target.id);
    setWorkspaceView("details");
  }

  const toolbarActions = useMemo(() => {
    if (workspaceView === "current") return null;

    return (
      <TargetToolbarActions
        targets={scopedLiveTargets}
        selectedTargetId={effectiveTargetId}
        target={effectiveTarget}
        onTargetChange={requestTargetChange}
        onCreateTarget={handleCreateTarget}
        onEditTarget={workspaceView === "details" ? handleEditTarget : undefined}
      />
    );
  }, [
    effectiveTarget,
    effectiveTargetId,
    handleCreateTarget,
    handleEditTarget,
    requestTargetChange,
    scopedLiveTargets,
    workspaceView,
  ]);

  useEffect(() => {
    onToolbarActionsChange?.(toolbarActions);
    return () => onToolbarActionsChange?.(null);
  }, [onToolbarActionsChange, toolbarActions]);

  if (workspaceView === "targets") {
    return (
      <>
        <div>
          <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2"
                onClick={() => backTo(effectiveTargetId ? "details" : "current")}
              >
                <Icons.ArrowLeft className="mr-1.5 h-4 w-4" />
                {t("insights:insights.back_to_allocation")}
              </Button>
              <span className="bg-border hidden h-5 w-px sm:block" />
              <h2 className="text-foreground text-[16px] font-semibold">
                {t("insights:insights.target_allocation")}
              </h2>
            </div>
          </div>
          {targetsLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <TargetsTab
              targets={scopedLiveTargets}
              selectedTargetId={effectiveTargetId}
              onTargetChange={(targetId) => {
                setTargetEditorMode("edit");
                setSelectedTargetId(targetId);
              }}
              editorMode={targetEditorMode}
              accountScope={targetEditorAccountScope}
              onAccountScopeChange={onFilterChange}
              onUnsavedChange={setTargetEditorDirty}
              onCancel={handleTargetEditorCancel}
              onSaved={handleTargetEditorSaved}
              actionsPlacement="page-header"
            />
          )}
        </div>
        <UnsavedTargetChangesDialog
          open={pendingWorkspaceView !== null || pendingTargetId !== null}
          onOpenChange={(open) => {
            if (!open) {
              setPendingWorkspaceView(null);
              setPendingTargetId(null);
            }
          }}
          onDiscard={discardTargetChanges}
        />
      </>
    );
  }

  if (workspaceView === "rebalance") {
    return (
      <div>
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 shrink-0"
            onClick={() => backTo("details")}
          >
            <Icons.ArrowLeft className="mr-1.5 h-4 w-4" />
            {t("insights:insights.back_to_overview")}
          </Button>
          <span className="bg-border hidden h-5 w-px sm:block" />
          <h2 className="text-foreground min-w-0 text-[16px] font-semibold">
            {t("insights:insights.rebalance")}
          </h2>
        </div>
        <RebalanceTab
          profile={effectiveTarget ?? null}
          driftReport={driftReport ?? null}
          accountScope={accountFilter}
          holdings={holdings}
          availableCash={availableCash}
          sourceVersion={rebalanceSourceVersion}
          isSourceLoading={holdingsLoading || driftLoading || !driftReport}
        />
      </div>
    );
  }

  if (workspaceView === "details") {
    return (
      <div>
        <TargetDetailHeader
          targets={scopedLiveTargets}
          selectedTargetId={effectiveTargetId}
          target={effectiveTarget}
          onBack={() => backTo("current")}
          onTargetChange={requestTargetChange}
          onCreateTarget={handleCreateTarget}
          onEditTarget={handleEditTarget}
          showActions={false}
        />
        {driftReport ? (
          <OverviewTab
            report={driftReport}
            taxonomyId={effectiveTarget?.taxonomyId ?? "asset_classes"}
            targetName={effectiveTarget?.name}
            target={effectiveTarget}
            onRebalanceClick={() => setWorkspaceView("rebalance")}
          />
        ) : targetLoading ? (
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <EmptyPlaceholder
            icon={<Icons.Target className="text-muted-foreground h-10 w-10" />}
            title={t("insights:insights.no_target_selected")}
            description={t("insights:insights.no_target_selected_description")}
          >
            <Button size="sm" onClick={handleCreateTarget}>
              {t("insights:insights.set_target_allocation")}
            </Button>
          </EmptyPlaceholder>
        )}
      </div>
    );
  }

  return (
    <>
      <InsightsDashboard
        onCustomizeActionChange={onCustomizeActionChange}
        widgets={{
          value: (
            <ValueWidget
              metric="value"
              data={valueStrip}
              currency={baseCurrency}
              isLoading={isLoading}
            />
          ),
          cash: (
            <ValueWidget
              metric="cash"
              data={valueStrip}
              currency={baseCurrency}
              isLoading={isLoading}
            />
          ),
          invested: (
            <ValueWidget
              metric="invested"
              data={valueStrip}
              currency={baseCurrency}
              isLoading={isLoading}
            />
          ),
          bookCost: (
            <ValueWidget
              metric="bookCost"
              data={valueStrip}
              currency={baseCurrency}
              isLoading={isLoading}
            />
          ),
          pnl: (
            <ValueWidget
              metric="pnl"
              data={valueStrip}
              currency={baseCurrency}
              isLoading={isLoading}
            />
          ),
          accounts: (
            <DrillableAccountChart
              isLoading={isLoading}
              accountIds={filteredAccountIds}
              accountValuations={currentValuation?.accounts}
            />
          ),
          classes: (
            <DrillableDonutChart
              title={t("insights:insights.chart_classes")}
              allocation={allocations?.assetClasses}
              baseCurrency={baseCurrency}
              isLoading={isLoading}
              onCategoryClick={(categoryId) =>
                openAllocationSheet(allocations?.assetClasses, categoryId)
              }
              onCardClick={() => openAllocationSheet(allocations?.assetClasses)}
            />
          ),
          regions: (
            <DrillableDonutChart
              title={t("insights:insights.chart_regions")}
              allocation={allocations?.regions}
              baseCurrency={baseCurrency}
              isLoading={isLoading}
              onCategoryClick={(categoryId) =>
                openAllocationSheet(allocations?.regions, categoryId)
              }
              onCardClick={() => openAllocationSheet(allocations?.regions)}
            />
          ),
          sectors: (
            <DrillableDonutChart
              title={t("insights:insights.chart_sectors")}
              allocation={allocations?.sectors}
              baseCurrency={baseCurrency}
              isLoading={isLoading}
              onCategoryClick={(categoryId) =>
                openAllocationSheet(allocations?.sectors, categoryId)
              }
              onCardClick={() => openAllocationSheet(allocations?.sectors)}
            />
          ),
          composition: <PortfolioComposition holdings={nonCashHoldings} isLoading={isLoading} />,
          targets: (
            <TargetRailsCard
              targets={scopedLiveTargets}
              selectedTargetId={effectiveTargetId}
              onTargetChange={requestTargetChange}
              driftReport={driftReport}
              isLoading={driftLoading && !driftReport}
              onCreateTarget={handleCreateTarget}
              onViewDetails={() => setWorkspaceView("details")}
            />
          ),
          movers: (
            <TopMoversCard
              holdings={portfolioHoldings}
              currency={baseCurrency}
              isLoading={isLoading}
            />
          ),
          concentration: (
            <ConcentrationCard
              holdings={portfolioHoldings}
              currency={baseCurrency}
              isLoading={isLoading}
            />
          ),
          breakdown: (
            <PortfolioExplorer
              allocations={allocations}
              holdings={holdings ?? []}
              accounts={accounts}
              accountIds={filteredAccountIds}
              accountValuations={currentValuation?.accounts}
              currency={baseCurrency}
              isLoading={isLoading}
              onOpenAllocation={openAllocationSheet}
            />
          ),
        }}
      />

      <AllocationDetailSheet
        isOpen={isSheetOpen}
        onOpenChange={setIsSheetOpen}
        allocation={selectedAllocation}
        accountFilter={accountFilter}
        baseCurrency={baseCurrency}
        initialCategoryId={initialCategoryId}
      />
    </>
  );
}

export default OverviewPage;
