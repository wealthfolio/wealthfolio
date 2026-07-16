import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@wealthfolio/ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { Account, TrackingMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Icons, type Icon } from "@wealthfolio/ui";
import { Fragment, forwardRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

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
import { AnimatePresence, motion } from "motion/react";

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

interface AccountSelectorProps {
  selectedAccount?: Account | null;
  setSelectedAccount: (account: Account) => void;
  variant?: "card" | "dropdown" | "button" | "form";
  buttonText?: string;
  filterActive?: boolean;
  includePortfolio?: boolean;
  className?: string;
  iconOnly?: boolean;
  /** Custom icon to use when iconOnly is true (overrides the default account type icon) */
  icon?: Icon;
  /** Filter accounts by tracking mode(s). If provided, only accounts with matching tracking mode are shown. */
  trackingModes?: TrackingMode[];
  /** Filter accounts by account type(s). If provided, only accounts with matching account type are shown. */
  accountTypes?: readonly AccountType[];
  /** Filter accounts by product purpose. Prefer this over accountTypes for app-owned account policy. */
  accountPurpose?: AccountPurpose;
  /**
   * When provided, the dropdown also lists user-created portfolios (groupings of
   * accounts from settings → Portfolios) under a "Portfolios" section, and the
   * callback fires when one is picked instead of `setSelectedAccount`.
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
    accountType: PORTFOLIO_ACCOUNT_TYPE as UIAccountType,
    balance: 0,
    currency: baseCurrency,
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "NOT_SET",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Animation variants for icon containers
const iconContainerVariants = {
  initial: {
    scale: 0.8,
    opacity: 0,
    rotate: -10,
  },
  animate: {
    scale: 1,
    opacity: 1,
    rotate: 0,
    transition: {
      type: "spring" as const,
      stiffness: 260,
      damping: 20,
      duration: 0.5,
    },
  },
  exit: {
    scale: 0.8,
    opacity: 0,
    rotate: 10,
    transition: { duration: 0.3 },
  },
};

// Animation variants for icons
const iconVariants = {
  initial: { scale: 0.6, opacity: 0 },
  animate: {
    scale: 1,
    opacity: 1,
    transition: {
      delay: 0.1,
      type: "spring" as const,
      stiffness: 300,
    },
  },
};

export const AccountSelector = forwardRef<HTMLButtonElement, AccountSelectorProps>(
  (
    {
      selectedAccount,
      setSelectedAccount,
      variant = "card",
      buttonText,
      filterActive = true,
      includePortfolio = false,
      className,
      iconOnly = false,
      icon: CustomIcon,
      trackingModes,
      accountTypes,
      accountPurpose,
      onPortfolioSelect,
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const { accounts, isLoading: isLoadingAccounts } = useAccounts({
      filterActive,
      includeArchived: false,
    });
    const { data: settings, isLoading: isLoadingSettings } = useSettings();
    // Only load user-created portfolios when the caller knows how to handle them.
    const { data: portfolios = [] } = usePortfolios();
    const showPortfolios = !!onPortfolioSelect && portfolios.length > 0;

    const isLoading = isLoadingAccounts || isLoadingSettings;

    // Filter by tracking/account type if specified, then add portfolio account if requested
    const filteredAccounts = accounts.filter((acc) => {
      if (trackingModes && !trackingModes.includes(acc.trackingMode)) {
        return false;
      }
      if (accountTypes && !accountTypes.includes(acc.accountType)) {
        return false;
      }
      if (accountPurpose && !accountSupportsPurpose(acc, accountPurpose)) {
        return false;
      }
      return true;
    });
    const displayAccounts = [...filteredAccounts];

    if (includePortfolio) {
      const baseCurrency = settings?.baseCurrency ?? "USD"; // Default to USD if settings not loaded
      const portfolioAccount = createPortfolioAccount(baseCurrency, t);
      // Check if portfolio account already exists to avoid duplication
      const portfolioExists = accounts.some((account) => account.id === PORTFOLIO_SCOPE_ID);

      if (!portfolioExists) {
        displayAccounts.push(portfolioAccount as Account);
      }
    }

    // Group accounts by type
    const accountsByType: Record<string, Account[]> = {};
    displayAccounts.forEach((account) => {
      if (!accountsByType[account.accountType]) {
        accountsByType[account.accountType] = [];
      }
      accountsByType[account.accountType].push(account);
    });

    // Sort groups to ensure PORTFOLIO appears first if it exists
    const sortedGroups = Object.entries(accountsByType).sort(([typeA], [typeB]) => {
      if (typeA === PORTFOLIO_ACCOUNT_TYPE) return -1;
      if (typeB === PORTFOLIO_ACCOUNT_TYPE) return 1;
      return 0;
    });

    // Render skeleton for loading state
    const renderSkeleton = () => {
      switch (variant) {
        case "card":
          return (
            <div className="border-border bg-background/50 h-full w-full rounded-lg border border-dashed p-2">
              <div className="flex flex-col items-center justify-center space-y-1">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="space-y-0.5 text-center">
                  <Skeleton className="mx-auto h-3 w-16" />
                  <Skeleton className="mx-auto h-3 w-20" />
                </div>
              </div>
            </div>
          );

        case "dropdown":
          return (
            <Button variant="outline" className="w-[240px] justify-between" disabled>
              <div className="flex w-full items-center gap-2">
                <Skeleton className="h-4 w-4 rounded-full" />
                <Skeleton className="h-4 w-36" />
              </div>
            </Button>
          );

        case "button":
          return (
            <Button variant="outline" className="h-8 px-3 py-1" size="sm" disabled>
              <Skeleton className="h-4 w-24" />
            </Button>
          );

        default:
          return null;
      }
    };

    // Render the appropriate trigger based on the variant
    const renderTrigger = () => {
      if (isLoading) {
        return renderSkeleton();
      }

      switch (variant) {
        case "card":
          return (
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-label={t("common:component.select_an_account")}
              className={cn(
                "h-full w-full justify-center rounded-lg border p-2 transition-colors",
                !selectedAccount && "border-dashed",
                open
                  ? "border-primary bg-primary/5"
                  : selectedAccount
                    ? "border-border bg-background"
                    : "border-border bg-background/50 hover:bg-background/80 hover:border-muted-foreground/50",
              )}
            >
              <div className="flex flex-col items-center justify-center space-y-1">
                <AnimatePresence mode="wait">
                  {selectedAccount ? (
                    <motion.div
                      key="account"
                      variants={iconContainerVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100 shadow-sm dark:bg-green-900/20"
                    >
                      <motion.div variants={iconVariants} initial="initial" animate="animate">
                        {(() => {
                          const IconComponent =
                            accountTypeIcons[selectedAccount.accountType] ?? Icons.CreditCard;
                          return (
                            <IconComponent className="h-4 w-4 text-green-600 dark:text-green-400" />
                          );
                        })()}
                      </motion.div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="select"
                      variants={iconContainerVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      className="bg-muted flex h-8 w-8 items-center justify-center rounded-full shadow-sm"
                    >
                      <motion.div variants={iconVariants} initial="initial" animate="animate">
                        <Icons.ChevronsUpDown className="text-muted-foreground h-4 w-4" />
                      </motion.div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="space-y-0 text-center">
                  <AnimatePresence mode="wait">
                    {selectedAccount ? (
                      <motion.div
                        key="account-info"
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -5 }}
                        transition={{ duration: 0.2 }}
                        className="space-y-0"
                      >
                        <p className="text-xs font-medium">{selectedAccount.name}</p>
                        <p className="text-muted-foreground text-xs">
                          {selectedAccount.accountType}
                        </p>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="select-text"
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -5 }}
                        transition={{ duration: 0.2 }}
                      >
                        <p className="text-xs font-medium">
                          {t("common:component.click_to_select_account")}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {t("common:component.required_for_import")}
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </Button>
          );

        case "dropdown":
          return (
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-label={iconOnly ? t("common:component.select_account") : undefined}
              size={iconOnly ? "icon" : "sm"}
              className={cn(
                "bg-secondary/30 hover:bg-muted/80 flex items-center rounded-full border-none",
                iconOnly ? "h-9 w-9 p-0" : "h-10 gap-1.5 px-3 py-1 text-sm font-medium",
                className,
              )}
            >
              {iconOnly ? (
                (() => {
                  const IconComponent = CustomIcon
                    ? CustomIcon
                    : selectedAccount
                      ? (accountTypeIcons[selectedAccount.accountType] ?? Icons.CreditCard)
                      : Icons.Wallet;
                  return <IconComponent className="h-4 w-4 shrink-0" />;
                })()
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    {selectedAccount ? (
                      <>
                        {(() => {
                          const IconComponent =
                            accountTypeIcons[selectedAccount.accountType] ?? Icons.CreditCard;
                          return <IconComponent className="h-4 w-4 shrink-0 opacity-70" />;
                        })()}
                        <span>{selectedAccount.name}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("common:component.select_an_account")}
                      </span>
                    )}
                  </div>
                  <Icons.ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </>
              )}
            </Button>
          );

        case "form":
          return (
            <Button
              ref={ref}
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className={cn(
                "border-input bg-background ring-offset-background placeholder:text-muted-foreground focus:ring-ring flex h-10 w-full items-center justify-between rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                className,
              )}
            >
              <div className="flex flex-1 items-center gap-2">
                {selectedAccount ? (
                  <>
                    {(() => {
                      const IconComponent =
                        accountTypeIcons[selectedAccount.accountType] ?? Icons.CreditCard;
                      return <IconComponent className="h-4 w-4 shrink-0 opacity-70" />;
                    })()}
                    <span className="truncate">{selectedAccount.name}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    {t("common:component.select_an_account")}
                  </span>
                )}
              </div>
              <Icons.ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
            </Button>
          );

        case "button":
          return (
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-label={iconOnly ? t("common:component.add_account") : undefined}
              className={cn(
                "bg-secondary/30 hover:bg-muted/80 flex items-center gap-1.5 rounded-md border-dashed text-sm font-medium",
                iconOnly ? "h-9 w-9 p-0" : "h-8 px-3 py-1",
                className,
              )}
              size={iconOnly ? "icon" : "sm"}
            >
              <Icons.Briefcase className="h-4 w-4" />
              {!iconOnly && (buttonText ?? t("common:component.select_account"))}
            </Button>
          );

        default:
          return null;
      }
    };

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{renderTrigger()}</PopoverTrigger>
        <PopoverContent
          className="p-0"
          align="start"
          sideOffset={8}
          style={{
            minWidth: variant === "card" ? "var(--radix-popover-trigger-width)" : "240px",
          }}
        >
          <Command className="w-full">
            <CommandInput placeholder={t("common:search_accounts")} />
            <CommandList>
              {isLoading ? (
                <div className="px-2 py-6 text-center">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                </div>
              ) : (
                <>
                  <CommandEmpty>{t("common:component.no_accounts_found")}</CommandEmpty>
                  {(() => {
                    // Insert the Portfolios group after the synthetic "PORTFOLIO" entry
                    // so user-created portfolios sit next to "All Portfolio" rather than
                    // between two SECURITIES groups. If no synthetic group exists, render
                    // Portfolios at the top.
                    const hasPortfolioGroup = sortedGroups.some(
                      ([t]) => t === PORTFOLIO_ACCOUNT_TYPE,
                    );
                    const portfoliosGroup = showPortfolios ? (
                      <CommandGroup key="__portfolios__" heading={t("common:component.portfolios")}>
                        {portfolios.map((p) => (
                          <CommandItem
                            key={p.id}
                            value={p.id}
                            keywords={[p.name]}
                            onSelect={() => {
                              onPortfolioSelect?.({ id: p.id, name: p.name });
                              setOpen(false);
                            }}
                            className="flex items-center py-1.5"
                          >
                            <div className="flex flex-1 items-center">
                              <Icons.Folder className="mr-2 h-4 w-4" />
                              <span>{p.name}</span>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ) : null;
                    return (
                      <>
                        {showPortfolios && !hasPortfolioGroup && portfoliosGroup}
                        {sortedGroups.map(([type, typeAccounts]) => (
                          <Fragment key={type}>
                            <CommandGroup heading={type}>
                              {typeAccounts.map((account) => {
                                const IconComponent =
                                  accountTypeIcons[account.accountType] ?? Icons.CreditCard;
                                return (
                                  <CommandItem
                                    key={account.id}
                                    value={account.id}
                                    keywords={[account.name, account.currency, account.accountType]}
                                    onSelect={() => {
                                      setSelectedAccount(account);
                                      setOpen(false);
                                    }}
                                    className="flex items-center py-1.5"
                                  >
                                    <div className="flex flex-1 items-center">
                                      <IconComponent className="mr-2 h-4 w-4" />
                                      <span>
                                        {account.name} ({account.currency})
                                      </span>
                                    </div>
                                    <Icons.Check
                                      className={cn(
                                        "ml-auto h-4 w-4",
                                        selectedAccount?.id === account.id
                                          ? "opacity-100"
                                          : "opacity-0",
                                      )}
                                    />
                                  </CommandItem>
                                );
                              })}
                            </CommandGroup>
                            {type === PORTFOLIO_ACCOUNT_TYPE && portfoliosGroup}
                          </Fragment>
                        ))}
                      </>
                    );
                  })()}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  },
);

AccountSelector.displayName = "AccountSelector";
