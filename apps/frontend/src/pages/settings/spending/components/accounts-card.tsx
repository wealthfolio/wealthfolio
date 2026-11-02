import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useAccounts } from "@/hooks/use-accounts";
import { useNameComparator } from "@/hooks/use-name-comparator";
import type { Account } from "@/lib/types";
import {
  Badge,
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
import { SettingsList, SettingsListMedia, SettingsListRow } from "@/components/settings-list";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";

export function AccountsCard() {
  const { t } = useTranslation();
  const compareNames = useNameComparator();
  const { settings } = useSpendingSettings();
  const mutation = useSpendingSettingsMutation();
  const { accounts } = useAccounts({ filterActive: false });

  const accountIds = useMemo(() => settings?.accountIds ?? [], [settings?.accountIds]);
  const initialAccountIdsRef = useRef<string[] | null>(null);
  if (settings && initialAccountIdsRef.current === null) {
    initialAccountIdsRef.current = settings.accountIds;
  }
  // Initial load groups tracked accounts first; later toggle changes should not move rows.
  const sortAccountIds = initialAccountIdsRef.current ?? accountIds;

  const spendingAccounts = useMemo<Account[]>(() => {
    const initiallyTracked = new Set(sortAccountIds);
    return (accounts ?? [])
      .filter((a) => isSpendingAccountType(a.accountType))
      .sort((a, b) => {
        const aTracked = initiallyTracked.has(a.id) ? 0 : 1;
        const bTracked = initiallyTracked.has(b.id) ? 0 : 1;
        if (aTracked !== bTracked) return aTracked - bTracked;
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return compareNames(a.name, b.name);
      });
  }, [accounts, sortAccountIds, compareNames]);

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
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-lg">
          {t("settings:spending.accounts.title")}
        </CardTitle>
        <CardDescription>{t("settings:spending.accounts.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {spendingAccounts.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t("settings:spending.accounts.empty")}
          </p>
        ) : (
          <>
            <SettingsList label={t("settings:spending.accounts.title")}>
              {spendingAccounts.map((account) => {
                const tracked = accountIds.includes(account.id);
                const isCredit = isCreditCardAccountType(account.accountType);
                const typeLabel = isCredit
                  ? t("settings:spending.accounts.type_credit_card")
                  : t("settings:spending.accounts.type_cash");
                const TypeIcon = isCredit ? Icons.CreditCard : Icons.Wallet;
                return (
                  <li key={account.id}>
                    <SettingsListRow
                      inactive={!tracked}
                      media={
                        <SettingsListMedia>
                          <TypeIcon weight="duotone" />
                        </SettingsListMedia>
                      }
                      title={account.name}
                      badges={
                        !account.isActive && (
                          <Badge variant="secondary">
                            {t("settings:spending.accounts.inactive_badge")}
                          </Badge>
                        )
                      }
                      meta={
                        <>
                          {typeLabel} · {account.currency}
                          {account.group ? ` · ${account.group}` : ""}
                          {!tracked && ` · ${t("settings:spending.accounts.not_tracked")}`}
                        </>
                      }
                      actions={
                        <Switch
                          checked={tracked}
                          onCheckedChange={(next) => handleToggle(account.id, next)}
                          disabled={mutation.isPending}
                          aria-label={
                            tracked
                              ? t("settings:spending.accounts.stop_tracking_aria", {
                                  name: account.name,
                                })
                              : t("settings:spending.accounts.track_aria", { name: account.name })
                          }
                        />
                      }
                    />
                  </li>
                );
              })}
            </SettingsList>

            {hasMixedCashAndCredit && (
              <Alert variant="warning" className="mt-4 p-2.5 text-xs">
                <Icons.AlertTriangle className="size-3.5" />
                <AlertDescription className="leading-relaxed">
                  {t("settings:spending.accounts.mixed_warning")}
                </AlertDescription>
              </Alert>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
