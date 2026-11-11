import { createContext, forwardRef, useContext, type AnchorHTMLAttributes, type ReactNode } from "react";

type OpenUrl = (url: string) => void | Promise<void>;

const ExternalLinkContext = createContext<OpenUrl | undefined>(undefined);

interface ExternalLinkProviderProps {
  openUrl: OpenUrl;
  children: ReactNode;
}

/** Lets shared UI open links through the host application's platform adapter. */
export function ExternalLinkProvider({ openUrl, children }: ExternalLinkProviderProps) {
  return <ExternalLinkContext.Provider value={openUrl}>{children}</ExternalLinkContext.Provider>;
}

interface ExternalLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  openUrl?: OpenUrl;
}

/** Uses the host's browser opener when provided, or normal anchor navigation otherwise. */
export const ExternalLink = forwardRef<HTMLAnchorElement, ExternalLinkProps>(
  ({ href, onClick, openUrl, ...props }, ref) => {
    const contextOpenUrl = useContext(ExternalLinkContext);
    const open = openUrl ?? contextOpenUrl;

    return (
      <a
        {...props}
        ref={ref}
        href={href}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || !open) return;
          event.preventDefault();
          void open(href);
        }}
      />
    );
  },
);

ExternalLink.displayName = "ExternalLink";
