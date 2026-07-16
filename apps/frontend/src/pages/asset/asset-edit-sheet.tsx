import { getExchanges, resolveSymbolQuote } from "@/adapters";
import { MultiSelectTaxonomy } from "@/components/classification/multi-select-taxonomy";
import { SingleSelectTaxonomy } from "@/components/classification/single-select-taxonomy";
import { TickerAvatar } from "@/components/ticker-avatar";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { useMarketDataProviders } from "@/hooks/use-market-data-providers";
import { useTaxonomies } from "@/hooks/use-taxonomies";
import type { Asset, Quote } from "@/lib/types";
import { formatPrice } from "@wealthfolio/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  AlertDescription,
  CurrencyInput,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ResponsiveSelect,
  type ResponsiveSelectOption,
  SearchableSelect,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Switch,
} from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@wealthfolio/ui/components/ui/tabs";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Path, useFieldArray, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import * as z from "zod";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { serializeProviderConfig } from "./asset-provider-config";
import { useAssetProfileMutations } from "./hooks/use-asset-profile-mutations";

// Schema for a single provider override (type is derived from instrument type)
const providerOverrideSchema = z.object({
  provider: z.string(),
  symbol: z.string(),
});

// QuoteMode values matching Rust enum
const QuoteMode = {
  MARKET: "MARKET",
  MANUAL: "MANUAL",
} as const;

type QuoteMode = (typeof QuoteMode)[keyof typeof QuoteMode];

const assetFormSchema = (t: TFunction) =>
  z.object({
    name: z.string().optional(),
    notes: z.string().optional(),
    isin: z.string().optional(),
    instrumentType: z.string().optional(),
    quoteCcy: z.string().min(1, t("asset:editSheet.currency_required")),
    instrumentExchangeMic: z.string().optional(),
    quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]),
    preferredProvider: z.string().optional(),
    providerConfig: z.array(providerOverrideSchema).optional(),
  });

type AssetFormValues = z.infer<ReturnType<typeof assetFormSchema>>;
type ProviderOverride = z.infer<typeof providerOverrideSchema>;

const normalizeMic = (mic?: string | null): string => mic?.trim().toUpperCase() ?? "";

const PROVIDER_SYMBOL_HINTS: Record<string, string> = {
  YAHOO: "e.g. AAPL, LYMS.DE",
  COINGECKO: "e.g. bitcoin, ethereum",
  TWELVEDATA: "e.g. AAPL, EUR/USD",
};

function getSymbolPlaceholder(provider: string): string {
  return PROVIDER_SYMBOL_HINTS[provider] ?? "e.g. AAPL";
}

function isResolvedByRequestedProvider(
  resolvedProviderId: string | undefined,
  requestedProvider: string | undefined,
): boolean {
  const requested = requestedProvider?.trim();
  if (!requested) return true;
  if (!resolvedProviderId) return false;

  if (requested.startsWith("CUSTOM:")) {
    const customProviderId = requested.slice("CUSTOM:".length);
    return resolvedProviderId === `CUSTOM_SCRAPER:${customProviderId}`;
  }

  return resolvedProviderId === requested;
}

function extractIsin(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "";
  const identifiers = (metadata as Record<string, unknown>).identifiers;
  if (!identifiers || typeof identifiers !== "object") return "";
  return ((identifiers as Record<string, unknown>).isin as string) ?? "";
}

// Parse provider overrides from config JSON (supports nested and flat formats)
function parseProviderOverrides(
  config: Record<string, unknown> | null | undefined,
): ProviderOverride[] {
  if (!config) return [];
  // Nested format: { overrides: { YAHOO: { symbol: "..." } } }
  // Flat format (legacy): { YAHOO: { symbol: "..." } }
  const source = (config.overrides as Record<string, unknown> | undefined) ?? config;
  const result: ProviderOverride[] = [];
  for (const [provider, value] of Object.entries(source)) {
    if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, unknown>;
      const symbol = (obj.symbol ?? obj.isin) as string;
      if (symbol) {
        result.push({ provider, symbol });
      }
    }
  }
  return result;
}

// Extract preferred_provider from config JSON
// Returns "CUSTOM:<code>" when preferred_provider is CUSTOM_SCRAPER with custom_provider_code
function parsePreferredProvider(
  config: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!config) return undefined;
  const pref = config.preferred_provider;
  if (typeof pref !== "string") return undefined;
  if (pref === "CUSTOM_SCRAPER") {
    const code = config.custom_provider_code;
    return typeof code === "string" ? `CUSTOM:${code}` : pref;
  }
  return pref;
}

type EditTab = "general" | "classification" | "market-data" | "fx-settings";

// Extracted component for pricing mode toggle with controlled popover
// Uses "Automatic Updates" toggle: ON = automatic, OFF = manual (more intuitive)
function PricingModeToggle({
  isManualMode,
  onConfirm,
}: {
  isManualMode: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isAutomatic = !isManualMode;

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <Label className="text-sm font-medium">{t("asset:editSheet.automatic_updates")}</Label>
          <p className="text-muted-foreground text-xs">
            {isAutomatic
              ? t("asset:editSheet.automatic_on_description")
              : t("asset:editSheet.automatic_off_description")}
          </p>
        </div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="shrink-0">
              <Switch checked={isAutomatic} />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[360px] p-4" align="end">
            <div className="space-y-4">
              <h4 className="font-medium">
                {isAutomatic
                  ? t("asset:editSheet.disable_automatic_title")
                  : t("asset:editSheet.enable_automatic_title")}
              </h4>
              {isAutomatic ? (
                <>
                  <p className="text-muted-foreground text-sm">
                    {t("asset:editSheet.disable_automatic_description")}
                  </p>
                  <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                    {t("asset:editSheet.disable_automatic_warning")}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-muted-foreground text-sm">
                    {t("asset:editSheet.enable_automatic_description")}
                  </p>
                  <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                    {t("asset:editSheet.enable_automatic_warning")}
                  </p>
                </>
              )}
              <div className="flex justify-end space-x-2">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  {t("common:cancel")}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => {
                    onConfirm();
                    setOpen(false);
                  }}
                >
                  {t("asset:editSheet.confirm")}
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

interface AssetEditSheetProps {
  asset: Asset | null;
  latestQuote?: Quote | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: EditTab;
}

type SymbolValidationStatus = "idle" | "loading" | "valid" | "invalid";

interface SymbolMappingRowProps {
  index: number;
  fieldId: string;
  initialSymbol?: string;
  control: ReturnType<typeof useForm<AssetFormValues>>["control"];
  mappingProviderOptions: ResponsiveSelectOption[];
  onRemove: () => void;
  onValidationChange: (fieldId: string, status: SymbolValidationStatus) => void;
}

function SymbolMappingRow({
  index,
  fieldId,
  initialSymbol,
  control,
  mappingProviderOptions,
  onRemove,
  onValidationChange,
}: SymbolMappingRowProps) {
  const { t } = useTranslation();
  const [validationStatus, setValidationStatus] = useState<SymbolValidationStatus>(
    initialSymbol?.trim() ? "valid" : "idle",
  );
  // Track whether we are on the first render to avoid re-validating pre-loaded values.
  const isFirstRender = useRef(true);
  const validationRequestSeq = useRef(0);

  const symbol = useWatch({
    control,
    name: `providerConfig.${index}.symbol` as Path<AssetFormValues>,
  }) as string | undefined;
  const provider = useWatch({
    control,
    name: `providerConfig.${index}.provider` as Path<AssetFormValues>,
  }) as string | undefined;
  const instrumentType = useWatch({
    control,
    name: "instrumentType" as Path<AssetFormValues>,
  }) as string | undefined;
  const exchangeMic = useWatch({
    control,
    name: "instrumentExchangeMic" as Path<AssetFormValues>,
  }) as string | undefined;
  const quoteCcy = useWatch({
    control,
    name: "quoteCcy" as Path<AssetFormValues>,
  }) as string | undefined;

  useEffect(() => {
    const requestId = ++validationRequestSeq.current;

    // Skip validation on mount when the symbol is already known-good (loaded from DB).
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (symbol?.trim() === initialSymbol?.trim() && initialSymbol?.trim()) {
        return;
      }
    }

    const trimmedSymbol = symbol?.trim();
    if (!trimmedSymbol) {
      setValidationStatus("idle");
      onValidationChange(fieldId, "idle");
      return;
    }

    setValidationStatus("idle");
    const requestExchangeMic = normalizeMic(exchangeMic) || undefined;
    const requestInstrumentType = instrumentType?.trim() || undefined;
    const requestQuoteCcy = quoteCcy?.trim() || undefined;
    const requestProvider = provider?.trim() || undefined;

    const timer = setTimeout(async () => {
      if (validationRequestSeq.current !== requestId) return;

      setValidationStatus("loading");
      onValidationChange(fieldId, "idle");
      try {
        const result = await resolveSymbolQuote(
          trimmedSymbol,
          requestExchangeMic,
          requestInstrumentType,
          requestProvider,
          requestQuoteCcy,
        );
        if (validationRequestSeq.current !== requestId) return;

        const status: SymbolValidationStatus =
          result?.price != null &&
          isResolvedByRequestedProvider(result.resolvedProviderId, requestProvider)
            ? "valid"
            : "invalid";
        setValidationStatus(status);
        onValidationChange(fieldId, status);
      } catch {
        if (validationRequestSeq.current !== requestId) return;

        setValidationStatus("invalid");
        onValidationChange(fieldId, "invalid");
      }
    }, 800);

    return () => clearTimeout(timer);
  }, [symbol, provider, instrumentType, exchangeMic, quoteCcy, fieldId, onValidationChange]); // eslint-disable-line react-hooks/exhaustive-deps -- initialSymbol is intentionally captured at mount time only

  return (
    <tr className="border-b last:border-b-0">
      <td className="px-4 py-2">
        <FormField
          control={control}
          name={`providerConfig.${index}.provider` as Path<AssetFormValues>}
          render={({ field: providerField }) => (
            <FormItem className="space-y-0">
              <FormControl>
                <ResponsiveSelect
                  value={providerField.value as string | undefined}
                  onValueChange={providerField.onChange}
                  options={mappingProviderOptions}
                  placeholder={t("asset:editSheet.select_provider")}
                  sheetTitle={t("asset:editSheet.data_provider")}
                  sheetDescription={t("asset:editSheet.data_provider_sheet_description")}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </td>
      <td className="px-4 py-2">
        <FormField
          control={control}
          name={`providerConfig.${index}.symbol` as Path<AssetFormValues>}
          render={({ field: symbolField }) => (
            <FormItem className="space-y-0">
              <FormControl>
                <div className="relative flex items-center">
                  <Input
                    placeholder={getSymbolPlaceholder(provider ?? "")}
                    {...{
                      ...symbolField,
                      value: (symbolField.value as string | undefined) ?? "",
                    }}
                    className="h-9 pr-8"
                  />
                  <span className="absolute right-2 flex items-center">
                    {validationStatus === "loading" && (
                      <span data-testid="symbol-validation-loading">
                        <Icons.Spinner className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
                      </span>
                    )}
                    {validationStatus === "valid" && (
                      <span data-testid="symbol-validation-valid">
                        <Icons.Check className="h-3.5 w-3.5 text-green-500" />
                      </span>
                    )}
                    {validationStatus === "invalid" && (
                      <span data-testid="symbol-validation-invalid">
                        <Icons.AlertCircle className="h-3.5 w-3.5 text-red-500" />
                      </span>
                    )}
                  </span>
                </div>
              </FormControl>
            </FormItem>
          )}
        />
      </td>
      <td className="px-2 py-2">
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={onRemove}>
          <Icons.Close className="h-4 w-4" />
        </Button>
      </td>
    </tr>
  );
}

export function AssetEditSheet({
  asset,
  latestQuote,
  open,
  onOpenChange,
  defaultTab = "general",
}: AssetEditSheetProps) {
  const { t } = useTranslation();
  const EDIT_INSTRUMENT_TYPE_OPTIONS = useMemo(
    () =>
      [
        { value: "EQUITY", label: t("asset:editSheet.instrumentType.equity") },
        { value: "CRYPTO", label: t("asset:editSheet.instrumentType.crypto") },
        { value: "BOND", label: t("asset:editSheet.instrumentType.bond") },
        { value: "OPTION", label: t("asset:editSheet.instrumentType.option") },
        { value: "METAL", label: t("asset:editSheet.instrumentType.metal") },
      ] as const,
    [t],
  );
  const [activeTab, setActiveTab] = useState<EditTab>(defaultTab);
  const [symbolValidations, setSymbolValidations] = useState<
    Record<string, SymbolValidationStatus>
  >({});

  const handleSymbolValidationChange = useCallback(
    (fieldId: string, status: SymbolValidationStatus) => {
      setSymbolValidations((prev) => ({ ...prev, [fieldId]: status }));
    },
    [],
  );
  const { data: taxonomies = [], isLoading: isTaxonomiesLoading } = useTaxonomies({
    scope: "asset",
  });
  const { updateAssetProfileMutation } = useAssetProfileMutations();
  const { data: marketDataProviders = [] } = useMarketDataProviders();
  const { data: customProviders = [] } = useCustomProviders();

  // Built-in providers only (exclude CUSTOM_SCRAPER dispatcher and custom provider rows)
  const builtinProviders = useMemo(
    () =>
      marketDataProviders.filter((p) => p.id !== "CUSTOM_SCRAPER" && p.providerType !== "custom"),
    [marketDataProviders],
  );

  const providerOptions: ResponsiveSelectOption[] = useMemo(() => {
    const options: ResponsiveSelectOption[] = [
      { value: "__auto__", label: t("asset:editSheet.auto_default") },
      ...builtinProviders.map((p) => ({ value: p.id, label: p.name })),
    ];
    for (const cp of customProviders) {
      options.push({ value: `CUSTOM:${cp.id}`, label: cp.name });
    }
    return options;
  }, [builtinProviders, customProviders, t]);

  // Provider options for symbol mapping (without Auto, includes custom providers)
  const mappingProviderOptions: ResponsiveSelectOption[] = useMemo(() => {
    const options: ResponsiveSelectOption[] = builtinProviders.map((p) => ({
      value: p.id,
      label: p.name,
    }));
    for (const cp of customProviders) {
      options.push({ value: `CUSTOM:${cp.id}`, label: cp.name });
    }
    return options;
  }, [builtinProviders, customProviders]);

  const { data: exchanges = [] } = useQuery({
    queryKey: ["exchanges"],
    queryFn: getExchanges,
    staleTime: Infinity,
  });

  const currentMic = normalizeMic(asset?.instrumentExchangeMic);

  const exchangeOptions = useMemo(() => {
    const options = exchanges.map((e) => ({
      value: normalizeMic(e.mic),
      label: `${e.longName} (${e.name})`,
    }));

    if (currentMic && !options.some((option) => option.value === currentMic)) {
      options.unshift({
        value: currentMic,
        label: asset?.exchangeName ? `${asset.exchangeName} (${currentMic})` : currentMic,
      });
    }

    return options;
  }, [exchanges, currentMic, asset?.exchangeName]);

  // Split taxonomies by selection type
  const { singleSelectTaxonomies, multiSelectTaxonomies } = useMemo(() => {
    const sorted = [...taxonomies].sort((a, b) => a.sortOrder - b.sortOrder);
    return {
      singleSelectTaxonomies: sorted.filter((t) => t.isSingleSelect),
      multiSelectTaxonomies: sorted.filter((t) => !t.isSingleSelect),
    };
  }, [taxonomies]);

  const form = useForm<AssetFormValues>({
    resolver: zodResolver(assetFormSchema(t)),
    defaultValues: {
      name: asset?.name ?? "",
      notes: asset?.notes ?? "",
      isin: extractIsin(asset?.metadata),
      instrumentType: asset?.instrumentType ?? "",
      quoteCcy: asset?.quoteCcy ?? "",
      instrumentExchangeMic: normalizeMic(asset?.instrumentExchangeMic),
      quoteMode: asset?.quoteMode === "MANUAL" ? QuoteMode.MANUAL : QuoteMode.MARKET,
      preferredProvider: parsePreferredProvider(
        asset?.providerConfig as Record<string, unknown> | null,
      ),
      providerConfig: parseProviderOverrides(
        asset?.providerConfig as Record<string, unknown> | null,
      ),
    },
  });

  const {
    fields: overrideFields,
    append: appendOverride,
    remove: removeOverride,
  } = useFieldArray({
    control: form.control,
    name: "providerConfig",
  });

  // Reset form when asset changes
  useEffect(() => {
    if (asset) {
      form.reset({
        name: asset.name ?? "",
        notes: asset.notes ?? "",
        isin: extractIsin(asset.metadata),
        instrumentType: asset.instrumentType ?? "",
        quoteCcy: asset.quoteCcy ?? "",
        instrumentExchangeMic: normalizeMic(asset.instrumentExchangeMic),
        quoteMode: asset.quoteMode === "MANUAL" ? QuoteMode.MANUAL : QuoteMode.MARKET,
        preferredProvider: parsePreferredProvider(
          asset.providerConfig as Record<string, unknown> | null,
        ),
        providerConfig: parseProviderOverrides(
          asset.providerConfig as Record<string, unknown> | null,
        ),
      });
    }
  }, [asset, form]);

  // Reset tab and validation state when sheet opens
  useEffect(() => {
    if (open) {
      setActiveTab(defaultTab);
      setSymbolValidations({});
    }
  }, [open, defaultTab, asset?.id]);

  const handleSave = useCallback(
    async (values: AssetFormValues) => {
      if (!asset) return;

      const hasInvalidMappings = Object.values(symbolValidations).some((s) => s === "invalid");
      if (hasInvalidMappings) {
        toast.warning(t("asset:editSheet.invalid_mappings_warning"));
      }

      // Serialize provider config to nested JSON format
      const serializedOverrides = serializeProviderConfig(
        values.preferredProvider,
        values.providerConfig ?? [],
        values.instrumentType || asset.instrumentType,
      );
      const normalizedMic = normalizeMic(values.instrumentExchangeMic);

      try {
        // Merge ISIN into existing metadata without clobbering other fields
        const existingMeta: Record<string, unknown> = asset.metadata ?? {};
        const existingIdentifiers: Record<string, unknown> =
          typeof existingMeta.identifiers === "object" && existingMeta.identifiers !== null
            ? (existingMeta.identifiers as Record<string, unknown>)
            : {};
        const isinTrimmed = values.isin?.trim() ?? "";
        const newIdentifiers = isinTrimmed
          ? { ...existingIdentifiers, isin: isinTrimmed }
          : Object.fromEntries(Object.entries(existingIdentifiers).filter(([k]) => k !== "isin"));
        const newMetadata = {
          ...existingMeta,
          ...(Object.keys(newIdentifiers).length > 0
            ? { identifiers: newIdentifiers }
            : { identifiers: undefined }),
        };

        // Update profile with all fields including quote mode
        await updateAssetProfileMutation.mutateAsync({
          id: asset.id,
          displayCode: asset.displayCode,
          name: values.name || "",
          notes: values.notes ?? "",
          instrumentType: values.instrumentType || null,
          quoteMode: values.quoteMode,
          quoteCcy: values.quoteCcy,
          instrumentExchangeMic: normalizedMic || null,
          providerConfig: serializedOverrides,
          metadata: newMetadata,
        });

        onOpenChange(false);
      } catch {
        // Error toast is shown by mutation's onError callback
        // Keep sheet open so user can retry
      }
    },
    [asset, updateAssetProfileMutation, onOpenChange, symbolValidations, t],
  );

  const isManualMode = form.watch("quoteMode") === QuoteMode.MANUAL;
  const isSaving = updateAssetProfileMutation.isPending;

  // Check if current asset kind is system-managed (shouldn't allow editing)
  const isSystemManagedKind = asset?.kind === "FX";

  if (!asset) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-safe flex h-full w-full flex-col sm:max-w-2xl">
        <SheetHeader className="shrink-0 pb-4">
          <div className="flex items-center gap-3">
            <TickerAvatar symbol={asset.displayCode ?? ""} className="size-10" />
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-lg">
                {asset.displayCode ?? asset.name ?? t("asset:editSheet.unknown")}
              </SheetTitle>
              <SheetDescription className="truncate text-sm">
                {asset.name || t("asset:editSheet.edit_asset")}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as EditTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          {asset.kind === "FX" ? (
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="general">{t("asset:editSheet.general")}</TabsTrigger>
              <TabsTrigger value="market-data">{t("asset:editSheet.market_data")}</TabsTrigger>
            </TabsList>
          ) : (
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="general" className="px-1.5 text-xs sm:px-3 sm:text-sm">
                {t("asset:editSheet.general")}
              </TabsTrigger>
              <TabsTrigger value="classification" className="px-1.5 text-xs sm:px-3 sm:text-sm">
                {t("asset:editSheet.classification")}
              </TabsTrigger>
              <TabsTrigger value="market-data" className="px-1.5 text-xs sm:px-3 sm:text-sm">
                {t("asset:editSheet.market_data")}
              </TabsTrigger>
            </TabsList>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto pt-4">
            {/* General Tab */}
            <TabsContent value="general" className="mt-0 h-full">
              <Form {...form}>
                <form onSubmit={form.handleSubmit(handleSave)} className="space-y-6">
                  {/* FX: Base and Quote Currency (both disabled) */}
                  {asset.kind === "FX" ? (
                    <div className="space-y-6">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <label className="text-sm font-medium">
                            {t("asset:editSheet.base_currency")}
                          </label>
                          <Input
                            value={asset.instrumentSymbol ?? ""}
                            disabled
                            className="bg-muted/50"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-sm font-medium">
                            {t("asset:editSheet.quote_currency")}
                          </label>
                          <Input value={asset.quoteCcy ?? ""} disabled className="bg-muted/50" />
                        </div>
                      </div>

                      <FormField
                        control={form.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("asset:editSheet.name")}</FormLabel>
                            <FormControl>
                              <Input
                                placeholder={t("asset:editSheet.name_placeholder")}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="isin"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("asset:editSheet.isin")}</FormLabel>
                            <FormControl>
                              <Input
                                placeholder={t("asset:editSheet.isin_placeholder")}
                                className="font-mono uppercase"
                                {...field}
                                onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="notes"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("asset:editSheet.notes")}</FormLabel>
                            <FormControl>
                              <Textarea
                                rows={6}
                                placeholder={t("asset:editSheet.notes_placeholder")}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <div className="flex justify-end gap-3 pt-4">
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                          {t("common:cancel")}
                        </Button>
                        <Button type="submit" disabled={isSaving}>
                          {isSaving
                            ? t("asset:editSheet.saving")
                            : t("asset:editSheet.save_changes")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    /* Regular assets: Symbol, Currency, Name, Notes, Asset Type, Exchange */
                    <div className="space-y-6">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <label className="text-sm font-medium">
                            {t("asset:editSheet.symbol")}
                          </label>
                          <Input value={asset.displayCode ?? ""} disabled className="bg-muted/50" />
                        </div>
                        <FormField
                          control={form.control}
                          name="quoteCcy"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t("asset:editSheet.currency")}</FormLabel>
                              <FormControl>
                                <CurrencyInput
                                  value={field.value}
                                  onChange={field.onChange}
                                  placeholder={t("asset:editSheet.select_currency")}
                                  valueDisplay="code"
                                  allowCustom
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      {/* Editable fields */}
                      <FormField
                        control={form.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("asset:editSheet.name")}</FormLabel>
                            <FormControl>
                              <Input
                                placeholder={t("asset:editSheet.name_placeholder")}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="isin"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("asset:editSheet.isin")}</FormLabel>
                            <FormControl>
                              <Input
                                placeholder={t("asset:editSheet.isin_placeholder")}
                                className="font-mono uppercase"
                                {...field}
                                onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="notes"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("asset:editSheet.notes")}</FormLabel>
                            <FormControl>
                              <Textarea
                                rows={10}
                                placeholder={t("asset:editSheet.notes_placeholder")}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Instrument Type and Exchange */}
                      <div className="grid gap-4 md:grid-cols-2">
                        <FormField
                          control={form.control}
                          name="instrumentType"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t("asset:editSheet.instrument_type")}</FormLabel>
                              <Select
                                onValueChange={field.onChange}
                                value={field.value ?? ""}
                                disabled={isSystemManagedKind}
                              >
                                <FormControl>
                                  <SelectTrigger className="h-11">
                                    <SelectValue placeholder={t("asset:editSheet.select_type")} />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {EDIT_INSTRUMENT_TYPE_OPTIONS.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="instrumentExchangeMic"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t("asset:editSheet.exchange")}</FormLabel>
                              <FormControl>
                                <SearchableSelect
                                  options={exchangeOptions}
                                  value={field.value ?? ""}
                                  onValueChange={field.onChange}
                                  placeholder={t("asset:editSheet.select_exchange")}
                                  searchPlaceholder={t("asset:editSheet.search_exchanges")}
                                  className="h-11"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      <div className="flex justify-end gap-3 pt-4">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => onOpenChange(false)}
                          disabled={isSaving}
                        >
                          {t("common:cancel")}
                        </Button>
                        <Button type="submit" disabled={isSaving}>
                          {isSaving ? (
                            <span className="flex items-center gap-2">
                              <Icons.Spinner className="h-4 w-4 animate-spin" />{" "}
                              {t("asset:editSheet.saving_short")}
                            </span>
                          ) : (
                            t("asset:editSheet.save_changes_lower")
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                </form>
              </Form>
            </TabsContent>

            {/* Classification Tab */}
            <TabsContent value="classification" className="mt-0 h-full">
              <div className="space-y-8 pb-8">
                {isTaxonomiesLoading && <ClassificationSkeleton />}

                {!isTaxonomiesLoading &&
                  singleSelectTaxonomies.length === 0 &&
                  multiSelectTaxonomies.length === 0 && (
                    <div className="py-8 text-center">
                      <p className="text-muted-foreground text-sm">
                        {t("asset:editSheet.no_taxonomies")}
                      </p>
                    </div>
                  )}

                {!isTaxonomiesLoading &&
                  singleSelectTaxonomies.map((taxonomy) => (
                    <SingleSelectTaxonomy
                      key={taxonomy.id}
                      taxonomyId={taxonomy.id}
                      assetId={asset.id}
                      label={taxonomy.name}
                    />
                  ))}

                {!isTaxonomiesLoading &&
                  multiSelectTaxonomies.map((taxonomy) => (
                    <MultiSelectTaxonomy
                      key={taxonomy.id}
                      taxonomyId={taxonomy.id}
                      assetId={asset.id}
                      label={taxonomy.name}
                    />
                  ))}
              </div>
            </TabsContent>

            {/* Market Data Tab */}
            <TabsContent value="market-data" className="mt-0 h-full">
              <div className="space-y-6 pb-8">
                <Form {...form}>
                  <div className="space-y-6">
                    {/* Latest Quote Card - First */}
                    <div className="bg-muted/30 rounded-lg border p-4">
                      {latestQuote ? (
                        <div className="grid grid-cols-3 gap-4 text-center">
                          <div>
                            <p className="text-xl font-semibold">
                              {formatPrice(latestQuote.close, latestQuote.currency)}
                            </p>
                            <p className="text-muted-foreground text-xs">
                              {t("asset:editSheet.latest_price")}
                            </p>
                          </div>
                          <div>
                            <p className="text-sm font-medium">
                              {new Date(latestQuote.timestamp).toLocaleDateString()}
                            </p>
                            <p className="text-muted-foreground text-xs">
                              {new Date(latestQuote.timestamp).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </p>
                          </div>
                          <div>
                            <Badge variant="secondary" className="text-xs">
                              {latestQuote.dataSource}
                            </Badge>
                            <p className="text-muted-foreground mt-1 text-xs">
                              {t("asset:editSheet.source")}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <Alert variant="destructive" className="border-0 bg-transparent p-0">
                          <Icons.AlertCircle className="h-4 w-4" />
                          <AlertDescription>
                            {t("asset:editSheet.price_fetch_error")}
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>

                    {/* Pricing Mode Toggle Card */}
                    <PricingModeToggle
                      isManualMode={isManualMode}
                      onConfirm={() => {
                        form.setValue(
                          "quoteMode",
                          isManualMode ? QuoteMode.MARKET : QuoteMode.MANUAL,
                        );
                      }}
                    />

                    {/* Preferred Provider - Only show for automatic pricing */}
                    {!isManualMode && (
                      <FormField
                        control={form.control}
                        name="preferredProvider"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("asset:editSheet.preferred_provider")}</FormLabel>
                            {customProviders.length > 0 ? (
                              <Select
                                value={field.value ?? "__auto__"}
                                onValueChange={(v) =>
                                  field.onChange(v === "__auto__" ? undefined : v)
                                }
                              >
                                <FormControl>
                                  <SelectTrigger className="h-11">
                                    <SelectValue placeholder={t("asset:editSheet.auto_default")} />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="__auto__">
                                    {t("asset:editSheet.auto_default")}
                                  </SelectItem>
                                  <SelectGroup>
                                    <SelectLabel>{t("asset:editSheet.builtin")}</SelectLabel>
                                    {builtinProviders.map((p) => (
                                      <SelectItem key={p.id} value={p.id}>
                                        {p.name}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                  <SelectGroup>
                                    <SelectLabel>{t("asset:editSheet.custom")}</SelectLabel>
                                    {customProviders.map((cp) => (
                                      <SelectItem key={cp.id} value={`CUSTOM:${cp.id}`}>
                                        {cp.name}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            ) : (
                              <FormControl>
                                <ResponsiveSelect
                                  value={field.value ?? "__auto__"}
                                  onValueChange={(v) =>
                                    field.onChange(v === "__auto__" ? undefined : v)
                                  }
                                  options={providerOptions}
                                  placeholder={t("asset:editSheet.auto_default")}
                                  sheetTitle={t("asset:editSheet.preferred_provider")}
                                  sheetDescription={t(
                                    "asset:editSheet.preferred_provider_sheet_description",
                                  )}
                                  triggerClassName="h-11"
                                />
                              </FormControl>
                            )}
                            <p className="text-muted-foreground text-xs">
                              {t("asset:editSheet.preferred_provider_hint")}
                            </p>
                          </FormItem>
                        )}
                      />
                    )}

                    {/* Symbol Mapping - Only show for automatic pricing */}
                    {!isManualMode && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <label className="text-sm font-medium">
                              {t("asset:editSheet.symbol_mapping")}
                            </label>
                            <p className="text-muted-foreground text-xs">
                              {t("asset:editSheet.symbol_mapping_hint")}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => appendOverride({ provider: "YAHOO", symbol: "" })}
                          >
                            <Icons.Plus className="mr-1 h-3 w-3" />
                            {t("asset:editSheet.add")}
                          </Button>
                        </div>

                        {overrideFields.length === 0 ? (
                          <div className="rounded-lg border border-dashed p-6 text-center">
                            <Icons.Link className="text-muted-foreground/50 mx-auto h-8 w-8" />
                            <p className="text-muted-foreground mt-2 text-sm">
                              {t("asset:editSheet.no_mappings")}
                            </p>
                            <p className="text-muted-foreground text-xs">
                              {t("asset:editSheet.using_symbol_for_all", {
                                symbol: asset.displayCode ?? "",
                              })}
                            </p>
                          </div>
                        ) : (
                          <div className="rounded-lg border">
                            <table className="w-full">
                              <thead>
                                <tr className="bg-muted/50 border-b">
                                  <th className="text-muted-foreground px-4 py-2 text-left text-xs font-medium">
                                    {t("asset:editSheet.provider")}
                                  </th>
                                  <th className="text-muted-foreground px-4 py-2 text-left text-xs font-medium">
                                    {t("asset:editSheet.symbol")}
                                  </th>
                                  <th className="w-10"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {overrideFields.map((field, index) => (
                                  <SymbolMappingRow
                                    key={field.id}
                                    index={index}
                                    fieldId={field.id}
                                    initialSymbol={field.symbol}
                                    control={form.control}
                                    mappingProviderOptions={mappingProviderOptions}
                                    onRemove={() => {
                                      setSymbolValidations((prev) => {
                                        const next = { ...prev };
                                        delete next[field.id];
                                        return next;
                                      });
                                      removeOverride(index);
                                    }}
                                    onValidationChange={handleSymbolValidationChange}
                                  />
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Save Actions */}
                    <div className="flex justify-end gap-3 border-t pt-4">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => onOpenChange(false)}
                        disabled={isSaving}
                      >
                        {t("common:cancel")}
                      </Button>
                      <Button
                        type="button"
                        onClick={form.handleSubmit(handleSave)}
                        disabled={isSaving}
                      >
                        {isSaving ? (
                          <span className="flex items-center gap-2">
                            <Icons.Spinner className="h-4 w-4 animate-spin" />{" "}
                            {t("asset:editSheet.saving_short")}
                          </span>
                        ) : (
                          t("asset:editSheet.save_changes_lower")
                        )}
                      </Button>
                    </div>
                  </div>
                </Form>
              </div>
            </TabsContent>
          </div>
        </Tabs>

        <div className="mt-auto border-t pt-4 sm:hidden">
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => onOpenChange(false)}
          >
            {t("asset:editSheet.close")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ClassificationSkeleton() {
  return (
    <div className="space-y-8">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={`single-${i}`} className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 4 }).map((_, j) => (
              <Skeleton key={j} className="h-7 w-16 rounded-full" />
            ))}
          </div>
        </div>
      ))}
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={`multi-${i}`} className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      ))}
    </div>
  );
}

export default AssetEditSheet;
