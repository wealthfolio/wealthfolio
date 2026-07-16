import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface ProviderButtonProps {
  provider: "google" | "apple" | "email";
  onClick: () => void;
  isLoading: boolean;
  isLastUsed?: boolean;
  variant?: "default" | "outline";
  className?: string;
  type?: "button" | "submit";
}

export function ProviderButton({
  provider,
  onClick,
  isLoading,
  isLastUsed = false,
  variant = "outline",
  className,
  type = "button",
}: ProviderButtonProps) {
  const { t } = useTranslation();
  const providerConfig = {
    google: {
      icon: Icons.Google,
      label: t("connect:providers.continueWithGoogle"),
    },
    apple: {
      icon: Icons.Apple,
      label: t("connect:providers.continueWithApple"),
    },
    email: {
      icon: Icons.Mail,
      label: t("connect:providers.continueWithEmail"),
    },
  };

  const config = providerConfig[provider];
  const Icon = config.icon;

  return (
    <Button
      type={type}
      variant={variant}
      onClick={onClick}
      disabled={isLoading}
      className={cn("relative h-12 w-full max-w-sm justify-start gap-3", className)}
    >
      {isLoading ? (
        <Icons.Spinner className="h-5 w-5 animate-spin" />
      ) : (
        <Icon className="h-5 w-5" />
      )}
      <span className="flex-1 text-center">{config.label}</span>
      {isLastUsed && !isLoading && (
        <span className="text-muted-foreground absolute right-3 text-xs">
          {t("connect:providers.lastUsed")}
        </span>
      )}
    </Button>
  );
}
