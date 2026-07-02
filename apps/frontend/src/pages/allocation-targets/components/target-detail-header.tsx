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
import { useI18n } from "@/i18n/i18n-provider";

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
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const newTargetLabel = isChinese ? "新建目标" : "New target";
  const editTargetLabel = isChinese ? "编辑目标" : "Edit target";

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
                {target?.name ?? (isChinese ? "选择目标" : "Select target")}
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
        aria-label={newTargetLabel}
        title={newTargetLabel}
      >
        <Icons.Plus className="h-4 w-4" />
      </Button>
      {target && onEditTarget && (
        <Button
          variant="outline"
          className="bg-secondary/30 hover:bg-muted/80 h-10 w-10 shrink-0 rounded-full border-none p-0"
          onClick={onEditTarget}
          aria-label={editTargetLabel}
          title={editTargetLabel}
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
  const { language } = useI18n();
  const isChinese = language === "zh-CN";

  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
        <Icons.ArrowLeft className="mr-1.5 h-4 w-4" />
        {isChinese ? "返回配置" : "Back to allocation"}
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
