import { Button } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useTranslation } from "react-i18next";

export interface ToolErrorProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function ToolError({ title, message, onRetry }: ToolErrorProps) {
  const { t } = useTranslation();
  return (
    <div className="border-destructive/50 bg-destructive/10 flex flex-col items-center gap-3 rounded-lg border px-4 py-6 text-center">
      <Icons.AlertCircle className="text-destructive size-8" />
      <div className="flex flex-col gap-1">
        <p className="text-destructive font-medium">{title ?? t("ai:toolError.title")}</p>
        <p className="text-destructive/80 text-sm">{message}</p>
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
