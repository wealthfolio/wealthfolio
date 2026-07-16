import { useWealthfolioConnect } from "@/features/wealthfolio-connect";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

/**
 * Auth callback page that handles OAuth and magic link redirects.
 * Waits for the WealthfolioConnectContext to process the auth tokens,
 * then redirects to the connect settings page.
 */
export default function AuthCallbackPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isConnected, isLoading, error } = useWealthfolioConnect();
  const [hasCheckedAuth, setHasCheckedAuth] = useState(false);

  useEffect(() => {
    // Wait for the context to finish loading
    if (isLoading) {
      return;
    }

    setHasCheckedAuth(true);

    // If connected, redirect to sync settings
    if (isConnected) {
      navigate("/settings/connect", { replace: true });
      return;
    }

    // If there's an error, still redirect but show error on the settings page
    if (error) {
      console.error("Auth error:", error);
      navigate("/settings/connect", { replace: true });
      return;
    }

    // If not connected after checking, wait a bit more then redirect
    // (the context might still be processing)
    const timer = setTimeout(() => {
      navigate("/settings/connect", { replace: true });
    }, 5000);

    return () => clearTimeout(timer);
  }, [isConnected, isLoading, error, navigate]);

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <Icons.Spinner className="text-muted-foreground h-8 w-8 animate-spin" />
        <p className="text-muted-foreground text-sm">
          {hasCheckedAuth && !isConnected
            ? t("connect:authCallback.processing")
            : t("connect:authCallback.completing")}
        </p>
        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>
    </div>
  );
}
