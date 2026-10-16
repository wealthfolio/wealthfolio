import { Button } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { statusSurfaceVariants } from "@wealthfolio/ui/components/ui/status-surface";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export interface ToolErrorProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

/** A tool's failed state: fills the tool's area, centred, on the destructive surface. */
export function ToolError({ title, message, onRetry }: ToolErrorProps) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={cn(
        statusSurfaceVariants({ status: "destructive" }),
        "text-destructive-subtle-foreground flex flex-col items-center gap-3 rounded-lg px-4 py-6 text-center",
      )}
    >
      <span className="bg-current/15 flex rounded-full p-3">
        <Icons.AlertCircle className="size-7" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="font-medium">{title ?? t("ai:toolError.title")}</p>
        <p className="text-foreground/90 text-sm">{message}</p>
      </div>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive mt-2 gap-1.5"
        >
          <Icons.RefreshCw className="size-3.5" />
          {t("ai:toolError.retry")}
        </Button>
      )}
    </div>
  );
}
