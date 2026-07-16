import { searchTicker } from "@/adapters";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@wealthfolio/ui/components/ui/sheet";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { SymbolSearchResult } from "@/lib/types";
import { getExchangeDisplayName } from "@/lib/constants";

import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

// Predefined benchmarks with canonical asset IDs
// exchangeMic is undefined for indices (will use "INDEX" as pseudo-MIC)
// exchangeMic is set for ETFs that trade on real exchanges
const BENCHMARKS = [
  {
    groupKey: "benchmark_group_us_indices",
    items: [
      { symbol: "^GSPC", name: "S&P 500", descriptionKey: "benchmark_desc_large_cap_us" },
      { symbol: "^NDX", name: "Nasdaq 100", descriptionKey: "benchmark_desc_large_cap_tech_us" },
      { symbol: "^RUT", name: "Russell 2000", descriptionKey: "benchmark_desc_small_cap_us" },
      { symbol: "^DJI", name: "Dow Jones", descriptionKey: "benchmark_desc_blue_chip_us" },
    ],
  },
  {
    groupKey: "benchmark_group_european_indices",
    items: [
      { symbol: "^FTSE", name: "FTSE 100", descriptionKey: "benchmark_desc_large_cap_uk" },
      {
        symbol: "^STOXX50E",
        name: "EURO STOXX 50",
        descriptionKey: "benchmark_desc_european_blue_chip",
      },
      { symbol: "^GDAXI", name: "DAX", descriptionKey: "benchmark_desc_german_blue_chip" },
      { symbol: "^FCHI", name: "CAC 40", descriptionKey: "benchmark_desc_french_large_cap" },
      { symbol: "^IBEX", name: "IBEX 35", descriptionKey: "benchmark_desc_spanish_large_cap" },
      { symbol: "^AEX", name: "AEX", descriptionKey: "benchmark_desc_dutch_blue_chip" },
      {
        symbol: "^OMX",
        name: "OMX Stockholm 30",
        descriptionKey: "benchmark_desc_swedish_large_cap",
      },
    ],
  },
  {
    groupKey: "benchmark_group_asian_indices",
    items: [
      { symbol: "^N225", name: "Nikkei 225", descriptionKey: "benchmark_desc_japanese_large_cap" },
      { symbol: "^HSI", name: "Hang Seng", descriptionKey: "benchmark_desc_hong_kong_large_cap" },
      {
        symbol: "000001.SS",
        name: "Shanghai Composite",
        descriptionKey: "benchmark_desc_chinese_a_shares",
      },
      { symbol: "^KS11", name: "KOSPI", descriptionKey: "benchmark_desc_south_korean" },
      { symbol: "^TWII", name: "Taiwan Weighted", descriptionKey: "benchmark_desc_taiwanese" },
      { symbol: "^AXJO", name: "ASX 200", descriptionKey: "benchmark_desc_australian_large_cap" },
      { symbol: "^BSESN", name: "BSE Sensex", descriptionKey: "benchmark_desc_indian_large_cap" },
      { symbol: "^NSEI", name: "NIFTY 50", descriptionKey: "benchmark_desc_indian_blue_chip" },
    ],
  },
  {
    groupKey: "benchmark_group_global_emerging",
    items: [
      {
        symbol: "EEM",
        name: "MSCI Emerging Markets",
        descriptionKey: "benchmark_desc_emerging_market",
        exchangeMic: "ARCX",
      },
      {
        symbol: "ACWI",
        name: "MSCI All Country World",
        descriptionKey: "benchmark_desc_global_equity",
        exchangeMic: "XNAS",
      },
      {
        symbol: "IEFA",
        name: "Core MSCI EAFE",
        descriptionKey: "benchmark_desc_eafe",
        exchangeMic: "ARCX",
      },
    ],
  },
  {
    groupKey: "benchmark_group_etfs",
    items: [
      {
        symbol: "VOO",
        name: "Vanguard S&P 500",
        descriptionKey: "benchmark_desc_sp500_fund",
        exchangeMic: "ARCX",
      },
      {
        symbol: "VTI",
        name: "Vanguard Total Stock",
        descriptionKey: "benchmark_desc_total_us_market",
        exchangeMic: "ARCX",
      },
      {
        symbol: "VEA",
        name: "Vanguard FTSE Developed",
        descriptionKey: "benchmark_desc_developed_ex_us",
        exchangeMic: "ARCX",
      },
      {
        symbol: "VWO",
        name: "Vanguard FTSE Emerging",
        descriptionKey: "benchmark_desc_emerging_markets",
        exchangeMic: "ARCX",
      },
    ],
  },
];

interface BenchmarkSymbolSelectorMobileProps {
  onSelect: (symbol: { id: string; name: string }) => void;
  className?: string;
  iconOnly?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function BenchmarkSymbolSelectorMobile({
  onSelect,
  className,
  iconOnly = false,
  open: controlledOpen,
  onOpenChange,
}: BenchmarkSymbolSelectorMobileProps) {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = onOpenChange !== undefined ? onOpenChange : setInternalOpen;

  const [searchQuery, setSearchQuery] = useState("");

  // Query for dynamic ticker search
  const {
    data: searchResults,
    isLoading,
    isError,
  } = useQuery<SymbolSearchResult[], Error>({
    queryKey: ["benchmark-ticker-search", searchQuery],
    queryFn: () => searchTicker(searchQuery),
    enabled: searchQuery?.length > 2,
  });

  // Sort search results by score if available
  const sortedSearchResults = searchResults?.sort((a, b) => b.score - a.score) ?? [];

  // Filter out search results that are already in predefined benchmarks
  const existingSymbols = BENCHMARKS.flatMap((group) => group.items.map((item) => item.symbol));
  const filteredSearchResults = sortedSearchResults.filter(
    (result) => !existingSymbols.includes(result.symbol),
  );

  const handleBenchmarkSelect = (benchmark: {
    symbol: string;
    name: string;
    exchangeMic?: string;
  }) => {
    onSelect({ id: benchmark.symbol, name: benchmark.name });
    setOpen(false);
    setSearchQuery("");
  };

  const handleSearchResultSelect = (ticker: SymbolSearchResult) => {
    onSelect({
      id: ticker.existingAssetId || ticker.symbol,
      name: ticker.longName || ticker.symbol,
    });
    setOpen(false);
    setSearchQuery("");
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          aria-label={iconOnly ? t("common:component.add_benchmark") : undefined}
          className={cn(
            "bg-secondary/30 hover:bg-muted/80 flex items-center gap-1.5 rounded-md border-[1.5px] border-none text-sm font-medium",
            iconOnly ? "h-9 w-9 p-0" : "h-8 px-3 py-1",
            className,
          )}
          size={iconOnly ? "icon" : "sm"}
        >
          <Icons.TrendingUp className="h-4 w-4" />
          {!iconOnly && t("common:component.add_benchmark")}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="rounded-t-4xl mx-1 h-[85vh] p-0">
        <SheetHeader className="border-border border-b px-6 py-4">
          <SheetTitle>{t("common:select_benchmark")}</SheetTitle>
          <SheetDescription>{t("common:choose_benchmark")}</SheetDescription>
        </SheetHeader>

        <div className="flex h-[calc(85vh-5rem)] flex-col">
          {/* Search Input */}
          <div className="border-border border-b px-6 py-3">
            <div className="relative">
              <Icons.Search className="text-muted-foreground absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
              <input
                type="text"
                placeholder={t("common:search_benchmarks")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-background border-input ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring h-10 w-full rounded-md border px-3 py-2 pl-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
              />
            </div>
          </div>

          {/* Results */}
          <ScrollArea className="flex-1 px-6 py-4">
            {/* Loading state for search results */}
            {isLoading && searchQuery.length > 2 && (
              <div className="space-y-2">
                <div className="text-muted-foreground mb-3 text-sm font-medium">
                  {t("common:searching")}
                </div>
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            )}

            {/* Error state for search results */}
            {isError && searchQuery.length > 2 && (
              <div className="text-muted-foreground py-8 text-center text-sm">
                {t("common:error_searching")}
              </div>
            )}

            {/* Dynamic search results */}
            {!isLoading &&
              !isError &&
              filteredSearchResults.length > 0 &&
              searchQuery.length > 2 && (
                <div className="mb-6">
                  <h3 className="text-muted-foreground mb-3 text-sm font-medium">
                    {t("common:component.search_results")}
                  </h3>
                  <div className="space-y-2">
                    {filteredSearchResults.slice(0, 8).map((ticker) => (
                      <button
                        key={ticker.symbol}
                        onClick={() => handleSearchResultSelect(ticker)}
                        className="hover:bg-accent active:bg-accent/80 focus:border-primary flex w-full items-center gap-3 rounded-lg border border-transparent p-3 text-left transition-colors focus:outline-none"
                      >
                        <div className="bg-primary/10 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full">
                          <Icons.TrendingUp className="text-primary h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-foreground truncate font-medium">
                              {ticker.longName || ticker.symbol}
                            </span>
                            <span className="text-muted-foreground text-xs">{ticker.symbol}</span>
                          </div>
                          {ticker.exchange && (
                            <div className="text-muted-foreground text-sm">
                              {ticker.exchangeName || getExchangeDisplayName(ticker.exchange)}
                            </div>
                          )}
                        </div>
                        <Icons.ChevronRight className="text-muted-foreground h-5 w-5 flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

            {/* Predefined benchmark groups */}
            {(searchQuery.length === 0 || !isLoading) && (
              <div className="space-y-6">
                {BENCHMARKS.map((group) => {
                  const filteredItems = group.items.filter(
                    (benchmark) =>
                      searchQuery.length === 0 ||
                      benchmark.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                      benchmark.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
                      t(`common:component.${benchmark.descriptionKey}`)
                        .toLowerCase()
                        .includes(searchQuery.toLowerCase()),
                  );

                  if (filteredItems.length === 0) return null;

                  return (
                    <div key={group.groupKey}>
                      <h3 className="text-muted-foreground mb-3 text-sm font-medium">
                        {t(`common:component.${group.groupKey}`)}
                      </h3>
                      <div className="space-y-2">
                        {filteredItems.map((benchmark) => (
                          <button
                            key={benchmark.symbol}
                            onClick={() => handleBenchmarkSelect(benchmark)}
                            className="hover:bg-accent active:bg-accent/80 focus:border-primary flex w-full items-center gap-3 rounded-lg border border-transparent p-3 text-left transition-colors focus:outline-none"
                          >
                            <div className="bg-primary/10 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full">
                              <Icons.TrendingUp className="text-primary h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-foreground font-medium">
                                  {benchmark.name}
                                </span>
                                <span className="text-muted-foreground text-xs">
                                  {benchmark.symbol}
                                </span>
                              </div>
                              <div className="text-muted-foreground text-sm">
                                {t(`common:component.${benchmark.descriptionKey}`)}
                              </div>
                            </div>
                            <Icons.ChevronRight className="text-muted-foreground h-5 w-5 flex-shrink-0" />
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Empty state */}
            {searchQuery.length > 0 &&
              !isLoading &&
              filteredSearchResults.length === 0 &&
              BENCHMARKS.every(
                (group) =>
                  group.items.filter(
                    (benchmark) =>
                      benchmark.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                      benchmark.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
                      t(`common:component.${benchmark.descriptionKey}`)
                        .toLowerCase()
                        .includes(searchQuery.toLowerCase()),
                  ).length === 0,
              ) && (
                <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                  {t("common:no_benchmarks_found")}
                </div>
              )}
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}
