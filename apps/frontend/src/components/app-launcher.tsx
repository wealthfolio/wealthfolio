import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import {
  useRecalculatePortfolioMutation,
  useUpdatePortfolioMutation,
} from "@/hooks/use-calculate-portfolio";
import { useHoldings } from "@/hooks/use-holdings";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useIsMobileViewport } from "@/hooks/use-platform";
import {
  AccountType,
  HoldingType,
  PORTFOLIO_ACCOUNT_TYPE,
  PORTFOLIO_SCOPE_ID,
} from "@/lib/constants";
import { useSettingsContext } from "@/lib/settings-provider";
import { Account } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useNavigation } from "@/pages/layouts/navigation/app-navigation";
import { resolveNavigationIcon } from "@/pages/layouts/navigation/navigation-icons";
import { useNavigationMode } from "@/pages/layouts/navigation/navigation-mode-context";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  DialogDescription,
  DialogTitle,
  Icons,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  type Icon,
} from "@wealthfolio/ui";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

interface RecentItem {
  type: "action" | "holding" | "account";
  id: string; // For actions: href, for holdings: symbol, for accounts: accountId
  label: string;
  timestamp: number;
}

const MAX_RECENT_ITEMS = 5;
const RECENT_ITEMS_KEY = "app-launcher-recent-items";

interface LauncherHoldingItem {
  id: string;
  symbol: string;
  name?: string | null;
}
interface LauncherAccountItem {
  id: string;
  name: string;
  accountType: Account["accountType"];
}
interface LauncherActionItem {
  title: string;
  href: string;
  icon?: ReactNode;
  keywords?: string[];
  label?: string;
  disabled?: boolean;
}

const accountTypeIcons: Record<AccountType | typeof PORTFOLIO_ACCOUNT_TYPE, Icon> = {
  [AccountType.SECURITIES]: Icons.Briefcase,
  [AccountType.CASH]: Icons.DollarSign,
  [AccountType.CREDIT_CARD]: Icons.CreditCard,
  [AccountType.CRYPTOCURRENCY]: Icons.Bitcoin,
  [PORTFOLIO_ACCOUNT_TYPE]: Icons.Wallet,
};

export function AppLauncher() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const navigation = useNavigation();
  const { accounts, isLoading: isAccountsLoading } = useAccounts();
  const { holdings, isLoading: isHoldingsLoading } = useHoldings({ type: "all" });
  const { isBalanceHidden, toggleBalanceVisibility } = useBalancePrivacy();
  const { updateSettings } = useSettingsContext();
  const { mutate: updatePortfolio, isPending: isUpdatingPortfolio } = useUpdatePortfolioMutation();
  const { mutate: recalculatePortfolio, isPending: isRecalculatingPortfolio } =
    useRecalculatePortfolioMutation();
  const {
    isLaunchBar,
    setMode: setNavigationMode,
    isFocusMode,
    toggleFocusMode,
  } = useNavigationMode();
  const isMobileViewport = useIsMobileViewport();
  const iconClassName = isMobileViewport
    ? "text-muted-foreground mr-3 h-5 w-5"
    : "text-muted-foreground mr-2 h-4 w-4";

  // Recent items state
  const [recentItems, setRecentItems] = usePersistentState<RecentItem[]>(RECENT_ITEMS_KEY, []);

  const addRecentItem = useCallback(
    (item: Omit<RecentItem, "timestamp">) => {
      setRecentItems((prev) => {
        // Remove existing item with same id and type
        const filtered = prev.filter((i) => !(i.id === item.id && i.type === item.type));
        // Add new item at the beginning with timestamp
        const newItem: RecentItem = { ...item, timestamp: Date.now() };
        const updated = [newItem, ...filtered].slice(0, MAX_RECENT_ITEMS);
        return updated;
      });
    },
    [setRecentItems],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Cmd/Ctrl+K or Cmd/Ctrl+P
      const isModifierK =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k";

      const isModifierP =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "p";

      if (!isModifierK && !isModifierP) {
        return;
      }

      // Allow native behavior in editable fields
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable = target?.isContentEditable;
      if (tagName === "input" || tagName === "textarea" || tagName === "select" || isEditable) {
        return;
      }

      // Prevent browser's default Cmd/Ctrl+K and Cmd/Ctrl+P behavior
      event.preventDefault();
      event.stopPropagation();
      setOpen((prev) => !prev);
    };

    // Use capture phase to intercept before other handlers
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  useEffect(() => {
    setOpen(false);
    setSearch("");
  }, [location.pathname]);

  // Combine navigation items with additional quick actions
  const actionItems = useMemo<LauncherActionItem[]>(() => {
    // Build smart URL with context awareness and optional activity type
    const buildTransactionUrl = (activityType?: string) => {
      const path = location.pathname;
      const params = new URLSearchParams();

      // Add activity type if provided
      if (activityType) {
        params.set("type", activityType);
      }

      // Check if on account page: /accounts/:id
      const accountRegex = /^\/accounts\/([^/]+)$/;
      const accountMatch = accountRegex.exec(path);
      if (accountMatch) {
        const accountId = accountMatch[1];
        params.set("account", accountId);
        params.set("redirect-to", path);
      }

      // Check if on asset profile page: /holdings/:assetId (only for trade activities)
      if (!activityType || ["BUY", "SELL"].includes(activityType)) {
        const assetRegex = /^\/holdings\/([^/]+)$/;
        const assetMatch = assetRegex.exec(path);
        if (assetMatch) {
          const assetId = decodeURIComponent(assetMatch[1]);
          params.set("assetId", assetId);
          if (!params.has("redirect-to")) {
            params.set("redirect-to", path);
          }
        }
      }

      return `/activities/manage${params.toString() ? `?${params.toString()}` : ""}`;
    };

    // Additional quick actions not in main navigation
    const quickActions: LauncherActionItem[] = [
      // Navigation mode switch and focus mode are desktop-only
      ...(isMobileViewport
        ? []
        : [
            {
              title: isLaunchBar
                ? t("common:component.switch_to_sidebar_navigation")
                : t("common:component.switch_to_floating_navigation"),
              href: isLaunchBar ? "#use-sidebar-navigation" : "#use-launchbar-navigation",
              icon: isLaunchBar ? (
                <Icons.PanelLeft className="size-6" />
              ) : (
                <Icons.RectangleEllipsis className="size-6" />
              ),
              keywords: ["navigation", "sidebar", "floating", "bottom", "switch", "layout"],
              label: isLaunchBar
                ? t("common:component.switch_to_sidebar_navigation")
                : t("common:component.switch_to_floating_navigation"),
            },
            {
              title: isFocusMode
                ? t("common:component.exit_focus_mode")
                : t("common:component.enter_focus_mode"),
              href: "#toggle-focus-mode",
              icon: <Icons.Fullscreen className="size-6" />,
              keywords: ["focus", "hide navigation", "minimal", "distraction-free", "layout"],
              label: t("common:component.toggle_focus_mode"),
            },
          ]),
      {
        title: isBalanceHidden
          ? t("common:component.show_balance")
          : t("common:component.hide_balance"),
        href: "#toggle-privacy",
        icon: isBalanceHidden ? (
          <Icons.Eye className="size-6" />
        ) : (
          <Icons.EyeOff className="size-6" />
        ),
        keywords: ["privacy", "hide", "show", "balance", "toggle", "visibility"],
        label: isBalanceHidden
          ? t("common:component.show_balance")
          : t("common:component.hide_balance"),
      },
      {
        title: t("common:component.theme_light"),
        href: "#theme-light",
        icon: <Icons.Sun className="size-6" />,
        keywords: ["theme", "light", "appearance", "mode"],
        label: t("common:component.theme_light"),
      },
      {
        title: t("common:component.theme_dark"),
        href: "#theme-dark",
        icon: <Icons.Moon className="size-6" />,
        keywords: ["theme", "dark", "appearance", "mode"],
        label: t("common:component.theme_dark"),
      },
      {
        title: t("common:component.theme_system"),
        href: "#theme-system",
        icon: <Icons.Monitor className="size-6" />,
        keywords: ["theme", "system", "appearance", "mode", "auto"],
        label: t("common:component.theme_system"),
      },
      {
        title: t("common:component.update_quotes"),
        href: "#update-portfolio",
        icon: isUpdatingPortfolio ? (
          <Icons.Spinner className="size-6 animate-spin" />
        ) : (
          <Icons.Refresh className="size-6" />
        ),
        keywords: ["update", "portfolio", "market data", "quotes", "refresh", "sync"],
        label: isUpdatingPortfolio
          ? t("common:component.updating_quotes")
          : t("common:component.update_quotes_label"),
        disabled: isUpdatingPortfolio,
      },
      {
        title: t("common:component.rebuild_full_history"),
        href: "#recalculate-portfolio",
        icon: isRecalculatingPortfolio ? (
          <Icons.Spinner className="size-6 animate-spin" />
        ) : (
          <Icons.Clock className="size-6" />
        ),
        keywords: ["rebuild", "history", "recalculate", "portfolio", "backfill", "full"],
        label: isRecalculatingPortfolio
          ? t("common:component.rebuilding_history")
          : t("common:component.rebuild_full_history_label"),
        disabled: isRecalculatingPortfolio,
      },
      {
        title: t("common:component.record_buy"),
        href: buildTransactionUrl("BUY"),
        icon: <Icons.Plus className="size-6" />,
        keywords: ["buy", "purchase", "trade", "stock", "shares", "record"],
        label: t("common:component.record_buy"),
      },
      {
        title: t("common:component.record_sell"),
        href: buildTransactionUrl("SELL"),
        icon: <Icons.TrendingDown className="size-6" />,
        keywords: ["sell", "sale", "trade", "stock", "shares", "record"],
        label: t("common:component.record_sell"),
      },
      {
        title: t("common:component.record_dividend"),
        href: buildTransactionUrl("DIVIDEND"),
        icon: <Icons.Income className="size-6" />,
        keywords: ["dividend", "income", "payout", "distribution", "record"],
        label: t("common:component.record_dividend"),
      },
      {
        title: t("common:component.record_deposit"),
        href: buildTransactionUrl("DEPOSIT"),
        icon: <Icons.DollarSign className="size-6" />,
        keywords: ["deposit", "add", "money", "cash", "fund", "record"],
        label: t("common:component.record_deposit"),
      },
      {
        title: t("common:component.record_withdrawal"),
        href: buildTransactionUrl("WITHDRAWAL"),
        icon: <Icons.ArrowDown className="size-6" />,
        keywords: ["withdrawal", "withdraw", "money", "cash", "take out", "record"],
        label: t("common:component.record_withdrawal"),
      },
      {
        title: t("common:component.add_holding"),
        href: "/activities/add?tab=holdings",
        icon: <Icons.Wallet className="size-6" />,
        keywords: ["holding", "add", "position", "import", "record"],
        label: t("common:component.add_holding"),
      },
      {
        title: t("common:component.record_interest"),
        href: buildTransactionUrl("INTEREST"),
        icon: <Icons.Percent className="size-6" />,
        keywords: ["interest", "income", "earned", "bank", "record"],
        label: t("common:component.record_interest"),
      },
      {
        title: t("common:component.add_transaction"),
        href: buildTransactionUrl(),
        icon: <Icons.Activity className="size-6" />,
        keywords: ["add", "new", "create", "transaction", "activity", "any"],
        label: t("common:component.add_transaction"),
      },
      {
        title: t("common:component.import_activities"),
        href: "/import",
        icon: <Icons.Import className="size-6" />,
        keywords: ["import", "csv", "upload", "file", "bulk"],
        label: t("common:component.import_activities"),
      },
      {
        title: t("common:component.manage_securities"),
        href: "/settings/securities",
        icon: <Icons.BadgeDollarSign className="size-6" />,
        keywords: ["securities", "assets", "stocks", "manage", "edit", "settings"],
        label: t("common:component.manage_securities"),
      },
      {
        title: t("common:component.manage_accounts"),
        href: "/settings/accounts",
        icon: <Icons.CreditCard className="size-6" />,
        keywords: ["accounts", "manage", "edit", "settings"],
        label: t("common:component.manage_accounts"),
      },
      {
        title: t("common:component.manage_goals"),
        href: "/goals",
        icon: <Icons.Goal className="size-6" />,
        keywords: ["goals", "manage", "edit", "settings"],
        label: t("common:component.manage_goals"),
      },
      {
        title: t("common:component.manage_contribution_limits"),
        href: "/settings/contribution-limits",
        icon: <Icons.TrendingUp className="size-6" />,
        keywords: ["contribution", "limits", "manage", "edit", "settings"],
        label: t("common:component.manage_contribution_limits"),
      },
    ];

    const navItems = [
      ...(navigation.primary ?? []),
      ...(navigation.secondary ?? []),
      ...(navigation.addons ?? []),
    ] as LauncherActionItem[];

    return [...quickActions, ...navItems];
  }, [
    isBalanceHidden,
    isLaunchBar,
    isMobileViewport,
    isRecalculatingPortfolio,
    isUpdatingPortfolio,
    location.pathname,
    navigation,
    isFocusMode,
    t,
  ]);

  const holdingOptions = useMemo<LauncherHoldingItem[]>(() => {
    if (!holdings?.length) {
      return [];
    }
    const seenSymbols = new Set<string>();
    return holdings
      .filter((holding) => holding.holdingType !== HoldingType.CASH && holding.instrument?.symbol)
      .map((holding) => ({
        id: holding.instrument?.id ?? holding.id,
        symbol: holding.instrument?.symbol ?? "",
        name: holding.instrument?.name ?? null,
      }))
      .filter((holding) => {
        if (seenSymbols.has(holding.symbol)) {
          return false;
        }
        seenSymbols.add(holding.symbol);
        return true;
      })
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [holdings]);
  const accountOptions = useMemo<LauncherAccountItem[]>(() => {
    if (!accounts?.length) {
      return [];
    }
    return accounts
      .filter((account) => account.id !== PORTFOLIO_SCOPE_ID)
      .map((account) => ({
        id: account.id,
        name: account.name,
        accountType: account.accountType,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [accounts]);
  const handleSelectHolding = (id: string, symbol: string, name?: string | null) => {
    if (!id) {
      return;
    }
    addRecentItem({
      type: "holding",
      id: id,
      label: name ? `${symbol} - ${name}` : symbol,
    });
    setSearch("");
    setOpen(false);
    navigate(`/holdings/${encodeURIComponent(id)}`);
  };
  const handleSelectAccount = (accountId: string, accountName: string) => {
    if (!accountId) {
      return;
    }
    addRecentItem({
      type: "account",
      id: accountId,
      label: accountName,
    });
    setSearch("");
    setOpen(false);
    navigate(`/accounts/${accountId}`);
  };

  const handleSelectAction = (path: string, label?: string) => {
    if (!path) {
      return;
    }

    // Handle special toggle actions (don't track these as recent)
    if (path === "#toggle-privacy") {
      toggleBalanceVisibility();
      setSearch("");
      setOpen(false);
      return;
    }

    if (path === "#theme-light") {
      updateSettings({ theme: "light" });
      setSearch("");
      setOpen(false);
      return;
    }

    if (path === "#theme-dark") {
      updateSettings({ theme: "dark" });
      setSearch("");
      setOpen(false);
      return;
    }

    if (path === "#theme-system") {
      updateSettings({ theme: "system" });
      setSearch("");
      setOpen(false);
      return;
    }

    if (path === "#update-portfolio") {
      if (isUpdatingPortfolio) {
        return;
      }
      updatePortfolio();
      setSearch("");
      setOpen(false);
      return;
    }

    if (path === "#recalculate-portfolio") {
      if (isRecalculatingPortfolio) {
        return;
      }
      recalculatePortfolio();
      setSearch("");
      setOpen(false);
      return;
    }

    if (path === "#use-launchbar-navigation") {
      setNavigationMode("launchbar");
      setSearch("");
      setOpen(false);
      return;
    }

    if (path === "#use-sidebar-navigation") {
      setNavigationMode("sidebar");
      setSearch("");
      setOpen(false);
      return;
    }

    if (path === "#toggle-focus-mode") {
      toggleFocusMode();
      setSearch("");
      setOpen(false);
      return;
    }

    // Track navigable actions as recent
    if (label) {
      addRecentItem({
        type: "action",
        id: path,
        label,
      });
    }

    setSearch("");
    setOpen(false);
    navigate(path);
  };

  const handleSelectRecent = (item: RecentItem) => {
    // Update the timestamp for this item (move to front)
    addRecentItem({
      type: item.type,
      id: item.id,
      label: item.label,
    });

    setSearch("");
    setOpen(false);

    switch (item.type) {
      case "holding":
        navigate(`/holdings/${encodeURIComponent(item.id)}`);
        break;
      case "account":
        navigate(`/accounts/${item.id}`);
        break;
      case "action":
        navigate(item.id);
        break;
    }
  };

  // Filter items based on search
  const searchLower = search.toLowerCase();
  const filteredActions = actionItems.filter((action) => {
    const displayText = (action.label ?? action.title).toLowerCase();
    const keywords = (action.keywords ?? []).map((k) => k.toLowerCase());
    return displayText.includes(searchLower) || keywords.some((k) => k.includes(searchLower));
  });

  const filteredHoldings = holdingOptions.filter((holding) => {
    return (
      holding.symbol.toLowerCase().includes(searchLower) ||
      holding.name?.toLowerCase().includes(searchLower)
    );
  });

  const filteredAccounts = accountOptions.filter((account) => {
    return account.name.toLowerCase().includes(searchLower);
  });

  // Filter recent items based on search (only show when searching or when no search)
  const filteredRecent = recentItems.filter((item) => {
    if (!searchLower) return true;
    return item.label.toLowerCase().includes(searchLower);
  });

  // Show recent items only when there's no search, or when searching and they match
  const showRecent = !searchLower ? recentItems.length > 0 : filteredRecent.length > 0;

  const hasResults =
    filteredActions.length > 0 ||
    filteredHoldings.length > 0 ||
    filteredAccounts.length > 0 ||
    showRecent;

  const renderIcon = (icon?: ReactNode) => resolveNavigationIcon(icon, iconClassName);

  const commandContent = (
    <>
      <CommandInput
        placeholder={t("common:component.search_actions_holdings_accounts")}
        autoFocus={!isMobileViewport && open}
        value={search}
        onValueChange={setSearch}
        className={cn(isMobileViewport ? "text-base" : "py-8")}
      />
      <CommandList
        className={cn(
          "flex-1",
          isMobileViewport ? "max-h-[calc(80vh-160px)] px-2 pb-8" : "max-h-[420px]",
        )}
      >
        {!hasResults && <CommandEmpty>{t("common:component.no_matches_found")}</CommandEmpty>}
        {showRecent && (
          <CommandGroup heading={t("common:component.recent")}>
            {(searchLower ? filteredRecent : recentItems).map((item) => {
              const getRecentIcon = () => {
                switch (item.type) {
                  case "holding":
                    return <Icons.TrendingUp className={iconClassName} />;
                  case "account":
                    return <Icons.Wallet className={iconClassName} />;
                  case "action":
                    return <Icons.Clock className={iconClassName} />;
                  default:
                    return <Icons.Clock className={iconClassName} />;
                }
              };

              return (
                <CommandItem
                  key={`${item.type}-${item.id}`}
                  value={`recent-${item.label}`}
                  onSelect={() => handleSelectRecent(item)}
                  className={cn(isMobileViewport ? "gap-3 py-4 text-base" : undefined)}
                >
                  {getRecentIcon()}
                  <span className="font-medium">{item.label}</span>
                  <span className="text-muted-foreground ml-auto text-xs capitalize">
                    {item.type}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {filteredActions.length > 0 && (
          <CommandGroup heading={t("common:actions")}>
            {filteredActions.map((action, index) => {
              const resizedIcon = renderIcon(action.icon);
              const displayText = action.label ?? action.title;

              return (
                <CommandItem
                  key={action.href ?? index}
                  value={displayText}
                  keywords={action.keywords ?? []}
                  disabled={action.disabled}
                  onSelect={() => handleSelectAction(action.href, displayText)}
                  className={cn(isMobileViewport ? "gap-3 py-4 text-base" : undefined)}
                >
                  {resizedIcon}
                  <span className="font-medium">{displayText}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {(isHoldingsLoading || filteredHoldings.length > 0) && (
          <CommandGroup heading={t("common:component.holdings")}>
            {isHoldingsLoading ? (
              <CommandItem disabled className={cn(isMobileViewport ? "py-4 text-base" : undefined)}>
                {t("common:component.loading_holdings")}
              </CommandItem>
            ) : (
              filteredHoldings.map((holding) => (
                <CommandItem
                  key={holding.id}
                  value={holding.symbol}
                  keywords={[
                    holding.symbol,
                    holding.name ?? "",
                    "holding",
                    "asset",
                    "stock",
                  ].filter((keyword): keyword is string => Boolean(keyword))}
                  onSelect={() => handleSelectHolding(holding.id, holding.symbol, holding.name)}
                  className={cn(isMobileViewport ? "gap-3 py-4 text-base" : undefined)}
                >
                  <Icons.TrendingUp className={iconClassName} />
                  <span className="font-medium">{holding.symbol}</span>
                  {holding.name ? (
                    <span className="text-muted-foreground ml-2 truncate">{holding.name}</span>
                  ) : null}
                </CommandItem>
              ))
            )}
          </CommandGroup>
        )}
        {(isAccountsLoading || filteredAccounts.length > 0) && (
          <CommandGroup heading={t("common:component.accounts")}>
            {isAccountsLoading ? (
              <CommandItem disabled className={cn(isMobileViewport ? "py-4 text-base" : undefined)}>
                {t("common:component.loading_accounts")}
              </CommandItem>
            ) : (
              filteredAccounts.map((account) => {
                const IconComponent = accountTypeIcons[account.accountType] ?? Icons.Wallet;
                return (
                  <CommandItem
                    key={account.id}
                    value={account.name}
                    keywords={[account.name, account.accountType, "account"].filter(
                      (keyword): keyword is string => Boolean(keyword),
                    )}
                    onSelect={() => handleSelectAccount(account.id, account.name)}
                    className={cn(isMobileViewport ? "gap-3 py-4 text-base" : undefined)}
                  >
                    <IconComponent className={iconClassName} />
                    <span className="font-medium">{account.name}</span>
                  </CommandItem>
                );
              })
            )}
          </CommandGroup>
        )}
      </CommandList>
    </>
  );

  if (isMobileViewport) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto flex h-[85vh] w-full max-w-screen-sm flex-col overflow-hidden rounded-t-3xl border-none px-0 pb-6 pt-4"
        >
          <SheetHeader className="px-6">
            <SheetTitle>{t("common:component.quick_launch")}</SheetTitle>
          </SheetHeader>
          <Command
            className={cn(
              "flex flex-1 flex-col bg-transparent",
              "[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:font-medium",
              "[&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2",
              "[&_[cmdk-input-wrapper]]:px-5 [&_[cmdk-input]]:h-14 [&_[cmdk-input]]:text-base",
              "[&_[cmdk-item]]:px-4 [&_[cmdk-item]]:py-4 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5",
              "[&_[data-cmdk-input-wrapper]_svg]:h-5 [&_[data-cmdk-input-wrapper]_svg]:w-5",
            )}
          >
            {commandContent}
          </Command>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <DialogTitle className="sr-only">{t("common:component.command_palette")}</DialogTitle>
      <DialogDescription className="sr-only">
        {t("common:component.command_palette_description")}
      </DialogDescription>
      {commandContent}
    </CommandDialog>
  );
}
export default AppLauncher;
