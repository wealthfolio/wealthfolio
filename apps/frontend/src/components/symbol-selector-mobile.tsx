import { searchTicker } from "@/adapters";
import { getExchangeDisplayName } from "@/lib/constants";
import { useSettingsContext } from "@/lib/settings-provider";
import { SymbolSearchResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { CurrencyInput } from "@wealthfolio/ui/components/financial";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@wealthfolio/ui/components/ui/sheet";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { forwardRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

interface SymbolSelectorMobileProps {
  onSelect: (symbol: string, searchResult?: SymbolSearchResult) => void;
  value?: string;
  placeholder?: string;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultCurrency?: string;
}

// Asset type options for inline form (values are InstrumentType)
const getAssetTypeOptions = (t: TFunction) =>
  [
    { value: "EQUITY", label: t("common:component.symbol_type_security") },
    { value: "CRYPTO", label: t("common:component.symbol_type_crypto") },
    { value: "OTHER", label: t("common:component.symbol_type_other") },
  ] as const;

export const SymbolSelectorMobile = forwardRef<HTMLButtonElement, SymbolSelectorMobileProps>(
  (
    {
      onSelect,
      value,
      placeholder,
      className,
      open: controlledOpen,
      onOpenChange,
      defaultCurrency,
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const resolvedPlaceholder = placeholder ?? t("common:component.select_symbol");
    const assetTypeOptions = getAssetTypeOptions(t);
    const [internalOpen, setInternalOpen] = useState(false);
    const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
    const baseSetOpen = onOpenChange !== undefined ? onOpenChange : setInternalOpen;
    const { settings } = useSettingsContext();

    const [searchQuery, setSearchQuery] = useState("");
    const [showCustomAssetForm, setShowCustomAssetForm] = useState(false);

    // Custom asset form state
    const [customSymbol, setCustomSymbol] = useState("");
    const [customName, setCustomName] = useState("");
    const [customAssetType, setCustomAssetType] = useState<"EQUITY" | "CRYPTO" | "OTHER">("EQUITY");
    const [customCurrency, setCustomCurrency] = useState("");

    // Reset state when sheet closes
    const setOpen = (isOpen: boolean) => {
      if (!isOpen) {
        setSearchQuery("");
        setShowCustomAssetForm(false);
        setCustomSymbol("");
        setCustomName("");
        setCustomAssetType("EQUITY");
        setCustomCurrency("");
      }
      baseSetOpen(isOpen);
    };

    // Query for dynamic ticker search
    const {
      data: searchResults,
      isLoading,
      isError,
    } = useQuery<SymbolSearchResult[], Error>({
      queryKey: ["symbol-ticker-search", searchQuery],
      queryFn: () => searchTicker(searchQuery),
      enabled: searchQuery?.length > 1,
    });

    // Sort search results by score if available
    const sortedSearchResults = searchResults?.sort((a, b) => b.score - a.score) ?? [];

    const handleSymbolSelect = (ticker: SymbolSearchResult) => {
      onSelect(ticker.symbol, ticker);
      setOpen(false);
      setSearchQuery("");
      resetCustomAssetForm();
    };

    const resetCustomAssetForm = () => {
      setShowCustomAssetForm(false);
      setCustomSymbol("");
      setCustomName("");
      setCustomAssetType("EQUITY");
      setCustomCurrency("");
    };

    const handleShowCustomAssetForm = () => {
      // Pre-fill symbol from search query
      setCustomSymbol(searchQuery.trim().toUpperCase());
      // Pre-fill currency from defaultCurrency or settings
      setCustomCurrency(defaultCurrency || settings?.baseCurrency || "USD");
      setShowCustomAssetForm(true);
    };

    const handleCustomAssetCancel = () => {
      resetCustomAssetForm();
    };

    const handleCustomAssetSubmit = () => {
      if (!customSymbol.trim() || !customName.trim() || !customCurrency.trim()) {
        return; // Basic validation
      }

      // Create a SymbolSearchResult-like object for the custom asset
      const searchResult: SymbolSearchResult = {
        symbol: customSymbol.trim().toUpperCase(),
        longName: customName.trim(),
        shortName: customName.trim(),
        exchange: "MANUAL",
        quoteType:
          customAssetType === "CRYPTO"
            ? "CRYPTOCURRENCY"
            : customAssetType === "OTHER"
              ? "OTHER"
              : "EQUITY",
        index: "MANUAL",
        typeDisplay: "Custom Asset",
        dataSource: "MANUAL",
        quoteMode: "MANUAL",
        score: 0,
        currency: customCurrency,
        assetKind: customAssetType === "OTHER" ? "OTHER" : "INVESTMENT",
      };

      handleSymbolSelect(searchResult);
    };

    // Find the currently selected symbol's info
    const selectedSymbol = value ? sortedSearchResults.find((s) => s.symbol === value) : undefined;

    const displayText = selectedSymbol
      ? `${selectedSymbol.symbol} - ${selectedSymbol.longName}`
      : value || resolvedPlaceholder;

    return (
      <>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button
              ref={ref}
              variant="outline"
              role="combobox"
              size="lg"
              className={cn(
                "w-full justify-between truncate rounded-md font-normal",
                !value && "text-muted-foreground",
                className,
              )}
            >
              <span className="truncate">{displayText}</span>
              <Icons.Search className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="rounded-t-4xl mx-1 h-[85vh] p-0">
            {showCustomAssetForm ? (
              <>
                {/* Custom Asset Form Header */}
                <SheetHeader className="border-border space-y-0 border-b px-4 py-4">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCustomAssetCancel}
                      className="text-muted-foreground hover:text-foreground rounded-md p-2 transition-colors"
                      type="button"
                    >
                      <Icons.ArrowLeft className="h-5 w-5" />
                    </button>
                    <div className="flex-1">
                      <SheetTitle>{t("common:component.create_custom_asset")}</SheetTitle>
                      <SheetDescription>
                        {t("common:component.track_assets_manual_pricing")}
                      </SheetDescription>
                    </div>
                  </div>
                </SheetHeader>

                {/* Custom Asset Form */}
                <div className="flex h-[calc(85vh-6rem)] flex-col">
                  <ScrollArea className="flex-1">
                    <div className="form-mobile-spacing px-6 py-4">
                      {/* Symbol */}
                      <div className="space-y-2">
                        <label className="text-base font-medium">
                          {t("common:component.symbol_ticker")}
                        </label>
                        <Input
                          placeholder={t("common:component.symbol_placeholder")}
                          value={customSymbol}
                          onChange={(e) => setCustomSymbol(e.target.value.toUpperCase())}
                          className="uppercase"
                          autoFocus
                        />
                      </div>

                      {/* Name */}
                      <div className="space-y-2">
                        <label className="text-base font-medium">
                          {t("common:component.name")}
                        </label>
                        <Input
                          placeholder={t("common:component.custom_coin_placeholder")}
                          value={customName}
                          onChange={(e) => setCustomName(e.target.value)}
                        />
                      </div>

                      {/* Asset Type and Currency - side by side */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <label className="text-base font-medium">
                            {t("common:component.asset_type")}
                          </label>
                          <Select
                            value={customAssetType}
                            onValueChange={(value) =>
                              setCustomAssetType(value as "EQUITY" | "CRYPTO" | "OTHER")
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {assetTypeOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <label className="text-base font-medium">
                            {t("common:component.currency")}
                          </label>
                          <CurrencyInput value={customCurrency} onChange={setCustomCurrency} />
                        </div>
                      </div>
                    </div>
                  </ScrollArea>

                  {/* Form Actions */}
                  <div className="border-border flex gap-3 border-t px-6 py-4">
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={handleCustomAssetCancel}
                      className="flex-1"
                      type="button"
                    >
                      {t("common:cancel")}
                    </Button>
                    <Button
                      size="lg"
                      onClick={handleCustomAssetSubmit}
                      className="flex-1"
                      disabled={
                        !customSymbol.trim() || !customName.trim() || !customCurrency.trim()
                      }
                      type="button"
                    >
                      {t("common:component.create_asset")}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Search View Header */}
                <SheetHeader className="border-border border-b px-6 py-4">
                  <SheetTitle>{t("common:component.select_symbol_title")}</SheetTitle>
                  <SheetDescription>
                    {t("common:component.search_symbol_description")}
                  </SheetDescription>
                </SheetHeader>

                <div className="flex h-[calc(85vh-6rem)] flex-col">
                  {/* Search Input */}
                  <div className="border-border border-b px-6 py-4">
                    <div className="relative">
                      <Icons.Search className="text-muted-foreground absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2" />
                      <input
                        type="text"
                        placeholder={t("common:search_symbols")}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="bg-background border-input ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring h-14 w-full rounded-md border px-4 py-3 pl-12 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                        autoFocus
                      />
                    </div>
                  </div>

                  {/* Results */}
                  <ScrollArea className="flex-1 px-6 py-4">
                    {/* Loading state */}
                    {isLoading && searchQuery.length > 1 && (
                      <div className="space-y-3">
                        <div className="text-muted-foreground text-sm font-medium">
                          {t("common:searching")}
                        </div>
                        <Skeleton className="h-16 w-full rounded-xl" />
                        <Skeleton className="h-16 w-full rounded-xl" />
                        <Skeleton className="h-16 w-full rounded-xl" />
                      </div>
                    )}

                    {/* Error state */}
                    {isError && searchQuery.length > 1 && (
                      <div className="text-muted-foreground py-8 text-center text-sm">
                        {t("common:error_searching")}
                      </div>
                    )}

                    {/* Search results */}
                    {!isLoading &&
                      !isError &&
                      sortedSearchResults.length > 0 &&
                      searchQuery.length > 1 && (
                        <div className="space-y-2">
                          {sortedSearchResults.slice(0, 20).map((ticker) => (
                            <button
                              key={ticker.symbol}
                              onClick={() => handleSymbolSelect(ticker)}
                              className="card-mobile hover:bg-accent active:bg-accent/80 focus:border-primary flex w-full items-center gap-3 border border-transparent text-left transition-colors focus:outline-none"
                            >
                              <div className="bg-primary/10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full">
                                <Icons.TrendingUp className="text-primary h-5 w-5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-foreground truncate font-medium">
                                    {ticker.longName || ticker.symbol}
                                  </span>
                                  <span className="text-muted-foreground text-xs font-medium">
                                    {ticker.symbol}
                                  </span>
                                </div>
                                {ticker.exchange && (
                                  <div className="text-muted-foreground mt-0.5 text-sm">
                                    {ticker.exchangeName || getExchangeDisplayName(ticker.exchange)}
                                  </div>
                                )}
                              </div>
                              <Icons.ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" />
                            </button>
                          ))}
                        </div>
                      )}

                    {/* Empty state */}
                    {searchQuery.length === 0 && (
                      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center text-sm">
                        <Icons.Search className="h-12 w-12 opacity-20" />
                        <p>{t("common:component.start_typing_symbols")}</p>
                      </div>
                    )}

                    {/* No results state */}
                    {searchQuery.length > 0 &&
                      !isLoading &&
                      !isError &&
                      sortedSearchResults.length === 0 &&
                      searchQuery.length > 1 && (
                        <div className="text-muted-foreground py-8 text-center text-sm">
                          <p>{t("common:component.no_matches_for", { query: searchQuery })}</p>
                          <p className="mt-2 text-xs">
                            {t("common:component.create_custom_asset_below")}
                          </p>
                        </div>
                      )}

                    {/* Too short query state */}
                    {searchQuery.length > 0 && searchQuery.length <= 1 && (
                      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                        {t("common:component.type_at_least_2")}
                      </div>
                    )}

                    {/* Create custom asset option - always visible when user has typed something */}
                    {searchQuery.length > 0 && !isLoading && (
                      <>
                        {sortedSearchResults.length > 0 && <Separator className="my-4" />}
                        <button
                          onClick={handleShowCustomAssetForm}
                          className="card-mobile hover:bg-accent active:bg-accent/80 focus:border-primary flex w-full items-center gap-3 border border-dashed text-left transition-colors focus:outline-none"
                        >
                          <div className="bg-muted flex h-12 w-12 shrink-0 items-center justify-center rounded-full">
                            <Icons.Plus className="text-muted-foreground h-5 w-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-foreground font-medium">
                              {t("common:component.create_custom_asset_option")}
                            </div>
                            <div className="text-muted-foreground mt-0.5 text-sm">
                              {searchQuery.trim()
                                ? t("common:component.create_symbol_manual_pricing", {
                                    symbol: searchQuery.trim().toUpperCase(),
                                  })
                                : t("common:component.track_assets_not_found")}
                            </div>
                          </div>
                          <Icons.ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" />
                        </button>
                      </>
                    )}
                  </ScrollArea>
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>
      </>
    );
  },
);

SymbolSelectorMobile.displayName = "SymbolSelectorMobile";
