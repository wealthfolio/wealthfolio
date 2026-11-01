import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { copyText } from "@wealthfolio/ui/lib/clipboard";
import { useTranslation } from "react-i18next";

import { maskAccountNumber } from "@/lib/account-number";
import type { Account } from "@/lib/types";

/**
 * The small line under the account's name: its currency when the account has
 * no group (the group sits beside the name instead), and the end of its number
 * with a button that copies the whole number.
 */
export function AccountHeaderDetails({
  account,
}: {
  account?: Pick<Account, "group" | "currency" | "accountNumber">;
}) {
  const { t } = useTranslation();
  const currency = !account?.group ? account?.currency : undefined;
  const maskedNumber = maskAccountNumber(account?.accountNumber);
  if (!currency && !maskedNumber) return null;

  const copyNumber = async () => {
    if (!account?.accountNumber) return;
    try {
      await copyText(account.accountNumber.trim());
      toast({ title: t("account:account_number_copied"), variant: "success" });
    } catch {
      toast({ title: t("account:account_number_copy_failed"), variant: "destructive" });
    }
  };

  return (
    <div className="text-muted-foreground flex items-center gap-1.5 text-xs leading-tight md:text-sm">
      {currency ? <span>{currency}</span> : null}
      {currency && maskedNumber ? <span aria-hidden="true">·</span> : null}
      {maskedNumber ? (
        <>
          <span dir="ltr" data-testid="account-header-number">
            {maskedNumber}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground -my-1 size-6"
            aria-label={t("account:copy_account_number")}
            title={t("account:copy_account_number")}
            onClick={copyNumber}
          >
            <Icons.Copy className="size-3.5" aria-hidden="true" />
          </Button>
        </>
      ) : null}
    </div>
  );
}
