import { Alert, AlertAction, AlertDescription, AlertTitle, Button, Icons } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { useActivitySearch } from "../hooks/use-activity-search";

interface NeedsReviewBannerProps {
  accountIds?: string[];
  onReview: () => void;
}

/**
 * Live warning driven by `activities.needs_review` - the source of truth.
 * It appears whenever flagged activities exist in the current account scope
 * (migration, imports, broker sync) and disappears on its own when the last
 * one is resolved, so it is never dismissed.
 */
export function NeedsReviewBanner({ accountIds, onReview }: NeedsReviewBannerProps) {
  const { t } = useTranslation(["activity"]);
  const { totalRowCount, isLoading } = useActivitySearch({
    mode: "paginated",
    filters: { accountIds, activityTypes: [], status: "pending" },
    searchQuery: "",
    sorting: [],
    pageIndex: 0,
    pageSize: 1,
  });

  if (isLoading || totalRowCount === 0) return null;

  return (
    <Alert variant="warning" role="status" className="px-3 py-2">
      <Icons.AlertTriangle />
      <AlertTitle className="font-normal">
        {t("activity:needs_review_alert.title", { count: totalRowCount })}
      </AlertTitle>
      <AlertDescription className="text-xs">
        {t("activity:needs_review_alert.description")}
      </AlertDescription>
      <AlertAction>
        <Button size="sm" onClick={onReview}>
          {t("activity:needs_review_alert.action")}
        </Button>
      </AlertAction>
    </Alert>
  );
}
