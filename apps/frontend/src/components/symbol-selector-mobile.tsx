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
const ASSET_TYPE_OPTIONS = [
  { value: "EQUITY", label: "Security" },
  { value: "CRYPTO", label: "Crypto" },
  { value: "OTHER", label: "Other" },
] as const;

export const SymbolSelectorMobile = forwardRef<HTMLButtonElement, SymbolSelectorMobileProps>(
  (
    {
      onSelect,
      value,
      placeholder = "Select symbol...",
      className,
      open: controlledOpen,
      onOpenChange,
      defaultCurrency,
    },
    ref,
  ) => {
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
      : value || placeholder;

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
                      <SheetTitle>Create Custom Asset</SheetTitle>
                      <SheetDescription>Track assets with manual pricing</SheetDescription>
                    </div>
                  </div>
                </SheetHeader>

                {/* Custom Asset Form */}
                <div className="flex h-[calc(85vh-6rem)] flex-col">
                  <ScrollArea className="flex-1">
                    <div className="form-mobile-spacing px-6 py-4">
                      {/* Symbol */}
                      <div className="space-y-2">
                        <label className="text-base font-medium">Symbol / Ticker</label>
                        <Input
                          placeholder="e.g., MYCOIN"
                          value={customSymbol}
                          onChange={(e) => setCustomSymbol(e.target.value.toUpperCase())}
                          className="uppercase"
                          autoFocus
                        />
                      </div>

                      {/* Name */}
                      <div className="space-y-2">
                        <label className="text-base font-medium">Name</label>
                        <Input
                          placeholder="e.g., My Custom Coin"
                          value={customName}
                          onChange={(e) => setCustomName(e.target.value)}
                        />
                      </div>

                      {/* Asset Type and Currency - side by side */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <label className="text-base font-medium">Asset Type</label>
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
                              {ASSET_TYPE_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <label className="text-base font-medium">Currency</label>
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
                      Cancel
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
                      Create Asset
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Search View Header */}
                <SheetHeader className="border-border border-b px-6 py-4">
                  <SheetTitle>Select Symbol</SheetTitle>
                  <SheetDescription>
                    Search for a stock, ETF, crypto, or other asset
                  </SheetDescription>
                </SheetHeader>

                <div className="flex h-[calc(85vh-6rem)] flex-col">
                  {/* Search Input */}
                  <div className="border-border border-b px-6 py-4">
                    <div className="relative">
                      <Icons.Search className="text-muted-foreground absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2" />
                      <input
                        type="text"
                        placeholder="Search symbols..."
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
                          Searching...
                        </div>
                        <Skeleton className="h-16 w-full rounded-xl" />
                        <Skeleton className="h-16 w-full rounded-xl" />
                        <Skeleton className="h-16 w-full rounded-xl" />
                      </div>
                    )}

                    {/* Error state */}
                    {isError && searchQuery.length > 1 && (
                      <div className="text-muted-foreground py-8 text-center text-sm">
                        Error searching for symbols. Please try again.
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
                        <p>Start typing to search for symbols</p>
                      </div>
                    )}

                    {/* No results state */}
                    {searchQuery.length > 0 &&
                      !isLoading &&
                      !isError &&
                      sortedSearchResults.length === 0 &&
                      searchQuery.length > 1 && (
                        <div className="text-muted-foreground py-8 text-center text-sm">
                          <p>No matches found for &quot;{searchQuery}&quot;</p>
                          <p className="mt-2 text-xs">You can create a custom asset below.</p>
                        </div>
                      )}

                    {/* Too short query state */}
                    {searchQuery.length > 0 && searchQuery.length <= 1 && (
                      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                        Type at least 2 characters to search.
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
                            <div className="text-foreground font-medium">Create custom asset</div>
                            <div className="text-muted-foreground mt-0.5 text-sm">
                              {searchQuery.trim()
                                ? `Create "${searchQuery.trim().toUpperCase()}" with manual pricing`
                                : "Track assets not found in market data"}
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
