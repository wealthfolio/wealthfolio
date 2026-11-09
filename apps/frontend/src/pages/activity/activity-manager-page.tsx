import { cn } from "@/lib/utils";
import { getAccounts, getAssetHoldingsScope } from "@/adapters";
import { ExternalLink } from "@/components/external-link";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useAssetProfile } from "@/pages/asset/hooks/use-asset-profile";
import { ActivityType } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, ActivityDetails } from "@/lib/types";
import {
  accountSupportsActivityType,
  getAllowedActivityTypes,
  getActivityRestrictionLevel,
} from "@/lib/activity-restrictions";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  Icons,
  Page,
  PageContent,
  PageHeader,
  Spinner,
  buttonVariants,
} from "@wealthfolio/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useBackNavigation } from "@/pages/layouts/mobile-stack/use-mobile-stack";
import type { AccountSelectOption } from "./components/forms/fields";
import {
  ActivityTypePicker,
  type ActivityType as PickerActivityType,
} from "./components/activity-type-picker";
import { ActivityFormRenderer } from "./components/activity-form-renderer";
import { MobileActivityForm } from "./components/mobile-forms/mobile-activity-form";
import { useActivityForm } from "./hooks/use-activity-form";
import { mapActivityTypeToPicker } from "./utils/activity-form-utils";

const ActivityManagerPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isMobileViewport = useIsMobileViewport();

  // Parse URL parameters
  const typeParam = searchParams.get("type") as ActivityType | null;
  const accountParam = searchParams.get("account");
  const assetIdParam = searchParams.get("assetId");
  const redirectTo = searchParams.get("redirect-to");

  const { data: accounts = [], isLoading: isAccountsLoading } = useQuery<Account[], Error>({
    queryKey: [QueryKeys.ACCOUNTS],
    queryFn: () => getAccounts(),
  });

  // Non-archived accounts for filtering
  const activeAccounts = useMemo(() => accounts.filter((acc) => !acc.isArchived), [accounts]);

  const goBack = useBackNavigation();
  const handleClose = useCallback(() => {
    if (redirectTo) {
      navigate(redirectTo);
      return;
    }
    goBack();
  }, [goBack, navigate, redirectTo]);

  // Get the selected account if pre-selected
  const selectedAccount = useMemo(() => {
    if (accountParam && accounts.length > 0) {
      return accounts.find((acc) => acc.id === accountParam);
    }
    return undefined;
  }, [accountParam, accounts]);

  const selectedAccountName = selectedAccount?.name ?? null;

  // Get allowed activity types based on account tracking mode
  const allowedActivityTypes = useMemo(() => {
    return getAllowedActivityTypes(selectedAccount);
  }, [selectedAccount]);

  // Get restriction level for alert display
  const restrictionLevel = useMemo(() => {
    return getActivityRestrictionLevel(selectedAccount);
  }, [selectedAccount]);

  // Fetch asset profile when assetId is provided (uses react-query cache)
  const { data: assetProfile, isLoading: isAssetProfileLoading } = useAssetProfile(assetIdParam);

  const [selectedType, setSelectedType] = useState<PickerActivityType | undefined>(
    mapActivityTypeToPicker(typeParam),
  );
  const [sellAccount, setSellAccount] = useState<{ assetId: string; accountId: string } | null>(
    null,
  );
  const needsSellAccount = selectedType === "SELL" && !!assetIdParam && !accountParam;
  const {
    data: assetHoldingsScope,
    isPending: isAssetHoldingsPending,
    isFetching: isAssetHoldingsFetching,
    isError: isAssetHoldingsError,
  } = useQuery({
    queryKey: [QueryKeys.ASSET_HOLDINGS, assetIdParam, "scope"],
    queryFn: () => getAssetHoldingsScope(assetIdParam!),
    enabled: needsSellAccount && sellAccount?.assetId !== assetIdParam,
    staleTime: 0,
  });
  // An account still being recalculated may own the asset. Wait: the portfolio
  // update's completion refreshes this query.
  const isAssetHoldingsUpdating =
    !isAssetHoldingsError &&
    !!assetHoldingsScope?.incompleteAccounts.some((account) => account.status === "pending");

  useEffect(() => {
    if (
      !needsSellAccount ||
      isAccountsLoading ||
      isAssetHoldingsPending ||
      isAssetHoldingsFetching ||
      isAssetHoldingsUpdating
    )
      return;
    const owners =
      isAssetHoldingsError ||
      !assetHoldingsScope ||
      assetHoldingsScope.incompleteAccounts.length > 0
        ? []
        : activeAccounts.filter(
            (account) =>
              accountSupportsActivityType(account, "SELL") &&
              assetHoldingsScope.holdings.some(
                (holding) => holding.accountId === account.id && holding.quantity > 0,
              ),
          );
    // Resolve once per asset so background refreshes cannot replace a user choice.
    setSellAccount((previous) =>
      previous?.assetId === assetIdParam
        ? previous
        : { assetId: assetIdParam!, accountId: owners.length === 1 ? owners[0].id : "" },
    );
  }, [
    needsSellAccount,
    isAccountsLoading,
    isAssetHoldingsPending,
    isAssetHoldingsFetching,
    isAssetHoldingsUpdating,
    isAssetHoldingsError,
    activeAccounts,
    assetHoldingsScope,
    assetIdParam,
  ]);

  const isResolvingSellAccount =
    needsSellAccount && (sellAccount?.assetId !== assetIdParam || isAssetProfileLoading);

  // Build initial activity from URL params + cached asset data
  const initialActivity: Partial<ActivityDetails> = useMemo(() => {
    const activity: Partial<ActivityDetails> = {};

    if (typeParam) {
      activity.activityType = typeParam;
    }

    if (accountParam) {
      activity.accountId = accountParam;
    } else if (needsSellAccount) {
      // An unresolved/ambiguous holding must not default to an unrelated account.
      activity.accountId = sellAccount?.assetId === assetIdParam ? sellAccount.accountId : "";
    }

    if (assetIdParam) {
      activity.assetId = assetIdParam;
    }

    if (assetProfile) {
      activity.assetSymbol =
        (selectedType === "SELL" ? assetProfile.instrumentSymbol : assetProfile.displayCode) ??
        assetProfile.displayCode ??
        assetProfile.instrumentSymbol ??
        undefined;
      activity.currency = assetProfile.quoteCcy;
      activity.exchangeMic = assetProfile.instrumentExchangeMic ?? undefined;
      activity.assetQuoteMode = assetProfile.quoteMode;
      // A crypto asset's totals stay exact and its money fields take 8 decimals.
      activity.instrumentType = assetProfile.instrumentType ?? undefined;
    }

    return activity;
  }, [
    typeParam,
    accountParam,
    assetIdParam,
    assetProfile,
    needsSellAccount,
    sellAccount,
    selectedType,
  ]);

  // Update selected type when URL param changes
  useEffect(() => {
    setSelectedType(mapActivityTypeToPicker(typeParam));
  }, [typeParam]);

  // Filter accounts by selected activity type and map to options
  const accountOptions: AccountSelectOption[] = useMemo(() => {
    const filtered = selectedType
      ? activeAccounts.filter((acc) => accountSupportsActivityType(acc, selectedType))
      : activeAccounts;

    return filtered.map((account) => ({
      value: account.id,
      label: account.name,
      currency: account.currency,
      accountType: account.accountType,
      group: account.group,
    }));
  }, [activeAccounts, selectedType]);

  // Use the activity form hook
  const { defaultValues, isEditing, isLoading, isError, error, handleSubmit } = useActivityForm({
    accounts: accountOptions,
    activity: initialActivity,
    selectedType,
    onSuccess: handleClose,
  });

  if (isResolvingSellAccount) {
    return (
      <Page>
        <PageHeader heading={t("activity:add_activity")} onBack={handleClose} />
        <PageContent>
          <div className="flex items-center justify-center gap-2 p-6" role="status">
            <Spinner />
            {t("common:component.loading_holdings")}
          </div>
        </PageContent>
      </Page>
    );
  }

  // For mobile, use the existing mobile form component
  if (isMobileViewport) {
    return (
      <Page>
        <PageHeader
          heading={t("activity:add_activity")}
          text={
            selectedAccountName
              ? t("activity:manager.add_to_account", { account: selectedAccountName })
              : t("activity:manager.create_transaction")
          }
          onBack={handleClose}
        />
        <PageContent>
          <MobileActivityForm
            key={initialActivity?.id ?? "new"}
            accounts={accountOptions}
            activity={initialActivity}
            open={true}
            onClose={handleClose}
          />
        </PageContent>
      </Page>
    );
  }

  // Desktop inline form with activity type picker
  return (
    <Page>
      <PageHeader
        heading={t("activity:add_activity")}
        text={
          selectedAccountName
            ? t("activity:manager.add_to_account", { account: selectedAccountName })
            : t("activity:manager.create_transaction")
        }
        onBack={handleClose}
        actions={
          <ExternalLink
            href="https://wealthfolio.app/docs/concepts/activity-types"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "flex items-center gap-1.5",
            )}
          >
            <Icons.HelpCircle className="h-4 w-4" />
            {t("activity:learn_more")}
          </ExternalLink>
        }
      />
      <PageContent>
        <div className="mx-auto max-w-5xl">
          <Card>
            <CardContent className="space-y-6 p-6">
              {/* Alert for connected HOLDINGS accounts (no manual entry) */}
              {restrictionLevel === "blocked" && (
                <Alert>
                  <Icons.Info className="h-4 w-4" />
                  <AlertTitle>{t("activity:manager.synced_account")}</AlertTitle>
                  <AlertDescription>{t("activity:manager.synced_account_desc")}</AlertDescription>
                </Alert>
              )}

              {/* Alert for manual HOLDINGS accounts (limited activity types) */}
              {restrictionLevel === "limited" && selectedAccount && (
                <Alert>
                  <Icons.Info className="h-4 w-4" />
                  <AlertTitle>{t("activity:manager.holdings_tracking_mode")}</AlertTitle>
                  <AlertDescription className="flex flex-col gap-2">
                    <span>{t("activity:manager.holdings_tracking_mode_desc")}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      onClick={() => navigate(`/account/${selectedAccount.id}`)}
                    >
                      <Icons.ExternalLink className="me-2 h-3 w-3" />
                      {t("activity:manager.go_to_account")}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}

              {/* Activity Type Picker - only show if not blocked */}
              {!isEditing && restrictionLevel !== "blocked" && (
                <ActivityTypePicker
                  value={selectedType}
                  onSelect={setSelectedType}
                  allowedTypes={allowedActivityTypes}
                />
              )}

              {/* When editing, show the activity type as a badge */}
              {isEditing && selectedType && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{t("activity:activity_type")}:</span>
                  <span className="bg-primary/10 text-primary rounded-md px-2 py-1 font-medium">
                    {selectedType}
                  </span>
                </div>
              )}

              {/* Render the appropriate form - only show if not blocked */}
              {restrictionLevel !== "blocked" && (
                <ActivityFormRenderer
                  selectedType={selectedType}
                  formIdentity={initialActivity?.id}
                  accounts={accountOptions}
                  defaultValues={defaultValues}
                  onSubmit={handleSubmit}
                  onCancel={handleClose}
                  isLoading={isLoading}
                  isEditing={isEditing}
                />
              )}

              {/* Display mutation error */}
              {isError && (
                <Alert variant="destructive">
                  <Icons.AlertCircle className="h-4 w-4" />
                  <AlertTitle>{t("common:error")}</AlertTitle>
                  <AlertDescription>{String(error)}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </PageContent>
    </Page>
  );
};

export default ActivityManagerPage;
