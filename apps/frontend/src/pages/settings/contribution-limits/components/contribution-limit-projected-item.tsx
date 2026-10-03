import { Badge, Button, Card, CardContent, Icons, useAmountFormatting } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { useSettingsContext } from "@/lib/settings-provider";
import type { ProjectedContributionLimit } from "../contribution-limit-projection";

interface ContributionLimitProjectedItemProps {
  limit: ProjectedContributionLimit;
  onAdd: (limit: ProjectedContributionLimit) => void;
}

export function ContributionLimitProjectedItem({
  limit,
  onAdd,
}: ContributionLimitProjectedItemProps) {
  const { t } = useTranslation();
  const amountFormatting = useAmountFormatting();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  return (
    <Card className="border-border/60 w-full border-dashed">
      <CardContent className="flex items-center justify-between gap-4 p-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{limit.groupName}</span>
            <Badge variant="outline">{t("settings:limits_projected_badge")}</Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            {amountFormatting.formatAmount(limit.limitAmount, baseCurrency)}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("settings:limits_projected_description", {
              year: limit.sourceYear ?? limit.contributionYear - 1,
            })}
          </p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => onAdd(limit)}>
          <Icons.Plus className="mr-2 h-4 w-4" />
          {t("settings:limits_projected_add_button")}
        </Button>
      </CardContent>
    </Card>
  );
}
