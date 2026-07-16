import { Button } from "@wealthfolio/ui/components/ui/button";
import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@wealthfolio/ui/components/ui/sheet";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useAccounts } from "@/hooks/use-accounts";
import { usePortfolios } from "@/hooks/use-portfolios";
import { useSettings } from "@/hooks/use-settings";
import {
  AccountPurpose,
  AccountType,
  accountSupportsPurpose,
  PORTFOLIO_ACCOUNT_TYPE,
  PORTFOLIO_SCOPE_ID,
} from "@/lib/constants";
import { Account } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Icons, type Icon } from "@wealthfolio/ui";
import { forwardRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

// Custom type for UI purposes that extends the standard AccountType
type UIAccountType = AccountType | typeof PORTFOLIO_ACCOUNT_TYPE;

// Map account types to icons for visual distinction
const accountTypeIcons: Record<string, Icon> = {
  SECURITIES: Icons.Briefcase,
  CASH: Icons.DollarSign,
  CREDIT_CARD: Icons.CreditCard,
  CRYPTOCURRENCY: Icons.Bitcoin,
  [PORTFOLIO_ACCOUNT_TYPE]: Icons.Wallet,
};

interface AccountSelectorMobileProps {
  setSelectedAccount: (account: Account) => void;
  includePortfolio?: boolean;
  accountTypes?: readonly AccountType[];
  accountPurpose?: AccountPurpose;
  className?: string;
  iconOnly?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * When provided, the sheet also lists user-created portfolios from
   * settings → Portfolios and the callback fires when one is picked.
   */
  onPortfolioSelect?: (portfolio: { id: string; name: string }) => void;
}

// Extended Account type for UI that can have the PORTFOLIO type
interface UIAccount extends Omit<Account, "accountType"> {
  accountType: UIAccountType;
}

// Create a portfolio account for UI purposes
function createPortfolioAccount(baseCurrency: string, t: TFunction): UIAccount {
  return {
    id: PORTFOLIO_SCOPE_ID,
    name: t("common:component.all_portfolio"),
    accountType: PORTFOLIO_ACCOUNT_TYPE,
    currency: baseCurrency,
    group: undefined,
    isActive: true,
    isArchived: false,
    trackingMode: "NOT_SET",
    isDefault: false,
    balance: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export const AccountSelectorMobile = forwardRef<HTMLButtonElement, AccountSelectorMobileProps>(
  (
    {
      setSelectedAccount,
      includePortfolio = false,
      accountTypes,
      accountPurpose,
      className,
      iconOnly = false,
      open: controlledOpen,
      onOpenChange,
      onPortfolioSelect,
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const [internalOpen, setInternalOpen] = useState(false);
    const open = controlledOpen ?? internalOpen;
    const setOpen = onOpenChange ?? setInternalOpen;

    const { accounts, isLoading: isLoadingAccounts } = useAccounts({
      filterActive: true,
      includeArchived: false,
    });
    const { data: settings, isLoading: isLoadingSettings } = useSettings();
    const { data: portfolios = [] } = usePortfolios();
    const showPortfolios = !!onPortfolioSelect && portfolios.length > 0;

    const isLoading = isLoadingAccounts || isLoadingSettings;

    const filteredAccounts = (accounts || []).filter((account) => {
      if (accountTypes && !accountTypes.includes(account.accountType)) {
        return false;
      }
      if (accountPurpose && !accountSupportsPurpose(account, accountPurpose)) {
        return false;
      }
      return true;
    });

    // Add portfolio account if requested
    const allAccounts: UIAccount[] = includePortfolio
      ? [createPortfolioAccount(settings?.baseCurrency || "USD", t), ...(filteredAccounts || [])]
      : filteredAccounts;

    // Group accounts by type
    const groupedAccounts = allAccounts.reduce(
      (acc, account) => {
        const type = account.accountType;
        if (!acc[type]) {
          acc[type] = [];
        }
        acc[type].push(account);
        return acc;
      },
      {} as Record<string, UIAccount[]>,
    );

    const handleAccountSelect = (account: UIAccount) => {
      setSelectedAccount(account as Account);
      setOpen(false);
    };

    const getAccountTypeLabel = (type: string): string => {
      switch (type) {
        case PORTFOLIO_ACCOUNT_TYPE:
          return t("common:component.account_type_portfolio");
        case "SECURITIES":
          return t("common:component.account_type_securities");
        case "CASH":
          return t("common:component.account_type_cash");
        case "CREDIT_CARD":
          return t("common:component.account_type_credit_card");
        case "CRYPTOCURRENCY":
          return t("common:component.account_type_cryptocurrency");
        default:
          return t("common:component.account_type_other");
      }
    };

    if (isLoading) {
      return (
        <Button variant="outline" className={cn("h-9 w-9 p-0", className)} size="icon" disabled>
          <Skeleton className="h-4 w-4" />
        </Button>
      );
    }

    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            ref={ref}
            variant="outline"
            aria-label={iconOnly ? t("common:component.add_account") : undefined}
            className={cn(
              "bg-secondary/30 hover:bg-muted/80 flex items-center gap-1.5 rounded-md border-[1.5px] border-none text-sm font-medium",
              iconOnly ? "h-9 w-9 p-0" : "h-8 px-3 py-1",
              className,
            )}
            size={iconOnly ? "icon" : "sm"}
          >
            <Icons.Briefcase className="h-4 w-4" />
            {!iconOnly && t("common:component.add_account")}
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" className="rounded-t-4xl mx-1 h-[80vh] p-0">
          <SheetHeader className="border-border border-b px-6 py-4">
            <SheetTitle>{t("common:component.select_account")}</SheetTitle>
            <SheetDescription>{t("common:component.choose_account_comparison")}</SheetDescription>
          </SheetHeader>
          <ScrollArea className="h-[calc(80vh-5rem)] px-6 py-4">
            <div className="space-y-6">
              {showPortfolios && (
                <div>
                  <h3 className="text-muted-foreground mb-3 text-sm font-medium">
                    {t("common:component.portfolios")}
                  </h3>
                  <div className="space-y-2">
                    {portfolios.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          onPortfolioSelect?.({ id: p.id, name: p.name });
                          setOpen(false);
                        }}
                        className="hover:bg-accent active:bg-accent/80 focus:border-primary flex w-full items-center gap-3 rounded-lg border border-transparent p-3 text-left transition-colors focus:outline-none"
                      >
                        <div className="bg-primary/10 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full">
                          <Icons.Folder className="text-primary h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-foreground truncate font-medium">{p.name}</div>
                        </div>
                        <Icons.ChevronRight className="text-muted-foreground h-5 w-5 flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {Object.entries(groupedAccounts).map(([type, accountsInGroup]) => (
                <div key={type}>
                  <h3 className="text-muted-foreground mb-3 text-sm font-medium">
                    {getAccountTypeLabel(type)}
                  </h3>
                  <div className="space-y-2">
                    {accountsInGroup.map((account) => {
                      const IconComponent = accountTypeIcons[account.accountType] ?? Icons.Wallet;
                      return (
                        <button
                          key={account.id}
                          onClick={() => handleAccountSelect(account)}
                          className="hover:bg-accent active:bg-accent/80 focus:border-primary flex w-full items-center gap-3 rounded-lg border border-transparent p-3 text-left transition-colors focus:outline-none"
                        >
                          <div className="bg-primary/10 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full">
                            <IconComponent className="text-primary h-5 w-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-foreground truncate font-medium">
                              {account.name}
                            </div>
                            <div className="text-muted-foreground text-sm">{account.currency}</div>
                          </div>
                          <Icons.ChevronRight className="text-muted-foreground h-5 w-5 flex-shrink-0" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    );
  },
);

AccountSelectorMobile.displayName = "AccountSelectorMobile";
