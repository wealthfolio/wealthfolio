import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Badge, Card, formatPrice, Input } from "@wealthfolio/ui";

import { TickerAvatar } from "@/components/ticker-avatar";
import { useSettingsContext } from "@/lib/settings-provider";
import { ASSET_KIND_DISPLAY_NAMES, LatestQuoteSnapshot } from "@/lib/types";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { cn, formatDate } from "@/lib/utils";
import { ScrollArea, Separator } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui/components/ui/sheet";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { getNoQuoteReasonText, isStaleQuote, ParsedAsset } from "./asset-utils";

interface AssetsTableMobileProps {
  assets: ParsedAsset[];
  latestQuotes?: Record<string, LatestQuoteSnapshot>;
  heldAssetIds: Set<string>;
  isLoading?: boolean;
  onEdit: (asset: ParsedAsset) => void;
  onDelete: (asset: ParsedAsset) => void;
  onUpdateQuotes: (asset: ParsedAsset) => void;
  onRefetchQuotes: (asset: ParsedAsset) => void;
  onClassify?: (asset: ParsedAsset) => void;
  isUpdatingQuotes?: boolean;
  isRefetchingQuotes?: boolean;
}

export function AssetsTableMobile({
  assets,
  latestQuotes = {},
  heldAssetIds,
  isLoading,
  onEdit,
  onDelete,
  onUpdateQuotes,
  onRefetchQuotes,
  onClassify,
  isUpdatingQuotes,
  isRefetchingQuotes,
}: AssetsTableMobileProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDataSources, setSelectedDataSources] = useState<string[]>([]);
  const [selectedAssetKinds, setSelectedAssetKinds] = useState<string[]>([]);
  const [selectedPriceStatus, setSelectedPriceStatus] = useState<string[]>([]);
  const [selectedStatus, setSelectedStatus] = useState<string[]>(["true"]);
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);

  // Get unique quote modes
  const quoteModeOptions = useMemo(() => {
    const modes = new Set(assets.map((asset) => asset.quoteMode).filter(Boolean));
    return Array.from(modes);
  }, [assets]);

  // Get unique asset kinds
  const assetKindOptions = useMemo(() => {
    const kinds = new Set(assets.map((asset) => asset.kind).filter((k) => !!k));
    return Array.from(kinds).sort();
  }, [assets]);

  const filteredAssets = useMemo(() => {
    let filtered = assets;

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((asset) =>
        [asset.displayCode ?? "", asset.name ?? "", asset.kind ?? ""].some((value) =>
          value.toLowerCase().includes(query),
        ),
      );
    }

    // Filter by pricing mode
    if (selectedDataSources.length > 0) {
      filtered = filtered.filter((asset) => selectedDataSources.includes(asset.quoteMode));
    }

    // Filter by asset kind
    if (selectedAssetKinds.length > 0) {
      filtered = filtered.filter((asset) => asset.kind && selectedAssetKinds.includes(asset.kind));
    }

    // Filter by holding status (held/not held)
    if (selectedStatus.length > 0) {
      filtered = filtered.filter((asset) => {
        const held = heldAssetIds.has(asset.id) ? "true" : "false";
        return selectedStatus.includes(held);
      });
    }

    // Filter by price status
    if (selectedPriceStatus.length > 0) {
      filtered = filtered.filter((asset) => {
        const snapshot = latestQuotes[asset.id];
        const isStale = isStaleQuote(snapshot, asset);
        return selectedPriceStatus.includes(isStale ? "true" : "false");
      });
    }

    // Sort by displayCode
    filtered.sort((a, b) => (a.displayCode ?? "").localeCompare(b.displayCode ?? ""));

    return filtered;
  }, [
    assets,
    searchQuery,
    selectedDataSources,
    selectedAssetKinds,
    selectedStatus,
    selectedPriceStatus,
    latestQuotes,
    heldAssetIds,
  ]);

  const hasActiveFilters =
    selectedDataSources.length > 0 ||
    selectedAssetKinds.length > 0 ||
    selectedPriceStatus.length > 0 ||
    (selectedStatus.length > 0 && !(selectedStatus.length === 1 && selectedStatus[0] === "true"));

  const handleResetFilters = () => {
    setSelectedDataSources([]);
    setSelectedAssetKinds([]);
    setSelectedPriceStatus([]);
    setSelectedStatus(["true"]);
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-10" />
        </div>
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-1 items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
              <Skeleton className="h-9 w-9" />
            </div>
            <div className="mt-3 flex gap-2">
              <Skeleton className="h-6 w-12" />
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-6 w-14" />
            </div>
            <div className="mt-3 flex justify-between">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-24" />
            </div>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          placeholder={t("asset:mobileTable.search_placeholder")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="bg-secondary/30 h-10 flex-1 rounded-full border-none"
        />
        <Button
          variant="outline"
          size="icon"
          className="relative size-10 flex-shrink-0"
          onClick={() => setIsFilterSheetOpen(true)}
        >
          <Icons.ListFilter className="h-4 w-4" />
          {hasActiveFilters && (
            <span className="bg-destructive absolute right-0 top-0.5 h-2 w-2 rounded-full" />
          )}
        </Button>
      </div>

      <div className="space-y-2">
        {filteredAssets.map((asset) => (
          <Card key={asset.id} className="p-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => navigate(`/holdings/${encodeURIComponent(asset.id)}`)}
                className="hover:bg-muted/60 focus-visible:ring-ring flex flex-1 items-center gap-3 overflow-hidden rounded-md text-left transition"
              >
                {(() => {
                  const rawSymbol = asset.displayCode ?? "";
                  const parsedOption = parseOccSymbol(rawSymbol);
                  const displaySymbol = parsedOption
                    ? parsedOption.underlying
                    : (asset.displayCode ?? asset.name ?? t("asset:table.unknown"));
                  const subtitle = parsedOption
                    ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
                    : (asset.name ?? "-");
                  const avatarSymbol = parsedOption ? parsedOption.underlying : rawSymbol;
                  return (
                    <>
                      <TickerAvatar symbol={avatarSymbol} className="h-10 w-10 flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate font-semibold">{displaySymbol}</p>
                          {parsedOption ? (
                            <Badge variant="secondary" className="text-[10px]">
                              {t("asset:mobileTable.option")}
                            </Badge>
                          ) : null}
                          <Badge variant="secondary" className="text-[10px] uppercase">
                            {asset.quoteCcy}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground truncate text-sm">{subtitle}</p>
                      </div>
                    </>
                  );
                })()}
              </button>

              <div className="flex flex-shrink-0 items-center gap-2">
                <div className="text-right text-sm">
                  {(() => {
                    const snapshot = latestQuotes[asset.id];
                    const quote = snapshot?.quote;

                    if (quote) {
                      return (
                        <>
                          <div className="flex items-center justify-end gap-1 font-semibold">
                            {formatPrice(
                              quote.close,
                              quote.currency ?? asset.quoteCcy ?? baseCurrency,
                            )}
                            {isStaleQuote(snapshot, asset) ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Icons.AlertTriangle
                                    className="text-destructive h-3.5 w-3.5"
                                    aria-label={t("asset:mobileTable.quote_behind_aria")}
                                  />
                                </TooltipTrigger>
                                <TooltipContent>
                                  {t("asset:mobileTable.quote_behind_tooltip")}
                                </TooltipContent>
                              </Tooltip>
                            ) : null}
                          </div>
                          <p className="text-muted-foreground text-xs">
                            {formatDate(quote.timestamp)}
                          </p>
                        </>
                      );
                    }

                    const noQuoteReason = getNoQuoteReasonText(snapshot, asset);

                    return (
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Icons.AlertTriangle
                              className="h-3.5 w-3.5 text-amber-500"
                              aria-label={noQuoteReason}
                            />
                          </TooltipTrigger>
                          <TooltipContent>{noQuoteReason}</TooltipContent>
                        </Tooltip>
                        <span className="text-muted-foreground text-xs">
                          {t("asset:mobileTable.no_quotes")}
                        </span>
                      </div>
                    );
                  })()}
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="hover:bg-muted text-muted-foreground inline-flex h-9 w-9 items-center justify-center rounded-md border transition"
                      aria-label={t("asset:mobileTable.open_actions")}
                    >
                      <Icons.MoreVertical className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => onUpdateQuotes(asset)}
                      disabled={isUpdatingQuotes}
                    >
                      {t("asset:mobileTable.update_quotes")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => onRefetchQuotes(asset)}
                      disabled={isRefetchingQuotes}
                    >
                      {t("asset:mobileTable.refetch_price_history")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onClassify?.(asset)}>
                      {t("asset:mobileTable.classify")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onEdit(asset)}>
                      {t("asset:mobileTable.edit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => onDelete(asset)}
                    >
                      {t("asset:mobileTable.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Filter Sheet */}
      <Sheet open={isFilterSheetOpen} onOpenChange={setIsFilterSheetOpen}>
        <SheetContent side="bottom" className="rounded-t-4xl mx-1 flex h-[70vh] flex-col">
          <SheetHeader className="text-left">
            <SheetTitle>{t("asset:mobileTable.filter_options")}</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 py-4">
            <div className="space-y-6">
              {/* Status Filter */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                    {t("asset:mobileTable.portfolio")}
                  </h4>
                  {selectedStatus.length > 0 &&
                    !(selectedStatus.length === 1 && selectedStatus[0] === "true") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto p-0 text-xs"
                        onClick={() => setSelectedStatus(["true"])}
                      >
                        {t("asset:mobileTable.reset")}
                      </Button>
                    )}
                </div>
                <div className="space-y-2">
                  {[
                    { label: t("asset:mobileTable.current"), value: "true" },
                    { label: t("asset:mobileTable.past"), value: "false" },
                  ].map((option) => {
                    const isSelected = selectedStatus.includes(option.value);
                    const count = assets.filter(
                      (a) => (heldAssetIds.has(a.id) ? "true" : "false") === option.value,
                    ).length;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          setSelectedStatus((prev) =>
                            isSelected
                              ? prev.filter((s) => s !== option.value)
                              : [...prev, option.value],
                          );
                        }}
                        className={cn(
                          "flex w-full items-center justify-between rounded-lg border p-3 text-sm transition-colors",
                          isSelected
                            ? "border-primary/50 bg-primary/5"
                            : "hover:bg-muted/50 border-border",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className={cn(
                              "flex h-5 w-5 items-center justify-center rounded border-2 transition-colors",
                              isSelected
                                ? "border-primary bg-primary"
                                : "border-muted-foreground/30",
                            )}
                          >
                            {isSelected && <Icons.Check className="text-secondary h-3 w-3" />}
                          </div>
                          <span className="font-medium">{option.label}</span>
                        </div>
                        <Badge variant="secondary" className="ml-auto">
                          {count}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              </div>

              <Separator />

              {/* Data Source Filter */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                    {t("asset:mobileTable.data_source")}
                  </h4>
                  {selectedDataSources.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => setSelectedDataSources([])}
                    >
                      {t("asset:mobileTable.clear")}
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {quoteModeOptions.map((mode) => {
                    const isSelected = selectedDataSources.includes(mode);
                    const count = assets.filter((a) => a.quoteMode === mode).length;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => {
                          setSelectedDataSources((prev) =>
                            isSelected ? prev.filter((s) => s !== mode) : [...prev, mode],
                          );
                        }}
                        className={cn(
                          "flex w-full items-center justify-between rounded-lg border p-3 text-sm transition-colors",
                          isSelected
                            ? "border-primary/50 bg-primary/5"
                            : "hover:bg-muted/50 border-border",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className={cn(
                              "flex h-5 w-5 items-center justify-center rounded border-2 transition-colors",
                              isSelected
                                ? "border-primary bg-primary"
                                : "border-muted-foreground/30",
                            )}
                          >
                            {isSelected && <Icons.Check className="text-secondary h-3 w-3" />}
                          </div>
                          <span className="font-medium uppercase">{mode}</span>
                        </div>
                        <Badge variant="secondary" className="ml-auto">
                          {count}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              </div>

              <Separator />

              {/* Asset Kind Filter */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                    {t("asset:mobileTable.asset_kind")}
                  </h4>
                  {selectedAssetKinds.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => setSelectedAssetKinds([])}
                    >
                      {t("asset:mobileTable.clear")}
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {assetKindOptions.map((kind) => {
                    const isSelected = selectedAssetKinds.includes(kind);
                    const count = assets.filter((a) => a.kind === kind).length;
                    return (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => {
                          setSelectedAssetKinds((prev) =>
                            isSelected ? prev.filter((s) => s !== kind) : [...prev, kind],
                          );
                        }}
                        className={cn(
                          "flex w-full items-center justify-between rounded-lg border p-3 text-sm transition-colors",
                          isSelected
                            ? "border-primary/50 bg-primary/5"
                            : "hover:bg-muted/50 border-border",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className={cn(
                              "flex h-5 w-5 items-center justify-center rounded border-2 transition-colors",
                              isSelected
                                ? "border-primary bg-primary"
                                : "border-muted-foreground/30",
                            )}
                          >
                            {isSelected && <Icons.Check className="text-secondary h-3 w-3" />}
                          </div>
                          <span className="font-medium">
                            {ASSET_KIND_DISPLAY_NAMES[kind] ?? kind}
                          </span>
                        </div>
                        <Badge variant="secondary" className="ml-auto">
                          {count}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              </div>

              <Separator />

              {/* Price Status Filter */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                    {t("asset:mobileTable.price_status")}
                  </h4>
                  {selectedPriceStatus.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => setSelectedPriceStatus([])}
                    >
                      {t("asset:mobileTable.clear")}
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {[
                    { label: t("asset:mobileTable.up_to_date"), value: "false" },
                    { label: t("asset:mobileTable.stale"), value: "true" },
                  ].map((option) => {
                    const isSelected = selectedPriceStatus.includes(option.value);
                    const count = assets.filter((a) => {
                      const snapshot = latestQuotes[a.id];
                      const isStale = isStaleQuote(snapshot, a);
                      return (isStale ? "true" : "false") === option.value;
                    }).length;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          setSelectedPriceStatus((prev) =>
                            isSelected
                              ? prev.filter((s) => s !== option.value)
                              : [...prev, option.value],
                          );
                        }}
                        className={cn(
                          "flex w-full items-center justify-between rounded-lg border p-3 text-sm transition-colors",
                          isSelected
                            ? "border-primary/50 bg-primary/5"
                            : "hover:bg-muted/50 border-border",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className={cn(
                              "flex h-5 w-5 items-center justify-center rounded border-2 transition-colors",
                              isSelected
                                ? "border-primary bg-primary"
                                : "border-muted-foreground/30",
                            )}
                          >
                            {isSelected && <Icons.Check className="text-secondary h-3 w-3" />}
                          </div>
                          <span className="font-medium">{option.label}</span>
                        </div>
                        <Badge variant="secondary" className="ml-auto">
                          {count}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </ScrollArea>
          <SheetFooter className="flex-row gap-2">
            {hasActiveFilters && (
              <Button variant="outline" className="flex-1" onClick={handleResetFilters}>
                {t("asset:mobileTable.reset_all")}
              </Button>
            )}
            <SheetClose asChild>
              <Button variant="default" className="flex-1">
                {t("asset:mobileTable.apply")}
              </Button>
            </SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
