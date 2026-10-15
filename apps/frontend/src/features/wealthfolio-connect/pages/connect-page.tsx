import { ConnectSessionUnavailable } from "../components/connect-session-unavailable";
import { CloudBackupCompactSummary } from "@/pages/settings/exports/cloud-backup-card";
import { openUrlInBrowser, syncTriggerCycle } from "@/adapters";
import { Page, PageContent, PageHeader } from "@/components/page";
import { useDevices, useSyncStatus } from "@/features/devices-sync/hooks";
import { SyncStates } from "@/features/devices-sync/types";
import { BrokerageLogo } from "../components/brokerage-logo";
import { PortalLink } from "../components/portal-link";
import { ConnectedView } from "../components/connected-view";
import { ConnectEmptyState } from "@/features/wealthfolio-connect/components/connect-empty-state";
import {
  useAggregatedSyncStatus,
  useBrokerAccounts,
  useImportRunsInfinite,
} from "@/features/wealthfolio-connect/hooks";
import { useSyncBrokerData } from "@/features/wealthfolio-connect/hooks/use-sync-broker-data";
import { useWealthfolioConnect } from "@/features/wealthfolio-connect/providers/wealthfolio-connect-provider";
import { isSubscriptionStatusActive } from "@/features/wealthfolio-connect/lib/plan-capabilities";
import { useAccounts } from "@/hooks/use-accounts";
import { WEALTHFOLIO_CONNECT_PORTAL_URL } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import { cn, formatDistanceToNow } from "@/lib/utils";
import { BankIcon } from "@phosphor-icons/react/dist/csr/Bank";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { DesktopIcon } from "@phosphor-icons/react/dist/csr/Desktop";
import { DeviceMobileIcon } from "@phosphor-icons/react/dist/csr/DeviceMobile";
import { DevicesIcon } from "@phosphor-icons/react/dist/csr/Devices";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalizationSettings, buttonVariants } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { listBrokerConnections } from "../services/broker-service";
import type { ImportRun } from "../types";

import type { Device } from "@/features/devices-sync/types";
import type { Account } from "@/lib/types";
import { NewAccountsFoundModal } from "../components/new-accounts-found-modal";
import { BROKER_SYNC_RUN_NEEDS_REVIEW_MESSAGE } from "../lib/broker-sync-messages";
import {
  buildAttentionItems,
  buildBrokerageRows,
  getLastBrokerSyncAt,
  type AttentionItem,
  type BrokerAccountState,
  type BrokerageRow,
  type BrokerageState,
} from "../lib/connect-overview";
import { hasReviewableActivityWarnings } from "../lib/import-run-review";
import { hasBrokerSync } from "../lib/plan-capabilities";

const BROKERAGE_PREVIEW_COUNT = 6;
const INACTIVE_DEVICE_DAYS = 30;
const SECTION_ICON_CLASS = "text-muted-foreground size-5 shrink-0";

export default function ConnectPage() {
  const localizationSettings = useLocalizationSettings();

  const { t } = useTranslation();
  const { isEnabled, isConnected, isInitializing, isSessionUnavailable, userInfo } =
    useWealthfolioConnect();
  const { status, syncStates } = useAggregatedSyncStatus();
  const showBrokerSync = hasBrokerSync(userInfo);
  const {
    data: brokerAccounts = [],
    isLoading: isLoadingBrokerAccounts,
    isError: hasBrokerAccountsError,
    refetch: refetchBrokerAccounts,
  } = useBrokerAccounts({ enabled: showBrokerSync });
  const { mutate: syncBrokerData, isPending: isSyncing } = useSyncBrokerData();
  const deviceSyncStatus = useSyncStatus();
  const showConnectDeviceAction =
    !deviceSyncStatus.isLoading &&
    !deviceSyncStatus.error &&
    (deviceSyncStatus.syncState !== SyncStates.READY ||
      deviceSyncStatus.device?.trustState === "untrusted");
  const { data: devices, isLoading: isLoadingDevices } = useDevices("my");
  const queryClient = useQueryClient();
  const [isTriggeringDeviceSync, setIsTriggeringDeviceSync] = useState(false);

  const isSyncRunning = isSyncing || isTriggeringDeviceSync || status === "running";

  const handleSyncAll = useCallback(async () => {
    if (showBrokerSync) {
      syncBrokerData();
    }
    setIsTriggeringDeviceSync(true);
    try {
      await syncTriggerCycle();
    } finally {
      setIsTriggeringDeviceSync(false);
      queryClient.invalidateQueries({ queryKey: ["sync", "devices"] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.BROKER_CONNECTIONS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTS] });
    }
  }, [showBrokerSync, syncBrokerData, queryClient]);
  const { data: importRunsData, isLoading: isLoadingActivity } = useImportRunsInfinite({
    pageSize: 10,
    enabled: showBrokerSync,
  });
  const { accounts: localAccounts } = useAccounts({ filterActive: false, includeArchived: false });

  const {
    data: brokerConnections = [],
    isLoading: isLoadingConnections,
    isError: hasConnectionsError,
    refetch: refetchConnections,
  } = useQuery({
    queryKey: [QueryKeys.BROKER_CONNECTIONS],
    queryFn: listBrokerConnections,
    enabled: isConnected && showBrokerSync,
    staleTime: 30000,
  });

  const [showNewAccountsModal, setShowNewAccountsModal] = useState(false);
  const [pendingNewAccounts, setPendingNewAccounts] = useState<Account[]>([]);

  useEffect(() => {
    const handler = (e: CustomEvent<{ localAccountId: string }[]>) => {
      const accountIds = new Set(e.detail.map((info) => info.localAccountId));
      const matchingAccounts = localAccounts.filter((acc) => accountIds.has(acc.id));
      if (matchingAccounts.length > 0) {
        setPendingNewAccounts(matchingAccounts);
        setShowNewAccountsModal(true);
      }
    };
    window.addEventListener("open-new-accounts-modal", handler as EventListener);
    return () => window.removeEventListener("open-new-accounts-modal", handler as EventListener);
  }, [localAccounts]);

  const recentActivity = useMemo(() => {
    if (!importRunsData?.pages) return [];
    return importRunsData.pages.flat().slice(0, 10);
  }, [importRunsData]);

  const brokerageRows = useMemo(
    () =>
      buildBrokerageRows(
        brokerConnections,
        brokerAccounts,
        localAccounts,
        syncStates,
        t("connect:connections.unknown"),
      ),
    [brokerConnections, brokerAccounts, localAccounts, syncStates, t],
  );

  const attentionItems = useMemo(
    () => buildAttentionItems(brokerageRows, syncStates, localAccounts, recentActivity),
    [brokerageRows, syncStates, localAccounts, recentActivity],
  );

  const lastBrokerSyncAt = useMemo(
    () => getLastBrokerSyncAt(syncStates, recentActivity),
    [syncStates, recentActivity],
  );

  const accountNameMap = useMemo(() => {
    const map = new Map<string, string>();
    localAccounts.forEach((account) => {
      map.set(account.id, account.name);
    });
    return map;
  }, [localAccounts]);

  const accountTrackingModeMap = useMemo(() => {
    const map = new Map<string, Account["trackingMode"]>();
    localAccounts.forEach((account) => {
      map.set(account.id, account.trackingMode);
    });
    return map;
  }, [localAccounts]);

  const hasSubscription = useMemo(() => {
    return isSubscriptionStatusActive(userInfo?.team?.subscription_status);
  }, [userInfo]);

  if (isInitializing) {
    return (
      <Page>
        <PageHeader heading={t("connect:page.title")} />
        <PageContent>
          <div className="@container mx-auto max-w-5xl pt-4 sm:pt-6">
            <div className="@3xl:grid-cols-[minmax(0,1fr)_18rem] grid grid-cols-1 items-start gap-4">
              {[5, 3].map((rows, i) => (
                <Card key={i} className="overflow-hidden">
                  <div className="flex min-h-12 items-center border-b px-4">
                    <Skeleton className="h-5 w-28" />
                  </div>
                  <ListSkeleton rows={rows} />
                </Card>
              ))}
            </div>
          </div>
        </PageContent>
      </Page>
    );
  }

  if (!isEnabled || !isConnected || !hasSubscription) {
    return (
      <Page>
        <PageHeader heading={t("connect:page.title")} />
        <PageContent>
          {isSessionUnavailable ? (
            <ConnectSessionUnavailable />
          ) : isEnabled && isConnected ? (
            <ConnectedView />
          ) : (
            <ConnectEmptyState />
          )}
        </PageContent>
      </Page>
    );
  }

  const headerText = !showBrokerSync
    ? t("connect:page.subtitle")
    : isSyncRunning
      ? t("connect:status.syncingEllipsis")
      : lastBrokerSyncAt
        ? t("connect:status.lastSynced", {
            time: formatDistanceToNow(lastBrokerSyncAt, localizationSettings, { addSuffix: true }),
          })
        : t("connect:page.subtitleWithBrokers");

  const devicesCard = (
    <DevicesCard
      devices={devices ?? []}
      isLoading={isLoadingDevices}
      engineStatus={deviceSyncStatus.engineStatus}
      showConnectDeviceAction={showConnectDeviceAction}
    />
  );

  return (
    <Page>
      <PageHeader
        heading={t("connect:page.title")}
        text={headerText}
        actions={
          <div className="flex items-center gap-2 sm:gap-3">
            <Button
              onClick={handleSyncAll}
              disabled={isSyncRunning}
              size="sm"
              className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
              aria-label={t(isSyncRunning ? "connect:sync.syncingShort" : "connect:sync.syncNow")}
            >
              {isSyncRunning ? (
                <>
                  <Icons.Spinner className="h-4 w-4 animate-spin sm:mr-2" />
                  <span className="hidden sm:inline">{t("connect:sync.syncingShort")}</span>
                </>
              ) : (
                <>
                  <Icons.RefreshCw className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">{t("connect:sync.syncNow")}</span>
                </>
              )}
            </Button>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to="/settings/connect"
                    aria-label={t("common:settings")}
                    className={cn(
                      buttonVariants({ variant: "outline", size: "icon" }),
                      "size-11 sm:size-9",
                    )}
                  >
                    <Icons.Settings className="size-4" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent>{t("common:settings")}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        }
      />
      <PageContent>
        <div className="@container mx-auto max-w-5xl pt-4 sm:pt-6">
          <div className="@3xl:grid-cols-[minmax(0,1fr)_18rem] grid grid-cols-1 items-start gap-4">
            <div className="min-w-0 space-y-4">
              {showBrokerSync ? (
                <>
                  {attentionItems.length > 0 && (
                    <AttentionCard
                      items={attentionItems}
                      isSyncing={isSyncRunning}
                      onRetry={() => syncBrokerData()}
                      onSetup={(accounts) => {
                        setPendingNewAccounts(accounts);
                        setShowNewAccountsModal(true);
                      }}
                    />
                  )}
                  <BrokeragesCard
                    rows={brokerageRows}
                    isLoading={isLoadingConnections || isLoadingBrokerAccounts}
                    // Rows need both lists: without accounts, every brokerage would read
                    // "No accounts found". Rows from an earlier load stay on a failed refresh.
                    isUnavailable={
                      (hasConnectionsError && brokerConnections.length === 0) ||
                      (hasBrokerAccountsError && brokerAccounts.length === 0)
                    }
                    onRetry={() => {
                      void refetchConnections();
                      void refetchBrokerAccounts();
                    }}
                  />
                  <SectionCard
                    icon={
                      <ClockCounterClockwiseIcon weight="duotone" className={SECTION_ICON_CLASS} />
                    }
                    title={t("connect:page.recentActivity")}
                  >
                    {isLoadingActivity ? (
                      <ListSkeleton rows={3} withTile={false} />
                    ) : recentActivity.length === 0 ? (
                      <EmptySection
                        icon={
                          <ClockCounterClockwiseIcon
                            weight="duotone"
                            className="text-muted-foreground size-6"
                          />
                        }
                        title={t("connect:page.noActivity")}
                        description={t("connect:page.noActivityDescription")}
                      />
                    ) : (
                      <div className="divide-border divide-y">
                        {recentActivity.map((run) => (
                          <SyncHistoryItem
                            key={run.id}
                            run={run}
                            accountName={accountNameMap.get(run.accountId)}
                            trackingMode={accountTrackingModeMap.get(run.accountId)}
                          />
                        ))}
                      </div>
                    )}
                  </SectionCard>
                </>
              ) : (
                <>
                  {devicesCard}
                  <Card className="border-primary/20 bg-primary/5">
                    <div className="flex items-center justify-between gap-3 p-4">
                      <div>
                        <h3 className="text-sm font-medium">{t("connect:upgrade.title")}</h3>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {t("connect:upgrade.description")}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        title={t("connect:opensInBrowser")}
                        onClick={() =>
                          openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}/settings/billing`)
                        }
                      >
                        {t("connect:upgrade.button")}
                        <Icons.ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </Card>
                </>
              )}
            </div>
            <div className="min-w-0 space-y-4">
              {showBrokerSync && devicesCard}
              <CloudBackupCompactSummary />
            </div>
          </div>
        </div>
      </PageContent>

      <NewAccountsFoundModal
        open={showNewAccountsModal}
        onOpenChange={setShowNewAccountsModal}
        accounts={pendingNewAccounts}
        onComplete={() => {
          setPendingNewAccounts([]);
        }}
      />
    </Page>
  );
}

/** Placeholder rows shaped like the list they stand in for. */
function ListSkeleton({ rows, withTile = true }: { rows: number; withTile?: boolean }) {
  const { t } = useTranslation();
  return (
    <div role="status">
      <span className="sr-only">{t("common:loading")}</span>
      <ul className="divide-y" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
            {withTile && <Skeleton className="size-9 shrink-0 rounded-lg" />}
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-32 max-w-full" />
              <Skeleton className="h-3 w-20" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SectionCard({
  icon,
  title,
  count,
  actions,
  className,
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className="flex min-h-12 items-center justify-between gap-2 border-b px-4 py-1">
        <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold">
          {icon}
          <span className="truncate">{title}</span>
          {count !== undefined && (
            <span className="text-muted-foreground text-sm font-normal tabular-nums">{count}</span>
          )}
        </h2>
        {actions}
      </div>
      {children}
    </Card>
  );
}

function EmptySection({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
      <div className="bg-muted/50 mb-3 rounded-full p-3">{icon}</div>
      <p className="text-muted-foreground text-sm">{title}</p>
      <p className="text-muted-foreground mt-1 text-xs">{description}</p>
      {action}
    </div>
  );
}

function AttentionCard({
  items,
  isSyncing,
  onRetry,
  onSetup,
}: {
  items: AttentionItem[];
  isSyncing: boolean;
  onRetry: () => void;
  onSetup: (accounts: Account[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="border-warning/40 overflow-hidden">
      <h2 className="border-warning/20 bg-warning/10 flex min-h-12 items-center gap-2 border-b px-4 py-1 text-base font-semibold">
        <WarningIcon weight="duotone" className="text-warning size-5 shrink-0" />
        {t("connect:attention.heading")}
        <span className="text-muted-foreground text-sm font-normal tabular-nums">
          {items.length}
        </span>
      </h2>
      <ul className="divide-y">
        {items.map((item) => (
          <AttentionRow
            key={item.key}
            item={item}
            isSyncing={isSyncing}
            onRetry={onRetry}
            onSetup={onSetup}
          />
        ))}
      </ul>
    </Card>
  );
}

function AttentionRow({
  item,
  isSyncing,
  onRetry,
  onSetup,
}: {
  item: AttentionItem;
  isSyncing: boolean;
  onRetry: () => void;
  onSetup: (accounts: Account[]) => void;
}) {
  const { t } = useTranslation();
  const buttonClass = "pointer-coarse:h-11 shrink-0";
  const retry = (
    <Button
      size="sm"
      variant="outline"
      className={buttonClass}
      onClick={onRetry}
      disabled={isSyncing}
    >
      {t("common:retry")}
    </Button>
  );

  let icon: ReactNode;
  let title: string;
  let details: (string | undefined)[];
  let action: ReactNode;
  switch (item.kind) {
    case "reconnect":
      icon = <XCircleIcon weight="duotone" className="text-destructive size-5 shrink-0" />;
      title = item.name;
      details = [
        t("connect:attention.connectionLost"),
        item.accountCount > 0
          ? t("connect:attention.accountsNotSyncing", { count: item.accountCount })
          : undefined,
      ];
      action = (
        <Button
          size="sm"
          className={buttonClass}
          title={t("connect:opensInBrowser")}
          onClick={() => openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}/connections`)}
        >
          {t("connect:connections.reconnect")}
          <Icons.ExternalLink className="size-3.5" aria-hidden="true" />
        </Button>
      );
      break;
    case "failed":
      icon = <XCircleIcon weight="duotone" className="text-destructive size-5 shrink-0" />;
      title = item.name;
      details = [item.brokerage, item.issueMessage ?? t("connect:attention.syncFailed")];
      action = retry;
      break;
    case "needsReview":
      icon = <WarningIcon weight="duotone" className="text-warning size-5 shrink-0" />;
      title = item.name;
      details = [
        item.brokerage,
        item.reviewCount > 0
          ? t("connect:activity.itemsNeedReview", { count: item.reviewCount })
          : (item.issueMessage ?? t("connect:status.needsReview")),
      ];
      action =
        item.reviewCount > 0 ? (
          <Link
            to={`/activities?account=${item.accountId}&needsReview=true`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), buttonClass)}
          >
            {t("connect:syncHistory.review")}
          </Link>
        ) : (
          retry
        );
      break;
    case "setup":
      icon = <InfoIcon weight="duotone" className="text-muted-foreground size-5 shrink-0" />;
      title = t("connect:setup.newAccountsTitle");
      details = [item.accounts.map((account) => account.name).join(", ")];
      action = (
        <Button
          size="sm"
          variant="outline"
          className={buttonClass}
          onClick={() => onSetup(item.accounts)}
        >
          {t("connect:setup.setUp")}
        </Button>
      );
      break;
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="text-muted-foreground line-clamp-2 text-xs">
          {details.filter(Boolean).join(" · ")}
        </p>
      </div>
      {action}
    </li>
  );
}

function BrokeragesCard({
  rows,
  isLoading,
  isUnavailable,
  onRetry,
}: {
  rows: BrokerageRow[];
  isLoading: boolean;
  isUnavailable: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const visibleRows = showAll ? rows : rows.slice(0, BROKERAGE_PREVIEW_COUNT);
  const hiddenCount = rows.length - BROKERAGE_PREVIEW_COUNT;
  const connectionsUrl = `${WEALTHFOLIO_CONNECT_PORTAL_URL}/connections`;

  return (
    <SectionCard
      icon={<BankIcon weight="duotone" className={SECTION_ICON_CLASS} />}
      title={t("connect:page.brokerages")}
      count={!isUnavailable && rows.length > 0 ? rows.length : undefined}
      actions={<PortalLink href={connectionsUrl} label={t("connect:connections.manage")} />}
    >
      {isLoading ? (
        <ListSkeleton rows={2} />
      ) : isUnavailable ? (
        // A failed request is not "no brokerages": don't offer to connect one.
        <EmptySection
          icon={<BankIcon weight="duotone" className="text-muted-foreground size-6" />}
          title={t("connect:serviceUnavailable.title")}
          description={t("connect:serviceUnavailable.description")}
          action={
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11 mt-4"
              onClick={onRetry}
            >
              {t("connect:serviceUnavailable.tryAgain")}
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptySection
          icon={<BankIcon weight="duotone" className="text-muted-foreground size-6" />}
          title={t("connect:page.noBrokeragesConnected")}
          description={t("connect:page.noBrokeragesDescription")}
          action={
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11 mt-4"
              title={t("connect:opensInBrowser")}
              onClick={() => openUrlInBrowser(connectionsUrl)}
            >
              {t("connect:connections.connectBroker")}
              <Icons.ExternalLink className="size-3.5" aria-hidden="true" />
            </Button>
          }
        />
      ) : (
        <>
          <ul className="divide-y">
            {visibleRows.map((row) => (
              <BrokerageItem
                key={row.connection.id}
                row={row}
                expanded={expandedId === row.connection.id}
                onToggle={() =>
                  setExpandedId((id) => (id === row.connection.id ? null : row.connection.id))
                }
              />
            ))}
          </ul>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="text-muted-foreground hover:bg-muted/40 hover:text-foreground flex min-h-11 w-full items-center border-t px-4 text-left text-sm"
            >
              {showAll
                ? t("connect:page.showLess")
                : t("connect:page.showMore", { count: hiddenCount })}
            </button>
          )}
        </>
      )}
    </SectionCard>
  );
}

const STATE_TONE: Record<BrokerAccountState | BrokerageState, string> = {
  reconnect: "text-destructive",
  failed: "text-destructive",
  needsReview: "text-warning",
  needsSetup: "text-warning",
  syncing: "text-muted-foreground",
  excluded: "text-muted-foreground",
  ok: "",
  inactive: "",
};

function stateLabel(state: BrokerAccountState | BrokerageState, t: TFunction): string | null {
  switch (state) {
    case "reconnect":
      return t("connect:connections.disconnected");
    case "failed":
      return t("connect:status.failed");
    case "needsReview":
      return t("connect:status.needsReview");
    case "needsSetup":
      return t("connect:accounts.needsSetup");
    case "syncing":
      return t("connect:status.syncing");
    case "excluded":
      return t("connect:accounts.excludedFromSync");
    default:
      return null;
  }
}

function getBrokerageSummary(row: BrokerageRow, t: TFunction): string {
  if (row.accounts.length === 0) return t("connect:connections.noAccountsFound");
  if (row.syncEnabledCount === 0) return t("connect:connections.allAccountsExcluded");
  const excludedCount = row.accounts.length - row.syncEnabledCount;
  const accounts = t("connect:connections.accountCount", { count: row.syncEnabledCount });
  return excludedCount > 0
    ? `${accounts} · ${t("connect:connections.excludedCount", { count: excludedCount })}`
    : accounts;
}

function BrokerageItem({
  row,
  expanded,
  onToggle,
}: {
  row: BrokerageRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = stateLabel(row.state, t);
  const inactive = row.state === "inactive";

  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="hover:bg-muted/40 flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        <BrokerageLogo
          brokerage={row.connection.brokerage}
          name={row.name}
          className={cn(inactive && "opacity-60")}
        />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-sm font-medium", inactive && "text-muted-foreground")}>
            {row.name}
          </p>
          <p className="text-muted-foreground truncate text-xs">{getBrokerageSummary(row, t)}</p>
        </div>
        {label && (
          <span className={cn("shrink-0 text-xs font-medium", STATE_TONE[row.state])}>{label}</span>
        )}
        <Icons.ChevronRight
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <ul className="bg-muted/30 border-t py-1 pl-16 pr-4">
          {row.accounts.length === 0 ? (
            <li className="text-muted-foreground py-2 text-xs">
              {t("connect:connections.noAccountsFound")}
            </li>
          ) : (
            row.accounts.map(({ account, localAccount, state }) => {
              const name =
                localAccount?.name ?? account.name ?? t("connect:accounts.accountFallback");
              return (
                <li
                  key={account.id ?? name}
                  className="flex items-center justify-between gap-3 py-2 text-xs"
                >
                  {localAccount ? (
                    <Link to={`/accounts/${localAccount.id}`} className="truncate hover:underline">
                      {name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground truncate">{name}</span>
                  )}
                  <span className={cn("shrink-0", STATE_TONE[state])}>{stateLabel(state, t)}</span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </li>
  );
}

type EngineStatus = ReturnType<typeof useSyncStatus>["engineStatus"];

function DevicesCard({
  devices,
  isLoading,
  engineStatus,
  showConnectDeviceAction,
}: {
  devices: Device[];
  isLoading: boolean;
  engineStatus: EngineStatus;
  showConnectDeviceAction: boolean;
}) {
  const { t } = useTranslation();
  const [showInactive, setShowInactive] = useState(false);
  const sorted = sortDevicesByCurrent(devices);
  const active = sorted.filter((device) => !isDeviceInactive(device));
  const inactive = sorted.filter(isDeviceInactive);
  const footerClass =
    "text-muted-foreground hover:bg-muted/40 hover:text-foreground flex min-h-11 w-full items-center gap-2 border-t px-4 text-left text-sm";

  return (
    <SectionCard
      icon={<DevicesIcon weight="duotone" className={SECTION_ICON_CLASS} />}
      title={t("connect:page.devices")}
      count={sorted.length > 0 ? sorted.length : undefined}
      actions={
        <PortalLink
          href={`${WEALTHFOLIO_CONNECT_PORTAL_URL}/settings/devices`}
          label={t("connect:page.manage")}
        />
      }
    >
      {isLoading ? (
        <ListSkeleton rows={2} />
      ) : sorted.length === 0 ? (
        <EmptySection
          icon={<DevicesIcon weight="duotone" className="text-muted-foreground size-6" />}
          title={t("connect:page.noDevicesSyncing")}
          description={t("connect:page.noDevicesDescription")}
        />
      ) : (
        <ul className="divide-y">
          {[...active, ...(showInactive ? inactive : [])].map((device) => (
            <DeviceItem
              key={device.id}
              device={device}
              engineStatus={device.isCurrent ? engineStatus : null}
            />
          ))}
        </ul>
      )}
      {inactive.length > 0 && (
        <button
          type="button"
          onClick={() => setShowInactive((value) => !value)}
          className={footerClass}
        >
          {showInactive
            ? t("connect:devices.hideInactive")
            : t("connect:devices.showInactive", { count: inactive.length })}
        </button>
      )}
      {showConnectDeviceAction && (
        <Link to="/settings/connect" className={cn(footerClass, "text-foreground font-medium")}>
          <Icons.Plus className="size-4 shrink-0" aria-hidden="true" />
          {t("sync:connect.connectThisDevice")}
        </Link>
      )}
    </SectionCard>
  );
}

function sortDevicesByCurrent(devices: Device[]): Device[] {
  return [...devices].sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
    return bTime - aTime;
  });
}

function isDeviceInactive(device: Device): boolean {
  if (device.isCurrent) return false;
  if (!device.lastSeenAt) return true;
  return Date.now() - new Date(device.lastSeenAt).getTime() > INACTIVE_DEVICE_DAYS * 86_400_000;
}

/** This device's sync engine health, as a dot color and a label. */
function getEngineStatus(engineStatus: EngineStatus, t: TFunction) {
  if (!engineStatus) return null;
  const { backgroundRunning, lastCycleStatus, lastError, consecutiveFailures } = engineStatus;
  if (lastError || consecutiveFailures > 2)
    return { dot: "bg-destructive", label: t("connect:deviceStatus.syncError") };
  if (!backgroundRunning)
    return { dot: "bg-muted-foreground", label: t("connect:deviceStatus.syncPaused") };
  if (lastCycleStatus === "ok")
    return { dot: "bg-success", label: t("connect:deviceStatus.upToDate") };
  return { dot: "bg-warning", label: t("connect:deviceStatus.syncing") };
}

// Product names stay untranslated; only generic kinds go through i18n.
const PLATFORM_NAMES: Partial<Record<string, string>> = {
  ios: "iOS",
  android: "Android",
  mac: "macOS",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

/** Same tile as the brokerage logos, so both lists line up. */
function DevicePlatformIcon({ platform }: { platform: string }) {
  const Icon =
    platform === "ios" || platform === "android"
      ? DeviceMobileIcon
      : platform === "server"
        ? HardDrivesIcon
        : platform === "web"
          ? GlobeIcon
          : DesktopIcon;
  return (
    <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
      <Icon weight="duotone" className="text-muted-foreground size-5" aria-hidden="true" />
    </span>
  );
}

function DeviceItem({ device, engineStatus }: { device: Device; engineStatus: EngineStatus }) {
  const { t } = useTranslation();
  const localizationSettings = useLocalizationSettings();
  const platform = device.platform?.toLowerCase() ?? "";
  const platformName =
    PLATFORM_NAMES[platform] ??
    (platform === "server" || platform === "web"
      ? t(`connect:devices.platforms.${platform}`)
      : undefined);
  const online =
    device.isCurrent ||
    (!!device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < 5 * 60_000);
  const engine = device.isCurrent ? getEngineStatus(engineStatus, t) : null;
  const lastSeen = device.lastSeenAt
    ? formatDistanceToNow(new Date(device.lastSeenAt), localizationSettings, { addSuffix: true })
    : t("connect:devices.never");
  // Status sits under the name so long device names keep the full row width.
  const details = device.isCurrent
    ? [t("connect:devices.thisDevice"), engine?.label]
    : [platformName, online ? t("connect:devices.online") : lastSeen];
  const dot = engine?.dot ?? (online ? "bg-success" : null);

  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <DevicePlatformIcon platform={platform} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{device.displayName}</p>
        <p className="text-muted-foreground truncate text-xs">
          {details.filter(Boolean).join(" · ")}
        </p>
      </div>
      {dot && <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden="true" />}
    </li>
  );
}

function SyncHistoryItem({
  run,
  accountName,
  trackingMode,
}: {
  run: ImportRun;
  accountName?: string;
  trackingMode?: Account["trackingMode"];
}) {
  const localizationSettings = useLocalizationSettings();

  const { t } = useTranslation();
  const timeAgo = formatDistanceToNow(new Date(run.startedAt), localizationSettings, {
    addSuffix: false,
  });
  const isNeedsReview = run.status === "NEEDS_REVIEW";
  const isFailed = run.status === "FAILED";
  const isRunning = run.status === "RUNNING";
  const itemType = trackingMode === "HOLDINGS" ? "position" : "transaction";

  const summary = run.summary;
  const inserted = summary?.inserted ?? 0;
  const updated = summary?.updated ?? 0;
  const warnings = summary?.warnings ?? 0;
  const errors = summary?.errors ?? 0;
  const removed = summary?.removed ?? 0;

  const hasIssues = warnings > 0 || errors > 0;
  const needsAttention = isNeedsReview || hasIssues;
  const canReviewActivities = hasReviewableActivityWarnings(warnings);

  let description = "";
  if (isRunning) {
    description = t("connect:activity.syncingData");
  } else if (isFailed) {
    description = t("connect:activity.somethingWentWrong");
  } else if (needsAttention) {
    const issueCount = warnings + errors;
    description =
      issueCount > 0
        ? t("connect:activity.itemsNeedReview", { count: issueCount })
        : BROKER_SYNC_RUN_NEEDS_REVIEW_MESSAGE;
  } else if (inserted > 0 || updated > 0 || removed > 0) {
    const parts: string[] = [];
    if (inserted > 0) {
      parts.push(t(`connect:activity.newItems.${itemType}`, { count: inserted }));
    }
    if (updated > 0) {
      parts.push(t(`connect:activity.updatedItems.${itemType}`, { count: updated }));
    }
    if (removed > 0) {
      parts.push(t(`connect:activity.removedItems.${itemType}`, { count: removed }));
    }
    description = parts.join(", ");
  } else {
    description = t("connect:activity.upToDate");
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:flex-nowrap sm:gap-4",
        isFailed
          ? "bg-destructive/5"
          : needsAttention
            ? "bg-yellow-500/10 dark:bg-yellow-500/5"
            : "hover:bg-muted/30",
      )}
    >
      <span
        className={cn(
          "inline-block h-2 w-2 shrink-0 rounded-full",
          isFailed ? "bg-destructive" : needsAttention ? "bg-yellow-500" : "bg-green-500",
        )}
      />
      <span className="text-muted-foreground shrink-0 whitespace-nowrap text-xs sm:min-w-[80px] sm:text-sm">
        {t("connect:page.timeAgo", { time: timeAgo })}
      </span>
      {accountName && (
        <span className="hidden shrink-0 truncate text-sm font-medium sm:inline sm:min-w-[100px]">
          {accountName}
        </span>
      )}
      <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:w-auto sm:flex-1 sm:text-sm">
        {accountName && <span className="font-medium sm:hidden">{accountName}</span>}
        <span
          className={cn(
            isFailed && "text-destructive font-medium",
            needsAttention && !isFailed && "font-medium text-amber-600 dark:text-amber-400",
          )}
        >
          {description}
        </span>
        {isRunning && <Icons.Spinner className="h-3 w-3 animate-spin" />}
      </div>
      {canReviewActivities && (
        <Link
          to={`/activities?account=${run.accountId}&needsReview=true`}
          className="text-primary shrink-0 text-sm font-medium hover:underline"
        >
          {t("connect:syncHistory.review")}
        </Link>
      )}
    </div>
  );
}
