import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@wealthfolio/ui/components/ui/sheet";
import { Icons } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

export interface MobileAction {
  icon: keyof typeof Icons;
  label: string;
  description: string;
  onClick: () => void;
}

interface MobileActionsMenuProps {
  actions: MobileAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
}

export function MobileActionsMenu({
  actions,
  open,
  onOpenChange,
  title,
  description,
}: MobileActionsMenuProps) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon" className="h-9 w-9">
          <Icons.MoreVertical className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="rounded-t-4xl mx-1 p-0">
        <SheetHeader className="border-border border-b px-6 py-4">
          <SheetTitle>{title ?? t("common:actions")}</SheetTitle>
          <SheetDescription>
            {description ?? t("common:component.choose_an_action")}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 p-6">
          {actions.map((action, index) => {
            const IconComponent = Icons[action.icon];
            return (
              <button
                key={index}
                onClick={() => {
                  action.onClick();
                  onOpenChange(false);
                }}
                className="hover:bg-accent active:bg-accent/80 focus:ring-primary flex items-center gap-4 rounded-lg border p-4 text-left transition-colors focus:outline-none focus:ring-2"
              >
                <div className="bg-primary/10 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full">
                  <IconComponent className="text-primary h-5 w-5" />
                </div>
                <div className="flex-1">
                  <div className="text-foreground font-medium">{action.label}</div>
                  <div className="text-muted-foreground text-sm">{action.description}</div>
                </div>
                <Icons.ChevronRight className="text-muted-foreground h-5 w-5 flex-shrink-0" />
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
