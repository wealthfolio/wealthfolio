import { AccountValuation, PerformanceMetrics } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import { PerformanceGrid } from "@/pages/account/performance-grid";
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  GainAmount,
  GainPercent,
  Icons,
  MoneyInput,
  PrivacyAmount,
  Separator,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui";
import React, { useState } from "react";

import { useBalanceUpdate } from "./use-balance-update";

interface EditableBalanceProps {
  account: AccountValuation;
  initialBalance: number;
  currency: string;
}

const EditableBalance: React.FC<EditableBalanceProps> = ({ account, initialBalance, currency }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [balance, setBalance] = useState(initialBalance);
  const { updateBalance, isPending } = useBalanceUpdate(account);

  const handleSave = () => {
    updateBalance(balance);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-2">
        <MoneyInput value={balance} onValueChange={(value) => setBalance(value ?? 0)} />
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending ? (
            <Icons.Spinner className="h-4 w-4 animate-spin" />
          ) : (
            <Icons.Check className="h-4 w-4" />
          )}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setIsEditing(false)}>
          <Icons.Close className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="flex cursor-pointer items-center gap-2 text-lg font-extrabold"
            onClick={() => setIsEditing(true)}
          >
            <PrivacyAmount value={initialBalance} currency={currency} />
            <Icons.Pencil className="text-muted-foreground h-4 w-4 cursor-pointer" />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>Click to update the cash balance</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

interface AccountMetricsProps {
  valuation?: AccountValuation | null;
  performance?: PerformanceMetrics | null;
  className?: string;
  isLoading?: boolean;
  isPerformanceLoading?: boolean;
  performanceError?: string;
  /** If true, hides the inline balance edit (HOLDINGS mode accounts should use the Update Holdings sheet) */
  hideBalanceEdit?: boolean;
  balanceLabel?: string;
  /** If true, shows only Volatility/MaxDrawdown and hides flow-adjusted returns. */
  isHoldingsMode?: boolean;
}

const AccountMetrics: React.FC<AccountMetricsProps> = ({
  valuation,
  performance,
  className,
  isLoading,
  isPerformanceLoading,
  performanceError,
  hideBalanceEdit = false,
  balanceLabel = "Cash Balance",
  isHoldingsMode = false,
}) => {
  // Full skeleton only when valuation data itself is loading
  if (isLoading || !valuation)
    return (
      <Card className={className}>
        <CardHeader className="flex flex-row items-center justify-between">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-7 w-24" />
        </CardHeader>
        <CardContent className="space-y-6">
          <Separator className="mb-4" />
          <div className="space-y-4 text-sm">
            <div className="flex justify-between">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-24" />
            </div>
            <div className="flex justify-between">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-24" />
            </div>
            <div className="flex justify-between">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-24" />
            </div>
          </div>

          <PerformanceGrid isLoading={true} />
        </CardContent>
        <CardFooter className="flex justify-end px-3 pb-0">
          <Skeleton className="h-3 w-48" />
        </CardFooter>
      </Card>
    );

  const displayCurrency = valuation?.accountCurrency || valuation?.baseCurrency;

  // Calculate Unrealized P&L for Holdings mode
  // Use investmentMarketValue (not totalValue) to exclude cash from P&L calculation
  const unrealizedPnL = (valuation?.investmentMarketValue || 0) - (valuation?.costBasis || 0);
  const unrealizedPnLPercent =
    valuation?.costBasis && valuation.costBasis !== 0
      ? (unrealizedPnL / valuation.costBasis) * 100
      : 0;

  // Different rows for Holdings vs Transactions mode
  const rows = isHoldingsMode
    ? [
        {
          label: "Investments",
          value: (
            <PrivacyAmount
              value={valuation?.investmentMarketValue || 0}
              currency={displayCurrency}
            />
          ),
        },
        {
          label: "Cost Basis",
          value: <PrivacyAmount value={valuation?.costBasis || 0} currency={displayCurrency} />,
        },
        {
          label: "Unrealized P&L",
          value: (
            <span className="flex items-center gap-1">
              <GainAmount value={unrealizedPnL} currency={displayCurrency} className="text-sm" />
              <GainPercent value={unrealizedPnLPercent / 100} variant="badge" className="text-xs" />
            </span>
          ),
        },
      ]
    : [
        {
          label: "Investments",
          value: (
            <PrivacyAmount
              value={valuation?.investmentMarketValue || 0}
              currency={displayCurrency}
            />
          ),
        },
        {
          label: "Net Contribution",
          value: (
            <PrivacyAmount value={valuation?.netContribution || 0} currency={displayCurrency} />
          ),
        },
        {
          label: "Cost Basis",
          value: <PrivacyAmount value={valuation?.costBasis || 0} currency={displayCurrency} />,
        },
      ];

  const formattedStartDate = performance ? formatDate(performance.periodStartDate || "") : "";
  const formattedEndDate = performance ? formatDate(performance.periodEndDate || "") : "";
  const lastUpdated = valuation?.calculatedAt ? formatDate(valuation.calculatedAt) : null;

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg font-bold">{balanceLabel}</CardTitle>
        {valuation && !hideBalanceEdit ? (
          <EditableBalance
            account={valuation}
            initialBalance={valuation?.cashBalance || 0}
            currency={displayCurrency}
          />
        ) : (
          <span className="text-lg font-extrabold">
            <PrivacyAmount value={valuation?.cashBalance || 0} currency={displayCurrency} />
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        <Separator className="mb-4" />
        <div className="space-y-4 text-sm">
          {rows.map(({ label, value }, idx) => (
            <div key={idx} className="flex justify-between">
              <span className="text-muted-foreground">{label}</span>
              <span className={`font-medium`}>{value}</span>
            </div>
          ))}
        </div>

        <PerformanceGrid
          performance={performance}
          isLoading={isPerformanceLoading}
          performanceError={performanceError}
          isHoldingsMode={isHoldingsMode}
        />
      </CardContent>
      <CardFooter className="mt-auto flex flex-col items-start gap-1 px-3">
        {performanceError ? (
          <p className="text-muted-foreground m-0 p-0 text-xs">
            {lastUpdated && <>Last updated: {lastUpdated}</>}
          </p>
        ) : isHoldingsMode ? (
          <>
            <p className="text-muted-foreground m-0 p-0 text-xs">
              Flow-adjusted returns require transaction tracking.
            </p>
            {lastUpdated && (
              <p className="text-muted-foreground m-0 p-0 text-xs">Last updated: {lastUpdated}</p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground m-0 p-0 text-xs">
            From {formattedStartDate} to {formattedEndDate}
          </p>
        )}
      </CardFooter>
    </Card>
  );
};

export default AccountMetrics;
