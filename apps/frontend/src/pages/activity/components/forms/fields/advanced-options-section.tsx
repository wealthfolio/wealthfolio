import { useState, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFormContext, useWatch, type FieldPath, type FieldValues } from "react-hook-form";
import { cn } from "@/lib/utils";
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
import { localizeActivitySubtypeName } from "@/lib/activity-utils";
import { SUBTYPES_BY_ACTIVITY_TYPE, type ActivityType } from "@/lib/constants";

interface AdvancedOptionsSectionProps<TFieldValues extends FieldValues = FieldValues> {
  /** Field name for the currency value */
  currencyName?: FieldPath<TFieldValues>;
  /** Field name for the FX rate value */
  fxRateName?: FieldPath<TFieldValues>;
  /** Field name for the subtype value */
  subtypeName?: FieldPath<TFieldValues>;
  /** Activity type to determine available subtypes */
  activityType?: ActivityType;
  /** Explicit subtype options for scoped form flows */
  subtypeOptions?: readonly string[];
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
  /** Trigger label (default: translated "Advanced Options") */
  title?: string;
  /** Render inside a dashed-border container with a leading "+" affordance */
  dashed?: boolean;
  /** Extra content rendered inside the collapsible below the advanced grid (e.g. Notes) */
  children?: ReactNode;
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
  subtypeOptions,
  assetCurrency,
  accountCurrency,
  baseCurrency,
  showCurrency = true,
  showFxRate = true,
  showSubtype = true,
  defaultOpen = false,
  variant = "desktop",
  title,
  dashed = false,
  children,
}: AdvancedOptionsSectionProps<TFieldValues>) {
  const { t } = useTranslation(["activity"]);
  const isMobile = variant === "mobile";
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const { control } = useFormContext<TFieldValues>();
  const triggerTitle = title ?? t("activity:form.advanced_options");

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
    if (!showSubtype) return [];
    if (subtypeOptions) return subtypeOptions;
    if (!activityType) return [];
    return SUBTYPES_BY_ACTIVITY_TYPE[activityType] ?? [];
  }, [activityType, showSubtype, subtypeOptions]);

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

  // Don't render if there are no advanced fields and no extra content
  const hasAdvancedFields =
    (showCurrency && currencyName) ||
    (showFxRate && fxRateName) ||
    (showSubtype && subtypeName && availableSubtypes.length > 0);
  if (!hasAdvancedFields && !children) {
    return null;
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(
        "w-full",
        dashed && "border-border rounded-lg border border-dashed px-4 py-1",
        !dashed && isMobile && "bg-muted/30 rounded-md border px-3 py-2",
      )}
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          data-testid="advanced-options-button"
          className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between px-0 py-1 hover:bg-transparent"
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            {dashed && <Icons.Plus className="h-3.5 w-3.5" />}
            {triggerTitle}
          </span>
          <Icons.ChevronDown
            className={`h-4 w-4 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pb-2 pt-2">
        {hasAdvancedFields && (
          <div
            className={
              isMobile ? "grid grid-cols-1 gap-4" : "grid grid-cols-1 gap-4 sm:grid-cols-2"
            }
          >
            {/* Currency Field */}
            {showCurrency && currencyName && (
              <FormField
                control={control}
                name={currencyName}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("activity:form.currency")}</FormLabel>
                    <FormControl>
                      <CurrencyInput
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        placeholder={t("activity:form.placeholder_select_currency")}
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
                                ? t("activity:form.currency_hint_asset")
                                : index <= 1 && accountCurrency === currency
                                  ? t("activity:form.currency_hint_account")
                                  : t("activity:form.currency_hint_base")
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
                    <FormLabel>{t("activity:form.label_fx_rate")}</FormLabel>
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
                        {t("activity:form.fx_conversion", {
                          from: fromCurrency,
                          rate: fxRateDisplay,
                          to: accountCurrency,
                        })}
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
                    <FormLabel>{t("activity:form.subtype")}</FormLabel>
                    <FormControl>
                      <Select
                        onValueChange={(value) =>
                          field.onChange(value === "__none__" ? null : value)
                        }
                        value={field.value ?? "__none__"}
                      >
                        <SelectTrigger
                          aria-label={t("activity:form.subtype")}
                          data-testid="subtype-select"
                        >
                          <SelectValue
                            placeholder={t("activity:form.placeholder_select_subtype")}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">
                            <span className="text-muted-foreground">
                              {t("activity:form.subtype_none")}
                            </span>
                          </SelectItem>
                          {availableSubtypes.map((subtype) => (
                            <SelectItem key={subtype} value={subtype}>
                              {localizeActivitySubtypeName(t, subtype)}
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
        )}
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
