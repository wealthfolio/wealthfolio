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
import { cn } from "@/lib/utils";
import { useState } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { usePortfolios } from "@/hooks/use-portfolios";
import type { AccountScope } from "@/lib/types";

interface AccountScopeSelectorProps {
  value: AccountScope;
  onChange: (filter: AccountScope) => void;
  className?: string;
}

function filterLabel(
  filter: AccountScope,
  accounts: { id: string; name: string }[],
  portfolios: { id: string; name: string }[],
): string {
  if (filter.type === "all") return "All Accounts";
  if (filter.type === "account") {
    return accounts.find((a) => a.id === filter.accountId)?.name ?? "Account";
  }
  if (filter.type === "portfolio") {
    return portfolios.find((p) => p.id === filter.portfolioId)?.name ?? "Portfolio";
  }
  return `${filter.accountIds.length} Accounts`;
}

function isAccountChecked(value: AccountScope, accountId: string): boolean {
  if (value.type === "account") return value.accountId === accountId;
  if (value.type === "accounts") return value.accountIds.includes(accountId);
  return false;
}

export function AccountScopeSelector({ value, onChange, className }: AccountScopeSelectorProps) {
  const [open, setOpen] = useState(false);
  const { accounts } = useAccounts({ filterActive: false, includeArchived: false });
  const { data: portfolios = [] } = usePortfolios();

  const label = filterLabel(value, accounts, portfolios);

  const select = (filter: AccountScope) => {
    onChange(filter);
    setOpen(false);
  };

  // Toggle a single account in/out of the selection without closing the popover,
  // collapsing to account/all when the count reaches 1/0.
  const toggleAccount = (accountId: string) => {
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "bg-secondary/30 hover:bg-muted/80 flex items-center gap-1.5 rounded-full border-none text-sm font-medium",
            className,
          )}
          size="sm"
        >
          {value.type === "portfolio" ? (
            <Icons.Folder className="h-4 w-4 shrink-0 opacity-70" />
          ) : value.type === "account" || value.type === "accounts" ? (
            <Icons.CreditCard className="h-4 w-4 shrink-0 opacity-70" />
          ) : (
            <Icons.Wallet className="h-4 w-4 shrink-0 opacity-70" />
          )}
          <span>{label}</span>
          <Icons.ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start" sideOffset={8}>
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>

            <CommandGroup>
              <CommandItem onSelect={() => select({ type: "all" })}>
                <Icons.Wallet className="mr-2 h-4 w-4" />
                All Accounts
                <Icons.Check
                  className={cn(
                    "ml-auto h-4 w-4",
                    value.type === "all" ? "opacity-100" : "opacity-0",
                  )}
                />
              </CommandItem>
            </CommandGroup>

            {portfolios.length > 0 && (
              <CommandGroup heading="Portfolios">
                {portfolios.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={p.id}
                    keywords={[p.name]}
                    onSelect={() => select({ type: "portfolio", portfolioId: p.id })}
                  >
                    <Icons.Folder className="mr-2 h-4 w-4" />
                    {p.name}
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
              <CommandGroup heading="Accounts">
                {accounts.map((a) => {
                  const checked = isAccountChecked(value, a.id);
                  return (
                    <CommandItem
                      key={a.id}
                      value={a.id}
                      keywords={[a.name, a.currency]}
                      onSelect={() => toggleAccount(a.id)}
                    >
                      <Icons.CreditCard className="mr-2 h-4 w-4" />
                      {a.name}
                      <span className="text-muted-foreground ml-1 text-xs">({a.currency})</span>
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
      </PopoverContent>
    </Popover>
  );
}
