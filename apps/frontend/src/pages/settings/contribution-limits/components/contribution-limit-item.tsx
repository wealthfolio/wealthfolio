import { Account, ContributionLimit } from "@/lib/types";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Icons,
  Progress,
  Skeleton,
  formatAmount,
} from "@wealthfolio/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useContributionLimitProgress } from "../use-contribution-limit-mutations";
import { AccountSelection } from "./account-selection";
import { ContributionLimitOperations } from "./contribution-limit-operations";

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
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (!limit.accountIds || limit.accountIds.length === 0) {
      setIsExpanded(true);
    }
  }, []);

  const toggleExpanded = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded(!isExpanded);
  };

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
      className={`w-full ${progressPercentageNumber === 100 ? "border-success/20 bg-success/10 shadow-sm" : isOverLimit ? "border-destructive/20 bg-destructive/10 shadow-sm" : ""}`}
    >
      <CardHeader className="cursor-pointer pb-3" onClick={toggleExpanded}>
        {/* Mobile Layout */}
        <div className="flex flex-col gap-2 sm:hidden">
          {/* Row 1: Title + Actions */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isComplete && <Icons.CheckCircle className="text-success h-5 w-5 shrink-0" />}
              {isOverLimit && <Icons.AlertTriangle className="text-destructive h-5 w-5 shrink-0" />}
              <CardTitle className="text-base">{limit.groupName}</CardTitle>
            </div>
            <div className="flex items-center">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleExpanded}>
                <Icons.ChevronDown
                  className={`h-4 w-4 transition-transform duration-300 ${isExpanded ? "rotate-180" : ""}`}
                />
              </Button>
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
                  {formatAmount(progressValue, baseCurrency)}
                </span>
                <span className="text-muted-foreground text-sm">
                  / {formatAmount(limit.limitAmount, baseCurrency)}
                </span>
              </div>
              {isComplete && (
                <span className="text-success text-xs">✓ {t("settings:limits_limit_reached")}</span>
              )}
              {isOverLimit && (
                <span className="text-destructive text-xs">
                  {t("settings:limits_over_limit", {
                    amount: formatAmount(overLimitAmount, baseCurrency),
                  })}
                </span>
              )}
              {!isComplete && !isOverLimit && (
                <span className="text-muted-foreground text-xs">
                  {t("settings:limits_remaining", {
                    amount: formatAmount(remainingAmount, baseCurrency),
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
                {new Date(limit.startDate).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}{" "}
                →{" "}
                {new Date(limit.endDate).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              {daysRemaining !== null && daysRemaining > 0 && daysRemaining <= 60 && (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 ${
                    daysRemaining <= 30 ? "bg-amber-100 text-amber-800" : "bg-blue-50 text-blue-700"
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
              {isComplete && <Icons.CheckCircle className="text-success mr-2 h-5 w-5" />}
              {isOverLimit && <Icons.AlertTriangle className="text-destructive mr-2 h-5 w-5" />}
              <CardTitle className="text-lg">{limit.groupName}</CardTitle>
            </div>

            {limit.startDate && limit.endDate && (
              <div className="text-muted-foreground flex items-center text-xs">
                <Icons.Calendar className="mr-1 h-3 w-3" />
                <span>
                  {new Date(limit.startDate).toLocaleDateString()} →{" "}
                  {new Date(limit.endDate).toLocaleDateString()}
                </span>
                {daysRemaining !== null && daysRemaining > 0 && daysRemaining <= 60 && (
                  <span
                    className={`ml-2 rounded-full px-2 py-0.5 text-xs ${
                      daysRemaining <= 30
                        ? "bg-amber-100 text-amber-800"
                        : "bg-blue-50 text-blue-700"
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
                      ? formatAmount(limit.limitAmount, baseCurrency)
                      : isOverLimit
                        ? `${formatAmount(progressValue, baseCurrency)}`
                        : `${formatAmount(progressValue, baseCurrency)}`}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    / {formatAmount(limit.limitAmount, baseCurrency)}
                  </span>
                </div>
                <span className="text-muted-foreground text-right text-xs">
                  {isComplete
                    ? t("settings:limits_completed")
                    : isOverLimit
                      ? t("settings:limits_over_limit", {
                          amount: formatAmount(overLimitAmount, baseCurrency),
                        })
                      : `${limit.contributionYear}`}
                </span>
              </div>
            )}

            <div className="flex items-center space-x-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleExpanded}>
                <Icons.ChevronDown
                  className={`h-4 w-4 transition-transform duration-300 ${isExpanded ? "rotate-180" : ""}`}
                />
              </Button>

              <ContributionLimitOperations limit={limit} onEdit={onEdit} onDelete={onDelete} />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-4 w-full" />
        ) : (
          <Progress
            value={progressPercentageNumber > 100 ? 100 : progressPercentageNumber}
            className={`w-full ${isOverLimit ? "bg-destructive/20" : ""}`}
          />
        )}
        {isExpanded && (
          <div className="mt-4 border-t pt-4">
            <AccountSelection
              limit={limit}
              accounts={accounts}
              deposits={progress}
              isLoading={isLoading}
            />
          </div>
        )}
      </CardContent>
    </Card>
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
