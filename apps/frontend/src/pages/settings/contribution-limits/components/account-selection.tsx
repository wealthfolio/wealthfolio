import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Toggle } from "@wealthfolio/ui/components/ui/toggle";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Account, ContributionLimit, DepositsCalculation } from "@/lib/types";
import { AccountPurpose, accountSupportsPurpose } from "@/lib/constants";
import { useContributionLimitMutations } from "../use-contribution-limit-mutations";
import { formatAmount } from "@wealthfolio/ui";

interface AccountSelectionProps {
  limit: ContributionLimit;
  accounts: Account[];
  deposits: DepositsCalculation | undefined;
  isLoading: boolean;
}

export function AccountSelection({ limit, accounts, deposits, isLoading }: AccountSelectionProps) {
  const { t } = useTranslation();
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>(
    limit.accountIds ? limit.accountIds.split(",") : [],
  );
  const { updateContributionLimitMutation } = useContributionLimitMutations();

  const handleAccountToggle = (accountId: string) => {
    setSelectedAccounts((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId],
    );
  };

  const handleSave = () => {
    updateContributionLimitMutation.mutate({
      id: limit.id,
      updatedLimit: {
        ...limit,
        accountIds: selectedAccounts.join(","),
      },
    });
  };

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">{t("settings:limits_select_accounts")}</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        {accounts
          ?.filter(
            (account) =>
              account.isActive &&
              accountSupportsPurpose(account, AccountPurpose.CONTRIBUTION_LIMITS),
          )
          .map((account) => {
            const accountDeposit = deposits?.byAccount[account.id];
            return (
              <Toggle
                key={account.id}
                pressed={selectedAccounts.includes(account.id)}
                onPressedChange={() => handleAccountToggle(account.id)}
                variant="outline"
                className="w-full justify-start space-x-2 px-3 py-8"
              >
                <div className="flex w-full items-center">
                  <div className="mr-2">
                    {selectedAccounts.includes(account.id) ? (
                      <Icons.CheckCircle className="text-success h-6 w-6" />
                    ) : (
                      <Icons.Circle className="h-6 w-6" />
                    )}
                  </div>
                  <div className="flex flex-col items-start">
                    <span className="font-medium">{account.name}</span>
                    {isLoading ? (
                      <span className="text-muted-foreground text-xs">
                        {t("settings:limits_loading")}
                      </span>
                    ) : accountDeposit ? (
                      <span className="text-muted-foreground text-xs font-light">
                        {formatAmount(accountDeposit.convertedAmount, deposits.baseCurrency)}{" "}
                        {t("settings:limits_contributed")}
                      </span>
                    ) : null}
                  </div>
                </div>
              </Toggle>
            );
          })}
      </div>
      <Button
        onClick={handleSave}
        className="mt-4"
        disabled={updateContributionLimitMutation.isPending}
      >
        {updateContributionLimitMutation.isPending
          ? t("settings:limits_saving")
          : t("settings:limits_save_selected_accounts")}
      </Button>
    </div>
  );
}
