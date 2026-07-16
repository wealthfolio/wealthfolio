import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

interface SettingsHeaderProps {
  heading: string;
  text?: string;
  className?: string;
  children?: React.ReactNode;
  showBackOnMobile?: boolean;
  backTo?: string;
  onBack?: () => void;
  /**
   * Keep the `children` actions on the same row as the title on mobile.
   * Default: actions stack below on mobile. Opt-in to inline for pages
   * with a compact icon-only mobile action (e.g. a single `+`).
   */
  actionsInline?: boolean;
}

export function SettingsHeader({
  heading,
  text,
  className,
  children,
  showBackOnMobile = true,
  backTo = "/settings",
  onBack,
  actionsInline = false,
}: SettingsHeaderProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    navigate(backTo);
  };

  return (
    <div
      className={cn(
        // Mobile: stack title and actions vertically by default. With
        // `actionsInline`, keep actions in the right column even on mobile.
        actionsInline
          ? "grid grid-cols-[1fr_auto] items-start gap-2"
          : "grid grid-cols-1 items-start gap-3 sm:grid-cols-[1fr_auto] sm:gap-2",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 sm:items-start sm:gap-2">
        {showBackOnMobile && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleBack}
            className="text-muted-foreground hover:text-foreground -ml-1 h-8 w-8 shrink-0 p-0 lg:hidden"
            aria-label={t("common:back")}
          >
            <Icons.ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        <div className="grid min-w-0 gap-1">
          <h1 className="font-heading break-words text-base font-bold sm:text-lg lg:text-xl">
            {heading}
          </h1>
          {text && (
            <p className="text-muted-foreground lg:text-md hidden break-words text-sm font-light sm:block">
              {text}
            </p>
          )}
        </div>
      </div>
      {children && (
        <div
          className={cn(
            actionsInline ? "justify-self-end" : "justify-self-start sm:justify-self-end",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
