import { Account, ContributionLimit } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Icons,
  Skeleton,
  useAmountFormatting,
  useDateFormatting,
} from "@wealthfolio/ui";
import { ProgressBar } from "@/features/goals/components/goal-card";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { parseAccountIds } from "../contribution-limit-accounts";
import { hasFormerDefaultDates } from "../contribution-limit-dates";
import { useContributionLimitProgress } from "../use-contribution-limit-mutations";
import { ContributionLimitOperations } from "./contribution-limit-operations";
import { statusSurfaceVariants } from "@wealthfolio/ui/components/ui/status-surface";
import { cn } from "@/lib/utils";

interface ContributionLimitItemProps {
  limit: ContributionLimit;
  accounts: Account[];
  onEdit: (limit: ContributionLimit) => void;
  onDelete: (limit: ContributionLimit) => void;
}

export function ContributionLimitItem({
  limit,
  accounts,
  onEdit,
  onDelete,
}: ContributionLimitItemProps) {
  const amountFormatting = useAmountFormatting();
  const dateFormatting = useDateFormatting();
  // At UTC+12 and beyond the former default dates fall on the next local day,
  // so they show as saved.
  const formatLimitDate = hasFormerDefaultDates(limit)
    ? (date: string, options?: Parameters<typeof dateFormatting.formatDate>[1]) =>
        dateFormatting.formatCalendarDate(date.slice(0, 10), options)
    : dateFormatting.formatDate;

  const { t } = useTranslation();
  const detailsPath = `/settings/contribution-limits/${encodeURIComponent(limit.id)}`;
  const limitAccounts = parseAccountIds(limit.accountIds).flatMap((id) => {
    const account = accounts.find((candidate) => candidate.id === id);
    return account ? [account] : [];
  });

  const { data: progress, isLoading } = useContributionLimitProgress(limit.id);

  const progressValue = progress ? progress.total : 0;
  const progressPercentageNumber =
    limit.limitAmount > 0 ? (progressValue / limit.limitAmount) * 100 : 0;
  const baseCurrency = progress?.baseCurrency || "USD";
  const isOverLimit = progressPercentageNumber > 100;
  const isComplete = progressPercentageNumber === 100;
  const remainingAmount = limit.limitAmount - progressValue;
  const overLimitAmount = isOverLimit ? Math.abs(remainingAmount) : 0;
  const today = new Date();
  const endDate = limit.endDate ? new Date(limit.endDate) : null;
  const daysRemaining = endDate
    ? Math.ceil((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <Card
      className={cn(
        "relative w-full",
        progressPercentageNumber === 100
          ? statusSurfaceVariants({ status: "success" })
          : isOverLimit && statusSurfaceVariants({ status: "destructive" }),
      )}
    >
      <CardHeader className="pb-3">
        {/* Mobile Layout */}
        <div className="flex flex-col gap-2 sm:hidden">
          {/* Row 1: Title + Actions */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isComplete && <Icons.CheckCircle className="text-success h-5 w-5 shrink-0" />}
              {isOverLimit && <Icons.AlertTriangle className="text-destructive h-5 w-5 shrink-0" />}
              <CardTitle className="text-base">
                <LimitLink to={detailsPath}>{limit.groupName}</LimitLink>
              </CardTitle>
            </div>
            <div className="relative">
              <ContributionLimitOperations limit={limit} onEdit={onEdit} onDelete={onDelete} />
            </div>
          </div>

          {/* Row 2: Amount display */}
          {!isLoading && (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-baseline gap-1">
                <span
                  className={`text-xl font-bold ${
                    isOverLimit ? "text-destructive" : isComplete ? "text-success" : ""
                  }`}
                >
                  {amountFormatting.formatAmount(progressValue, baseCurrency)}
                </span>
                <span className="text-muted-foreground text-sm">
                  / {amountFormatting.formatAmount(limit.limitAmount, baseCurrency)}
                </span>
              </div>
              {isComplete && (
                <span className="text-success text-xs">✓ {t("settings:limits_limit_reached")}</span>
              )}
              {isOverLimit && (
                <span className="text-destructive text-xs">
                  {t("settings:limits_over_limit", {
                    amount: amountFormatting.formatAmount(overLimitAmount, baseCurrency),
                  })}
                </span>
              )}
              {!isComplete && !isOverLimit && (
                <span className="text-muted-foreground text-xs">
                  {t("settings:limits_remaining", {
                    amount: amountFormatting.formatAmount(remainingAmount, baseCurrency),
                  })}
                </span>
              )}
            </div>
          )}

          {/* Row 3: Date range and days remaining */}
          {limit.startDate && limit.endDate && (
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <Icons.Calendar className="h-3 w-3 shrink-0" />
              <span>
                {formatLimitDate(limit.startDate, {
                  month: "short",
                  day: "numeric",
                })}{" "}
                →{" "}
                {formatLimitDate(limit.endDate, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              {daysRemaining !== null && daysRemaining > 0 && daysRemaining <= 60 && (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 ${
                    daysRemaining <= 30
                      ? "bg-warning-subtle text-warning-subtle-foreground"
                      : "bg-info-subtle text-info-subtle-foreground"
                  }`}
                >
                  {t("settings:limits.day_left", { days: daysRemaining })}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Desktop Layout */}
        <div className="hidden sm:flex sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center">
              {isComplete && <Icons.CheckCircle className="text-success me-2 h-5 w-5" />}
              {isOverLimit && <Icons.AlertTriangle className="text-destructive me-2 h-5 w-5" />}
              <CardTitle className="text-lg">
                <LimitLink to={detailsPath}>{limit.groupName}</LimitLink>
              </CardTitle>
            </div>

            {limit.startDate && limit.endDate && (
              <div className="text-muted-foreground flex items-center text-xs">
                <Icons.Calendar className="me-1 h-3 w-3" />
                <span>
                  {formatLimitDate(limit.startDate)} → {formatLimitDate(limit.endDate)}
                </span>
                {daysRemaining !== null && daysRemaining > 0 && daysRemaining <= 60 && (
                  <span
                    className={`ms-2 rounded-full px-2 py-0.5 text-xs ${
                      daysRemaining <= 30
                        ? "bg-warning-subtle text-warning-subtle-foreground"
                        : "bg-info-subtle text-info-subtle-foreground"
                    }`}
                  >
                    {t("settings:limits_days_left", { days: daysRemaining })}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center space-x-2">
            {!isLoading && (
              <div className="flex flex-col items-end">
                <div className="flex items-baseline space-x-1">
                  <span
                    className={`text-lg font-bold ${
                      isOverLimit ? "text-destructive" : isComplete ? "text-success" : ""
                    }`}
                  >
                    {isComplete
                      ? amountFormatting.formatAmount(limit.limitAmount, baseCurrency)
                      : isOverLimit
                        ? `${amountFormatting.formatAmount(progressValue, baseCurrency)}`
                        : `${amountFormatting.formatAmount(progressValue, baseCurrency)}`}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    / {amountFormatting.formatAmount(limit.limitAmount, baseCurrency)}
                  </span>
                </div>
                <span className="text-muted-foreground text-end text-xs">
                  {isComplete
                    ? t("settings:limits_completed")
                    : isOverLimit
                      ? t("settings:limits_over_limit", {
                          amount: amountFormatting.formatAmount(overLimitAmount, baseCurrency),
                        })
                      : `${limit.contributionYear}`}
                </span>
              </div>
            )}

            <div className="relative">
              <ContributionLimitOperations limit={limit} onEdit={onEdit} onDelete={onDelete} />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-4 w-full" />
        ) : (
          // Clicks pass through to the card's link.
          <div
            className="bg-muted pointer-events-none overflow-hidden rounded-full"
            role="progressbar"
            aria-label={limit.groupName}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(progressPercentageNumber, 100))}
          >
            <ProgressBar
              progress={progressPercentageNumber / 100}
              fillClass={isOverLimit ? "bg-destructive" : isComplete ? "bg-success" : "bg-primary"}
            />
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-3">
          {limitAccounts.length ? (
            <ul
              className="flex min-w-0 flex-wrap gap-1.5"
              aria-label={t("settings:limits_form_accounts_label")}
            >
              {limitAccounts.slice(0, MAX_ACCOUNT_BADGES).map((account) => (
                <li key={account.id}>
                  <Badge variant="outline">
                    <bdi>{account.name}</bdi>
                  </Badge>
                </li>
              ))}
              {limitAccounts.length > MAX_ACCOUNT_BADGES && (
                <li>
                  <Badge variant="outline" className="text-muted-foreground">
                    {t("settings:limits_accounts_more", {
                      number: limitAccounts.length - MAX_ACCOUNT_BADGES,
                    })}
                  </Badge>
                </li>
              )}
            </ul>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-sm">
                {t("settings:limits_no_accounts_selected")}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="relative"
                onClick={() => onEdit(limit)}
              >
                {t("settings:limits_choose_accounts")}
              </Button>
            </div>
          )}
          <Icons.ChevronRight
            className="text-muted-foreground size-4 shrink-0 rtl:rotate-180"
            aria-hidden="true"
          />
        </div>
      </CardContent>
    </Card>
  );
}

const MAX_ACCOUNT_BADGES = 3;

/** The title's link covers the card; the actions above it stay clickable. */
function LimitLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="focus-visible:ring-ring rounded-sm after:absolute after:inset-0 focus-visible:ring-2 focus-visible:outline-none"
    >
      {children}
    </Link>
  );
}

ContributionLimitItem.Skeleton = function ContributionLimitItemSkeleton() {
  return (
    <div className="p-4">
      <div className="space-y-3">
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    </div>
  );
};
