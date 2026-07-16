import { useHapticFeedback } from "@/hooks";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { cn } from "@wealthfolio/ui/lib/utils";
import * as React from "react";
import { useTranslation } from "react-i18next";

export interface ActionPaletteItem {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  testId?: string;
  variant?: "default" | "destructive";
}

export interface ActionPaletteGroup {
  title?: string;
  items: ActionPaletteItem[];
}

interface ActionPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  groups: ActionPaletteGroup[];
  trigger?: React.ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
}

export function ActionPalette({
  open,
  onOpenChange,
  title,
  groups,
  trigger,
  align = "end",
  side = "bottom",
}: ActionPaletteProps) {
  const { t } = useTranslation();
  const { triggerHaptic } = useHapticFeedback();

  const handleItemClick = React.useCallback(
    (item: ActionPaletteItem) => {
      triggerHaptic();
      item.onClick();
      onOpenChange(false);
    },
    [triggerHaptic, onOpenChange],
  );

  const handleClose = React.useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="icon" className="h-9 w-9">
            <Icons.DotsThreeVertical className="h-5 w-5" weight="fill" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        sideOffset={8}
        className={cn(
          "w-auto min-w-[260px] max-w-[320px] p-0",
          "rounded-2xl",
          "border-border/50 border dark:border-white/10",
          "bg-card backdrop-blur-xl",
          "shadow-lg",
        )}
      >
        {/* Header - only show if title provided */}
        {title && (
          <div className="flex items-center justify-between px-5 pb-3 pt-5">
            <h3 className="text-foreground text-lg font-bold">{title}</h3>
            <button
              onClick={handleClose}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full",
                "bg-muted/80 hover:bg-muted",
                "text-muted-foreground hover:text-foreground",
                "transition-colors duration-150",
                "focus-visible:ring-ring focus:outline-none focus-visible:ring-2",
              )}
              aria-label={t("common:close")}
            >
              <Icons.X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Action Groups */}
        <div className={cn("px-3 pb-4", !title && "pt-3")}>
          {groups.map((group, groupIndex) => (
            <div key={groupIndex}>
              {group.title && (
                <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium uppercase tracking-wider">
                  {group.title}
                </div>
              )}
              <div>
                {group.items.map((item, itemIndex) => {
                  const IconComponent = item.icon;
                  const isDestructive = item.variant === "destructive";
                  return (
                    <React.Fragment key={itemIndex}>
                      {itemIndex > 0 && <div className="bg-border/70 mx-3 h-px" />}
                      <button
                        data-testid={item.testId}
                        onClick={() => handleItemClick(item)}
                        className={cn(
                          "flex w-full items-center gap-4 rounded-xl px-3 py-3",
                          "transition-colors duration-150",
                          isDestructive
                            ? "text-destructive hover:bg-destructive/10 active:bg-destructive/15"
                            : "text-foreground hover:bg-accent active:bg-accent/80",
                          "focus-visible:ring-ring focus:outline-none focus-visible:ring-2 focus-visible:ring-inset",
                        )}
                      >
                        <IconComponent
                          className={cn(
                            "h-5 w-5 shrink-0",
                            isDestructive ? "text-destructive" : "text-muted-foreground",
                          )}
                        />
                        <span className="text-[15px] font-medium">{item.label}</span>
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
              {groupIndex < groups.length - 1 && <div className="bg-border/70 mx-3 my-1.5 h-px" />}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
