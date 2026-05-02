import { ReactNode } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@wealthfolio/ui/components/ui/hover-card";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  useUpdatePortfolioMutation,
  useRecalculatePortfolioMutation,
} from "@/hooks/use-calculate-portfolio";
import { formatDateTime } from "@/lib/utils";

// Rename interface
interface PortfolioUpdateTriggerProps {
  lastCalculatedAt: string | undefined;
  children: ReactNode;
}

// Rename function
export function PortfolioUpdateTrigger({
  lastCalculatedAt,
  children,
}: PortfolioUpdateTriggerProps) {
  // Instantiate the mutation hooks inside the component
  const updatePortfolioMutation = useUpdatePortfolioMutation();
  const recalculatePortfolioMutation = useRecalculatePortfolioMutation();
  const formattedLastCalculatedAt = lastCalculatedAt ? formatDateTime(lastCalculatedAt) : null;

  // Show a visible staleness indicator when data is > 1 day old
  const isStale = lastCalculatedAt
    ? Date.now() - new Date(lastCalculatedAt).getTime() > 24 * 60 * 60 * 1000
    : false;

  // Define handlers internally
  const handleUpdate = () => {
    updatePortfolioMutation.mutate();
  };

  const handleRecalculate = () => {
    recalculatePortfolioMutation.mutate();
  };

  return (
    <HoverCard>
      <HoverCardTrigger className="inline-flex cursor-pointer items-center gap-2">
        {children}
        {isStale && (
          <Badge variant="outline" className="text-muted-foreground gap-1 text-xs font-normal">
            <Icons.AlertTriangle className="h-3 w-3" />
            {formattedLastCalculatedAt ? `As of ${formattedLastCalculatedAt.date}` : "Stale"}
          </Badge>
        )}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 shadow-none">
        <div className="flex flex-col space-y-4">
          <div className="space-y-2">
            <h4 className="flex text-sm font-light">
              <Icons.Calendar className="mr-2 h-4 w-4" />
              As of:{" "}
              <Badge className="ml-1 font-medium" variant="secondary">
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
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Icons.Refresh className="mr-2 h-4 w-4" />
            )}
            {updatePortfolioMutation.isPending ? "Updating quotes..." : "Update quotes"}
          </Button>
          <Button
            onClick={handleRecalculate}
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={recalculatePortfolioMutation.isPending}
          >
            {recalculatePortfolioMutation.isPending ? (
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Icons.Clock className="mr-2 h-4 w-4" />
            )}
            {recalculatePortfolioMutation.isPending
              ? "Rebuilding history..."
              : "Rebuild full history"}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
