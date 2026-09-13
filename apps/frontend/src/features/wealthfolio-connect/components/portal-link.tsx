import { ExternalLink } from "@/components/external-link";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import { useTranslation } from "react-i18next";

interface PortalLinkProps {
  href: string;
  label: string;
}

export function PortalLink({ href, label }: PortalLinkProps) {
  const { t } = useTranslation();
  const hint = t("connect:opensInBrowser");

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground size-11 shrink-0 p-0 sm:h-8 sm:w-auto sm:px-3"
            asChild
          >
            <ExternalLink href={href} aria-label={`${label} — ${hint}`}>
              <span className="hidden sm:inline">{label}</span>
              <Icons.ExternalLink className="size-4" aria-hidden="true" />
            </ExternalLink>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
