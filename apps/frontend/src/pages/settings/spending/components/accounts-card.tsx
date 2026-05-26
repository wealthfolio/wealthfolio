import { useMemo } from "react";

import { BankIcon } from "@phosphor-icons/react/dist/csr/Bank";
import { CreditCardIcon } from "@phosphor-icons/react/dist/csr/CreditCard";

import { useAccounts } from "@/hooks/use-accounts";
import type { Account } from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
  Switch,
} from "@wealthfolio/ui";

import {
  useSpendingSettings,
  useSpendingSettingsMutation,
} from "@/features/spending/hooks/use-spending-settings";
import { isCreditCardAccountType, isSpendingAccountType } from "@/features/spending/lib/constants";
import { AccountType } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function AccountsCard() {
  const { settings } = useSpendingSettings();
  const mutation = useSpendingSettingsMutation();
  const { accounts } = useAccounts({ filterActive: false });

  const accountIds = useMemo(() => settings?.accountIds ?? [], [settings?.accountIds]);

  const spendingAccounts = useMemo<Account[]>(
    () =>
      (accounts ?? [])
        .filter((a) => isSpendingAccountType(a.accountType))
        .sort((a, b) => {
          // Tracked first, then active, then name
          const aTracked = accountIds.includes(a.id) ? 0 : 1;
          const bTracked = accountIds.includes(b.id) ? 0 : 1;
          if (aTracked !== bTracked) return aTracked - bTracked;
          if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
    [accounts, accountIds],
  );

  const includedAccounts = useMemo(
    () => spendingAccounts.filter((a) => accountIds.includes(a.id)),
    [spendingAccounts, accountIds],
  );

  const hasMixedCashAndCredit = useMemo(() => {
    const hasCash = includedAccounts.some((a) => a.accountType === AccountType.CASH);
    const hasCredit = includedAccounts.some((a) => isCreditCardAccountType(a.accountType));
    return hasCash && hasCredit;
  }, [includedAccounts]);

  const handleToggle = (id: string, next: boolean) => {
    const nextIds = next
      ? Array.from(new Set([...accountIds, id]))
      : accountIds.filter((x) => x !== id);
    mutation.mutate({ accountIds: nextIds });
  };

  return (
    <Card className="rounded-lg">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 p-6 pb-4">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-base font-semibold tracking-tight">
            Spending accounts
          </CardTitle>
          <CardDescription className="text-xs">
            Cash and credit card accounts that participate in spending. Investment accounts are
            excluded automatically.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="p-6 pt-0">
        {spendingAccounts.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed py-8 text-center text-xs">
            No cash or credit card accounts found. Create one in Settings → Accounts.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {spendingAccounts.map((account) => {
              const tracked = accountIds.includes(account.id);
              const isCredit = isCreditCardAccountType(account.accountType);
              const typeLabel = isCredit ? "Credit card" : "Cash";
              const TypeIcon = isCredit ? CreditCardIcon : BankIcon;
              return (
                <div
                  key={account.id}
                  className={cn(
                    "grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-md border px-4 py-3.5 transition-colors",
                    tracked
                      ? "bg-muted/30 border-border"
                      : "border-border border-dashed bg-transparent opacity-80",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-md border",
                      tracked
                        ? "bg-background border-border text-foreground"
                        : "border-border/60 text-muted-foreground bg-transparent",
                    )}
                  >
                    <TypeIcon size={18} weight="duotone" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{account.name}</span>
                      {!account.isActive && (
                        <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider">
                          Inactive
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-xs">
                      {typeLabel} · {account.currency}
                      {account.group ? ` · ${account.group}` : ""}
                      {!tracked && " · not tracked"}
                    </div>
                  </div>
                  <Switch
                    size="sm"
                    checked={tracked}
                    onCheckedChange={(next) => handleToggle(account.id, next)}
                    disabled={mutation.isPending}
                    aria-label={`${tracked ? "Stop tracking" : "Track"} ${account.name}`}
                    className="data-[state=checked]:bg-success data-[state=unchecked]:bg-muted-foreground/40"
                  />
                </div>
              );
            })}

            {hasMixedCashAndCredit && (
              <div className="text-warning border-warning/30 bg-warning/10 mt-3 flex gap-2 rounded-md border p-2.5 text-xs leading-relaxed">
                <Icons.AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>
                  Credit card payments from tracked cash accounts should be linked as transfers.
                  Unlinked payments can make both the card charge and cash payment count as
                  spending.
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
