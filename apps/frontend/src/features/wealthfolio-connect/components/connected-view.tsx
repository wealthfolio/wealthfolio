import { openUrlInBrowser } from "@/adapters";
import { ExternalLink } from "@/components/external-link";
import { DeviceSyncSection } from "@/features/devices-sync";
import { WEALTHFOLIO_CONNECT_PORTAL_URL } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ActionConfirm } from "@wealthfolio/ui";
import { Avatar, AvatarFallback, AvatarImage } from "@wealthfolio/ui/components/ui/avatar";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent, CardHeader } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { formatDate } from "@/lib/utils";
import { Trans, useTranslation } from "react-i18next";
import { useCallback, useState } from "react";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";
import {
  listBrokerAccounts,
  listBrokerConnections,
  syncBrokerData,
} from "../services/broker-service";
import type { BrokerAccount, BrokerConnection } from "../types";
import { hasBrokerSync } from "../lib/plan-capabilities";
import { SubscriptionPlans } from "./subscription-plans";

// ─────────────────────────────────────────────────────────────────────────────
// Custom Hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook to fetch broker connections from the backend.
 */
function useBrokerConnections(isConnected: boolean) {
  return useQuery({
    queryKey: [QueryKeys.BROKER_CONNECTIONS],
    queryFn: listBrokerConnections,
    enabled: isConnected,
    staleTime: 30000,
  });
}

/**
 * Hook to fetch broker accounts from the backend.
 */
function useBrokerAccountsQuery(isConnected: boolean) {
  return useQuery({
    queryKey: [QueryKeys.BROKER_ACCOUNTS],
    queryFn: listBrokerAccounts,
    enabled: isConnected,
    staleTime: 30000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Components
// ─────────────────────────────────────────────────────────────────────────────

interface ServiceUnavailableCardProps {
  onRetry: () => void;
  isRetrying: boolean;
}

function ServiceUnavailableCard({ onRetry, isRetrying }: ServiceUnavailableCardProps) {
  const { t } = useTranslation();
  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardContent className="py-8">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="bg-warning/15 mb-4 rounded-full p-4">
            <Icons.CloudOff className="text-warning h-8 w-8" />
          </div>
          <h3 className="text-foreground mb-2 text-base font-medium">
            {t("connect:serviceUnavailable.title")}
          </h3>
          <p className="text-muted-foreground mb-4 max-w-sm text-sm">
            {t("connect:serviceUnavailable.description")}
          </p>
          <Button variant="outline" onClick={onRetry} disabled={isRetrying}>
            {isRetrying ? (
              <>
                <Icons.Spinner className="h-4 w-4 animate-spin" />
                {t("connect:serviceUnavailable.retrying")}
              </>
            ) : (
              <>
                <Icons.Refresh className="h-4 w-4" />
                {t("connect:serviceUnavailable.tryAgain")}
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function BrokerConnectionSkeleton() {
  return (
    <div className="flex items-center gap-4 rounded-lg border p-4">
      <Skeleton className="h-12 w-12 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}

interface BrokerAccountCardProps {
  account: BrokerAccount;
  connections: BrokerConnection[];
}

/**
 * Mask account number to show only last 4 characters
 */
function maskAccountNumber(number?: string): string {
  if (!number) return "";
  const last4 = number.slice(-4);
  return `\u2022\u2022${last4}`;
}

/**
 * Get the latest sync date from transactions or holdings
 */
function getLastSyncDate(account: BrokerAccount): string | null {
  const txDate = account.sync_status?.transactions?.last_successful_sync;
  const holdingsDate = account.sync_status?.holdings?.last_successful_sync;
  if (txDate && holdingsDate) {
    return new Date(txDate) > new Date(holdingsDate) ? txDate : holdingsDate;
  }
  return txDate || holdingsDate || null;
}

function BrokerAccountCard({ account, connections }: BrokerAccountCardProps) {
  const { t } = useTranslation();
  const lastSyncDate = getLastSyncDate(account);

  // Find the connection that matches this account's brokerage_authorization
  const connection = connections.find((c) => c.id === account.brokerage_authorization);
  const logoUrl =
    connection?.brokerage?.aws_s3_square_logo_url ?? connection?.brokerage?.aws_s3_logo_url;

  const lastSyncedText = lastSyncDate
    ? t("connect:accounts.dataAsOf", { date: formatDate(lastSyncDate) })
    : t("connect:accounts.noDataYet");

  return (
    <div className="bg-muted/30 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        {/* Logo */}
        <Avatar className="mt-0.5 h-9 w-9 shrink-0 rounded-lg">
          <AvatarImage
            src={logoUrl}
            alt={account.institution_name || t("connect:accounts.brokerFallback")}
            className="bg-white object-contain p-1"
          />
          <AvatarFallback className="rounded-lg text-sm font-semibold">
            {(account.institution_name || account.name || "B").charAt(0)}
          </AvatarFallback>
        </Avatar>

        {/* Main info - takes remaining space */}
        <div className="min-w-0 flex-1">
          {/* Row 1: name + badges + sync icon */}
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {account.name || t("connect:accounts.accountFallback")}
            </span>
            {account.is_paper && (
              <Badge variant="outline" className="h-5 shrink-0 text-[10px]">
                {t("connect:accounts.paper")}
              </Badge>
            )}
            <Tooltip>
              <TooltipTrigger>
                {account.sync_enabled ? (
                  <Icons.Eye className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                ) : (
                  <Icons.EyeOff className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                )}
              </TooltipTrigger>
              <TooltipContent>
                {account.sync_enabled
                  ? t("connect:accounts.syncEnabled")
                  : t("connect:accounts.excludedFromSync")}
              </TooltipContent>
            </Tooltip>
          </div>
          {/* Row 2: institution · account number · shared */}
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
            <span className="truncate">{account.institution_name}</span>
            {account.number && (
              <>
                <span className="shrink-0 opacity-40">·</span>
                <span className="shrink-0">{maskAccountNumber(account.number)}</span>
              </>
            )}
            {account.shared_with_household && (
              <>
                <span className="shrink-0 opacity-40">·</span>
                <span className="flex shrink-0 items-center gap-0.5">
                  <Icons.Users className="h-3 w-3" />
                  {t("connect:accounts.shared")}
                </span>
              </>
            )}
            {/* Sync time inline on sm+ */}
            <span className="ml-auto hidden shrink-0 pl-2 sm:inline">{lastSyncedText}</span>
          </div>
          {/* Row 3: Sync time on its own line on mobile */}
          <p className="text-muted-foreground mt-0.5 text-[11px] sm:hidden">{lastSyncedText}</p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker Connections Card Component
// ─────────────────────────────────────────────────────────────────────────────

interface BrokerConnectionsCardProps {
  connections: BrokerConnection[];
  isLoading: boolean;
  onRefresh: () => void;
  isRefreshing: boolean;
}

function BrokerConnectionsCard({
  connections,
  isLoading,
  onRefresh,
  isRefreshing,
}: BrokerConnectionsCardProps) {
  const { t } = useTranslation();
  const openConnectionsPortal = () => {
    openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}/connections`);
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
              <Icons.Link className="text-muted-foreground h-4 w-4" />
            </div>
            <h3 className="text-base font-semibold">{t("connect:connections.title")}</h3>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground h-8 w-8"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <Icons.RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
            </Button>
            {/* Mobile: icon only */}
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground sm:hidden"
              onClick={openConnectionsPortal}
            >
              <Icons.ExternalLink className="h-4 w-4" />
            </Button>
            {/* Desktop: full text */}
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground hidden sm:inline-flex"
              onClick={openConnectionsPortal}
            >
              {t("connect:connections.manage")}
              <Icons.ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {isLoading ? (
            <>
              <BrokerConnectionSkeleton />
              <BrokerConnectionSkeleton />
            </>
          ) : connections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-center">
              <p className="text-muted-foreground text-sm">{t("connect:connections.empty")}</p>
              <Button className="mt-3" onClick={openConnectionsPortal}>
                <Icons.Plus className="h-4 w-4" />
                {t("connect:connections.connectBroker")}
              </Button>
            </div>
          ) : (
            connections.map((connection) => {
              const logoUrl =
                connection.brokerage?.aws_s3_square_logo_url ??
                connection.brokerage?.aws_s3_logo_url;
              const brokerageName =
                connection.brokerage?.display_name ??
                connection.brokerage?.name ??
                t("connect:connections.unknownBroker");
              const isConnected = connection.status === "connected" && !connection.disabled;

              return (
                <div
                  key={connection.id}
                  className="bg-muted/30 flex items-center gap-3 rounded-lg border p-3"
                >
                  <Avatar className="h-9 w-9 shrink-0 rounded-lg">
                    <AvatarImage
                      src={logoUrl}
                      alt={brokerageName}
                      className="bg-white object-contain p-1"
                    />
                    <AvatarFallback className="rounded-lg text-sm font-semibold">
                      {brokerageName.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {brokerageName}
                  </span>
                  <Badge
                    className={`shrink-0 ${
                      isConnected
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                    }`}
                  >
                    {isConnected
                      ? t("connect:connections.connected")
                      : t("connect:connections.disconnected")}
                  </Badge>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function ConnectedView() {
  const { t } = useTranslation();
  const {
    user,
    session,
    userInfo,
    signOut,
    isLoading,
    isLoadingUserInfo,
    error,
    clearError,
    refetchUserInfo,
  } = useWealthfolioConnect();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  // Check if user is connected (has a valid session)
  const isConnected = !!session;

  // Check if there's a service unavailable error (failed to fetch user info)
  const isServiceUnavailable = !!error && !isLoadingUserInfo && !userInfo;

  // Check if user has an active subscription
  const hasSubscription =
    userInfo?.team?.subscription_status === "active" ||
    userInfo?.team?.subscription_status === "trialing";

  // Check if user's plan includes broker sync
  const showBrokerSync = hasBrokerSync(userInfo);

  // Hooks - only fetch broker connections and accounts if user has broker sync
  const connectionsQuery = useBrokerConnections(showBrokerSync);
  const accountsQuery = useBrokerAccountsQuery(showBrokerSync);

  // Retry handler for service unavailable state
  const handleRetry = useCallback(async () => {
    setIsRetrying(true);
    clearError();
    try {
      await refetchUserInfo();
    } finally {
      setIsRetrying(false);
    }
  }, [clearError, refetchUserInfo]);

  // Sync accounts to local database
  // Sync runs in background, global event listener handles toasts and query invalidation
  const syncToLocalMutation = useMutation({
    mutationFn: syncBrokerData,
    onSuccess: () => {
      toast.loading(t("connect:sync.syncingBrokerData"), { id: "broker-sync-start" });
    },
    onError: (error) => {
      toast.error(
        t("connect:sync.startFailed", {
          error: error instanceof Error ? error.message : t("connect:errors.unknown"),
        }),
      );
    },
  });

  // Handlers
  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    clearError();
    try {
      await signOut();
    } catch {
      // Error is handled by context
    } finally {
      setIsSigningOut(false);
    }
  }, [clearError, signOut]);

  // Derived state
  const connections = connectionsQuery.data ?? [];
  const brokerAccounts = accountsQuery.data ?? [];
  const isLoadingConnections = connectionsQuery.isLoading;
  const isLoadingAccounts = accountsQuery.isLoading;
  const isSyncing = syncToLocalMutation.isPending;

  return (
    <div className="space-y-6">
      {/* Account Card */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12">
              <AvatarImage
                src={user?.user_metadata?.avatar_url}
                alt={user?.email ?? t("connect:account.userAvatar")}
              />
              <AvatarFallback className="bg-success/15">
                <span className="text-success text-lg font-semibold">
                  {(userInfo?.full_name?.[0] ?? user?.email?.[0] ?? "U").toUpperCase()}
                </span>
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-base font-semibold">
                  {userInfo?.full_name ??
                    user?.email?.split("@")[0] ??
                    t("connect:account.userFallback")}
                </h3>
                {hasSubscription && (
                  <Badge className="h-5 shrink-0 bg-green-100 px-2 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    {t("connect:account.active")}
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground truncate text-sm">{user?.email}</p>
            </div>
            <ActionConfirm
              handleConfirm={handleSignOut}
              isPending={isSigningOut}
              confirmTitle={t("connect:account.signOutTitle")}
              confirmMessage={t("connect:account.signOutMessage")}
              confirmButtonText={t("connect:account.signOutConfirm")}
              pendingText={t("connect:account.signingOut")}
              cancelButtonText={t("common:cancel")}
              confirmButtonVariant="destructive"
              button={
                <Button
                  variant="outline"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  disabled={isSigningOut || isLoading}
                >
                  {isSigningOut ? (
                    <Icons.Spinner className="h-4 w-4 animate-spin" />
                  ) : (
                    <Icons.LogOut className="h-4 w-4" />
                  )}
                  <span>{t("connect:account.signOut")}</span>
                </Button>
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Show loading skeleton only during initial load (not refreshes) */}
      {!isServiceUnavailable && !userInfo && (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="mt-2 h-4 w-72" />
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Show Service Unavailable card when API is down */}
      {isServiceUnavailable && (
        <ServiceUnavailableCard onRetry={handleRetry} isRetrying={isRetrying} />
      )}

      {/* Show Subscription Plans if user has no active subscription (keep mounted during refresh) */}
      {!isServiceUnavailable && !hasSubscription && !!userInfo && (
        <SubscriptionPlans
          enabled={isConnected && !hasSubscription}
          onRefresh={refetchUserInfo}
          isRefreshing={isLoadingUserInfo}
        />
      )}

      {/* Broker Connections Card - Only show if user has broker sync */}
      {showBrokerSync && (
        <BrokerConnectionsCard
          connections={connections}
          isLoading={isLoadingConnections}
          onRefresh={() => connectionsQuery.refetch()}
          isRefreshing={connectionsQuery.isFetching}
        />
      )}

      {/* Accounts Card - Only show if user has broker sync */}
      {showBrokerSync && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                  <Icons.Wallet className="text-muted-foreground h-4 w-4" />
                </div>
                <h3 className="text-base font-semibold">{t("connect:accounts.title")}</h3>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => syncToLocalMutation.mutate()}
                  disabled={isSyncing || accountsQuery.isFetching}
                >
                  <Icons.CloudSync2 className={`h-4 w-4 ${isSyncing ? "animate-pulse" : ""}`} />
                  {t("connect:sync.syncNow")}
                </Button>
                {/* Mobile: icon only */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground sm:hidden"
                  onClick={() => openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}/accounts`)}
                >
                  <Icons.ExternalLink className="h-4 w-4" />
                </Button>
                {/* Desktop: full text */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground hidden sm:inline-flex"
                  onClick={() => openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}/accounts`)}
                >
                  {t("connect:accounts.manage")}
                  <Icons.ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="mt-4">
              {isLoadingAccounts || isLoadingConnections ? (
                <div className="space-y-2">
                  <BrokerConnectionSkeleton />
                  <BrokerConnectionSkeleton />
                </div>
              ) : brokerAccounts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <p className="text-muted-foreground text-sm">
                    {t("connect:accounts.emptyTitle")}
                  </p>
                  <p className="text-muted-foreground mt-1 max-w-xs text-xs">
                    {t("connect:accounts.emptyDescription")}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {brokerAccounts.map((account) => (
                    <BrokerAccountCard
                      key={account.id}
                      account={account}
                      connections={connections}
                    />
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Device Sync Section - Only show if user has an active subscription */}
      {hasSubscription && <DeviceSyncSection />}

      {/* Upgrade callout for basic plan users */}
      {hasSubscription && !showBrokerSync && (
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

      {/* Privacy Footnote */}
      <footer className="border-t pt-4">
        <p className="text-muted-foreground text-center text-xs leading-relaxed">
          <Trans
            i18nKey="connect:privacy.footnote"
            components={{
              privacyLink: (
                <ExternalLink
                  href="https://wealthfolio.app/privacy"
                  className="text-muted-foreground hover:text-foreground underline underline-offset-2"
                />
              ),
            }}
          />
        </p>
      </footer>
    </div>
  );
}
