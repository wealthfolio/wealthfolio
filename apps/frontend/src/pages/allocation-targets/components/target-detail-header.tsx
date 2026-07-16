import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icons,
} from "@wealthfolio/ui";

import type { AllocationTarget } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface TargetDetailHeaderProps {
  targets: AllocationTarget[];
  selectedTargetId: string | null;
  target: AllocationTarget | null;
  onBack: () => void;
  onTargetChange: (id: string) => void;
  onCreateTarget: () => void;
  onEditTarget?: () => void;
  showActions?: boolean;
}

export function TargetToolbarActions({
  targets,
  selectedTargetId,
  target,
  onTargetChange,
  onCreateTarget,
  onEditTarget,
}: Omit<TargetDetailHeaderProps, "onBack" | "showActions">) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full min-w-0 items-center justify-end gap-2 md:w-auto">
      {targets.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="bg-secondary/30 hover:bg-muted/80 h-10 min-w-0 flex-1 justify-between gap-2 rounded-full border-none px-4 text-sm font-medium md:min-w-[220px] md:flex-none"
            >
              <Icons.Target className="h-4 w-4 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate text-left">
                {target?.name ?? t("allocation:header.selectTarget")}
              </span>
              <Icons.ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[calc(100vw-1.5rem)] md:w-60">
            {targets.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onSelect={() => onTargetChange(p.id)}
                className={cn(p.id === selectedTargetId && "font-medium")}
              >
                <span className="flex-1">{p.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button
        variant="outline"
        className="bg-secondary/30 hover:bg-muted/80 h-10 w-10 shrink-0 rounded-full border-none p-0"
        onClick={onCreateTarget}
        aria-label={t("allocation:header.newTarget")}
        title={t("allocation:header.newTarget")}
      >
        <Icons.Plus className="h-4 w-4" />
      </Button>
      {target && onEditTarget && (
        <Button
          variant="outline"
          className="bg-secondary/30 hover:bg-muted/80 h-10 w-10 shrink-0 rounded-full border-none p-0"
          onClick={onEditTarget}
          aria-label={t("allocation:header.editTarget")}
          title={t("allocation:header.editTarget")}
        >
          <Icons.Pencil className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

export function TargetDetailHeader({
  targets,
  selectedTargetId,
  target,
  onBack,
  onTargetChange,
  onCreateTarget,
  onEditTarget,
  showActions = true,
}: TargetDetailHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
        <Icons.ArrowLeft className="mr-1.5 h-4 w-4" />
        {t("allocation:header.backToAllocation")}
      </Button>

      {showActions && (
        <TargetToolbarActions
          targets={targets}
          selectedTargetId={selectedTargetId}
          target={target}
          onTargetChange={onTargetChange}
          onCreateTarget={onCreateTarget}
          onEditTarget={onEditTarget}
        />
      )}
    </div>
  );
}
