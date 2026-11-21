import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@wealthfolio/ui";

import type { TaxonomyCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

import { findPayee } from "../lib/payee";

interface PayeeFieldProps {
  /** The payee's name, or "" for none. */
  value: string;
  onChange: (name: string) => void;
  /** Existing payees, listed and searched in the popover. */
  payees: TaxonomyCategory[];
  isMobile?: boolean;
}

/**
 * Who the transaction was with. Opens the same searchable popover as the
 * Event field: pick a payee already used, or type a new name and add it. The
 * new payee itself is created when the transaction is saved.
 */
export function PayeeField({ value, onChange, payees, isMobile }: PayeeFieldProps) {
  const { t } = useTranslation();
  const labelId = useId();
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("space-y-2", isMobile && "space-y-0")}>
      <span
        id={labelId}
        className={cn("block text-sm font-medium", isMobile && "px-4 pt-3.5 text-base font-normal")}
      >
        {t("spending:cashForm.payee")}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="field"
              aria-labelledby={labelId}
              data-testid="payee-field"
              className={cn("w-full justify-between", isMobile && "rounded-none border-0 px-4")}
            />
          }
        >
          <span className={cn("min-w-0 truncate", !value && "text-muted-foreground")}>
            {value || t("spending:cashForm.payeePlaceholder")}
          </span>
          <Icons.ChevronDown className="ms-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent className="w-70 p-0" align="start">
          <PayeeCommand
            value={value}
            payees={payees}
            onPick={(name) => {
              onChange(name);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface PayeeCommandProps {
  /** The current payee's name, or "" for none: it gets the check mark, and the "No payee" row. */
  value: string;
  payees: TaxonomyCategory[];
  /** Called with a payee's name, a new name to add, or "" to clear. */
  onPick: (name: string) => void;
  /**
   * Offers "No payee" even with no current payee: for a selection of several
   * transactions, some of which may have one.
   */
  clearable?: boolean;
}

/**
 * The searchable payee list, for any popover: existing payees by name, an
 * `Add "<name>"` row for a name no payee has yet, and "No payee" when one is set.
 */
export function PayeeCommand({ value, payees, onPick, clearable = false }: PayeeCommandProps) {
  const canClear = value !== "" || clearable;
  const { t } = useTranslation();
  const [search, setSearch] = useState("");

  const sortedPayees = useMemo(
    () => [...payees].sort((a, b) => a.name.localeCompare(b.name)),
    [payees],
  );
  const typed = search.trim();
  const canAdd = typed !== "" && !findPayee(payees, typed);

  const pick = (name: string) => {
    onPick(name);
    setSearch("");
  };

  return (
    <Command>
      <CommandInput
        placeholder={t("spending:cashForm.payeeSearch")}
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>
          <div className="text-muted-foreground p-3 text-center text-xs">
            {t("spending:cashForm.payeeEmpty")}
          </div>
        </CommandEmpty>
        {sortedPayees.length > 0 && (
          <CommandGroup>
            {sortedPayees.map((payee) => (
              <CommandItem
                key={payee.id}
                value={payee.name}
                onSelect={() => pick(payee.name)}
                className="flex items-center gap-2"
              >
                <Icons.Check
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    payee.name === value ? "opacity-100" : "opacity-0",
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{payee.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {(canAdd || canClear) && (
          <>
            <CommandSeparator />
            <CommandGroup>
              {canAdd && (
                <CommandItem
                  // Carries the typed text, so the search never filters it out.
                  value={`${typed} add-payee`}
                  onSelect={() => pick(typed)}
                  className="text-primary flex items-center gap-2"
                >
                  <Icons.Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("spending:cashForm.payeeAdd", { name: typed })}
                </CommandItem>
              )}
              {canClear && typed === "" && (
                <CommandItem
                  onSelect={() => pick("")}
                  className="text-muted-foreground flex items-center gap-2"
                >
                  <Icons.X className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("spending:cashForm.payeeClear")}
                </CommandItem>
              )}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
