import { searchTicker } from "@/adapters";
import { getExchangeDisplayName } from "@/lib/constants";
import { debounce } from "@/lib/debounce";
import { SymbolSearchResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { formatPrice } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@wealthfolio/ui/components/ui/command";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useComposedRefs } from "@wealthfolio/ui/hooks";
import { Command as CommandPrimitive } from "cmdk";
import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CreateCustomAssetDialog } from "./create-custom-asset-dialog";

interface QuoteInfo {
  price: number | null;
  currency?: string;
  isLoading: boolean;
}

interface SearchProps {
  selectedResult?: SymbolSearchResult;
  defaultValue?: string;
  value?: string;
  placeholder?: string;
  onSelectResult: (symbol: string, searchResult?: SymbolSearchResult) => void;
  /** Controlled open state (optional). */
  open?: boolean;
  /** Controlled open change handler (optional). */
  onOpenChange?: (open: boolean) => void;
  /** When true, focuses the search input when the popover opens. */
  autoFocusSearch?: boolean;
  className?: string;
  /** Default currency to use for custom assets (typically from account) */
  defaultCurrency?: string;
  /** Optional exchange MIC for display context when value is canonical (e.g., SHOP -> SHOP (TSX)). */
  selectedExchangeMic?: string;
  /** Quote info to display in the trigger after selection */
  quoteInfo?: QuoteInfo;
  /** Called when the user clears the selection */
  onClear?: () => void;
  /** Hide the "Create custom (manual)" option in search results */
  hideCustomCreate?: boolean;
  /** Test ID for e2e testing */
  "data-testid"?: string;
}

interface SearchResultsProps {
  results?: SymbolSearchResult[];
  query: string;
  isLoading: boolean;
  isError?: boolean;
  selectedResult: SearchProps["selectedResult"];
  onSelect: (symbol: SymbolSearchResult) => void;
  onCreateCustomAsset: () => void;
  hideCustomCreate?: boolean;
}

function getSearchResultKey(result: SymbolSearchResult) {
  if (result.existingAssetId) return result.existingAssetId;
  const parts = [
    result.symbol,
    result.exchangeMic ?? result.exchange,
    result.currency,
    result.longName ?? result.shortName,
    result.index,
  ].filter(Boolean);
  return parts.join("|");
}

// Memoize search results component
const SearchResults = memo(
  ({
    results,
    query,
    isLoading,
    selectedResult,
    onSelect,
    onCreateCustomAsset,
    hideCustomCreate,
  }: SearchResultsProps) => {
    const { t } = useTranslation();
    const hasResults = results && results.length > 0;
    const showNoResults = !isLoading && !hasResults && query.length > 1;
    const selectedKey = selectedResult ? getSearchResultKey(selectedResult) : null;

    return (
      <CommandList>
        {isLoading ? (
          <CommandPrimitive.Loading>
            <div className="space-y-2 p-1">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          </CommandPrimitive.Loading>
        ) : null}

        {/* No results message */}
        {showNoResults && (
          <div className="text-muted-foreground px-2 py-3 text-center text-sm">
            {t("common:component.no_matches_for", { query })}
          </div>
        )}

        {/* Search results */}
        {hasResults &&
          results.map((ticker) => {
            // Use exchangeName if available (from backend), otherwise map exchange code to friendly name
            const exchangeDisplay = ticker.exchangeName || getExchangeDisplayName(ticker.exchange);
            const displayName = ticker.longName || ticker.shortName || ticker.symbol;
            const itemKey = getSearchResultKey(ticker);
            const isSelected = selectedKey === itemKey;
            return (
              <CommandItem
                key={itemKey}
                onSelect={() => onSelect(ticker)}
                value={itemKey}
                className="flex items-center justify-between rounded-none py-2"
              >
                <div className="flex flex-col">
                  <span className="font-mono text-xs font-semibold uppercase">{ticker.symbol}</span>
                  <span className="text-muted-foreground line-clamp-1 text-xs">{displayName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex flex-col items-end">
                    <span className="text-muted-foreground text-xs">{exchangeDisplay}</span>
                    {ticker.currency && (
                      <span className="text-muted-foreground text-[10px]">{ticker.currency}</span>
                    )}
                  </div>
                  {isSelected && <Icons.Check className="size-4" />}
                </div>
              </CommandItem>
            );
          })}

        {/* Create custom asset option - always visible unless hidden */}
        {!isLoading && !hideCustomCreate && (
          <>
            {hasResults && <CommandSeparator />}
            <CommandItem
              onSelect={onCreateCustomAsset}
              value={`create-custom-${query}`}
              className="flex items-center gap-3 py-2"
            >
              <Icons.PlusCircle className="text-muted-foreground size-4" />
              <div className="flex flex-col">
                <span className="font-mono text-xs font-semibold uppercase">
                  {query.trim().toUpperCase() || "..."}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t("common:component.create_custom_manual")}
                </span>
              </div>
            </CommandItem>
          </>
        )}
      </CommandList>
    );
  },
);

SearchResults.displayName = "SearchResults";

function isElementVisible(element: HTMLElement) {
  return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

function getFocusableElementsInDocument(doc: Document) {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  return Array.from(doc.querySelectorAll<HTMLElement>(selector)).filter((element) => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    if (!isElementVisible(element)) return false;
    return true;
  });
}

function focusRelativeTo(anchor: HTMLElement, direction: "next" | "prev") {
  const doc = anchor.ownerDocument;
  const focusables = getFocusableElementsInDocument(doc);
  const anchorIndex = focusables.indexOf(anchor);
  if (anchorIndex < 0) return;

  const offset = direction === "next" ? 1 : -1;
  focusables[anchorIndex + offset]?.focus();
}

const TickerSearchInput = forwardRef<HTMLButtonElement, SearchProps>(
  (
    {
      selectedResult,
      defaultValue,
      value,
      placeholder,
      onSelectResult,
      open: openProp,
      onOpenChange,
      autoFocusSearch = false,
      className,
      defaultCurrency,
      selectedExchangeMic,
      quoteInfo,
      onClear,
      hideCustomCreate,
      "data-testid": testId,
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const resolvedPlaceholder = placeholder ?? t("common:component.select_symbol");
    const isControlled = openProp !== undefined;
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const open = isControlled ? openProp : uncontrolledOpen;
    const [customAssetDialogOpen, setCustomAssetDialogOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState(defaultValue ?? value ?? "");
    const [debouncedQuery, setDebouncedQuery] = useState("");

    // Structured selection data for the rich trigger display
    const [selectedTicker, setSelectedTicker] = useState<{
      symbol: string;
      name: string;
      exchangeDisplay: string;
    } | null>(() => {
      if (selectedResult) {
        const exchangeDisplay =
          selectedResult.exchangeName || getExchangeDisplayName(selectedResult.exchange);
        return {
          symbol: selectedResult.symbol,
          name: selectedResult.longName || selectedResult.shortName || selectedResult.symbol,
          exchangeDisplay: exchangeDisplay || "",
        };
      }
      if (value) {
        const exchangeDisplay = getExchangeDisplayName(selectedExchangeMic) || "";
        return { symbol: value, name: "", exchangeDisplay };
      }
      return null;
    });

    // Keep a simple string for search query comparison
    const [selected, setSelected] = useState(() => {
      if (selectedResult) {
        const exchangeDisplay =
          selectedResult.exchangeName || getExchangeDisplayName(selectedResult.exchange);
        const exchangeSuffix = exchangeDisplay ? ` (${exchangeDisplay})` : "";
        return `${selectedResult.symbol} - ${selectedResult.longName}${exchangeSuffix}`;
      }
      if (defaultValue) {
        return defaultValue;
      }
      if (value) {
        const exchangeDisplay = getExchangeDisplayName(selectedExchangeMic);
        if (exchangeDisplay) {
          return `${value} (${exchangeDisplay})`;
        }
        return value;
      }
      return "";
    });
    const inputRef = useRef<HTMLInputElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const closeFocusIntentRef = useRef<null | "next" | "prev">(null);
    const composedTriggerRef = useComposedRefs(ref, triggerRef);

    // Create debounced search function
    const debouncedSearch = useMemo(
      () =>
        debounce((query: string) => {
          setDebouncedQuery(query);
        }, 300),
      [],
    );

    // Handle search query changes
    const handleSearchChange = useCallback(
      (newQuery: string) => {
        setSearchQuery(newQuery);
        debouncedSearch(newQuery);
      },
      [debouncedSearch],
    );

    const handleSelectResult = useCallback(
      (ticker: SymbolSearchResult) => {
        onSelectResult(ticker?.symbol, ticker);
        const exchangeDisplay = ticker?.exchangeName || getExchangeDisplayName(ticker?.exchange);
        const exchangeSuffix = exchangeDisplay ? ` (${exchangeDisplay})` : "";
        const displayText = ticker ? `${ticker.symbol} - ${ticker.longName}${exchangeSuffix}` : "";
        setSearchQuery(displayText);
        setSelected(displayText);
        setSelectedTicker({
          symbol: ticker.symbol,
          name: ticker.longName || ticker.shortName || ticker.symbol,
          exchangeDisplay: exchangeDisplay || "",
        });
        if (isControlled) {
          onOpenChange?.(false);
        } else {
          setUncontrolledOpen(false);
        }
        debouncedSearch.cancel();
      },
      [onSelectResult, debouncedSearch, isControlled, onOpenChange],
    );

    useEffect(() => {
      if (selectedResult) {
        const exchangeDisplay =
          selectedResult.exchangeName || getExchangeDisplayName(selectedResult.exchange);
        const exchangeSuffix = exchangeDisplay ? ` (${exchangeDisplay})` : "";
        const displayText = `${selectedResult.symbol} - ${
          selectedResult.longName || selectedResult.shortName || selectedResult.symbol
        }${exchangeSuffix}`;
        setSelected(displayText);
        setSelectedTicker({
          symbol: selectedResult.symbol,
          name: selectedResult.longName || selectedResult.shortName || selectedResult.symbol,
          exchangeDisplay: exchangeDisplay || "",
        });
        return;
      }

      const current = value ?? defaultValue ?? "";
      if (!current) {
        setSelected("");
        setSelectedTicker(null);
        return;
      }
      // Don't overwrite a richer internal selection with a bare value sync
      if (selectedTicker?.symbol === current && selectedTicker.name) return;
      const exchangeDisplay = getExchangeDisplayName(selectedExchangeMic);
      const next = exchangeDisplay ? `${current} (${exchangeDisplay})` : current;
      setSelected((prev) => (prev === next ? prev : next));
      setSelectedTicker({ symbol: current, name: "", exchangeDisplay: exchangeDisplay || "" });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [defaultValue, selectedExchangeMic, selectedResult, value]);

    // Handle "Create custom asset" click
    const handleCreateCustomAsset = useCallback(() => {
      // Don't close the popover here — in controlled mode, closing triggers the
      // parent's onOpenChange which may unmount this component (and the dialog
      // rendered inside it) before it can appear.  The dialog overlays on top;
      // once an asset is created, handleSelectResult closes the popover normally.
      debouncedSearch.cancel();
      setCustomAssetDialogOpen(true);
    }, [debouncedSearch]);

    // Handle custom asset created from dialog
    const handleCustomAssetCreated = useCallback(
      (searchResult: SymbolSearchResult) => {
        // Select the newly created custom asset
        handleSelectResult(searchResult);
      },
      [handleSelectResult],
    );

    // Auto-search on mount when a defaultValue is pre-filled
    useEffect(() => {
      if (defaultValue && defaultValue.length > 1) {
        setDebouncedQuery(defaultValue);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Use debounced query for API call
    const { data, isLoading, isError } = useQuery<SymbolSearchResult[], Error>({
      queryKey: ["ticker-search", debouncedQuery],
      queryFn: () => searchTicker(debouncedQuery),
      enabled:
        debouncedQuery?.length > 1 &&
        // Only block re-search after an actual confirmed selection (name is populated),
        // not when the input is just pre-filled from defaultValue (name is empty).
        !(selected === debouncedQuery && !!selectedTicker?.name),
      staleTime: 60000, // Cache results for 1 minute
      gcTime: 300000, // Keep in cache for 5 minutes (formerly cacheTime)
    });

    // Results are already sorted by backend (existing assets first, then by score)
    const sortedTickers = data;

    const clearSelection = useCallback(() => {
      setSelected("");
      setSelectedTicker(null);
      setSearchQuery("");
      setDebouncedQuery("");
      debouncedSearch.cancel();
      onClear?.();
    }, [debouncedSearch, onClear]);

    const handleClearClick = useCallback(
      (e: React.MouseEvent<HTMLSpanElement>) => {
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
      },
      [clearSelection],
    );

    const handleClearMouseDown = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
      e.preventDefault();
      e.stopPropagation();
    }, []);

    // Handle popover open
    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        if (isControlled) {
          onOpenChange?.(newOpen);
        } else {
          setUncontrolledOpen(newOpen);
        }
        if (!newOpen) {
          debouncedSearch.cancel(); // Cancel pending searches when closing
        }
      },
      [debouncedSearch, isControlled, onOpenChange],
    );

    // Handle focus events
    const handleOpenAutoFocus = useCallback(
      (e: Event) => {
        if (!autoFocusSearch) return;
        e.preventDefault();
        inputRef.current?.focus();
      },
      [autoFocusSearch],
    );

    const handleInputKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== "Tab") return;
        closeFocusIntentRef.current = e.shiftKey ? "prev" : "next";
        e.preventDefault();
        if (isControlled) {
          onOpenChange?.(false);
        } else {
          setUncontrolledOpen(false);
        }
      },
      [isControlled, onOpenChange],
    );

    const handleCloseAutoFocus = useCallback((e: Event) => {
      const intent = closeFocusIntentRef.current;
      closeFocusIntentRef.current = null;
      if (!intent) return;

      e.preventDefault();
      const trigger = triggerRef.current;
      if (!trigger) return;
      requestAnimationFrame(() => {
        focusRelativeTo(trigger, intent);
      });
    }, []);

    return (
      <>
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              className={cn(
                "min-h-input-height h-auto w-full justify-between rounded-md px-3 py-2",
                open && "ring-ring ring-2",
                className,
              )}
              ref={composedTriggerRef}
              aria-expanded={open}
              aria-haspopup="listbox"
              data-testid={testId}
            >
              {selectedTicker ? (
                <div className="flex w-full min-w-0 items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {/* Row 1: Symbol + Name (left) — Clear (right) */}
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 text-sm font-semibold tracking-tight">
                        {selectedTicker.symbol}
                      </span>
                      {selectedTicker.name && (
                        <span className="text-muted-foreground truncate text-sm">
                          {selectedTicker.name}
                        </span>
                      )}
                    </div>
                    {/* Row 2: Exchange (left) — Price + Currency (right) */}
                    <div className="flex items-center justify-between gap-2 text-xs">
                      {selectedTicker.exchangeDisplay ? (
                        <span className="text-muted-foreground shrink-0 uppercase">
                          {selectedTicker.exchangeDisplay}
                        </span>
                      ) : (
                        <span />
                      )}
                      <div className="flex shrink-0 items-center gap-1">
                        {quoteInfo?.isLoading ? (
                          <Skeleton className="h-3 w-12" />
                        ) : (
                          quoteInfo?.price != null && (
                            <span className="tabular-nums">
                              {formatPrice(quoteInfo.price, quoteInfo.currency ?? "USD", false)}
                            </span>
                          )
                        )}
                        {quoteInfo?.currency && !quoteInfo.isLoading && (
                          <span className="text-muted-foreground font-light">
                            {quoteInfo.currency}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {onClear && (
                    <span
                      onMouseDown={handleClearMouseDown}
                      onClick={handleClearClick}
                      className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-0.5"
                    >
                      <Icons.Close className="size-3.5" />
                    </span>
                  )}
                </div>
              ) : (
                <>
                  <span className="text-muted-foreground">{resolvedPlaceholder}</span>
                  <Icons.Search className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </>
              )}
            </Button>
          </PopoverTrigger>

          <PopoverContent
            side="bottom"
            align="start"
            className="w-(--radix-popover-trigger-width) h-auto min-w-[280px] p-0"
            onOpenAutoFocus={handleOpenAutoFocus}
            onCloseAutoFocus={handleCloseAutoFocus}
            onWheel={(e) => e.stopPropagation()}
          >
            <Command shouldFilter={false} className="border-none">
              <CommandInput
                ref={inputRef}
                autoFocus={autoFocusSearch}
                value={searchQuery}
                onValueChange={handleSearchChange}
                placeholder={t("common:search_symbol")}
                onKeyDown={handleInputKeyDown}
              />

              <SearchResults
                isLoading={isLoading}
                isError={isError}
                query={searchQuery}
                results={sortedTickers}
                selectedResult={selectedResult}
                onSelect={handleSelectResult}
                onCreateCustomAsset={handleCreateCustomAsset}
                hideCustomCreate={hideCustomCreate}
              />
            </Command>
          </PopoverContent>
        </Popover>

        {/* Custom Asset Creation Dialog */}
        <CreateCustomAssetDialog
          open={customAssetDialogOpen}
          onOpenChange={setCustomAssetDialogOpen}
          onAssetCreated={handleCustomAssetCreated}
          defaultSymbol={searchQuery.trim()}
          defaultCurrency={defaultCurrency}
        />
      </>
    );
  },
);

TickerSearchInput.displayName = "TickerSearchInput";

export default TickerSearchInput;
