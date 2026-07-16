import { forwardRef, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useIsMobile as defaultUseIsMobile } from "../../hooks/use-mobile";
import { worldCurrencies } from "../../lib/currencies";
import { cn } from "../../lib/utils";
import type { ButtonProps } from "../ui/button";
import { Button } from "../ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Icons } from "../ui/icons";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";

interface CurrencyInputCustomProps {
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  displayMode?: "auto" | "desktop" | "mobile";
  /** Controls how the selected value is displayed in the trigger button. */
  valueDisplay?: "label" | "code" | "code-label";
  /** When true, focuses the search input when the picker opens. */
  autoFocusSearch?: boolean;
  /** Controlled open state (optional). */
  open?: boolean;
  /** Controlled open change handler (optional). */
  onOpenChange?: (open: boolean) => void;
  useIsMobile?: () => boolean;
  /** When true, allows creating custom currencies not in the list. */
  allowCustom?: boolean;
}

type CurrencyInputProps = CurrencyInputCustomProps & Omit<ButtonProps, "onChange" | "value">;

const popularCurrencies = ["USD", "CAD", "EUR", "GBP", "CHF"];

export const CurrencyInput = forwardRef<HTMLButtonElement, CurrencyInputProps>(
  (
    {
      value,
      onChange,
      className,
      placeholder = "Select account currency",
      displayMode = "auto",
      valueDisplay = "label",
      autoFocusSearch = false,
      open: openProp,
      onOpenChange,
      useIsMobile,
      allowCustom = true,
      ...props
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const isControlled = openProp !== undefined;
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const open = isControlled ? openProp : uncontrolledOpen;
    const setOpen = (nextOpen: boolean) => {
      if (isControlled) {
        onOpenChange?.(nextOpen);
      } else {
        setUncontrolledOpen(nextOpen);
      }
    };
    const [searchQuery, setSearchQuery] = useState("");
    const [desktopSearchQuery, setDesktopSearchQuery] = useState("");
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const desktopCommandInputRef = useRef<HTMLInputElement | null>(null);

    const useIsMobileHook = useIsMobile ?? defaultUseIsMobile;
    const isMobileFromHook = useIsMobileHook();
    const isMobile = displayMode === "mobile" || (displayMode === "auto" && isMobileFromHook);

    const selectedCurrency = worldCurrencies.find((currency) => currency.value === value);
    const buttonLabel = selectedCurrency
      ? valueDisplay === "code"
        ? selectedCurrency.value
        : valueDisplay === "code-label"
          ? `${selectedCurrency.value} - ${selectedCurrency.label}`
          : selectedCurrency.label
      : value || placeholder;

    const handleSelect = (currencyValue: string) => {
      onChange(currencyValue);
      setOpen(false);
      setSearchQuery("");
      setDesktopSearchQuery("");
    };

    const getCustomCurrencyValue = (query: string) => {
      const trimmed = query.trim();
      if (!allowCustom || !trimmed) return undefined;
      if (worldCurrencies.some((currency) => currency.value === trimmed)) return undefined;
      return trimmed;
    };

    const handleOpenAutoFocus = useCallback(
      (e: Event) => {
        if (!autoFocusSearch) return;
        e.preventDefault();
        if (isMobile) {
          searchInputRef.current?.focus();
        } else {
          desktopCommandInputRef.current?.focus();
        }
      },
      [autoFocusSearch, isMobile],
    );

    if (isMobile) {
      const filteredCurrencies = worldCurrencies.filter(
        (curr) =>
          curr.value.toLowerCase().includes(searchQuery.toLowerCase()) ||
          curr.label.toLowerCase().includes(searchQuery.toLowerCase()),
      );
      const customCurrencyValue = getCustomCurrencyValue(searchQuery);
      const mobileDisplayText = selectedCurrency
        ? valueDisplay === "code"
          ? selectedCurrency.value
          : valueDisplay === "label"
            ? selectedCurrency.label
            : `${selectedCurrency.value} - ${selectedCurrency.label}`
        : value || placeholder;

      return (
        <>
          <Button
            ref={ref}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              "h-input-height w-full justify-between truncate rounded-md font-normal",
              !value && "text-muted-foreground",
              className,
            )}
            onClick={() => setOpen(true)}
            {...props}
          >
            <span className="truncate">{mobileDisplayText}</span>
            <Icons.ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent
              side="bottom"
              className="rounded-t-4xl mx-1 h-[85vh] p-0"
              onOpenAutoFocus={handleOpenAutoFocus}
            >
              <SheetHeader className="border-border border-b px-6 pb-4 pt-6">
                <SheetTitle>{t("ui:currency.selectTitle", "Select Currency")}</SheetTitle>
                <SheetDescription>
                  {t("ui:currency.selectDescription", "Choose your activity currency")}
                </SheetDescription>
              </SheetHeader>

              <div className="flex h-[calc(85vh-7rem)] flex-col">
                <div className="border-border border-b px-6 py-4">
                  <h3 className="text-foreground mb-3 text-sm font-semibold">Popular</h3>
                  <div className="grid grid-cols-3 gap-2">
                    {popularCurrencies.map((curr) => (
                      <button
                        key={curr}
                        onClick={() => handleSelect(curr)}
                        className={cn(
                          "card-mobile flex items-center justify-center border py-3 font-semibold transition-colors",
                          value === curr
                            ? "border-primary bg-primary/10 text-primary"
                            : "hover:bg-accent active:bg-accent/80",
                        )}
                      >
                        {curr}
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        searchInputRef.current?.focus();
                      }}
                      className="card-mobile hover:bg-accent active:bg-accent/80 flex items-center justify-center border py-3 font-semibold transition-colors"
                    >
                      <Icons.Search className="mr-1 h-4 w-4" />
                      {t("ui:currency.more", "More")}
                    </button>
                  </div>
                </div>
                <div className="border-border border-b px-6 py-4">
                  <div className="relative">
                    <Icons.Search className="text-muted-foreground absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2" />
                    <Input
                      ref={searchInputRef}
                      type="text"
                      placeholder={t("ui:currency.searchAll", "Search all currencies...")}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-12"
                    />
                  </div>
                </div>
                <ScrollArea className="flex-1 px-6 py-4">
                  {searchQuery.length === 0 ? (
                    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center text-sm">
                      <Icons.DollarSign className="h-12 w-12 opacity-20" />
                      <span>
                        {t("ui:currency.searchPrompt", "Search for any currency or select from popular options above.")}
                      </span>
                    </div>
                  ) : filteredCurrencies.length > 0 ? (
                    <div className="space-y-2">
                      {filteredCurrencies.map((curr) => (
                        <button
                          key={curr.value}
                          onClick={() => handleSelect(curr.value)}
                          className={cn(
                            "card-mobile flex w-full items-center gap-3 border border-transparent text-left transition-colors",
                            value === curr.value
                              ? "border-primary bg-primary/10"
                              : "hover:bg-accent active:bg-accent/80 focus:border-primary focus:outline-none",
                          )}
                        >
                          <div className="bg-primary/10 flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full">
                            <Icons.DollarSign className="text-primary h-5 w-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-foreground truncate font-semibold">{curr.value}</span>
                            </div>
                            <div className="text-muted-foreground mt-0.5 truncate text-sm">{curr.label}</div>
                          </div>
                          {value === curr.value && <Icons.Check className="text-primary h-5 w-5 flex-shrink-0" />}
                        </button>
                      ))}
                      {customCurrencyValue && (
                        <button
                          onClick={() => handleSelect(customCurrencyValue)}
                          className="text-primary w-full py-2 text-center text-sm font-medium hover:underline"
                        >
                          {t("ui:currency.useCustom", 'Use "{{value}}" as custom currency', {
                            value: customCurrencyValue,
                          })}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center text-sm">
                      <Icons.Search className="h-12 w-12 opacity-20" />
                      <span>
                        {t("ui:currency.noneFound", 'No currencies found for "{{query}}".', { query: searchQuery })}
                      </span>
                      {customCurrencyValue && (
                        <button
                          onClick={() => handleSelect(customCurrencyValue)}
                          className="text-primary mt-2 text-sm font-medium hover:underline"
                        >
                          {t("ui:currency.useCustom", 'Use "{{value}}" as custom currency', {
                            value: customCurrencyValue,
                          })}
                        </button>
                      )}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </SheetContent>
          </Sheet>
        </>
      );
    }

    const desktopCustomCurrencyValue = getCustomCurrencyValue(desktopSearchQuery);

    return (
      <Popover open={open} onOpenChange={setOpen} modal={true}>
        <PopoverTrigger asChild>
          <Button
            ref={ref}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              "h-input-height w-full justify-between rounded-md",
              !value && "text-muted-foreground",
              className,
            )}
            {...props}
          >
            <span className="truncate">{buttonLabel}</span>
            <Icons.ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-full p-0" onOpenAutoFocus={handleOpenAutoFocus}>
          <Command>
            <CommandInput
              ref={desktopCommandInputRef}
              placeholder={t("ui:currency.search", "Search currency...")}
              className="h-9"
              value={desktopSearchQuery}
              onValueChange={setDesktopSearchQuery}
            />
            <CommandList>
              <CommandEmpty>
                {desktopCustomCurrencyValue ? (
                  <button
                    className="text-primary w-full py-1 text-sm font-medium hover:underline"
                    onClick={() => handleSelect(desktopCustomCurrencyValue)}
                  >
                    {t("ui:currency.useCustom", 'Use "{{value}}" as custom currency', {
                      value: desktopCustomCurrencyValue,
                    })}
                  </button>
                ) : (
                  t("ui:currency.noneFoundShort", "No currency found.")
                )}
              </CommandEmpty>
              <CommandGroup>
                <ScrollArea className="max-h-96 overflow-y-auto">
                  {desktopCustomCurrencyValue && (
                    <CommandItem
                      value={desktopCustomCurrencyValue}
                      onSelect={() => handleSelect(desktopCustomCurrencyValue)}
                    >
                      {t("ui:currency.useCustom", 'Use "{{value}}" as custom currency', {
                        value: desktopCustomCurrencyValue,
                      })}
                    </CommandItem>
                  )}
                  {worldCurrencies.map((currency) => (
                    <CommandItem
                      value={currency.label}
                      key={currency.value}
                      onSelect={() => {
                        handleSelect(currency.value);
                      }}
                    >
                      {currency.label}
                      <Icons.Check
                        className={cn("ml-auto h-4 w-4", currency.value === value ? "opacity-100" : "opacity-0")}
                      />
                    </CommandItem>
                  ))}
                </ScrollArea>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  },
);

CurrencyInput.displayName = "CurrencyInput";
