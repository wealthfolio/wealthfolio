import { cn } from "@/lib/utils";
import type { NavigationMode } from "@/pages/layouts/navigation/navigation-mode-context";
import { Icons } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

interface NavigationStyleSelectorProps {
  value: NavigationMode;
  onChange: (mode: NavigationMode) => void;
  className?: string;
}

// Presentational picker for the desktop navigation style (collapsed sidebar vs
// floating bottom bar). Callers own the state (settings context vs onboarding
// localStorage) and gate on large screens — this only renders the two cards.
export function NavigationStyleSelector({
  value,
  onChange,
  className,
}: NavigationStyleSelectorProps) {
  const { t } = useTranslation();

  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:gap-4", className)}>
      {/* Sidebar */}
      <button
        type="button"
        data-testid="nav-sidebar-button"
        onClick={() => onChange("sidebar")}
        className={cn(
          "group relative overflow-hidden rounded-xl border-2 transition-all duration-200",
          value === "sidebar"
            ? "border-primary ring-primary/20 ring-2"
            : "border-border hover:border-primary/50",
        )}
      >
        <div className="bg-muted/40 h-32 w-full overflow-hidden p-2.5">
          <div className="flex h-full gap-1.5">
            <div className="bg-foreground/10 flex w-[15%] flex-col items-center gap-1.5 rounded-md py-2.5">
              <div className="bg-foreground/40 h-2.5 w-2.5 rounded-[4px]" />
              <div className="bg-foreground/45 mt-1 h-2 w-2 rounded-full" />
              <div className="bg-foreground/20 h-2 w-2 rounded-full" />
              <div className="bg-foreground/20 h-2 w-2 rounded-full" />
              <div className="bg-foreground/20 h-2 w-2 rounded-full" />
            </div>
            <div className="bg-foreground/5 flex-1 rounded-md" />
          </div>
        </div>
        <div
          className={cn(
            "flex items-center justify-center gap-2 py-2.5 sm:py-3",
            value === "sidebar" ? "bg-primary/10" : "bg-muted/50",
          )}
        >
          <Icons.PanelLeft
            className={cn(
              "h-4 w-4",
              value === "sidebar" ? "text-primary" : "text-muted-foreground",
            )}
          />
          <span className="text-sm font-medium">{t("common:navStyle.sidebar")}</span>
        </div>
        {value === "sidebar" && (
          <div className="bg-primary absolute right-2 top-2 rounded-full p-0.5">
            <Icons.Check className="h-3 w-3 text-white" />
          </div>
        )}
      </button>

      {/* Floating Bar */}
      <button
        type="button"
        data-testid="nav-launchbar-button"
        onClick={() => onChange("launchbar")}
        className={cn(
          "group relative overflow-hidden rounded-xl border-2 transition-all duration-200",
          value === "launchbar"
            ? "border-primary ring-primary/20 ring-2"
            : "border-border hover:border-primary/50",
        )}
      >
        <div className="bg-muted/40 h-32 w-full overflow-hidden p-2.5">
          <div className="bg-foreground/5 relative h-full rounded-md">
            <div className="bg-foreground/10 absolute bottom-2.5 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-lg px-2 py-1.5 shadow-sm">
              <div className="bg-foreground/45 h-2 w-2 rounded-[3px]" />
              <div className="bg-foreground/25 h-2 w-2 rounded-[3px]" />
              <div className="bg-foreground/25 h-2 w-2 rounded-[3px]" />
              <div className="bg-foreground/25 h-2 w-2 rounded-[3px]" />
              <div className="bg-foreground/25 h-2 w-2 rounded-[3px]" />
            </div>
          </div>
        </div>
        <div
          className={cn(
            "flex items-center justify-center gap-2 py-2.5 sm:py-3",
            value === "launchbar" ? "bg-primary/10" : "bg-muted/50",
          )}
        >
          <Icons.RectangleEllipsis
            className={cn(
              "h-4 w-4",
              value === "launchbar" ? "text-primary" : "text-muted-foreground",
            )}
          />
          <span className="text-sm font-medium">{t("common:navStyle.floating")}</span>
        </div>
        {value === "launchbar" && (
          <div className="bg-primary absolute right-2 top-2 rounded-full p-0.5">
            <Icons.Check className="h-3 w-3 text-white" />
          </div>
        )}
      </button>
    </div>
  );
}
