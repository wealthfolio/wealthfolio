import { forwardRef, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useIsMobile as defaultUseIsMobile } from "../../hooks/use-mobile";
import { canonicalCurrencyCode, getCurrencyDisplayLabel, worldCurrencies } from "../../lib/currencies";
import { cn } from "../../lib/utils";
import type { ButtonProps } from "../ui/button";
import { Button } from "../ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Icons } from "../ui/icons";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { SheetScreen, useInSheetNavigation } from "../ui/sheet-navigation";

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
      placeholder,
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
    const { t, i18n } = useTranslation();
    const currencyLabel = (currency: (typeof worldCurrencies)[number]) =>
      getCurrencyDisplayLabel(currency, i18n.resolvedLanguage ?? i18n.language, t);
    const placeholderText = placeholder ?? t("ui:currency.placeholder", "Select currency");
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
    // In a phone form's sheet the picker opens as a screen of that sheet.
    const inSheetNavigation = useInSheetNavigation();
    const isMobile = inSheetNavigation || displayMode === "mobile" || (displayMode === "auto" && isMobileFromHook);

    const selectedCurrency = worldCurrencies.find((currency) => currency.value === value);
    const buttonLabel = selectedCurrency
      ? valueDisplay === "code"
        ? selectedCurrency.value
        : valueDisplay === "code-label"
          ? `${selectedCurrency.value} - ${currencyLabel(selectedCurrency)}`
          : currencyLabel(selectedCurrency)
      : value || placeholderText;

    const handleSelect = (currencyValue: string) => {
      onChange(currencyValue);
      setOpen(false);
      setSearchQuery("");
      setDesktopSearchQuery("");
    };

    const getCustomCurrencyValue = (query: string) => {
      const code = canonicalCurrencyCode(query);
      if (!allowCustom || !code) return undefined;
      if (worldCurrencies.some((currency) => currency.value === code)) return undefined;
      return code;
    };

    if (isMobile) {
      const query = searchQuery.trim().toLowerCase();
      const filteredCurrencies = worldCurrencies.filter(
        (curr) =>
          curr.value.toLowerCase().includes(query) ||
          curr.label.toLowerCase().includes(query) ||
          currencyLabel(curr).toLowerCase().includes(query),
      );
      const customCurrencyValue = getCustomCurrencyValue(searchQuery);
      const mobileDisplayText = selectedCurrency
        ? valueDisplay === "code"
          ? selectedCurrency.value
          : valueDisplay === "label"
            ? currencyLabel(selectedCurrency)
            : `${selectedCurrency.value} - ${currencyLabel(selectedCurrency)}`
        : value || placeholderText;

      const mobileBody = (
        <div className={cn("flex flex-col", inSheetNavigation ? "min-h-0 flex-1" : "h-[calc(85vh-7rem)]")}>
          <div className="border-border border-b px-6 py-4">
            <h3 className="text-foreground mb-3 text-sm font-semibold">{t("ui:currency.popular", "Popular")}</h3>
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
                <Icons.Search className="me-1 h-4 w-4" />
                {t("ui:currency.more", "More")}
              </button>
            </div>
          </div>
          <div className="border-border border-b px-6 py-4">
            <div className="relative">
              <Icons.Search className="text-muted-foreground absolute start-4 top-1/2 h-5 w-5 -translate-y-1/2" />
              <Input
                ref={searchInputRef}
                type="text"
                placeholder={t("ui:currency.searchAll", "Search all currencies...")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ps-12"
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
                      "card-mobile flex w-full items-center gap-3 border border-transparent text-start transition-colors",
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
                      <div className="text-muted-foreground mt-0.5 truncate text-sm">{currencyLabel(curr)}</div>
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
      );

      return (
        <>
          <Button
            ref={ref}
            type="button"
            variant="field"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              "h-input-height w-full justify-between truncate",
              !value && "text-muted-foreground",
              className,
            )}
            onClick={() => setOpen(true)}
            {...props}
          >
            <span className="truncate">{mobileDisplayText}</span>
            {inSheetNavigation ? (
              <Icons.ChevronRight className="ms-2 h-4 w-4 shrink-0 opacity-50 rtl:rotate-180" />
            ) : (
              <Icons.ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
            )}
          </Button>
          {inSheetNavigation ? (
            <SheetScreen
              open={open}
              onOpenChange={setOpen}
              title={t("ui:currency.selectTitle", "Select Currency")}
              initialFocus={autoFocusSearch ? searchInputRef : undefined}
            >
              {mobileBody}
            </SheetScreen>
          ) : (
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetContent
                side="bottom"
                className="mx-1 h-[85vh] rounded-t-4xl p-0"
                initialFocus={autoFocusSearch ? searchInputRef : undefined}
              >
                <SheetHeader className="border-border border-b px-6 pt-6 pb-4">
                  <SheetTitle>{t("ui:currency.selectTitle", "Select Currency")}</SheetTitle>
                  <SheetDescription>{t("ui:currency.selectDescription", "Choose a currency")}</SheetDescription>
                </SheetHeader>

                {mobileBody}
              </SheetContent>
            </Sheet>
          )}
        </>
      );
    }

    const desktopCustomCurrencyValue = getCustomCurrencyValue(desktopSearchQuery);
    // cmdk can't reorder items inside the ScrollArea, so Enter takes the first match in list
    // order: list a code typed in any case before fuzzy matches such as USD for "EUR".
    const typedCode = canonicalCurrencyCode(desktopSearchQuery);
    const desktopCurrencies = [...worldCurrencies].sort(
      (a, b) => Number(b.value === typedCode) - Number(a.value === typedCode),
    );

    return (
      <Popover open={open} onOpenChange={setOpen} modal={true}>
        <PopoverTrigger
          render={
            <Button
              ref={ref}
              type="button"
              variant="field"
              role="combobox"
              aria-expanded={open}
              className={cn("h-input-height w-full justify-between", !value && "text-muted-foreground", className)}
              {...props}
            />
          }
        >
          <span className="truncate">{buttonLabel}</span>
          <Icons.ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent className="w-full p-0" initialFocus={autoFocusSearch ? desktopCommandInputRef : undefined}>
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
                {/* Fits inside CommandList's max-h-75 with the group's padding, so only this area scrolls. */}
                <ScrollArea className="max-h-72 overflow-y-auto">
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
                  {desktopCurrencies.map((currency) => (
                    <CommandItem
                      value={currency.value}
                      keywords={[currency.label, currencyLabel(currency)]}
                      key={currency.value}
                      onSelect={() => {
                        handleSelect(currency.value);
                      }}
                    >
                      {currencyLabel(currency)}
                      <Icons.Check
                        className={cn("ms-auto h-4 w-4", currency.value === value ? "opacity-100" : "opacity-0")}
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
