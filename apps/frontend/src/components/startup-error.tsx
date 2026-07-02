import { getPreferredLanguage } from "@/i18n/languages";
import { translateUiText } from "@/i18n/ui-text";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

interface StartupErrorProps {
  error?: Error | null;
  isRetrying?: boolean;
  onRetry: () => void;
}

export function StartupError({ error, isRetrying = false, onRetry }: StartupErrorProps) {
  const language = getPreferredLanguage();
  const isChinese = language === "zh-CN";
  const title = translateUiText(language, "Backend unavailable");
  const description = translateUiText(
    language,
    "Wealthfolio could not load settings from the backend.",
  );

  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-6 supports-[min-height:100dvh]:min-h-dvh">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <div className="bg-destructive/10 mb-6 flex h-16 w-16 items-center justify-center rounded-full">
          <Icons.AlertTriangle className="text-destructive h-8 w-8" strokeWidth={1.5} />
        </div>

        <div className="mb-6 space-y-2">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
          {error?.message && (
            <p className="text-muted-foreground/80 text-xs leading-relaxed">{error.message}</p>
          )}
        </div>

        <Button onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? (
            <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Icons.RefreshCw className="mr-2 h-4 w-4" />
          )}
          {isChinese ? "重试" : "Retry"}
        </Button>
      </div>
    </div>
  );
}
