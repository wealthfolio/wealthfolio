import { Button } from "@wealthfolio/ui";
import { Alert, AlertDescription, AlertTitle } from "@wealthfolio/ui/components/ui/alert";
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
    <Alert variant="destructive">
      <Icons.AlertCircle />
      <AlertTitle>{title ?? t("ai:toolError.title")}</AlertTitle>
      <AlertDescription>
        {message}
        {onRetry && (
          <div className="mt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive gap-1.5"
            >
              <Icons.RefreshCw className="size-3.5" />
              {t("ai:toolError.retry")}
            </Button>
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
