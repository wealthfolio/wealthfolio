import { openUrlInBrowser } from "@/adapters";
import { ExternalLink as PlatformExternalLink } from "@wealthfolio/ui/components/ui/external-link";
import { forwardRef } from "react";

interface ExternalLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

/** Opens external links through the platform adapter, including outside the app provider. */
export const ExternalLink = forwardRef<HTMLAnchorElement, ExternalLinkProps>((props, ref) => (
  <PlatformExternalLink {...props} ref={ref} openUrl={openUrlInBrowser} />
));

ExternalLink.displayName = "ExternalLink";
