import { getExchanges, resolveSymbolQuote } from "@/adapters";
import TickerSearchInput from "@/components/ticker-search";
import { quoteModeFromSearchResult } from "@/lib/asset-utils";
import { useSettingsContext } from "@/lib/settings-provider";
import type { NewAsset, SymbolSearchResult } from "@/lib/types";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { CurrencyInput, SearchableSelect } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { z } from "zod";

/** Map search result quoteType to our InstrumentType form values.
 *  Returns null for unrecognized types so the caller can fall back to manual mode. */
function mapQuoteTypeToInstrumentType(quoteType: string): string | null {
  switch (quoteType.toUpperCase()) {
    case "EQUITY":
    case "ETF":
    case "MUTUALFUND":
    case "INDEX":
    case "ECNQUOTE":
      return "EQUITY";
    case "CRYPTOCURRENCY":
      return "CRYPTO";
    case "BOND":
    case "MONEYMARKET":
      return "BOND";
    case "OPTION":
      return "OPTION";
    default:
      return null;
  }
}

const createSecuritySchema = (t: TFunction) =>
  z.object({
    symbol: z
      .string()
      .min(1, t("asset:createSecurity.errors.symbol_required"))
      .max(100, t("asset:createSecurity.errors.symbol_max"))
      .transform((val) => val.toUpperCase().trim()),
    name: z
      .string()
      .min(1, t("asset:createSecurity.errors.name_required"))
      .max(100, t("asset:createSecurity.errors.name_max")),
    instrumentType: z.string().min(1, t("asset:createSecurity.errors.instrument_type_required")),
    quoteCcy: z.string().min(1, t("asset:createSecurity.errors.currency_required")),
    quoteMode: z.enum(["MANUAL", "MARKET"]),
    instrumentExchangeMic: z.string().optional(),
    notes: z.string().optional(),
  });

type CreateSecurityFormValues = z.infer<ReturnType<typeof createSecuritySchema>>;

const normalizeMic = (mic?: string | null): string => mic?.trim().toUpperCase() ?? "";

interface CreateSecurityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: NewAsset) => void;
  isPending?: boolean;
  initialAsset?: Partial<NewAsset>;
  title?: string;
  description?: string;
  submitLabel?: string;
}

export function CreateSecurityDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending = false,
  initialAsset,
  title,
  description,
  submitLabel,
}: CreateSecurityDialogProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("asset:createSecurity.title");
  const resolvedDescription = description ?? t("asset:createSecurity.description");
  const resolvedSubmitLabel = submitLabel ?? t("asset:createSecurity.submit_label");
  const { settings } = useSettingsContext();
  const defaultCurrency = settings?.baseCurrency || "USD";

  const INSTRUMENT_TYPE_OPTIONS = useMemo(
    () =>
      [
        { value: "EQUITY", label: t("asset:createSecurity.instrumentType.equity") },
        { value: "CRYPTO", label: t("asset:createSecurity.instrumentType.crypto") },
        { value: "BOND", label: t("asset:createSecurity.instrumentType.bond") },
        { value: "OPTION", label: t("asset:createSecurity.instrumentType.option") },
        { value: "FX", label: t("asset:createSecurity.instrumentType.fx") },
        { value: "METAL", label: t("asset:createSecurity.instrumentType.metal") },
      ] as const,
    [t],
  );

  const QUOTE_MODE_OPTIONS = useMemo(
    () =>
      [
        { value: "MANUAL", label: t("asset:createSecurity.quoteModeOptions.manual") },
        { value: "MARKET", label: t("asset:createSecurity.quoteModeOptions.market") },
      ] as const,
    [t],
  );
  const [selectedResult, setSelectedResult] = useState<SymbolSearchResult | undefined>();
  const [isResolvingSubmit, setIsResolvingSubmit] = useState(false);
  const resolveRequestSeq = useRef(0);
  const selectedCurrencyBaselineRef = useRef<string | undefined>(undefined);
  const quoteCcyUserEditedAfterSelectionRef = useRef(false);

  const { data: exchanges = [] } = useQuery({
    queryKey: ["exchanges"],
    queryFn: getExchanges,
    staleTime: Infinity,
  });

  const exchangeOptions = useMemo(
    () =>
      exchanges.map((e) => ({
        value: normalizeMic(e.mic),
        label: `${e.longName} (${e.name})`,
      })),
    [exchanges],
  );

  const defaultValues = useMemo<CreateSecurityFormValues>(
    () => ({
      symbol: (initialAsset?.instrumentSymbol || initialAsset?.displayCode || "").toUpperCase(),
      name: initialAsset?.name || initialAsset?.displayCode || initialAsset?.instrumentSymbol || "",
      instrumentType: initialAsset?.instrumentType || "EQUITY",
      quoteCcy: initialAsset?.quoteCcy || defaultCurrency,
      quoteMode: initialAsset?.quoteMode === "MARKET" ? "MARKET" : "MANUAL",
      instrumentExchangeMic: normalizeMic(initialAsset?.instrumentExchangeMic),
      notes: initialAsset?.notes || "",
    }),
    [defaultCurrency, initialAsset],
  );

  const form = useForm<CreateSecurityFormValues>({
    resolver: zodResolver(createSecuritySchema(t)),
    defaultValues,
  });

  useEffect(() => {
    resolveRequestSeq.current += 1;
    selectedCurrencyBaselineRef.current = undefined;
    quoteCcyUserEditedAfterSelectionRef.current = false;
    if (open) {
      setSelectedResult(undefined);
      form.reset(defaultValues);
    }
  }, [defaultValues, form, open]);

  const handleTickerSelect = useCallback(
    (_symbol: string, result?: SymbolSearchResult) => {
      if (!result) return;

      const requestId = ++resolveRequestSeq.current;
      const previousCurrency = form.getValues("quoteCcy")?.trim();
      const canonicalSymbol = result.canonicalSymbol || result.symbol;
      const canonicalExchangeMic = result.canonicalExchangeMic || result.exchangeMic;
      const provisionalCurrency = result.currency?.trim();
      const expectedCurrency = provisionalCurrency || previousCurrency;

      setSelectedResult(result);
      selectedCurrencyBaselineRef.current = expectedCurrency;
      quoteCcyUserEditedAfterSelectionRef.current = false;
      form.setValue("symbol", canonicalSymbol.toUpperCase(), { shouldValidate: true });
      form.setValue("name", result.longName || result.shortName || "", { shouldValidate: true });

      const mappedType = result.quoteType ? mapQuoteTypeToInstrumentType(result.quoteType) : null;

      if (mappedType) {
        form.setValue("instrumentType", mappedType);
      }
      if (provisionalCurrency) {
        form.setValue("quoteCcy", provisionalCurrency, { shouldValidate: true });
      }
      if (canonicalExchangeMic) {
        form.setValue("instrumentExchangeMic", normalizeMic(canonicalExchangeMic));
      }

      const selectedQuoteMode = mappedType ? quoteModeFromSearchResult(result) : "MANUAL";

      // If the type is unrecognized, fall back to manual mode.
      // Otherwise auto-sync unless the result is from MANUAL source.
      form.setValue("quoteMode", selectedQuoteMode);

      if (selectedQuoteMode !== "MARKET") {
        return;
      }

      resolveSymbolQuote(
        canonicalSymbol,
        canonicalExchangeMic,
        result.quoteType,
        result.providerId,
        provisionalCurrency,
      )
        .then((resolved) => {
          if (requestId !== resolveRequestSeq.current) return;

          const currentSymbol = form.getValues("symbol")?.trim().toUpperCase();
          const currentMic = normalizeMic(form.getValues("instrumentExchangeMic"));
          if (
            currentSymbol !== canonicalSymbol.toUpperCase() ||
            currentMic !== normalizeMic(canonicalExchangeMic) ||
            (mappedType && form.getValues("instrumentType") !== mappedType)
          ) {
            return;
          }

          const confirmedCurrency = resolved?.currency?.trim();
          if (!confirmedCurrency) return;

          const currentCurrency = form.getValues("quoteCcy")?.trim();
          if (
            !quoteCcyUserEditedAfterSelectionRef.current &&
            (!currentCurrency || currentCurrency === expectedCurrency)
          ) {
            form.setValue("quoteCcy", confirmedCurrency, { shouldValidate: true });
          }
        })
        .catch(() => {
          // Search selection remains usable even if quote confirmation fails.
        });
    },
    [form],
  );

  const handleSubmit = async (values: CreateSecurityFormValues) => {
    const kind = values.instrumentType === "FX" ? "FX" : "INVESTMENT";
    const selectedCanonicalSymbol = selectedResult?.canonicalSymbol || selectedResult?.symbol;
    const selectedCanonicalMic = normalizeMic(
      selectedResult?.canonicalExchangeMic || selectedResult?.exchangeMic,
    );
    const selectedInstrumentType = selectedResult?.quoteType
      ? mapQuoteTypeToInstrumentType(selectedResult.quoteType)
      : null;
    const initialSymbol = (
      initialAsset?.instrumentSymbol || initialAsset?.displayCode
    )?.toUpperCase();
    const initialMic = normalizeMic(initialAsset?.instrumentExchangeMic);
    const initialInstrumentType = initialAsset?.instrumentType;
    const selectedProviderRef =
      selectedResult &&
      selectedCanonicalSymbol?.toUpperCase() === values.symbol &&
      selectedCanonicalMic === normalizeMic(values.instrumentExchangeMic) &&
      (!selectedInstrumentType || selectedInstrumentType === values.instrumentType)
        ? {
            providerId: selectedResult.providerId,
            providerSymbol: selectedResult.providerSymbol,
          }
        : undefined;
    const initialProviderConfig =
      !selectedResult &&
      initialAsset?.providerConfig &&
      initialSymbol === values.symbol &&
      initialMic === normalizeMic(values.instrumentExchangeMic) &&
      (!initialInstrumentType || initialInstrumentType === values.instrumentType)
        ? initialAsset.providerConfig
        : undefined;
    let resolvedQuoteCcy = values.quoteCcy;

    if (selectedResult && selectedProviderRef && values.quoteMode === "MARKET") {
      setIsResolvingSubmit(true);
      try {
        const resolved = await resolveSymbolQuote(
          values.symbol,
          normalizeMic(values.instrumentExchangeMic) || undefined,
          selectedResult.quoteType,
          selectedResult.providerId,
          values.quoteCcy,
        );
        const confirmedCurrency = resolved?.currency?.trim();
        if (confirmedCurrency && !quoteCcyUserEditedAfterSelectionRef.current) {
          resolvedQuoteCcy = confirmedCurrency;
          form.setValue("quoteCcy", confirmedCurrency, { shouldValidate: true });
        }
      } catch {
        // Continue with the selected/provided currency when confirmation is unavailable.
      } finally {
        setIsResolvingSubmit(false);
      }
    }

    const payload: NewAsset = {
      kind,
      name: values.name,
      displayCode: values.symbol,
      isActive: true,
      quoteMode: values.quoteMode,
      quoteCcy: resolvedQuoteCcy,
      instrumentType: values.instrumentType,
      instrumentSymbol: values.symbol,
      instrumentExchangeMic: values.instrumentExchangeMic || undefined,
      providerId: selectedProviderRef?.providerId,
      providerSymbol: selectedProviderRef?.providerSymbol,
      providerConfig: selectedProviderRef ? undefined : initialProviderConfig,
      notes: values.notes || undefined,
    };
    onSubmit(payload);
  };

  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    if (isPending || isResolvingSubmit) return;
    if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
    // Don't submit when interacting with the ticker search popover
    const inPopover = (e.target as HTMLElement).closest("[data-radix-popper-content-wrapper]");
    if (inPopover) return;
    e.preventDefault();
    void form.handleSubmit(handleSubmit)();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{resolvedTitle}</DialogTitle>
          <DialogDescription>{resolvedDescription}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <div className="space-y-4" onKeyDown={handleDialogKeyDown}>
            {/* Ticker search - auto-populates form fields on selection */}
            {open && (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {t("asset:createSecurity.search_label")}
                </label>
                <TickerSearchInput
                  onSelectResult={handleTickerSelect}
                  placeholder={t("asset:createSecurity.search_placeholder")}
                  defaultCurrency={defaultCurrency}
                  autoFocusSearch
                  hideCustomCreate
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="symbol"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("asset:createSecurity.symbol")}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={t("asset:createSecurity.symbol_placeholder")}
                        {...field}
                        onChange={(e) => {
                          const next = e.target.value.toUpperCase();
                          const selectedCanonicalSymbol =
                            selectedResult?.canonicalSymbol || selectedResult?.symbol;
                          if (
                            selectedResult &&
                            next.trim() !== selectedCanonicalSymbol?.toUpperCase()
                          ) {
                            resolveRequestSeq.current += 1;
                            selectedCurrencyBaselineRef.current = undefined;
                            quoteCcyUserEditedAfterSelectionRef.current = false;
                            setSelectedResult(undefined);
                          }
                          field.onChange(next);
                        }}
                        className="uppercase"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="instrumentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("asset:createSecurity.type")}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("asset:createSecurity.select_type")} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {INSTRUMENT_TYPE_OPTIONS.map((option) => (
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
            </div>

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("asset:createSecurity.name")}</FormLabel>
                  <FormControl>
                    <Input placeholder={t("asset:createSecurity.name_placeholder")} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="quoteCcy"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("asset:createSecurity.currency")}</FormLabel>
                    <FormControl>
                      <CurrencyInput
                        value={field.value}
                        onChange={(nextCurrency) => {
                          if (selectedResult) {
                            quoteCcyUserEditedAfterSelectionRef.current = true;
                          }
                          field.onChange(nextCurrency);
                        }}
                        placeholder={t("asset:createSecurity.select_currency")}
                        valueDisplay="code"
                        allowCustom
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="quoteMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("asset:createSecurity.quote_mode")}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {QUOTE_MODE_OPTIONS.map((option) => (
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
            </div>

            <FormField
              control={form.control}
              name="instrumentExchangeMic"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t("asset:createSecurity.exchange")}{" "}
                    <span className="text-muted-foreground text-xs">
                      {t("asset:createSecurity.optional")}
                    </span>
                  </FormLabel>
                  <FormControl>
                    <SearchableSelect
                      options={exchangeOptions}
                      value={field.value ?? ""}
                      onValueChange={field.onChange}
                      placeholder={t("asset:createSecurity.select_exchange")}
                      searchPlaceholder={t("asset:createSecurity.search_exchanges")}
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
                  <FormLabel>
                    {t("asset:createSecurity.notes")}{" "}
                    <span className="text-muted-foreground text-xs">
                      {t("asset:createSecurity.optional")}
                    </span>
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      placeholder={t("asset:createSecurity.notes_placeholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isPending || isResolvingSubmit}
              >
                {t("common:cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => void form.handleSubmit(handleSubmit)()}
                disabled={isPending || isResolvingSubmit}
              >
                {isPending || isResolvingSubmit ? (
                  <span className="flex items-center gap-2">
                    <Icons.Spinner className="h-4 w-4 animate-spin" />{" "}
                    {t("asset:createSecurity.creating")}
                  </span>
                ) : (
                  resolvedSubmitLabel
                )}
              </Button>
            </DialogFooter>
          </div>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
