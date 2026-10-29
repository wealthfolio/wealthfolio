import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface PrivacyToggleProps {
  className?: string;
  /** `ghost` beside a hero figure: no fill or outline in any theme, and a muted icon. */
  variant?: "secondary" | "ghost";
}

export function PrivacyToggle({ className, variant = "secondary" }: PrivacyToggleProps) {
  const { t } = useTranslation();
  const { isBalanceHidden, toggleBalanceVisibility } = useBalancePrivacy();

  return (
    <Button
      variant={variant}
      size="icon-xs"
      aria-label={t(
        isBalanceHidden ? "common:component.show_balance" : "common:component.hide_balance",
      )}
      className={cn("rounded-full", variant === "ghost" && "text-muted-foreground", className)}
      onClick={(e) => {
        e.stopPropagation();
        toggleBalanceVisibility();
      }}
    >
      {isBalanceHidden ? <Icons.Eye className="size-5" /> : <Icons.EyeOff className="size-5" />}
    </Button>
  );
}
