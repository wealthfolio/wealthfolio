import {
  useRecalculatePortfolioMutation,
  useUpdatePortfolioMutation,
} from "@/hooks/use-calculate-portfolio";
import { formatDateTime } from "@/lib/utils";
import { useDateFormatting, Spinner } from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@wealthfolio/ui/components/ui/hover-card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { ReactNode } from "react";
import { useTranslation } from "react-i18next";

// Rename interface
interface PortfolioUpdateTriggerProps {
  lastCalculatedAt: string | undefined;
  children: ReactNode;
  /** Informational notes about the displayed return (e.g. why TWR is unavailable for this scope). */
  notices?: string[];
}

// Rename function
export function PortfolioUpdateTrigger({
  lastCalculatedAt,
  children,
  notices = [],
}: PortfolioUpdateTriggerProps) {
  const dateFormatting = useDateFormatting();

  const { t } = useTranslation();
  // Instantiate the mutation hooks inside the component
  const updatePortfolioMutation = useUpdatePortfolioMutation();
  const recalculatePortfolioMutation = useRecalculatePortfolioMutation();
  const formattedLastCalculatedAt = lastCalculatedAt
    ? formatDateTime(lastCalculatedAt, dateFormatting)
    : null;

  // Define handlers internally
  const handleUpdate = () => {
    updatePortfolioMutation.mutate();
  };

  const handleRecalculate = () => {
    recalculatePortfolioMutation.mutate();
  };

  return (
    <HoverCard>
      <HoverCardTrigger className="inline-flex min-w-0 cursor-pointer items-center">
        {children}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 shadow-none">
        <div className="flex flex-col space-y-4">
          {notices.length > 0 && (
            <div className="border-warning/20 bg-warning/10 flex gap-2.5 rounded-lg border p-3">
              <Icons.AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1.5">
                {notices.map((notice) => (
                  <p key={notice} className="text-foreground/80 text-xs leading-relaxed font-light">
                    {notice}
                  </p>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <h4 className="flex text-sm font-light">
              <Icons.Calendar className="me-2 h-4 w-4" />
              {t("dashboard:update.as_of")}{" "}
              <Badge className="ms-1 font-medium" variant="secondary">
                {/* Use lastCalculatedAt prop */}
                {formattedLastCalculatedAt
                  ? `${formattedLastCalculatedAt.date} ${formattedLastCalculatedAt.time}`
                  : "-"}
              </Badge>
            </h4>
          </div>
          <Button
            onClick={handleUpdate} // Use internal handler
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={updatePortfolioMutation.isPending} // Use internal mutation state
          >
            {updatePortfolioMutation.isPending ? (
              <Spinner className="me-2 h-4 w-4" />
            ) : (
              <Icons.Refresh className="me-2 h-4 w-4" />
            )}
            {updatePortfolioMutation.isPending
              ? t("dashboard:update.updating_quotes")
              : t("dashboard:update.update_quotes")}
          </Button>
          <Button
            onClick={handleRecalculate}
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={recalculatePortfolioMutation.isPending}
          >
            {recalculatePortfolioMutation.isPending ? (
              <Spinner className="me-2 h-4 w-4" />
            ) : (
              <Icons.Clock className="me-2 h-4 w-4" />
            )}
            {recalculatePortfolioMutation.isPending
              ? t("dashboard:update.rebuilding_history")
              : t("dashboard:update.rebuild_history")}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
