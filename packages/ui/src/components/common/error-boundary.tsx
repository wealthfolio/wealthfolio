import { Component, ErrorInfo, ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Icons } from "../ui/icons";
import { ApplicationShell } from "../ui/shell";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

function ErrorFallback({ error }: { error?: Error }) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);

  return (
    <ApplicationShell className="flex h-screen w-full items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center">
        {/* Icon with subtle background */}
        <div className="bg-destructive/10 mb-6 flex h-20 w-20 items-center justify-center rounded-full">
          <Icons.AlertTriangle className="text-destructive h-10 w-10" strokeWidth={1.5} />
        </div>

        {/* Content */}
        <div className="mb-8 space-y-2 text-center">
          <h1 className="text-foreground text-xl font-semibold tracking-tight">
            {t("ui:errorBoundary.title", "Something went wrong")}
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t(
              "ui:errorBoundary.description",
              "We hit an unexpected error. Your data is safe — try refreshing to get back on track.",
            )}
          </p>
        </div>

        {/* Actions */}
        <div className="flex w-full flex-col gap-3">
          <Button onClick={() => window.location.reload()} className="w-full">
            <Icons.RefreshCw className="mr-2 h-4 w-4" />
            {t("ui:errorBoundary.refresh", "Refresh page")}
          </Button>

          {error && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDetails(!showDetails)}
              className="text-muted-foreground hover:text-foreground"
            >
              <Icons.ChevronDown className={`mr-1.5 h-4 w-4 transition-transform ${showDetails ? "rotate-180" : ""}`} />
              {showDetails
                ? t("ui:errorBoundary.hideDetails", "Hide error details")
                : t("ui:errorBoundary.showDetails", "Show error details")}
            </Button>
          )}
        </div>

        {/* Error details */}
        {showDetails && error && (
          <div className="bg-muted/50 mt-4 w-full overflow-hidden rounded-lg border">
            <div className="border-b px-3 py-2">
              <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                {t("ui:errorBoundary.errorDetails", "Error details")}
              </span>
            </div>
            <pre className="text-foreground/80 max-h-40 overflow-auto p-3 font-mono text-xs leading-relaxed">
              {error.message}
              {import.meta.env?.DEV && error.stack && (
                <>
                  {"\n\n"}
                  {error.stack}
                </>
              )}
            </pre>
          </div>
        )}
      </div>
    </ApplicationShell>
  );
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: undefined,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`Error Boundary Caught Error:
      Message: ${error.message}
      Stack: ${error.stack}
      Component Stack: ${errorInfo.componentStack}
    `);
  }

  public render() {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} />;
    }

    return this.props.children;
  }
}

export { ErrorBoundary };
