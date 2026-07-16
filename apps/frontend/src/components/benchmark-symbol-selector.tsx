import { searchTicker } from "@/adapters";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@wealthfolio/ui/components/ui/command";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
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

interface BenchmarkSymbolSelectorProps {
  onSelect: (symbol: { id: string; name: string }) => void;
  className?: string;
  iconOnly?: boolean;
}

export function BenchmarkSymbolSelector({
  onSelect,
  className,
  iconOnly = false,
}: BenchmarkSymbolSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Query for dynamic ticker search
  const {
    data: searchResults,
    isLoading,
    isError,
  } = useQuery<SymbolSearchResult[], Error>({
    queryKey: ["benchmark-ticker-search", searchQuery],
    queryFn: () => searchTicker(searchQuery),
    enabled: searchQuery?.length > 2, // Only search when query is longer than 2 characters
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
    setValue(benchmark.name);
    onSelect({ id: benchmark.symbol, name: benchmark.name });
    setOpen(false);
    setSearchQuery(""); // Clear search when selecting
  };

  const handleSearchResultSelect = (ticker: SymbolSearchResult) => {
    setValue(ticker.longName || ticker.symbol);
    onSelect({
      id: ticker.existingAssetId || ticker.symbol,
      name: ticker.longName || ticker.symbol,
    });
    setOpen(false);
    setSearchQuery(""); // Clear search when selecting
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={iconOnly ? t("common:component.add_benchmark") : undefined}
          className={cn(
            "bg-secondary/30 hover:bg-muted/80 flex items-center gap-1.5 rounded-md border-dashed text-sm font-medium",
            iconOnly ? "h-9 w-9 p-0" : "h-8 px-3 py-1",
            className,
          )}
          size={iconOnly ? "icon" : "sm"}
        >
          <Icons.TrendingUp className="h-4 w-4" />
          {!iconOnly && t("common:component.add_benchmark")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[350px] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("common:search_benchmarks")}
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList className="max-h-[300px] overflow-y-auto">
            <CommandEmpty>
              {isLoading ? t("common:searching") : t("common:no_benchmarks_found")}
            </CommandEmpty>

            {/* Predefined benchmark groups */}
            {BENCHMARKS.map((group) => (
              <CommandGroup
                key={group.groupKey}
                heading={t(`common:component.${group.groupKey}`)}
                className="[&_[cmdk-group-heading]]:bg-popover [&_[cmdk-group-heading]]:border-border/10 [&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:border-b"
              >
                {group.items
                  .filter(
                    (benchmark) =>
                      searchQuery.length === 0 ||
                      benchmark.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                      benchmark.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
                      t(`common:component.${benchmark.descriptionKey}`)
                        .toLowerCase()
                        .includes(searchQuery.toLowerCase()),
                  )
                  .map((benchmark) => (
                    <CommandItem
                      key={benchmark.symbol}
                      value={`${benchmark.name} ${benchmark.symbol}`}
                      onSelect={() => handleBenchmarkSelect(benchmark)}
                    >
                      <div className="flex flex-col">
                        <div className="flex items-center">
                          <span className="font-medium">{benchmark.name}</span>
                          <span className="text-muted-foreground ml-2 text-xs">
                            {benchmark.symbol}
                          </span>
                        </div>
                        <span className="text-muted-foreground text-xs">
                          {t(`common:component.${benchmark.descriptionKey}`)}
                        </span>
                      </div>
                      <Icons.Check
                        className={cn(
                          "ml-auto h-4 w-4",
                          value === benchmark.name ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}

            {/* Loading state for search results */}
            {isLoading && searchQuery.length > 2 && (
              <CommandGroup
                heading={t("common:component.search_results")}
                className="[&_[cmdk-group-heading]]:bg-popover [&_[cmdk-group-heading]]:border-border/10 [&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:border-b"
              >
                <div className="space-y-2 p-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              </CommandGroup>
            )}

            {/* Error state for search results */}
            {isError && searchQuery.length > 2 && (
              <CommandGroup
                heading={t("common:component.search_results")}
                className="[&_[cmdk-group-heading]]:bg-popover [&_[cmdk-group-heading]]:border-border/10 [&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:border-b"
              >
                <div className="text-muted-foreground p-4 text-sm">
                  {t("common:error_searching")}
                </div>
              </CommandGroup>
            )}

            {/* Dynamic search results */}
            {!isLoading &&
              !isError &&
              filteredSearchResults.length > 0 &&
              searchQuery.length > 2 && (
                <CommandGroup
                  heading={t("common:component.search_results")}
                  className="[&_[cmdk-group-heading]]:bg-popover [&_[cmdk-group-heading]]:border-border/10 [&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:border-b"
                >
                  {filteredSearchResults.slice(0, 8).map((ticker) => (
                    <CommandItem
                      key={ticker.symbol}
                      value={ticker.symbol}
                      onSelect={() => handleSearchResultSelect(ticker)}
                    >
                      <div className="flex flex-col">
                        <div className="flex items-center">
                          <span className="font-medium">{ticker.longName || ticker.symbol}</span>
                          <span className="text-muted-foreground ml-2 text-xs">
                            {ticker.symbol}
                          </span>
                        </div>
                        {ticker.exchange && (
                          <span className="text-muted-foreground text-xs">
                            {ticker.exchangeName || getExchangeDisplayName(ticker.exchange)}
                          </span>
                        )}
                      </div>
                      <Icons.Check
                        className={cn(
                          "ml-auto h-4 w-4",
                          value === (ticker.longName || ticker.symbol)
                            ? "opacity-100"
                            : "opacity-0",
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
