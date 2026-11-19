import { useAccounts } from "@/hooks/use-accounts";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { getActivityRestrictionLevel } from "@/lib/activity-restrictions";
import { ActivityType, isLiabilityAccountType } from "@/lib/constants";
import { ActivityForm } from "@/pages/activity/components/activity-form";
import { MobileActivityForm } from "@/pages/activity/components/mobile-forms/mobile-activity-form";
import { useBackNavigation } from "@/pages/layouts/mobile-stack/use-mobile-stack";
import { Page, Spinner } from "@wealthfolio/ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { CashActivityForm } from "../components/cash-activity-form";
import { useSpendingSettings } from "../hooks/use-spending-settings";
import { getSpendingBackgroundLocation } from "../lib/activity-entry";

const TRANSFER_ACTIVITY = { activityType: ActivityType.TRANSFER_OUT };

export default function SpendingActivityPage() {
  const [params] = useSearchParams();
  const type = params.get("type");
  const { isEnabled, isLoading } = useSpendingSettings();
  const { accounts = [] } = useAccounts();
  const isMobile = useIsMobileViewport();
  const [open, setOpen] = useState(true);
  // "Record payment" or "Transfer between accounts" from the form: the
  // transfer, from the account it was chosen for.
  const [transferActivity, setTransferActivity] = useState<
    { activityType: ActivityType; accountId: string } | undefined
  >();
  const switchingToTransfer = useRef(false);
  const goBack = useBackNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const backgroundLocation = getSpendingBackgroundLocation(location);
  const close = useCallback(() => {
    if (!open) return;
    setOpen(false);
    if (backgroundLocation) goBack();
    else navigate("/?tab=spending", { replace: true });
  }, [backgroundLocation, goBack, navigate, open]);
  const transferAccounts = useMemo(
    () =>
      accounts
        .filter((account) => !account.isArchived)
        .map((account) => ({
          value: account.id,
          label: account.name,
          currency: account.currency,
          accountType: account.accountType,
          restrictionLevel: getActivityRestrictionLevel(account),
        })),
    [accounts],
  );

  if (isLoading)
    return (
      <Page>
        <Spinner />
      </Page>
    );
  if (!isEnabled) return <Navigate to="/" replace />;
  if (type === "TRANSFER" || transferActivity) {
    const activity = transferActivity ?? TRANSFER_ACTIVITY;
    return isMobile ? (
      <MobileActivityForm
        open={open}
        startOnDetails
        accounts={transferAccounts}
        transferAccounts={transferAccounts}
        activity={activity}
        onClose={close}
      />
    ) : (
      <ActivityForm
        open={open}
        hidePicker
        accounts={transferAccounts}
        transferAccounts={transferAccounts}
        activity={activity}
        onClose={close}
      />
    );
  }
  return (
    <CashActivityForm
      open={open}
      onOpenChange={(open) => {
        if (!open && !switchingToTransfer.current) close();
      }}
      onTransferClick={(accountId) => {
        const account = accounts.find((item) => item.id === accountId);
        switchingToTransfer.current = true;
        setTransferActivity({
          activityType: isLiabilityAccountType(account?.accountType)
            ? ActivityType.TRANSFER_IN
            : ActivityType.TRANSFER_OUT,
          accountId,
        });
      }}
      intent={type === "WITHDRAWAL" ? "expense" : type === "DEPOSIT" ? "income" : undefined}
    />
  );
}
