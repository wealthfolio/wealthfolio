import { ReactNode } from "react";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

// Status Card Component
interface MappingStatusCardProps {
  title: string;
  icon: ReactNode;
  mappedCount: number;
  totalCount: number;
  isComplete: boolean;
  additionalText?: string;
}

export function MappingStatusCard({
  title,
  icon,
  mappedCount,
  totalCount,
  isComplete,
  additionalText,
}: MappingStatusCardProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border p-2",
        isComplete
          ? "border-green-200 bg-green-50/50 dark:border-green-800/50 dark:bg-green-800/30"
          : "border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-800/30",
      )}
    >
      <div
        className={cn(
          "rounded-full p-1",
          isComplete
            ? "bg-green-00 text-green-700 dark:bg-green-800/30 dark:text-green-400"
            : "bg-orange-100 text-red-700 dark:bg-red-800/30 dark:text-red-400",
        )}
      >
        {icon}
      </div>
      <div className="flex-1">
        <p
          className={cn(
            "text-sm font-medium",
            isComplete ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400",
          )}
        >
          {title}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("activity:import.mapping.mappedCount", { mapped: mappedCount, total: totalCount })}
          {additionalText && ` ${additionalText}`}
        </p>
      </div>
      {isComplete ? (
        <Icons.CheckCircle className="h-4 w-4 text-green-500 dark:text-green-400" />
      ) : (
        <Icons.AlertCircle className="h-4 w-4 text-red-500 dark:text-red-400" />
      )}
    </div>
  );
}
