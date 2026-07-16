import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@wealthfolio/ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@wealthfolio/ui/components/ui/sheet";
import { useIsMobileViewport } from "@/hooks";
import { cn } from "@/lib/utils";
import { forwardRef, useState, type ComponentPropsWithoutRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useAccounts } from "@/hooks/use-accounts";
import { usePortfolios } from "@/hooks/use-portfolios";
import type { AccountScope } from "@/lib/types";

interface AccountScopeSelectorProps {
  value: AccountScope;
  onChange: (filter: AccountScope) => void;
  className?: string;
  triggerVariant?: "default" | "input";
  allowMultiAccount?: boolean;
}

function filterLabel(
  filter: AccountScope,
  accounts: { id: string; name: string }[],
  portfolios: { id: string; name: string }[],
  t: TFunction,
): string {
  if (filter.type === "all") return t("common:component.all_accounts");
  if (filter.type === "account") {
    return accounts.find((a) => a.id === filter.accountId)?.name ?? t("common:account");
  }
  if (filter.type === "portfolio") {
    return portfolios.find((p) => p.id === filter.portfolioId)?.name ?? t("common:portfolio");
  }
  return t("common:component.accounts_count", { count: filter.accountIds.length });
}

function isAccountChecked(value: AccountScope, accountId: string): boolean {
  if (value.type === "account") return value.accountId === accountId;
  if (value.type === "accounts") return value.accountIds.includes(accountId);
  return false;
}

function ScopeIcon({ value, className }: { value: AccountScope; className?: string }) {
  if (value.type === "portfolio") {
    return <Icons.Folder className={cn("h-4 w-4 shrink-0 opacity-70", className)} />;
  }
  if (value.type === "account" || value.type === "accounts") {
    return <Icons.CreditCard className={cn("h-4 w-4 shrink-0 opacity-70", className)} />;
  }
  return <Icons.Wallet className={cn("h-4 w-4 shrink-0 opacity-70", className)} />;
}

type SelectorTriggerProps = Omit<ComponentPropsWithoutRef<typeof Button>, "value" | "variant"> & {
  value: AccountScope;
  label: string;
  open: boolean;
  isMobile: boolean;
  triggerVariant: "default" | "input";
};

const SelectorTrigger = forwardRef<HTMLButtonElement, SelectorTriggerProps>(
  function SelectorTrigger(
    { value, label, open, isMobile, triggerVariant, className, ...props },
    ref,
  ) {
    const compact = isMobile && triggerVariant === "default";

    return (
      <Button
        ref={ref}
        variant="outline"
        role="combobox"
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2 font-medium",
          triggerVariant === "input"
            ? "bg-background/70 text-foreground hover:bg-background/70 focus-visible:border-foreground w-full justify-between rounded-lg border px-3 py-2.5 text-[14px] font-semibold shadow-none"
            : "bg-secondary/30 hover:bg-muted/80 rounded-full border-none",
          triggerVariant === "default" &&
            (isMobile
              ? "h-9 w-9 justify-center p-0"
              : "h-10 min-w-[220px] justify-between px-4 text-sm"),
          className,
        )}
        size={compact ? "sm" : "default"}
        {...props}
      >
        <ScopeIcon value={value} />
        {compact ? (
          <span className="sr-only">{label}</span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            <Icons.ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </>
        )}
      </Button>
    );
  },
);

function AccountScopeCommand({
  value,
  accounts,
  portfolios,
  onSelect,
  onToggleAccount,
  commandClassName,
  listClassName,
  itemClassName,
  groupClassName,
  t,
}: {
  value: AccountScope;
  accounts: { id: string; name: string; currency: string }[];
  portfolios: { id: string; name: string }[];
  onSelect: (filter: AccountScope) => void;
  onToggleAccount: (accountId: string) => void;
  commandClassName?: string;
  listClassName?: string;
  itemClassName?: string;
  groupClassName?: string;
  t: TFunction;
}) {
  return (
    <Command className={commandClassName}>
      <CommandInput placeholder={t("common:search_accounts")} />
      <CommandList className={listClassName}>
        <CommandEmpty>{t("common:component.no_results")}</CommandEmpty>

        <CommandGroup className={groupClassName}>
          <CommandItem className={itemClassName} onSelect={() => onSelect({ type: "all" })}>
            <Icons.Wallet className="mr-1 h-4 w-4" />
            <span className="min-w-0 flex-1 truncate">{t("common:component.all_accounts")}</span>
            <Icons.Check
              className={cn("ml-auto h-4 w-4", value.type === "all" ? "opacity-100" : "opacity-0")}
            />
          </CommandItem>
        </CommandGroup>

        {portfolios.length > 0 && (
          <CommandGroup heading={t("common:component.portfolios")} className={groupClassName}>
            {portfolios.map((p) => (
              <CommandItem
                key={p.id}
                value={p.id}
                keywords={[p.name]}
                className={itemClassName}
                onSelect={() => onSelect({ type: "portfolio", portfolioId: p.id })}
              >
                <Icons.Folder className="mr-1 h-4 w-4" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <Icons.Check
                  className={cn(
                    "ml-auto h-4 w-4",
                    value.type === "portfolio" && value.portfolioId === p.id
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {accounts.length > 0 && (
          <CommandGroup heading={t("common:component.accounts")} className={groupClassName}>
            {accounts.map((a) => {
              const checked = isAccountChecked(value, a.id);
              return (
                <CommandItem
                  key={a.id}
                  value={a.id}
                  keywords={[a.name, a.currency]}
                  className={itemClassName}
                  onSelect={() => onToggleAccount(a.id)}
                >
                  <Icons.CreditCard className="mr-1 h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">({a.currency})</span>
                  <Icons.Check
                    className={cn("ml-auto h-4 w-4", checked ? "opacity-100" : "opacity-0")}
                  />
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
}

export function AccountScopeSelector({
  value,
  onChange,
  className,
  triggerVariant = "default",
  allowMultiAccount = true,
}: AccountScopeSelectorProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobileViewport();
  const [open, setOpen] = useState(false);
  const { accounts } = useAccounts({ filterActive: false, includeArchived: false });
  const { data: portfolios = [] } = usePortfolios();

  const label = filterLabel(value, accounts, portfolios, t);

  const select = (filter: AccountScope) => {
    onChange(filter);
    setOpen(false);
  };

  // Toggle a single account in/out of the selection without closing the popover,
  // collapsing to account/all when the count reaches 1/0.
  const toggleAccount = (accountId: string) => {
    if (!allowMultiAccount) {
      select({ type: "account", accountId });
      return;
    }

    if (value.type === "account" && value.accountId === accountId) {
      onChange({ type: "all" });
    } else if (value.type === "account") {
      onChange({ type: "accounts", accountIds: [value.accountId, accountId] });
    } else if (value.type === "accounts") {
      const ids = value.accountIds.includes(accountId)
        ? value.accountIds.filter((id) => id !== accountId)
        : [...value.accountIds, accountId];
      if (ids.length === 0) onChange({ type: "all" });
      else if (ids.length === 1) onChange({ type: "account", accountId: ids[0] });
      else onChange({ type: "accounts", accountIds: ids });
    } else {
      // Currently all/portfolio — start a new single-account selection.
      onChange({ type: "account", accountId });
    }
  };

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <SelectorTrigger
            value={value}
            label={label}
            open={open}
            isMobile
            triggerVariant={triggerVariant}
            className={className}
          />
        </SheetTrigger>
        <SheetContent side="bottom" className="rounded-t-4xl mx-1 h-[80vh] p-0">
          <SheetHeader className="border-border border-b px-6 py-4">
            <SheetTitle>{t("common:component.select_account_scope")}</SheetTitle>
          </SheetHeader>
          <AccountScopeCommand
            value={value}
            accounts={accounts}
            portfolios={portfolios}
            onSelect={select}
            onToggleAccount={toggleAccount}
            t={t}
            commandClassName="h-[calc(80vh-4.5rem)] rounded-none"
            listClassName="max-h-none flex-1 px-2 py-2"
            groupClassName="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
            itemClassName="min-h-12 rounded-xl px-3 py-3 text-base"
          />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SelectorTrigger
          value={value}
          label={label}
          open={open}
          isMobile={false}
          triggerVariant={triggerVariant}
          className={className}
        />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end" sideOffset={8}>
        <AccountScopeCommand
          value={value}
          accounts={accounts}
          portfolios={portfolios}
          onSelect={select}
          onToggleAccount={toggleAccount}
          t={t}
          itemClassName="py-2"
        />
      </PopoverContent>
    </Popover>
  );
}
