import TickerSearchInput from "@/components/ticker-search";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@wealthfolio/ui";
import { QuoteMode } from "@/lib/constants";
import {
  isManualSearchResult,
  quoteModeFromSearchResult,
  stripCryptoQuoteSuffix,
} from "@/lib/asset-utils";
import type { SymbolSearchResult } from "@/lib/types";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFormContext, type FieldPath, type FieldValues } from "react-hook-form";
import { resolveSymbolQuote } from "@/adapters";

function canUseResolvedCurrency(searchResult: SymbolSearchResult | undefined): boolean {
  if (!searchResult || searchResult.isExisting || isManualSearchResult(searchResult)) {
    return false;
  }
  return true;
}

interface SymbolSearchProps<TFieldValues extends FieldValues = FieldValues> {
  /** Field name for the symbol value */
  name: FieldPath<TFieldValues>;
  /** Whether to show manual input instead of search */
  isManualAsset?: boolean;
  /** Label for the field */
  label?: string;
  /** Default currency for creating custom assets */
  defaultCurrency?: string;
  /** Field name for exchangeMic (optional, for capturing exchange info) */
  exchangeMicName?: FieldPath<TFieldValues>;
  /** Field name for quoteMode (optional, to set manual pricing for custom assets) */
  quoteModeName?: FieldPath<TFieldValues>;
  /** Field name for currency (optional, to set currency from search result) */
  currencyName?: FieldPath<TFieldValues>;
  /** Field name for symbol quote currency hint (optional, e.g. "GBp") */
  quoteCcyName?: FieldPath<TFieldValues>;
  /** Field name for symbol instrument type hint (optional, e.g. "EQUITY") */
  instrumentTypeName?: FieldPath<TFieldValues>;
  /** Field name for selected existing asset id from search (optional) */
  existingAssetIdName?: FieldPath<TFieldValues>;
  /** Field name for assetMetadata (optional, to capture asset name for custom assets) */
  assetMetadataName?: FieldPath<TFieldValues>;
}

export function SymbolSearch<TFieldValues extends FieldValues = FieldValues>({
  name,
  isManualAsset = false,
  label,
  defaultCurrency,
  exchangeMicName,
  quoteModeName,
  currencyName,
  quoteCcyName,
  instrumentTypeName,
  existingAssetIdName,
  assetMetadataName,
}: SymbolSearchProps<TFieldValues>) {
  const { t } = useTranslation(["activity"]);
  const resolvedLabel = label ?? t("activity:form.label_symbol");
  const { control, setValue, watch, getValues } = useFormContext<TFieldValues>();
  const [quoteDisplay, setQuoteDisplay] = useState<{
    price: number | null;
    isLoading: boolean;
  } | null>(null);
  const latestResolveRequestId = useRef(0);
  const selectedExchangeMic = exchangeMicName
    ? (watch(exchangeMicName as any) as string | undefined)
    : undefined;
  const displayCurrency = quoteCcyName
    ? (watch(quoteCcyName as any) as string | undefined)
    : undefined;

  const handleAssetSelect = (symbol: string, searchResult: SymbolSearchResult | undefined) => {
    latestResolveRequestId.current += 1;
    const requestId = latestResolveRequestId.current;
    const selectedQuoteMode = quoteModeFromSearchResult(searchResult);
    const isManualAsset = selectedQuoteMode === QuoteMode.MANUAL;
    const previousCurrency = currencyName
      ? ((getValues(currencyName) as string | undefined)?.trim() ?? undefined)
      : undefined;

    if (quoteModeName) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setValue(quoteModeName, selectedQuoteMode as any);
    }

    const canonicalMic = searchResult?.canonicalExchangeMic || searchResult?.exchangeMic;
    const fallbackBaseSymbol =
      searchResult?.assetKind?.toUpperCase() === "CRYPTO"
        ? stripCryptoQuoteSuffix(symbol, searchResult?.currency)
        : symbol;
    const canonicalSymbol = (searchResult?.canonicalSymbol || fallbackBaseSymbol)
      .trim()
      .toUpperCase();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setValue(name, canonicalSymbol as any, {
      shouldValidate: true,
      shouldDirty: true,
      shouldTouch: true,
    });

    // Capture exchangeMic for canonical asset ID generation
    if (exchangeMicName) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setValue(exchangeMicName, (canonicalMic ?? undefined) as any);
    }

    // Symbol-based activities should prioritize the selected asset quote currency.
    // If provider/search result includes currency, set activity currency from symbol.
    if (currencyName) {
      const rawCurrency = searchResult?.currency?.trim();
      if (rawCurrency) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setValue(currencyName, rawCurrency as any, {
          shouldDirty: true,
          shouldValidate: true,
        });
      }
    }

    if (assetMetadataName) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setValue(`${assetMetadataName}.providerId` as any, searchResult?.providerId as any, {
        shouldValidate: true,
        shouldDirty: true,
        shouldTouch: true,
      });
      setValue(`${assetMetadataName}.providerSymbol` as any, searchResult?.providerSymbol as any, {
        shouldValidate: true,
        shouldDirty: true,
        shouldTouch: true,
      });
    }

    if (quoteCcyName) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setValue(quoteCcyName, (searchResult?.currency ?? undefined) as any);
    }

    // Background quote resolution confirms selected symbol currency and shows display quote.
    // Existing assets keep their stored currency.
    const shouldUseResolvedCurrency = canUseResolvedCurrency(searchResult);
    const needsCurrencyConfirmation = Boolean(currencyName && shouldUseResolvedCurrency);

    if (searchResult) {
      setQuoteDisplay({ price: null, isLoading: true });
      const provisionalCurrency = searchResult.currency?.trim();
      resolveSymbolQuote(
        canonicalSymbol,
        canonicalMic,
        searchResult.quoteType,
        searchResult.providerId,
        searchResult.currency,
      )
        .then((resolved) => {
          if (requestId !== latestResolveRequestId.current) return;
          setQuoteDisplay({ price: resolved?.price ?? null, isLoading: false });

          const confirmedCurrency = resolved?.currency?.trim();
          if (confirmedCurrency && quoteCcyName && shouldUseResolvedCurrency) {
            // Resolver output is the source of truth for newly selected market assets.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            setValue(quoteCcyName, confirmedCurrency as any);
          }

          // Keep user edits if the activity currency changed after selection.
          if (needsCurrencyConfirmation && confirmedCurrency) {
            const current = getValues(currencyName!);
            const expectedCurrentCurrency = provisionalCurrency || previousCurrency;
            const shouldUpdate = expectedCurrentCurrency
              ? current === expectedCurrentCurrency
              : true;
            if (shouldUpdate) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              setValue(currencyName!, confirmedCurrency as any, {
                shouldDirty: true,
                shouldValidate: true,
              });
            }
          }
        })
        .catch(() => {
          if (requestId !== latestResolveRequestId.current) return;
          setQuoteDisplay({ price: null, isLoading: false });
        });
    } else {
      setQuoteDisplay(null);
    }

    if (instrumentTypeName) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setValue(instrumentTypeName, (searchResult?.quoteType ?? undefined) as any);
    }

    if (existingAssetIdName) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setValue(existingAssetIdName, (searchResult?.existingAssetId ?? undefined) as any, {
        shouldDirty: true,
      });
    }

    // Persist selected symbol name as a create hint for new assets.
    if (assetMetadataName) {
      const selectedName = searchResult?.longName?.trim() || searchResult?.shortName?.trim();
      if (selectedName) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setValue(`${assetMetadataName}.name` as any, selectedName as any, {
          shouldValidate: true,
          shouldDirty: true,
          shouldTouch: true,
        });
      }
    }

    // Capture asset kind only for manual/custom assets.
    if (isManualAsset && assetMetadataName) {
      if (searchResult?.assetKind) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setValue(`${assetMetadataName}.kind` as any, searchResult.assetKind as any, {
          shouldValidate: true,
          shouldDirty: true,
          shouldTouch: true,
        });
      }
    }
  };

  const handleClear = () => {
    latestResolveRequestId.current += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setValue(name, "" as any, { shouldValidate: true, shouldDirty: true });
    if (exchangeMicName) setValue(exchangeMicName, undefined as any);
    if (currencyName) setValue(currencyName, "" as any);
    if (quoteCcyName) setValue(quoteCcyName, undefined as any);
    if (instrumentTypeName) setValue(instrumentTypeName, undefined as any);
    if (existingAssetIdName) setValue(existingAssetIdName, undefined as any);
    if (assetMetadataName) {
      setValue(`${assetMetadataName}.name` as any, undefined as any);
      setValue(`${assetMetadataName}.kind` as any, undefined as any);
      setValue(`${assetMetadataName}.providerId` as any, undefined as any);
      setValue(`${assetMetadataName}.providerSymbol` as any, undefined as any);
    }
    setQuoteDisplay(null);
  };

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="-mt-2">
          <FormLabel>{resolvedLabel}</FormLabel>
          <FormControl>
            {isManualAsset ? (
              <Input
                placeholder={t("activity:symbol_placeholder")}
                className="h-10"
                {...field}
                onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                aria-label={resolvedLabel}
                data-testid="symbol-input"
              />
            ) : (
              <TickerSearchInput
                onSelectResult={handleAssetSelect}
                value={field.value}
                defaultCurrency={defaultCurrency}
                selectedExchangeMic={selectedExchangeMic}
                quoteInfo={
                  quoteDisplay ? { ...quoteDisplay, currency: displayCurrency } : undefined
                }
                onClear={handleClear}
                aria-label={resolvedLabel}
                data-testid="symbol-search"
              />
            )}
          </FormControl>
          <FormMessage className="text-xs" />
        </FormItem>
      )}
    />
  );
}
