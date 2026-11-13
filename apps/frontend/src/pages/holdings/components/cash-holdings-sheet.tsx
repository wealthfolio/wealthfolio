import { getHoldingsList } from "@/adapters";
import { HoldingsScopeNotice } from "@/components/holdings-scope-notice";
import { TickerAvatar } from "@/components/ticker-avatar";
import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { HoldingType } from "@/lib/constants";
import { sumAmounts } from "@/lib/monetary-value";
import { QueryKeys } from "@/lib/query-keys";
import type { Holding, IncompleteHoldingsAccount } from "@/lib/types";
import { useQueries } from "@tanstack/react-query";
import {
  AmountDisplay,
  Button,
  Card,
  chartSliceColor,
  Skeleton,
  useNumberFormatting,
} from "@wealthfolio/ui";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui/components/ui/sheet";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

interface CashHoldingsSheetProps {
  holding: Holding;
  incompleteAccounts?: IncompleteHoldingsAccount[];
  onClose: () => void;
  finalFocus?: () => HTMLElement | null;
}

interface CashAccountBalance {
  accountId: string;
  name: string;
  amount: number | null;
}

// Mounted only while open: per-account reads share the ordinary holdings cache
// and its existing invalidation/pending-account refresh behavior.
export function CashHoldingsSheet({
  holding,
  incompleteAccounts = [],
  onClose,
  finalFocus,
}: CashHoldingsSheetProps) {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const { isBalanceHidden } = useBalancePrivacy();
  const formatting = useNumberFormatting();
  const { accounts } = useAccounts({ filterActive: false });
  const currency = holding.localCurrency;
  const accountIds = [
    ...new Set([
      ...(holding.sourceAccountIds?.length ? holding.sourceAccountIds : [holding.accountId]),
      ...incompleteAccounts.map((account) => account.accountId),
    ]),
  ].sort();
  const queries = useQueries({
    queries: accountIds.map((accountId) => {
      const filter = { type: "account", accountId } as const;
      return {
        queryKey: [QueryKeys.HOLDINGS, filter, { includeClosed: false }],
        queryFn: () => getHoldingsList(filter),
      };
    }),
  });
  const isLoading = queries.some((query) => query.isLoading);
  const isError = queries.some((query) => query.isError);
  const missingAccounts = [
    ...incompleteAccounts,
    ...queries.flatMap((query) => query.data?.incompleteAccounts ?? []),
  ];
  const isComplete = !isLoading && !isError && missingAccounts.length === 0;
  const balancesByAccount = new Map<string, CashAccountBalance>();
  for (const query of queries) {
    for (const row of query.data?.holdings ?? []) {
      if (row.holdingType !== HoldingType.CASH || row.localCurrency !== currency) continue;
      const existing = balancesByAccount.get(row.accountId);
      if (existing) {
        existing.amount = sumAmounts([existing.amount, row.marketValue.local]);
      } else {
        balancesByAccount.set(row.accountId, {
          accountId: row.accountId,
          name: accounts.find((account) => account.id === row.accountId)?.name ?? row.accountId,
          amount: row.marketValue.local,
        });
      }
    }
  }
  const balances = [...balancesByAccount.values()].sort(
    (a, b) => (b.amount ?? 0) - (a.amount ?? 0) || a.name.localeCompare(b.name),
  );
  const total = sumAmounts(balances.map((balance) => balance.amount));
  // A stacked allocation cannot represent debt or a net-zero cash balance.
  const showAllocation =
    isComplete &&
    total != null &&
    total > 0 &&
    balances.every((balance) => balance.amount != null && balance.amount >= 0);

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="flex w-full flex-col overflow-hidden sm:max-w-xl"
        initialFocus={titleRef}
        finalFocus={finalFocus}
      >
        <SheetHeader className="mt-4">
          <SheetTitle ref={titleRef} tabIndex={-1} className="outline-none">
            {t("holdings:cash_with_currency", { currency })}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto py-4">
          <HoldingsScopeNotice
            isComplete={isComplete}
            isLoading={isLoading}
            isError={isError}
            incompleteAccounts={missingAccounts}
          />
          {isError && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                queries.filter((query) => query.isError).forEach((query) => void query.refetch());
              }}
            >
              {t("common:retry")}
            </Button>
          )}

          {isLoading ? (
            <div className="space-y-3" role="status" aria-label={t("common:loading")}>
              <Skeleton className="h-24 w-full rounded-lg" />
              {[1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <>
              <Card className="space-y-3 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground text-sm">{t("holdings:total")}</span>
                  <AmountDisplay
                    value={isComplete ? total : null}
                    currency={currency}
                    isHidden={isBalanceHidden}
                    className="text-lg font-semibold"
                  />
                </div>
                {showAllocation && (
                  <div className="space-y-2">
                    <div className="flex h-5 overflow-hidden rounded" aria-hidden="true">
                      {balances.map((balance, index) => (
                        <div
                          key={balance.accountId}
                          className="border-background h-full border-e last:border-0"
                          style={{
                            width: `${((balance.amount ?? 0) / total) * 100}%`,
                            backgroundColor: chartSliceColor(index),
                          }}
                        />
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {balances.map((balance, index) => (
                        <div
                          key={balance.accountId}
                          className="flex min-w-0 items-center gap-1.5 text-xs"
                        >
                          <span
                            className="h-2.5 w-1 shrink-0 rounded-sm"
                            style={{ backgroundColor: chartSliceColor(index) }}
                          />
                          <span className="text-muted-foreground truncate">{balance.name}</span>
                          <span className="font-medium tabular-nums">
                            {formatting.formatPercent((balance.amount ?? 0) / total, { digits: 0 })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>

              <div className="space-y-2">
                <h3 className="text-sm font-medium">{t("holdings:account_allocation")}</h3>
                <div className="divide-y">
                  {balances.map((balance) => (
                    <div key={balance.accountId}>
                      <Link
                        to={`/accounts/${encodeURIComponent(balance.accountId)}`}
                        onClick={onClose}
                        className="hover:bg-muted/30 focus-visible:ring-ring -mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors outline-none focus-visible:ring-2"
                      >
                        <TickerAvatar symbol={`CASH:${currency}`} className="h-9 w-9" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">{balance.name}</p>
                          <p className="text-muted-foreground truncate text-xs">
                            {t("holdings:cash_with_currency", { currency })}
                          </p>
                        </div>
                        <div className="shrink-0 text-end">
                          <AmountDisplay
                            value={balance.amount}
                            currency={currency}
                            isHidden={isBalanceHidden}
                            className="text-sm font-medium"
                          />
                          {showAllocation && (
                            <p className="text-muted-foreground text-xs tabular-nums">
                              {formatting.formatPercent((balance.amount ?? 0) / total, {
                                digits: 1,
                              })}
                            </p>
                          )}
                        </div>
                      </Link>
                    </div>
                  ))}
                </div>
                {isComplete && balances.length === 0 && (
                  <p className="text-muted-foreground py-4 text-center text-sm">
                    {t("holdings:no_holdings_selection")}
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <SheetFooter className="border-t pt-4">
          <SheetClose render={<Button variant="outline" className="w-full" />}>
            {t("holdings:close")}
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
