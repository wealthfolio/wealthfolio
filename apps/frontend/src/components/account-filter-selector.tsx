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
import type { AccountFilter } from "@/lib/types";

interface AccountFilterSelectorProps {
  value: AccountFilter;
  onChange: (filter: AccountFilter) => void;
  className?: string;
}

function filterLabel(
  filter: AccountFilter,
  accounts: { id: string; name: string }[],
  portfolios: { id: string; name: string }[],
): string {
  if (filter.type === "all") return "All Accounts";
  if (filter.type === "account") {
    return accounts.find((a) => a.id === filter.accountId)?.name ?? "Account";
  }
  return portfolios.find((p) => p.id === filter.portfolioId)?.name ?? "Portfolio";
}

export function AccountFilterSelector({ value, onChange, className }: AccountFilterSelectorProps) {
  const [open, setOpen] = useState(false);
  const { accounts } = useAccounts({ filterActive: false, includeArchived: false });
  const { data: portfolios = [] } = usePortfolios();

  const label = filterLabel(value, accounts, portfolios);

  const select = (filter: AccountFilter) => {
    onChange(filter);
    setOpen(false);
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
          ) : value.type === "account" ? (
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
                  <CommandItem key={p.id} value={p.id} keywords={[p.name]} disabled>
                    <Icons.Folder className="mr-2 h-4 w-4" />
                    {p.name}
                    <span className="text-muted-foreground ml-auto text-xs">Coming soon</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {accounts.length > 0 && (
              <CommandGroup heading="Accounts">
                {accounts.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={a.id}
                    keywords={[a.name, a.currency]}
                    onSelect={() => select({ type: "account", accountId: a.id })}
                  >
                    <Icons.CreditCard className="mr-2 h-4 w-4" />
                    {a.name}
                    <span className="text-muted-foreground ml-1 text-xs">({a.currency})</span>
                    <Icons.Check
                      className={cn(
                        "ml-auto h-4 w-4",
                        value.type === "account" && value.accountId === a.id
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
