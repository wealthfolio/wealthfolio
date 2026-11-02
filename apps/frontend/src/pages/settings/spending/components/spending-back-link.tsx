import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useBackNavigation } from "@/pages/layouts/mobile-stack/use-mobile-stack";
import { Icons } from "@wealthfolio/ui";

export function SpendingBackLink() {
  const { t } = useTranslation();
  // On a phone screen stacked over Spending, step back to it rather than
  // opening Spending again on top.
  const goBack = useBackNavigation("/settings/spending");

  return (
    <Link
      to="/settings/spending"
      onClick={(event) => {
        event.preventDefault();
        goBack();
      }}
      className="text-muted-foreground hover:text-foreground hidden items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline sm:inline-flex"
    >
      <Icons.ArrowLeft className="h-4 w-4 rtl:rotate-180" />
      {t("settings:spending.back_to_tracker")}
    </Link>
  );
}
