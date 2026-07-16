import { useIsMobileViewport } from "@/hooks";
import { useSettingsContext } from "@/lib/settings-provider";
import { Icons } from "@wealthfolio/ui";
import { createPortal } from "react-dom";

import { Toaster as Sonner, type ToasterProps } from "sonner";
// Bundle Sonner's stylesheet from 'self' rather than depending on its runtime
// <style> injection. Per the CSP spec, a single hash or nonce in style-src
// disables 'unsafe-inline' for the whole document, silently blocking runtime
// style injection in packaged builds (see the comments in index.html and
// public/splash.css) — the bundled stylesheet keeps toasts styled either way.
import "sonner/dist/styles.css";

const Toaster = ({ ...props }: ToasterProps) => {
  const { settings } = useSettingsContext();
  const isMobile = useIsMobileViewport();
  const settingsTheme = settings?.theme;

  let theme: "light" | "dark" | "system" = "system";
  if (settingsTheme === "light") {
    theme = "light";
  } else if (settingsTheme === "dark") {
    theme = "dark";
  } else if (settingsTheme === "system") {
    theme = "system";
  }

  const content = (
    <Sonner
      theme={theme}
      position={isMobile ? "top-center" : undefined}
      className="toaster group"
      expand={true}
      icons={{
        success: <Icons.CheckCircle className="size-4" />,
        info: <Icons.Info className="size-4" />,
        warning: <Icons.AlertTriangle className="size-4" />,
        error: <Icons.OctagonX className="size-4" />,
        loading: <Icons.Spinner className="size-4 animate-spin" />,
        close: <Icons.Close className="size-4" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            (isMobile
              ? "!backdrop-blur-[20px] !backdrop-saturate-[1.8] !rounded-2xl !shadow-[0_2px_16px_rgba(0,0,0,0.08)] dark:!shadow-[0_2px_20px_rgba(0,0,0,0.3)] !py-3 !px-4"
              : "") + " !pr-8",
          title: isMobile ? "!text-sm !font-semibold" : undefined,
          description: isMobile ? "!text-[0.8125rem] !leading-tight" : undefined,
          actionButton: isMobile
            ? "!bg-transparent !border-none !p-0 !font-semibold !text-[0.8125rem] !underline !underline-offset-2"
            : undefined,
          closeButton:
            "!absolute !top-2 !right-2 !left-auto !transform-none !border-none" +
            (isMobile ? " !bg-transparent" : ""),
        },
      }}
      style={
        {
          zIndex: 2147483647,
          "--normal-bg": isMobile
            ? "color-mix(in srgb, var(--toast-bg) 70%, transparent)"
            : "var(--toast-bg)",
          "--normal-text": "var(--toast-fg)",
          "--normal-border": isMobile
            ? "color-mix(in srgb, var(--toast-border) 50%, transparent)"
            : "var(--toast-border)",
          "--border-radius": isMobile ? "1rem" : "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );

  if (typeof document === "undefined") return content;

  return createPortal(content, document.body);
};

export { Toaster };
