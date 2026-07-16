import { calculateDepositsForLimit, getContributionLimit } from "@/adapters";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { Progress } from "@wealthfolio/ui/components/ui/progress";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { QueryKeys } from "@/lib/query-keys";
import { ContributionLimit, DepositsCalculation } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { PrivacyAmount } from "@wealthfolio/ui";
import { Trans, useTranslation } from "react-i18next";

interface AccountContributionLimitProps {
  accountId: string;
}

export function AccountContributionLimit({ accountId }: AccountContributionLimitProps) {
  const currentYear = new Date().getFullYear();

  const { data: allLimits, isLoading: isLimitsLoading } = useQuery<ContributionLimit[], Error>({
    queryKey: [QueryKeys.CONTRIBUTION_LIMITS],
    queryFn: getContributionLimit,
  });

  const limitForAccount = allLimits?.find(
    (limit) => limit.accountIds?.includes(accountId) && limit.contributionYear === currentYear,
  );
  const limitForAccountId = limitForAccount?.id;

  const { data: deposits, isLoading: isDepositsLoading } = useQuery<DepositsCalculation, Error>({
    queryKey: [QueryKeys.CONTRIBUTION_LIMIT_PROGRESS, accountId, currentYear, limitForAccountId],
    queryFn: () => calculateDepositsForLimit(limitForAccountId!),
    enabled: !isLimitsLoading && !!limitForAccountId,
  });

  if (isLimitsLoading) {
    return <AccountContributionLimit.Skeleton />;
  }

  if (!limitForAccount) {
    return null;
  }

  if (isDepositsLoading) {
    return <AccountContributionLimit.Skeleton />;
  }

  return (
    <div className="space-y-4">
      <AccountContributionLimitItem
        key={limitForAccount.id}
        limit={limitForAccount}
        totalDeposits={deposits?.total ?? 0}
        baseCurrency={deposits?.baseCurrency ?? "USD"}
      />
    </div>
  );
}

function AccountContributionLimitItem({
  limit,
  totalDeposits,
  baseCurrency,
}: {
  limit: ContributionLimit;
  totalDeposits: number;
  baseCurrency: string;
}) {
  const { t } = useTranslation();
  const progressValue = totalDeposits ? totalDeposits : 0;
  const progressPercentageNumber =
    limit.limitAmount > 0 ? (progressValue / limit.limitAmount) * 100 : 0;
  const remainingAmount = limit.limitAmount - progressValue;
  const isOverLimit = remainingAmount < 0;
  const isAtLimit = remainingAmount === 0;
  const statusClassName = isOverLimit
    ? "text-destructive"
    : isAtLimit
      ? "text-success"
      : "text-muted-foreground";
  const groupName = limit.groupName.replace(new RegExp(`^${limit.contributionYear}\\s+`, "i"), "");

  return (
    <Card
      className={`border-none shadow-sm ${
        isOverLimit ? "border-destructive/20 bg-destructive/10" : isAtLimit ? "bg-success/10" : ""
      }`}
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {t("account:contribution.year_limit", {
                year: limit.contributionYear,
                group: groupName,
              })}
            </p>
            <p className="text-muted-foreground text-xs">
              <Trans
                i18nKey="account:contribution.used"
                components={{
                  used: <PrivacyAmount value={progressValue} currency={baseCurrency} />,
                  limit: <PrivacyAmount value={limit.limitAmount} currency={baseCurrency} />,
                }}
              />
            </p>
          </div>
          <div className={`shrink-0 text-right text-xs font-semibold ${statusClassName}`}>
            {isOverLimit ? (
              <Trans
                i18nKey="account:contribution.over_by"
                components={{
                  amount: (
                    <PrivacyAmount value={Math.abs(remainingAmount)} currency={baseCurrency} />
                  ),
                }}
              />
            ) : isAtLimit ? (
              t("account:contribution.limit_reached")
            ) : (
              <Trans
                i18nKey="account:contribution.left"
                components={{
                  amount: <PrivacyAmount value={remainingAmount} currency={baseCurrency} />,
                }}
              />
            )}
          </div>
        </div>
        <Progress value={Math.min(progressPercentageNumber, 100)} className="w-full" />
      </CardContent>
    </Card>
  );
}

AccountContributionLimit.Skeleton = function AccountContributionLimitSkeleton() {
  return (
    <div className="space-y-4">
      <Card className="border-none shadow-sm">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-2 w-full" />
        </CardContent>
      </Card>
    </div>
  );
};
