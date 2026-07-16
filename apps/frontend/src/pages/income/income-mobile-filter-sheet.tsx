import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui/components/ui/sheet";
import type { AccountScope } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@wealthfolio/ui";
import { useAccounts } from "@/hooks/use-accounts";
import { usePortfolios } from "@/hooks/use-portfolios";
import { useTranslation } from "react-i18next";

interface IncomeMobileFilterSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountFilter: AccountScope;
  onAccountScopeChange: (filter: AccountScope) => void;
}

export const IncomeMobileFilterSheet = ({
  open,
  onOpenChange,
  accountFilter,
  onAccountScopeChange,
}: IncomeMobileFilterSheetProps) => {
  const { t } = useTranslation();
  const { accounts } = useAccounts();
  const { data: portfolios = [] } = usePortfolios();

  const select = (filter: AccountScope) => {
    onAccountScopeChange(filter);
    onOpenChange(false);
  };

  const isAll = accountFilter.type === "all";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex h-[70vh] flex-col rounded-t-xl pb-[max(env(safe-area-inset-bottom),0.75rem)]"
      >
        <SheetHeader className="text-left">
          <SheetTitle>{t("income:filter_options")}</SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1 py-4">
          <div className="space-y-3">
            <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
              {t("common:account")}
            </h4>
            <div className="overflow-hidden rounded-lg border">
              <div
                className={cn(
                  "flex cursor-pointer items-center justify-between p-3 text-sm transition-colors",
                  isAll ? "bg-accent/50 font-medium" : "hover:bg-muted/50",
                )}
                onClick={() => select({ type: "all" })}
              >
                <span className="flex items-center gap-2">
                  <Icons.LayoutDashboard className="text-muted-foreground h-4 w-4" />
                  {t("income:all_accounts")}
                </span>
                {isAll && <Icons.Check className="text-primary h-4 w-4" />}
              </div>

              {portfolios.map((p) => {
                const isSelected =
                  accountFilter.type === "portfolio" && accountFilter.portfolioId === p.id;
                return (
                  <div
                    key={p.id}
                    className={cn(
                      "flex cursor-pointer items-center justify-between border-t p-3 text-sm transition-colors",
                      isSelected ? "bg-accent/50 font-medium" : "hover:bg-muted/50",
                    )}
                    onClick={() => select({ type: "portfolio", portfolioId: p.id })}
                  >
                    <span className="flex items-center gap-2">
                      <Icons.Folder className="text-muted-foreground h-4 w-4" />
                      {p.name}
                    </span>
                    {isSelected && <Icons.Check className="text-primary h-4 w-4" />}
                  </div>
                );
              })}

              {accounts.map((account) => {
                const isSelected =
                  accountFilter.type === "account" && accountFilter.accountId === account.id;
                return (
                  <div
                    key={account.id}
                    className={cn(
                      "flex cursor-pointer items-center justify-between border-t p-3 text-sm transition-colors",
                      isSelected ? "bg-accent/50 font-medium" : "hover:bg-muted/50",
                    )}
                    onClick={() => select({ type: "account", accountId: account.id })}
                  >
                    <span className="flex items-center gap-2">
                      <Icons.Wallet className="text-muted-foreground h-4 w-4" />
                      {account.name}
                    </span>
                    {isSelected && <Icons.Check className="text-primary h-4 w-4" />}
                  </div>
                );
              })}
            </div>
          </div>
        </ScrollArea>
        <SheetFooter className="mt-auto">
          <SheetClose asChild>
            <Button className="w-full">{t("income:done")}</Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
