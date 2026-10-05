import { ExternalLink } from "@/components/external-link";
import { useConnectUrl } from "@/features/wealthfolio-connect/hooks/use-connect-url";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ConnectFeatures } from "./connect-features";
import { ConnectFlowDiagram } from "./connect-flow-diagram";

export function ConnectEmptyState() {
  const { t } = useTranslation();
  const connectLink = useConnectUrl("connect_empty_state");

  return (
    <div className="flex min-h-[calc(100vh-12rem)] flex-col items-center justify-center px-4 py-6">
      <div className="w-full max-w-3xl space-y-8 sm:space-y-12">
        {/* Header with Logo */}
        <header className="text-center">
          <img alt="Wealthfolio" className="mx-auto mb-4 h-16 w-16" src="/logo-vantage.png" />
          <div className="bg-secondary text-secondary-foreground mb-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium">
            <Icons.Sparkles className="h-3 w-3" />
            {t("connect:emptyState.optional")}
          </div>
          <h1 className="mb-2 text-xl font-semibold tracking-tight">Wealthfolio Connect</h1>
          <p className="text-muted-foreground text-sm">{t("connect:emptyState.subtitle")}</p>
        </header>

        {/* Hero Diagram - constrained width */}
        <section className="mx-auto max-w-2xl">
          <ConnectFlowDiagram />
        </section>

        <ConnectFeatures dashboard />

        {/* CTA */}
        <footer className="flex flex-col items-center gap-4">
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
            <Button asChild className="from-primary to-primary/90 bg-linear-to-r w-full sm:w-auto">
              <ExternalLink href={connectLink}>
                {t("connect:emptyState.getStarted")}
                <Icons.ExternalLink className="ml-1.5 h-4 w-4" />
              </ExternalLink>
            </Button>
            <Button variant="outline" asChild className="w-full sm:w-auto">
              <Link to="/settings/connect">
                <Icons.User className="mr-1.5 h-4 w-4" />
                {t("connect:emptyState.loginToAccount")}
              </Link>
            </Button>
          </div>
          <ExternalLink
            href="https://wealthfolio.app/connect/"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
          >
            {t("connect:emptyState.learnMore")}
            <Icons.ExternalLink className="h-3 w-3" />
          </ExternalLink>
        </footer>
      </div>
    </div>
  );
}
