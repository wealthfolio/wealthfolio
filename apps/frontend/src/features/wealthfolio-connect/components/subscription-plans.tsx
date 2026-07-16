import { openUrlInBrowser } from "@/adapters";
import { getSubscriptionPlans } from "../services/broker-service";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";
import type { BillingPeriod, SubscriptionPlan } from "../types";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@wealthfolio/ui/components/ui/toggle-group";
import { WEALTHFOLIO_CONNECT_PORTAL_URL } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getDisplayablePlans } from "../lib/plan-visibility";

// Helper to detect if error is an auth/token issue
function isAuthError(error: Error | null): boolean {
  if (!error) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("access token") ||
    msg.includes("refresh token") ||
    msg.includes("unauthorized") ||
    msg.includes("sign in") ||
    msg.includes("session expired")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Hooks
// ─────────────────────────────────────────────────────────────────────────────

function useSubscriptionPlans(enabled: boolean) {
  return useQuery({
    queryKey: [QueryKeys.SUBSCRIPTION_PLANS],
    queryFn: getSubscriptionPlans,
    enabled,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Components
// ─────────────────────────────────────────────────────────────────────────────

function PlanCardSkeleton() {
  return (
    <div className="border-border bg-muted/30 flex flex-col rounded-lg border p-4">
      {/* Title and description */}
      <div className="mb-3">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="mt-1.5 h-3 w-full" />
      </div>
      {/* Price */}
      <div className="mb-4">
        <Skeleton className="h-7 w-20" />
      </div>
      {/* Features */}
      <div className="mb-4 flex-1 space-y-1.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-3 w-3 rounded-full" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
      {/* Button */}
      <Skeleton className="mt-auto h-8 w-full rounded-md" />
    </div>
  );
}

interface PlanCardProps {
  plan: SubscriptionPlan;
  billingPeriod: BillingPeriod;
  isDefault?: boolean;
  isComingSoon?: boolean;
}

function PlanCard({ plan, billingPeriod, isDefault, isComingSoon }: PlanCardProps) {
  const { t } = useTranslation();
  const priceAmount = billingPeriod === "monthly" ? plan.pricing.monthly : plan.pricing.yearly;
  const yearlyPricing = plan.pricing.yearly;
  const monthlyPricing = plan.pricing.monthly;

  // Use yearlyDiscountPercent from API if available, otherwise calculate
  const yearlySavings =
    billingPeriod === "yearly"
      ? (plan.yearlyDiscountPercent ??
        Math.round(((monthlyPricing * 12 - yearlyPricing) / (monthlyPricing * 12)) * 100))
      : 0;

  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const handleGetStarted = () => {
    openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}/onboarding?plan=${plan.id}`);
  };

  // Use isComingSoon from API if available
  const showComingSoon = isComingSoon || plan.isComingSoon;

  return (
    <div
      className={`bg-muted/30 relative flex flex-col rounded-lg border p-4 ${
        isDefault ? "border-primary" : "border-border"
      } ${showComingSoon ? "opacity-60" : ""}`}
    >
      {showComingSoon && (
        <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2" variant="secondary">
          {t("connect:subscription.comingSoon")}
        </Badge>
      )}

      <div className="mb-3">
        <h3 className="text-base font-semibold">{plan.name}</h3>
        <p className="text-muted-foreground mt-0.5 text-xs">{plan.tagline ?? plan.description}</p>
      </div>

      <div className="mb-4">
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold">{formatPrice(priceAmount)}</span>
          <span className="text-muted-foreground text-xs">
            /
            {billingPeriod === "monthly"
              ? t("connect:subscription.perMonthShort")
              : t("connect:subscription.perYearShort")}
          </span>
        </div>
        {billingPeriod === "yearly" && yearlySavings > 0 && (
          <p className="mt-0.5 text-xs text-green-600 dark:text-green-400">
            {t("connect:subscription.savings", { percent: yearlySavings })}
          </p>
        )}
      </div>

      <ul className="mb-4 flex-1 space-y-1.5">
        {plan.features.map((feature, index) => (
          <li key={index} className="flex items-start gap-2 text-xs">
            <Icons.Check className="mt-0.5 h-3 w-3 shrink-0 text-green-500" />
            <span className="text-muted-foreground">{feature}</span>
          </li>
        ))}
      </ul>

      <Button
        className="mt-auto w-full"
        size="sm"
        variant={isDefault ? "default" : "outline"}
        onClick={handleGetStarted}
        disabled={showComingSoon || !plan.isAvailable}
      >
        {showComingSoon
          ? t("connect:subscription.comingSoon")
          : t("connect:subscription.getStarted")}
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

interface SubscriptionPlansProps {
  enabled?: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function SubscriptionPlans({
  enabled = true,
  onRefresh,
  isRefreshing,
}: SubscriptionPlansProps) {
  const { t } = useTranslation();
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>("monthly");
  const { data, isLoading, error } = useSubscriptionPlans(enabled);
  const { signOut, isLoading: isSigningOut } = useWealthfolioConnect();
  const plans = getDisplayablePlans(data?.plans);

  // Handle auth errors - session expired or token sync issue
  if (error && isAuthError(error)) {
    const handleReconnect = async () => {
      // Sign out to clear stale session, then user can sign in again
      await signOut();
    };

    const handleRefresh = () => {
      window.location.reload();
    };

    return (
      <Card className="border-warning/30 bg-warning/5">
        <CardContent className="py-8">
          <div className="flex flex-col items-center justify-center text-center">
            <div className="bg-warning/15 mb-4 rounded-full p-4">
              <Icons.AlertCircle className="text-warning h-8 w-8" />
            </div>
            <h3 className="text-foreground mb-2 text-base font-medium">
              {t("connect:subscription.connectionIssueTitle")}
            </h3>
            <p className="text-muted-foreground mb-4 max-w-sm text-sm">
              {t("connect:subscription.connectionIssueDescription")}{" "}
              <Popover>
                <PopoverTrigger asChild>
                  <button className="text-muted-foreground hover:text-foreground underline underline-offset-2">
                    {t("connect:subscription.contactSupport")}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">support@wealthfolio.app</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        navigator.clipboard.writeText("support@wealthfolio.app");
                        toast.success(t("connect:subscription.emailCopied"));
                      }}
                    >
                      <Icons.Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={handleRefresh}>
                <Icons.Refresh className="mr-2 h-4 w-4" />
                {t("common:refresh")}
              </Button>
              <Button size="sm" onClick={handleReconnect} disabled={isSigningOut}>
                {isSigningOut ? (
                  <>
                    <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                    {t("connect:subscription.reconnecting")}
                  </>
                ) : (
                  <>
                    <Icons.LogOut className="mr-2 h-4 w-4" />
                    {t("connect:subscription.reconnect")}
                  </>
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Handle other errors (service unavailable, network issues, etc.)
  if (error) {
    return (
      <Card className="border-warning/30 bg-warning/5">
        <CardContent className="py-8">
          <div className="flex flex-col items-center justify-center text-center">
            <div className="bg-warning/15 mb-4 rounded-full p-4">
              <Icons.CloudOff className="text-warning h-8 w-8" />
            </div>
            <h3 className="text-foreground mb-2 text-base font-medium">
              {t("connect:subscription.unableToLoadTitle")}
            </h3>
            <p className="text-muted-foreground mb-4 max-w-sm text-sm">
              {t("connect:subscription.unableToLoadDescription")}{" "}
              <Popover>
                <PopoverTrigger asChild>
                  <button className="text-muted-foreground hover:text-foreground underline underline-offset-2">
                    {t("connect:subscription.contactSupport")}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">support@wealthfolio.app</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        navigator.clipboard.writeText("support@wealthfolio.app");
                        toast.success(t("connect:subscription.emailCopied"));
                      }}
                    >
                      <Icons.Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </p>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              <Icons.Refresh className="mr-2 h-4 w-4" />
              {t("connect:subscription.refreshPage")}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base font-medium">
              {t("connect:subscription.choosePlan")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("connect:subscription.choosePlanDescription")}
            </CardDescription>
          </div>
          <ToggleGroup
            type="single"
            value={billingPeriod}
            onValueChange={(value) => value && setBillingPeriod(value as BillingPeriod)}
            className="bg-muted h-8 rounded-md p-0.5"
          >
            <ToggleGroupItem
              value="monthly"
              aria-label={t("connect:subscription.monthlyBilling")}
              className="data-[state=on]:bg-background h-7 rounded px-3 text-xs data-[state=on]:shadow-sm"
            >
              {t("connect:subscription.monthly")}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="yearly"
              aria-label={t("connect:subscription.yearlyBilling")}
              className="data-[state=on]:bg-background h-7 rounded px-3 text-xs data-[state=on]:shadow-sm"
            >
              {t("connect:subscription.yearly")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <PlanCardSkeleton />
            <PlanCardSkeleton />
            <PlanCardSkeleton />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                billingPeriod={billingPeriod}
                isDefault={plan.id === "essentials" || plan.badge === "Popular"}
              />
            ))}
          </div>
        )}

        {/* Refresh hint after subscribing */}
        {onRefresh && (
          <div className="mt-4 flex items-center justify-center gap-2 rounded-md border border-dashed p-3">
            <p className="text-muted-foreground text-xs">
              {t("connect:subscription.alreadySubscribed")}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={isRefreshing}
              className="h-7 px-2 text-xs"
            >
              {isRefreshing ? (
                <Icons.Spinner className="mr-1.5 h-3 w-3 animate-spin" />
              ) : (
                <Icons.Refresh className="mr-1.5 h-3 w-3" />
              )}
              {t("common:refresh")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
