import { openUrlInBrowser } from "@/adapters";
import { forwardRef, useCallback } from "react";

interface ExternalLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

/**
 * Anchor element that opens URLs via the platform adapter (Tauri shell / window.open).
 * Necessary because `<a target="_blank">` is silently ignored inside Tauri's WKWebView on iOS.
 * Renders a normal `<a>` for semantics/accessibility; click is handled by `openUrlInBrowser`.
 */
export const ExternalLink = forwardRef<HTMLAnchorElement, ExternalLinkProps>(
  ({ href, children, onClick, ...props }, ref) => {
    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        openUrlInBrowser(href);
      },
      [href, onClick],
    );

    return (
      <a ref={ref} href={href} onClick={handleClick} {...props}>
        {children}
      </a>
    );
  },
);

ExternalLink.displayName = "ExternalLink";
