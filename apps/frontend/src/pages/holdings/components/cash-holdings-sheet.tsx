import { getAssetHoldingsScope } from "@/adapters";
import { CategoryAvatar } from "@/components/financial/category-avatar";
import { CompactAmount } from "@/components/financial/compact-amount";
import { CARD_LABEL } from "@/components/financial/styles";
import { HoldingsScopeNotice } from "@/components/holdings-scope-notice";
import { CASH_INSTRUMENT_ID_PREFIX, HoldingType } from "@/lib/constants";
import { sumAmounts } from "@/lib/monetary-value";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, AccountScope } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { Button, Icons, Skeleton, useNumberFormatting } from "@wealthfolio/ui";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { isHoldingsScopeReady } from "@/lib/holdings-scope";

interface CashHoldingsSheetProps {
  currency: string;
  accountFilter: AccountScope;
  accounts: Account[];
  onClose: () => void;
  finalFocus?: () => HTMLElement | null;
}

interface CashAccountBalance {
  accountId: string;
  name: string;
  amount: number | null;
}

export function CashHoldingsSheet({
  currency,
  accountFilter,
  accounts,
  onClose,
  finalFocus,
}: CashHoldingsSheetProps) {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const formatting = useNumberFormatting();
  const assetId = `${CASH_INSTRUMENT_ID_PREFIX}${currency}`;
  const {
    data: scope,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: [QueryKeys.ASSET_HOLDINGS, assetId, accountFilter],
    queryFn: () => getAssetHoldingsScope(assetId, accountFilter),
  });
  const isComplete =
    scope !== undefined && !isError && isHoldingsScopeReady(scope.incompleteAccounts);
  const balancesByAccount = new Map<string, CashAccountBalance>();
  for (const row of scope?.holdings ?? []) {
    if (row.holdingType !== HoldingType.CASH || row.localCurrency !== currency) continue;
    const existing = balancesByAccount.get(row.accountId);
    if (existing) existing.amount = sumAmounts([existing.amount, row.marketValue.local]);
    else
      balancesByAccount.set(row.accountId, {
        accountId: row.accountId,
        name: accounts.find((account) => account.id === row.accountId)?.name ?? row.accountId,
        amount: row.marketValue.local,
      });
  }
  const balances = [...balancesByAccount.values()].sort(
    (a, b) => (b.amount ?? 0) - (a.amount ?? 0) || a.name.localeCompare(b.name),
  );
  const total = sumAmounts(balances.map((balance) => balance.amount));
  const showShares =
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
        className="flex w-full flex-col overflow-hidden sm:max-w-md"
        initialFocus={titleRef}
        finalFocus={finalFocus}
      >
        <SheetHeader className="mt-4">
          <SheetTitle
            ref={titleRef}
            tabIndex={-1}
            className="flex items-center gap-2.5 outline-none"
          >
            <CategoryAvatar category="cash" />
            {t("holdings:cash_with_currency", { currency })}
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto py-4">
          <HoldingsScopeNotice
            isComplete={isComplete}
            isLoading={isLoading}
            isError={isError}
            incompleteAccounts={scope?.incompleteAccounts}
          />
          {isError && (
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              {t("common:retry")}
            </Button>
          )}
          {isLoading ? (
            <div className="space-y-3" role="status" aria-label={t("common:loading")}>
              <Skeleton className="h-8 w-36" />
              {[1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-11 w-full" />
              ))}
            </div>
          ) : (
            <>
              <div
                role="group"
                className="text-2xl font-bold tabular-nums"
                aria-label={t("holdings:total")}
              >
                {isComplete && total != null ? (
                  <CompactAmount value={total} currency={currency} />
                ) : (
                  "—"
                )}
              </div>
              {balances.length > 0 && (
                <div>
                  <p className={`${CARD_LABEL} pb-1`}>
                    {t("insights:networth.category_sheet.items")}
                  </p>
                  <div className="divide-border/40 divide-y">
                    {balances.map((balance) => (
                      <Link
                        key={balance.accountId}
                        to={`/accounts/${encodeURIComponent(balance.accountId)}`}
                        onClick={onClose}
                        className="hover:bg-muted/50 focus-visible:ring-ring -mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2 outline-none focus-visible:ring-2 pointer-coarse:min-h-11"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <CategoryAvatar category="cash" />
                          <span className="text-foreground/90 min-w-0 truncate text-sm">
                            {balance.name}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-baseline gap-2.5">
                          {showShares && (
                            <span className="text-muted-foreground/60 text-xs tabular-nums">
                              {formatting.formatPercent((balance.amount ?? 0) / total, {
                                digits: 1,
                              })}
                            </span>
                          )}
                          <span className="text-foreground/90 text-sm tabular-nums">
                            {balance.amount != null ? (
                              <CompactAmount value={balance.amount} currency={currency} />
                            ) : (
                              "—"
                            )}
                          </span>
                          <Icons.ChevronRight
                            className="text-muted-foreground size-4 rtl:rotate-180"
                            aria-hidden
                          />
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {isComplete && balances.length === 0 && (
                <p className="text-muted-foreground py-4 text-center text-sm">
                  {t("holdings:no_holdings_selection")}
                </p>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
