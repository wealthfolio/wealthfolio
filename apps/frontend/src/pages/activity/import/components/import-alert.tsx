import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@wealthfolio/ui/components/ui/alert";
import { Icons, type Icon } from "@wealthfolio/ui/components/ui/icons";
import { cn } from "@/lib/utils";
import type React from "react";

type AlertVariant = "warning" | "success" | "destructive" | "info";
type AlertSize = "sm" | "lg" | "xl";

interface ImportAlertProps {
  variant: AlertVariant;
  title: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  icon?: Icon;
  iconClassName?: string;
  rightIcon?: Icon;
  size?: AlertSize;
  children?: React.ReactNode;
}

const defaultIcons: Record<AlertVariant, Icon> = {
  success: Icons.CheckCircle,
  warning: Icons.AlertTriangle,
  destructive: Icons.AlertCircle,
  info: Icons.Info,
};

// The alert's font size is the title's, so the icon centres on the title; the
// description is one step smaller.
const sizeStyles: Record<AlertSize, { alert: string; icon: string; description: string }> = {
  sm: { alert: "p-3 text-sm", icon: "size-4", description: "text-xs" },
  lg: { alert: "p-4 text-base", icon: "size-5", description: "text-sm" },
  xl: { alert: "p-5 text-lg", icon: "size-6", description: "text-base" },
};

/** A notice or summary in an import step: an Alert with a default icon per variant. */
export function ImportAlert({
  variant,
  title,
  description,
  className,
  icon,
  iconClassName,
  rightIcon: RightIcon,
  size = "lg",
  children,
}: ImportAlertProps) {
  const LeadingIcon = icon ?? defaultIcons[variant];
  const sizeStyle = sizeStyles[size];

  return (
    <Alert
      variant={variant === "info" ? "default" : variant}
      className={cn("mb-6", sizeStyle.alert, className)}
    >
      <LeadingIcon className={cn(sizeStyle.icon, iconClassName)} />
      {title && <AlertTitle>{title}</AlertTitle>}
      {(description || children) && (
        <AlertDescription className={sizeStyle.description}>
          {description}
          {/* Buttons and other content keep the page's text colour. */}
          {children && <div className="text-foreground">{children}</div>}
        </AlertDescription>
      )}
      {RightIcon && (
        <AlertAction className="top-1/2 -translate-y-1/2">
          <RightIcon className={cn(sizeStyle.icon, "opacity-80")} />
        </AlertAction>
      )}
    </Alert>
  );
}
