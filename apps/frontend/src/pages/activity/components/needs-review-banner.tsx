import { Button, Icons } from "@wealthfolio/ui";
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
    <div className="border-warning/30 bg-warning/5 flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <Icons.AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm">
            {t("activity:needs_review_alert.title", { count: totalRowCount })}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("activity:needs_review_alert.description")}
          </p>
        </div>
      </div>
      <Button size="sm" className="shrink-0" onClick={onReview}>
        {t("activity:needs_review_alert.action")}
      </Button>
    </div>
  );
}
