import { Badge, Button, Card, CardContent, Icons, useAmountFormatting } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { useSettingsContext } from "@/lib/settings-provider";
import type { Account } from "@/lib/types";
import type { ProjectedContributionLimit } from "../contribution-limit-projection";

interface ContributionLimitProjectedItemProps {
  limit: ProjectedContributionLimit;
  accounts: Pick<Account, "id" | "name">[];
  onAdd: (limit: ProjectedContributionLimit) => void;
}

export function ContributionLimitProjectedItem({
  limit,
  accounts,
  onAdd,
}: ContributionLimitProjectedItemProps) {
  const { t } = useTranslation();
  const amountFormatting = useAmountFormatting();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const accountIds = (limit.accountIds ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const accountNames = accountIds.length
    ? accountIds.map((id) => accounts.find((account) => account.id === id)?.name ?? id).join(", ")
    : t("settings:limits_no_accounts_selected");

  return (
    <Card className="border-border/60 w-full border-dashed">
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{limit.groupName}</span>
            <span className="text-muted-foreground tabular-nums">{limit.contributionYear}</span>
            <Badge variant="outline">{t("settings:limits_projected_badge")}</Badge>
          </div>
          <p className="text-muted-foreground text-sm break-words">
            <bdi>{accountNames}</bdi>
          </p>
          <p className="text-muted-foreground text-sm">
            {amountFormatting.formatAmount(limit.limitAmount, baseCurrency)}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("settings:limits_projected_description", {
              year: limit.sourceYear ?? limit.contributionYear - 1,
            })}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => onAdd(limit)}
          aria-label={t("settings:limits_projected_add_aria", {
            group: limit.groupName,
            year: limit.contributionYear,
            accounts: accountNames,
          })}
        >
          <Icons.Plus className="me-2 h-4 w-4" />
          {t("settings:limits_projected_add_button")}
        </Button>
      </CardContent>
    </Card>
  );
}
