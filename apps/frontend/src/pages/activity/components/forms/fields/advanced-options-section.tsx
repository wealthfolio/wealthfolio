import { useState, useMemo } from "react";
import { useFormContext, useWatch, type FieldPath, type FieldValues } from "react-hook-form";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui";
import { FormDescription } from "@wealthfolio/ui/components/ui/form";
import { CurrencyInput, MoneyInput } from "@wealthfolio/ui/components/financial";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  SUBTYPES_BY_ACTIVITY_TYPE,
  SUBTYPE_DISPLAY_NAMES,
  type ActivityType,
} from "@/lib/constants";

interface AdvancedOptionsSectionProps<TFieldValues extends FieldValues = FieldValues> {
  /** Field name for the currency value */
  currencyName?: FieldPath<TFieldValues>;
  /** Field name for the FX rate value */
  fxRateName?: FieldPath<TFieldValues>;
  /** Field name for the subtype value */
  subtypeName?: FieldPath<TFieldValues>;
  /** Activity type to determine available subtypes */
  activityType?: ActivityType;
  /** Asset currency (from selected symbol) */
  assetCurrency?: string;
  /** Account currency (from selected account) */
  accountCurrency?: string;
  /** Base currency (user's default) */
  baseCurrency?: string;
  /** Whether to show the currency field */
  showCurrency?: boolean;
  /** Whether to show the FX rate field */
  showFxRate?: boolean;
  /** Whether to show the subtype field */
  showSubtype?: boolean;
  /** Default open state */
  defaultOpen?: boolean;
  /** Variant for different layouts */
  variant?: "desktop" | "mobile";
  /** Additional content rendered inside the collapsible section */
  children?: React.ReactNode;
}

/**
 * Advanced options section with collapsible FX Rate (currency) and Subtype fields.
 * Currency options are ordered by: asset currency, account currency, base currency.
 */
export function AdvancedOptionsSection<TFieldValues extends FieldValues = FieldValues>({
  currencyName,
  fxRateName,
  subtypeName,
  activityType,
  assetCurrency,
  accountCurrency,
  baseCurrency,
  showCurrency = true,
  showFxRate = true,
  showSubtype = true,
  defaultOpen = false,
  variant = "desktop",
  children,
}: AdvancedOptionsSectionProps<TFieldValues>) {
  const isMobile = variant === "mobile";
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const { control } = useFormContext<TFieldValues>();

  const watchedCurrency = useWatch({
    control,
    name: currencyName as FieldPath<TFieldValues>,
    disabled: !currencyName,
  }) as string | undefined;
  const fromCurrency = watchedCurrency || assetCurrency;

  const watchedFxRate = useWatch({
    control,
    name: fxRateName as FieldPath<TFieldValues>,
    disabled: !fxRateName,
  }) as number | undefined;
  const fxRateDisplay =
    typeof watchedFxRate === "number" && Number.isFinite(watchedFxRate) && watchedFxRate > 0
      ? watchedFxRate.toString()
      : "?";

  // Get available subtypes for the current activity type
  const availableSubtypes = useMemo(() => {
    if (!activityType || !showSubtype) return [];
    return SUBTYPES_BY_ACTIVITY_TYPE[activityType] || [];
  }, [activityType, showSubtype]);

  // Get prioritized currency list: asset currency, account currency, base currency
  // Remove duplicates while preserving order
  const prioritizedCurrencies = useMemo(() => {
    const currencies: string[] = [];
    if (assetCurrency && !currencies.includes(assetCurrency)) {
      currencies.push(assetCurrency);
    }
    if (accountCurrency && !currencies.includes(accountCurrency)) {
      currencies.push(accountCurrency);
    }
    if (baseCurrency && !currencies.includes(baseCurrency)) {
      currencies.push(baseCurrency);
    }
    return currencies;
  }, [assetCurrency, accountCurrency, baseCurrency]);

  // Don't render if nothing to show
  const hasContent =
    (showCurrency && currencyName) ||
    (showFxRate && fxRateName) ||
    (showSubtype && subtypeName && availableSubtypes.length > 0) ||
    children;
  if (!hasContent) {
    return null;
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={isMobile ? "bg-muted/30 w-full rounded-md border px-3 py-2" : "w-full"}
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          data-testid="advanced-options-button"
          className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between px-0 py-1 hover:bg-transparent"
        >
          <span className="text-sm font-medium">Advanced Options</span>
          <Icons.ChevronDown
            className={`h-4 w-4 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-2">
        <div
          className={isMobile ? "grid grid-cols-1 gap-4" : "grid grid-cols-1 gap-4 sm:grid-cols-2"}
        >
          {/* Currency Field */}
          {showCurrency && currencyName && (
            <FormField
              control={control}
              name={currencyName}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Currency</FormLabel>
                  <FormControl>
                    <CurrencyInput
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      placeholder="Select currency"
                      className="w-full"
                      data-testid="advanced-currency-input"
                    />
                  </FormControl>
                  {prioritizedCurrencies.length > 1 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {prioritizedCurrencies.map((currency, index) => (
                        <button
                          key={currency}
                          type="button"
                          onClick={() => field.onChange(currency)}
                          className={`rounded px-2 py-0.5 text-xs transition-colors ${
                            field.value === currency
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted hover:bg-muted/80 text-muted-foreground"
                          }`}
                          title={
                            index === 0 && assetCurrency === currency
                              ? "Asset currency"
                              : index <= 1 && accountCurrency === currency
                                ? "Account currency"
                                : "Base currency"
                          }
                        >
                          {currency}
                        </button>
                      ))}
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {/* FX Rate Field */}
          {showFxRate && fxRateName && (
            <FormField
              control={control}
              name={fxRateName}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>FX Rate</FormLabel>
                  <FormControl>
                    <MoneyInput
                      ref={field.ref}
                      name={field.name}
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder="1.0000"
                      maxDecimalPlaces={6}
                      className="w-full"
                      data-testid="fx-rate-input"
                    />
                  </FormControl>
                  {fromCurrency && accountCurrency && fromCurrency !== accountCurrency && (
                    <FormDescription className="text-xs">
                      1 {fromCurrency} = {fxRateDisplay} {accountCurrency}
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {/* Subtype Field */}
          {showSubtype && subtypeName && availableSubtypes.length > 0 && (
            <FormField
              control={control}
              name={subtypeName}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Subtype</FormLabel>
                  <FormControl>
                    <Select
                      onValueChange={(value) => field.onChange(value === "__none__" ? null : value)}
                      value={field.value ?? "__none__"}
                    >
                      <SelectTrigger aria-label="Subtype" data-testid="subtype-select">
                        <SelectValue placeholder="Select subtype" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">
                          <span className="text-muted-foreground">None</span>
                        </SelectItem>
                        {availableSubtypes.map((subtype) => (
                          <SelectItem key={subtype} value={subtype}>
                            {SUBTYPE_DISPLAY_NAMES[subtype] || subtype}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
