import { openUrlInBrowser, syncTriggerCycle } from "@/adapters";
import { Page, PageContent, PageHeader } from "@/components/page";
import { useSyncStatus } from "@/features/devices-sync/hooks";
import { useDevices } from "@/features/devices-sync/hooks";
import { ConnectEmptyState } from "@/features/wealthfolio-connect/components/connect-empty-state";
import {
  useAggregatedSyncStatus,
  useBrokerAccounts,
  useImportRunsInfinite,
} from "@/features/wealthfolio-connect/hooks";
import { useSyncBrokerData } from "@/features/wealthfolio-connect/hooks/use-sync-broker-data";
import { useWealthfolioConnect } from "@/features/wealthfolio-connect/providers/wealthfolio-connect-provider";
import { useAccounts } from "@/hooks/use-accounts";
import { WEALTHFOLIO_CONNECT_PORTAL_URL } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@wealthfolio/ui/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@wealthfolio/ui/components/ui/avatar";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import { formatDistanceToNow } from "date-fns";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { listBrokerConnections } from "../services/broker-service";
import type { BrokerConnection, BrokerSyncState, ImportRun } from "../types";

import type { Device } from "@/features/devices-sync/types";
import type { Account } from "@/lib/types";
import { hasBrokerSync } from "../lib/plan-capabilities";
import { hasReviewableActivityWarnings } from "../lib/import-run-review";
import {
  BROKER_SYNC_RUN_NEEDS_REVIEW_MESSAGE,
  getBrokerSyncIssueMessage,
} from "../lib/broker-sync-messages";
import { NewAccountsFoundModal } from "../components/new-accounts-found-modal";

export default function ConnectPage() {
  const { t } = useTranslation();
  const { isEnabled, isConnected, isInitializing, userInfo } = useWealthfolioConnect();
  const { status, lastSyncTime, syncStates } = useAggregatedSyncStatus();
  const showBrokerSync = hasBrokerSync(userInfo);
  const { data: brokerAccounts = [] } = useBrokerAccounts({ enabled: showBrokerSync });
  const { mutate: syncBrokerData, isPending: isSyncing } = useSyncBrokerData();
  const { engineStatus: deviceSyncEngineStatus } = useSyncStatus();
  const { data: devices } = useDevices("my");
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
  const { data: importRunsData } = useImportRunsInfinite({ pageSize: 10, enabled: showBrokerSync });
  const { accounts: localAccounts } = useAccounts({ filterActive: false, includeArchived: false });

  const { data: brokerConnections = [] } = useQuery({
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

  const accountsNeedingSetup = useMemo(() => {
    return localAccounts.filter((acc) => {
      if (!acc.providerAccountId) return false;
      return acc.trackingMode === "NOT_SET";
    });
  }, [localAccounts]);

  const hasAccountsNeedingSetup = accountsNeedingSetup.length > 0;

  const recentActivity = useMemo(() => {
    if (!importRunsData?.pages) return [];
    return importRunsData.pages.flat().slice(0, 10);
  }, [importRunsData]);

  const recentActivityIssueCount = useMemo(() => {
    return recentActivity.filter((run) => {
      const summary = run.summary;
      return (
        run.status === "FAILED" ||
        run.status === "NEEDS_REVIEW" ||
        (summary?.warnings ?? 0) > 0 ||
        (summary?.errors ?? 0) > 0
      );
    }).length;
  }, [recentActivity]);

  const brokerSyncIssues = useMemo(
    () => syncStates.filter((s) => s.syncStatus === "NEEDS_REVIEW" || s.syncStatus === "FAILED"),
    [syncStates],
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
    if (!userInfo?.team) return false;
    const subStatus = userInfo.team.subscription_status;
    return subStatus === "active" || subStatus === "trialing";
  }, [userInfo]);

  if (isInitializing) {
    return (
      <Page>
        <PageHeader heading={t("connect:page.title")} />
        <PageContent>
          <div className="mx-auto max-w-5xl space-y-6">
            <Card>
              <CardContent className="p-0">
                <div className="divide-border grid grid-cols-3 divide-x">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="flex items-center gap-4 p-5">
                      <Skeleton className="h-12 w-12 rounded-lg" />
                      <div className="space-y-2">
                        <Skeleton className="h-6 w-16" />
                        <Skeleton className="h-4 w-24" />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {[...Array(2)].map((_, i) => (
                <Card key={i} className="border">
                  <CardHeader className="pb-3">
                    <Skeleton className="h-5 w-24" />
                  </CardHeader>
                  <CardContent className="space-y-3 pt-0">
                    {[...Array(3)].map((_, j) => (
                      <div key={j} className="flex items-center gap-3 py-2">
                        <Skeleton className="h-10 w-10 rounded-full" />
                        <div className="space-y-1.5">
                          <Skeleton className="h-4 w-32" />
                          <Skeleton className="h-3 w-20" />
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
            <Card className="border">
              <CardHeader className="pb-3">
                <Skeleton className="h-5 w-36" />
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="flex items-center gap-4 py-3">
                    <Skeleton className="h-2 w-2 rounded-full" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                ))}
              </CardContent>
            </Card>
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
          <ConnectEmptyState />
        </PageContent>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        heading={t("connect:page.title")}
        text={showBrokerSync ? t("connect:page.subtitleWithBrokers") : t("connect:page.subtitle")}
        actions={
          <div className="flex items-center gap-2 sm:gap-3">
            <Button onClick={handleSyncAll} disabled={isSyncRunning} size="sm">
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
          </div>
        }
      />
      <PageContent>
        <div className="mx-auto max-w-5xl space-y-6 pt-12">
          {showBrokerSync && hasAccountsNeedingSetup && (
            <Alert variant="warning" className="mb-4">
              <Icons.AlertTriangle className="h-4 w-4" />
              <div className="flex flex-1 items-center justify-between">
                <div>
                  <p className="font-medium">{t("connect:setup.newAccountsTitle")}</p>
                  <p className="text-muted-foreground text-sm">
                    {t("connect:setup.newAccountsDescription", {
                      count: accountsNeedingSetup.length,
                    })}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setPendingNewAccounts(accountsNeedingSetup);
                    setShowNewAccountsModal(true);
                  }}
                >
                  {t("connect:setup.reviewAccounts")}
                </Button>
              </div>
            </Alert>
          )}

          {showBrokerSync && brokerSyncIssues.length > 0 && (
            <BrokerSyncAttentionSection
              issues={brokerSyncIssues}
              accounts={localAccounts}
              onRetry={() => syncBrokerData()}
              onManage={() => openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}/connections`)}
              isSyncing={isSyncRunning}
            />
          )}

          <div className={`grid grid-cols-1 gap-4 ${showBrokerSync ? "md:grid-cols-2" : ""}`}>
            {showBrokerSync && (
              <Card className="flex flex-col border">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center justify-between text-base font-medium">
                    <div className="flex items-center gap-2">
                      <div className="bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
                        <Icons.Link className="text-muted-foreground h-3.5 w-3.5" />
                      </div>
                      {t("connect:page.brokerages")}
                      {lastSyncTime && (
                        <span className="text-muted-foreground text-xs font-normal">
                          ·{" "}
                          {t("connect:page.timeAgo", {
                            time: formatDistanceToNow(new Date(lastSyncTime)),
                          })}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-foreground h-8 w-8 sm:hidden"
                        onClick={() =>
                          openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}/connections`)
                        }
                      >
                        <Icons.ExternalLink className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-foreground hidden sm:inline-flex"
                        onClick={() =>
                          openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}/connections`)
                        }
                      >
                        {t("connect:page.manage")}
                        <Icons.ArrowRight className="ml-1 h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex-1 pt-0">
                  {brokerConnections.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                      <div className="bg-muted/50 mb-3 rounded-full p-3">
                        <Icons.Link className="text-muted-foreground h-6 w-6" />
                      </div>
                      <p className="text-muted-foreground text-sm">
                        {t("connect:page.noBrokeragesConnected")}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {t("connect:page.noBrokeragesDescription")}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {brokerConnections.map((connection) => {
                        const connectionAccounts = brokerAccounts.filter(
                          (a) => a.brokerage_authorization === connection.id,
                        );
                        const syncEnabledCount = connectionAccounts.filter(
                          (a) => a.sync_enabled,
                        ).length;
                        return (
                          <ConnectionItem
                            key={connection.id}
                            connection={connection}
                            syncEnabledCount={syncEnabledCount}
                            totalAccountCount={connectionAccounts.length}
                          />
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card className="flex flex-col border">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between text-base font-medium">
                  <div className="flex items-center gap-2">
                    <div className="bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
                      <Icons.Smartphone className="text-muted-foreground h-3.5 w-3.5" />
                    </div>
                    {t("connect:page.devices")}
                    <DeviceSyncStatusBadge engineStatus={deviceSyncEngineStatus} />
                  </div>
                  <div className="flex items-center gap-1">
                    <Link to="/settings/connect">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-foreground h-8 w-8 sm:hidden"
                      >
                        <Icons.Settings className="h-4 w-4" />
                      </Button>
                    </Link>
                    <Link to="/settings/connect">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-foreground hidden sm:inline-flex"
                      >
                        {t("connect:page.manage")}
                        <Icons.ArrowRight className="ml-1 h-3.5 w-3.5" />
                      </Button>
                    </Link>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 pt-0">
                {!devices || devices.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <div className="bg-muted/50 mb-3 rounded-full p-3">
                      <Icons.Smartphone className="text-muted-foreground h-6 w-6" />
                    </div>
                    <p className="text-muted-foreground text-sm">
                      {t("connect:page.noDevicesSyncing")}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t("connect:page.noDevicesDescription")}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {sortDevicesByCurrent(devices).map((device) => (
                      <DeviceItem key={device.id} device={device} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {showBrokerSync && (
            <Card className="border">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <div className="bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
                    <Icons.History className="text-muted-foreground h-3.5 w-3.5" />
                  </div>
                  {t("connect:page.recentActivity")}
                  {recentActivityIssueCount > 0 && (
                    <Badge variant="default" className="ml-1 h-5 min-w-5 px-1.5 text-xs">
                      {recentActivityIssueCount}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {recentActivity.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <div className="bg-muted/50 mb-3 rounded-full p-3">
                      <Icons.History className="text-muted-foreground h-6 w-6" />
                    </div>
                    <p className="text-muted-foreground text-sm">{t("connect:page.noActivity")}</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t("connect:page.noActivityDescription")}
                    </p>
                  </div>
                ) : (
                  <div className="divide-border -mx-3 divide-y">
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
              </CardContent>
            </Card>
          )}

          {!showBrokerSync && (
            <Card className="border-primary/20 bg-primary/5">
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium">{t("connect:upgrade.title")}</h3>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {t("connect:upgrade.description")}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() =>
                      openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}/settings/billing`)
                    }
                  >
                    {t("connect:upgrade.button")}
                    <Icons.ArrowRight className="ml-1 h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
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

function sortDevicesByCurrent(devices: Device[]): Device[] {
  return [...devices].sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
    return bTime - aTime;
  });
}

function ConnectionItem({
  connection,
  syncEnabledCount,
  totalAccountCount,
}: {
  connection: BrokerConnection;
  syncEnabledCount: number;
  totalAccountCount: number;
}) {
  const { t } = useTranslation();
  const name =
    connection.brokerage?.display_name ||
    connection.brokerage?.name ||
    connection.name ||
    t("connect:connections.unknown");
  const logoUrl =
    connection.brokerage?.aws_s3_square_logo_url ?? connection.brokerage?.aws_s3_logo_url;
  const isConnected = connection.status === "connected" && !connection.disabled;
  const syncSummary = getConnectionSyncSummary(syncEnabledCount, totalAccountCount, t);

  return (
    <div className="bg-muted/30 flex items-center gap-3 rounded-lg border p-3">
      <Avatar className="h-9 w-9 shrink-0 rounded-lg">
        <AvatarImage src={logoUrl} alt={name} className="bg-white object-contain p-1" />
        <AvatarFallback className="rounded-lg text-sm font-semibold">
          {name.charAt(0)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm font-medium">{name}</span>
        <p className="text-muted-foreground text-xs">{syncSummary}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge
          className={`shrink-0 ${
            isConnected
              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
              : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
          }`}
        >
          {isConnected ? t("connect:connections.connected") : t("connect:connections.disconnected")}
        </Badge>
        {!isConnected && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}/connections`)}
          >
            {t("connect:connections.reconnect")}
          </Button>
        )}
      </div>
    </div>
  );
}

function getConnectionSyncSummary(
  syncEnabledCount: number,
  totalAccountCount: number,
  t: TFunction,
): string {
  if (totalAccountCount === 0) {
    return t("connect:connections.noAccountsFound");
  }

  if (syncEnabledCount === 0) {
    return t("connect:connections.allAccountsExcluded");
  }

  if (syncEnabledCount === totalAccountCount) {
    return t("connect:connections.accountsSyncing", { count: totalAccountCount });
  }

  const excludedCount = totalAccountCount - syncEnabledCount;
  return t("connect:connections.partialSyncing", {
    syncing: syncEnabledCount,
    total: totalAccountCount,
    excluded: excludedCount,
    count: excludedCount,
  });
}

function DeviceSyncStatusBadge({
  engineStatus,
}: {
  engineStatus: {
    backgroundRunning: boolean;
    lastCycleStatus: string | null;
    lastError: string | null;
    consecutiveFailures: number;
  } | null;
}) {
  const { t } = useTranslation();
  if (!engineStatus) return null;

  const { backgroundRunning, lastCycleStatus, lastError, consecutiveFailures } = engineStatus;

  let color: string;
  let label: string;

  if (lastError || consecutiveFailures > 2) {
    color = "bg-red-500";
    label = t("connect:deviceStatus.syncError");
  } else if (!backgroundRunning) {
    color = "bg-gray-400";
    label = t("connect:deviceStatus.syncPaused");
  } else if (lastCycleStatus === "ok") {
    color = "bg-green-500";
    label = t("connect:deviceStatus.upToDate");
  } else {
    color = "bg-yellow-500";
    label = t("connect:deviceStatus.syncing");
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
            <span className="text-muted-foreground text-xs">{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-64 text-xs">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const platformIcons: Record<string, typeof Icons.Monitor> = {
  macos: Icons.Monitor,
  mac: Icons.Monitor,
  windows: Icons.Monitor,
  linux: Icons.Monitor,
  ios: Icons.Smartphone,
  android: Icons.Smartphone,
  server: Icons.Cloud,
  web: Icons.Cloud,
};

function DeviceItem({ device }: { device: Device }) {
  const { t } = useTranslation();
  const platform = device.platform?.toLowerCase() || "unknown";
  const Icon = platformIcons[platform] || Icons.Monitor;
  const isOnline = isDeviceOnline(device);
  const lastSeenText = formatDeviceLastSeen(device, t);

  return (
    <div className="bg-muted/30 flex items-center gap-3 rounded-lg border p-3">
      <Avatar className="h-9 w-9 shrink-0 rounded-lg">
        <AvatarFallback className="rounded-lg">
          <Icon className="text-muted-foreground h-4 w-4" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{device.displayName}</span>
          {device.isCurrent && (
            <Badge variant="outline" className="h-5 shrink-0 text-[10px]">
              {t("connect:devices.thisDevice")}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          {isOnline
            ? t("connect:devices.activeNow")
            : t("connect:devices.lastSeen", { time: lastSeenText })}
        </p>
      </div>
      {isOnline ? (
        <Badge className="shrink-0 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
          {t("connect:devices.online")}
        </Badge>
      ) : (
        <span className="text-muted-foreground shrink-0 text-xs">{lastSeenText}</span>
      )}
    </div>
  );
}

function isDeviceOnline(device: Device): boolean {
  if (device.isCurrent) return true;
  if (!device.lastSeenAt) return false;
  const diffMins = Math.floor((Date.now() - new Date(device.lastSeenAt).getTime()) / 60000);
  return diffMins < 5;
}

function formatDeviceLastSeen(device: Device, t: TFunction): string {
  if (device.isCurrent) return t("connect:devices.online");
  if (!device.lastSeenAt) return t("connect:devices.never");
  const diffMins = Math.floor((Date.now() - new Date(device.lastSeenAt).getTime()) / 60000);
  if (diffMins < 5) return t("connect:devices.online");
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function BrokerSyncAttentionSection({
  issues,
  accounts,
  onRetry,
  onManage,
  isSyncing,
}: {
  issues: BrokerSyncState[];
  accounts: Account[];
  onRetry: () => void;
  onManage: () => void;
  isSyncing: boolean;
}) {
  const { t } = useTranslation();
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );

  return (
    <Alert variant="warning" className="mb-4">
      <Icons.AlertTriangle className="h-4 w-4" />
      <div className="flex flex-1 flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="font-medium">{t("connect:attention.title")}</p>
            <p className="text-muted-foreground text-sm">
              {t("connect:attention.description", { count: issues.length })}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={onRetry} disabled={isSyncing}>
              {isSyncing ? (
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Icons.RefreshCw className="mr-2 h-4 w-4" />
              )}
              {t("common:retry")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onManage}>
              <Icons.ExternalLink className="mr-2 h-4 w-4" />
              {t("connect:page.manage")}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {issues.map((issue) => {
            const account = accountById.get(issue.accountId);
            const accountName = account?.name || issue.accountId;
            const broker = account?.provider || issue.provider;
            const message = getBrokerSyncIssueMessage(issue.syncStatus, issue.lastError);

            return (
              <div key={`${issue.provider}:${issue.accountId}`} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{accountName}</span>
                  <Badge variant={issue.syncStatus === "FAILED" ? "destructive" : "outline"}>
                    {issue.syncStatus === "FAILED"
                      ? t("connect:status.failed")
                      : t("connect:status.needsReview")}
                  </Badge>
                  <span className="text-muted-foreground text-xs">{broker}</span>
                </div>
                <p className="text-muted-foreground mt-1 text-sm">{message}</p>
              </div>
            );
          })}
        </div>
      </div>
    </Alert>
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
  const { t } = useTranslation();
  const timeAgo = formatDistanceToNow(new Date(run.startedAt), { addSuffix: false });
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
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-3 sm:flex-nowrap sm:gap-4 ${
        needsAttention ? "bg-yellow-500/10 dark:bg-yellow-500/5" : "hover:bg-muted/30"
      }`}
    >
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
          needsAttention || isFailed ? "bg-yellow-500" : "bg-green-500"
        }`}
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
        <span className={needsAttention ? "font-medium text-amber-600 dark:text-amber-400" : ""}>
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
