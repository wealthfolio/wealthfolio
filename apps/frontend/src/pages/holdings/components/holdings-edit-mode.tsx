import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { CurrencyInput, DatePickerInput, QuantityInput, MoneyInput } from "@wealthfolio/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";

import { TickerAvatar } from "@/components/ticker-avatar";
import TickerSearchInput from "@/components/ticker-search";
import {
  saveManualHoldings,
  getSnapshotByDate,
  deleteSnapshot,
  type HoldingInput,
} from "@/adapters";
import { Holding, Account, SymbolSearchResult } from "@/lib/types";
import { getAssetIdFromSearchResult } from "@/lib/asset-utils";
import { HoldingType } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";

interface EditableHolding {
  assetId: string;
  symbol: string;
  name?: string;
  quantity: string;
  averageCost: string;
  currency: string;
  /** Exchange MIC code (e.g., "XNAS", "XTSE") for new holdings from search */
  exchangeMic?: string;
  /** Data source (e.g., "MANUAL" for custom assets) */
  dataSource?: string;
  /** Asset kind (e.g., "INVESTMENT", "OTHER") */
  assetKind?: string;
  /** Quote currency returned by search/provider for the canonical asset */
  quoteCcy?: string;
  /** Instrument type returned by search/provider for the canonical asset */
  instrumentType?: string;
  /** Market data provider that resolved this symbol, if selected. */
  providerId?: string;
  /** Provider-native symbol/code selected by search/import. */
  providerSymbol?: string;
  isNew?: boolean;
}

interface EditableCashBalance {
  currency: string;
  amount: string;
}

interface HoldingsEditModeProps {
  holdings: Holding[];
  account: Account;
  isLoading: boolean;
  onClose: () => void;
  /** When provided, edits an existing snapshot. Date picker is locked. */
  existingSnapshotDate?: string | null;
}

export const HoldingsEditMode = ({
  holdings,
  account,
  isLoading,
  onClose,
  existingSnapshotDate,
}: HoldingsEditModeProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showAddHolding, setShowAddHolding] = useState(false);
  const [isAddHoldingPickerOpen, setIsAddHoldingPickerOpen] = useState(false);
  const holdingSharesInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const pendingHoldingSharesFocusAssetIdRef = useRef<string | null>(null);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showAddCurrency, setShowAddCurrency] = useState(false);
  const [isAddCurrencyPickerOpen, setIsAddCurrencyPickerOpen] = useState(false);
  const cashAmountInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const pendingCashAmountFocusCurrencyRef = useRef<string | null>(null);

  // When editing an existing snapshot, the date is locked
  const isEditingExistingSnapshot = !!existingSnapshotDate;
  const [snapshotDate, setSnapshotDate] = useState<Date>(
    existingSnapshotDate ? parseISO(existingSnapshotDate) : new Date(),
  );

  // Fetch holdings for existing snapshot date
  const { data: snapshotHoldings, isLoading: isLoadingSnapshot } = useQuery({
    queryKey: QueryKeys.snapshotHoldings(account.id, existingSnapshotDate ?? ""),
    queryFn: () => getSnapshotByDate(account.id, existingSnapshotDate!),
    enabled: isEditingExistingSnapshot,
  });

  // Use snapshot holdings when editing existing, otherwise use current holdings
  const effectiveHoldings =
    isEditingExistingSnapshot && snapshotHoldings ? snapshotHoldings : holdings;

  // Convert holdings to editable format
  const convertToEditableHoldings = useCallback((holdingsList: Holding[]): EditableHolding[] => {
    return holdingsList
      .filter((h) => h.holdingType?.toLowerCase() !== HoldingType.CASH)
      .map((h) => {
        let averageCost = "";
        if (h.costBasis?.local && h.quantity > 0) {
          const avgCostValue = h.costBasis.local / h.quantity;
          averageCost = avgCostValue.toFixed(8).replace(/\.?0+$/, "");
        }
        return {
          assetId: h.instrument?.id ?? h.id,
          symbol: h.instrument?.symbol ?? h.id,
          name: h.instrument?.name ?? undefined,
          quantity: String(h.quantity),
          averageCost,
          currency: h.localCurrency,
          isNew: false,
        };
      });
  }, []);

  // Convert holdings to editable cash balances
  const convertToCashBalances = useCallback((holdingsList: Holding[]): EditableCashBalance[] => {
    return holdingsList
      .filter((h) => h.holdingType?.toLowerCase() === HoldingType.CASH)
      .map((h) => ({
        currency: h.localCurrency,
        amount: String(h.marketValue?.local ?? 0),
      }));
  }, []);

  // Initialize editable holdings from effective holdings (excluding cash)
  const initialHoldings = useMemo(() => {
    return convertToEditableHoldings(effectiveHoldings);
  }, [effectiveHoldings, convertToEditableHoldings]);

  // Initialize cash balances from effective holdings
  const initialCashBalances = useMemo(() => {
    return convertToCashBalances(effectiveHoldings);
  }, [effectiveHoldings, convertToCashBalances]);

  const [editableHoldings, setEditableHoldings] = useState<EditableHolding[]>(initialHoldings);
  const [cashBalances, setCashBalances] = useState<EditableCashBalance[]>(initialCashBalances);

  // Update editable holdings when snapshot holdings are loaded
  useEffect(() => {
    if (isEditingExistingSnapshot && snapshotHoldings) {
      setEditableHoldings(convertToEditableHoldings(snapshotHoldings));
      setCashBalances(convertToCashBalances(snapshotHoldings));
    }
  }, [
    isEditingExistingSnapshot,
    snapshotHoldings,
    convertToEditableHoldings,
    convertToCashBalances,
  ]);

  // Track if there are unsaved changes
  const hasChanges = useMemo(() => {
    if (editableHoldings.length !== initialHoldings.length) return true;
    for (const holding of editableHoldings) {
      const original = initialHoldings.find((h) => h.assetId === holding.assetId);
      if (!original) return true;
      if (original.quantity !== holding.quantity) return true;
      if (original.averageCost !== holding.averageCost) return true;
    }
    if (cashBalances.length !== initialCashBalances.length) return true;
    for (const cash of cashBalances) {
      const original = initialCashBalances.find((c) => c.currency === cash.currency);
      if (!original) return true;
      if (original.amount !== cash.amount) return true;
    }
    return false;
  }, [editableHoldings, initialHoldings, cashBalances, initialCashBalances]);

  const handleQuantityChange = useCallback((assetId: string, value: number | undefined) => {
    const quantity = value === undefined ? "" : String(value);
    setEditableHoldings((prev) =>
      prev.map((h) => (h.assetId === assetId ? { ...h, quantity } : h)),
    );
  }, []);

  const handleAverageCostChange = useCallback((assetId: string, value: number | undefined) => {
    const averageCost = value === undefined ? "" : String(value);
    setEditableHoldings((prev) =>
      prev.map((h) => (h.assetId === assetId ? { ...h, averageCost } : h)),
    );
  }, []);

  const handleCashAmountChange = useCallback((currency: string, value: number | undefined) => {
    const amount = value === undefined ? "" : String(value);
    setCashBalances((prev) => prev.map((c) => (c.currency === currency ? { ...c, amount } : c)));
  }, []);

  const handleRemoveHolding = useCallback((assetId: string) => {
    setEditableHoldings((prev) => prev.filter((h) => h.assetId !== assetId));
  }, []);

  const handleAddHolding = useCallback(
    (_symbol: string, searchResult?: SymbolSearchResult) => {
      if (!searchResult) return;

      // Build the canonical asset ID using the same format as the backend
      const assetId = getAssetIdFromSearchResult(searchResult, account.currency);

      // Check for duplicates
      if (editableHoldings.some((h) => h.assetId === assetId)) {
        toast.error(t("holdings:holding_already_exists"));
        return;
      }

      const canonicalSymbol = (searchResult.canonicalSymbol || searchResult.symbol)
        .trim()
        .toUpperCase();
      const canonicalExchangeMic = searchResult.canonicalExchangeMic || searchResult.exchangeMic;

      const newHolding: EditableHolding = {
        assetId,
        symbol: canonicalSymbol,
        name: searchResult.longName || searchResult.shortName,
        quantity: "",
        averageCost: "",
        currency: searchResult.currency ?? account.currency,
        exchangeMic: canonicalExchangeMic,
        dataSource: searchResult.dataSource,
        assetKind: searchResult.assetKind,
        quoteCcy: searchResult.currency,
        instrumentType: searchResult.quoteType,
        providerId: searchResult.providerId,
        providerSymbol: searchResult.providerSymbol,
        isNew: !searchResult.existingAssetId,
      };
      pendingHoldingSharesFocusAssetIdRef.current = assetId;
      setEditableHoldings((prev) => [...prev, newHolding]);
      setIsAddHoldingPickerOpen(false);
      setShowAddHolding(false);
    },
    [editableHoldings, account.currency, t],
  );

  useLayoutEffect(() => {
    const assetId = pendingHoldingSharesFocusAssetIdRef.current;
    if (!assetId) return;
    const input = holdingSharesInputRefs.current[assetId];
    if (!input) return;
    pendingHoldingSharesFocusAssetIdRef.current = null;
    input.focus();
    input.select();
  }, [editableHoldings]);

  const openAddHolding = useCallback(() => {
    setShowAddHolding(true);
    setIsAddHoldingPickerOpen(true);
  }, []);

  useLayoutEffect(() => {
    const currency = pendingCashAmountFocusCurrencyRef.current;
    if (!currency) return;
    const input = cashAmountInputRefs.current[currency];
    if (!input) return;
    pendingCashAmountFocusCurrencyRef.current = null;
    input.focus();
    input.select();
  }, [cashBalances]);

  const handleSelectCashCurrency = useCallback(
    (currency: string) => {
      if (!currency) return;
      if (cashBalances.some((c) => c.currency === currency)) {
        toast.error(t("holdings:currency_already_exists"));
        return;
      }
      setCashBalances((prev) => [...prev, { currency, amount: "" }]);
      pendingCashAmountFocusCurrencyRef.current = currency;
      setIsAddCurrencyPickerOpen(false);
      setShowAddCurrency(false);
    },
    [cashBalances, t],
  );

  const openAddCurrency = useCallback(() => {
    setShowAddCurrency(true);
    setIsAddCurrencyPickerOpen(true);
  }, []);

  const handleRemoveCashBalance = useCallback((currency: string) => {
    setCashBalances((prev) => prev.filter((c) => c.currency !== currency));
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const holdingsInput: HoldingInput[] = editableHoldings
        .filter((h) => h.quantity !== "" && parseFloat(h.quantity) !== 0)
        .map((h) => ({
          // For existing holdings, pass the known assetId to avoid regenerating IDs
          // For new holdings (isNew), backend generates ID from symbol + exchangeMic
          assetId: h.isNew ? undefined : h.assetId,
          symbol: h.symbol,
          quantity: h.quantity,
          currency: h.currency,
          averageCost: h.averageCost || undefined,
          exchangeMic: h.isNew ? h.exchangeMic : undefined,
          quoteCcy: h.isNew ? h.quoteCcy : undefined,
          instrumentType: h.isNew ? h.instrumentType : undefined,
          providerId: h.isNew ? h.providerId : undefined,
          providerSymbol: h.isNew ? h.providerSymbol : undefined,
          name: h.isNew ? h.name : undefined,
          dataSource: h.isNew ? h.dataSource : undefined,
          assetKind: h.isNew ? h.assetKind : undefined,
        }));
      const cashBalancesInput: Record<string, string> = {};
      for (const cash of cashBalances) {
        if (cash.amount !== "" && parseFloat(cash.amount) !== 0) {
          cashBalancesInput[cash.currency] = cash.amount;
        }
      }
      const formattedDate = format(snapshotDate, "yyyy-MM-dd");
      await saveManualHoldings(account.id, holdingsInput, cashBalancesInput, formattedDate);
      // Invalidate holdings queries
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS, account.id] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
      // Invalidate performance queries
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTS_SIMPLE_PERFORMANCE] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PERFORMANCE_HISTORY] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PERFORMANCE_SUMMARY] });
      // Invalidate valuation queries - use spread to match the query key structure
      queryClient.invalidateQueries({ queryKey: QueryKeys.valuationHistory(account.id) });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HISTORY_VALUATION] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.latestValuations] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.CURRENT_VALUATION] });
      // Invalidate manual snapshots query
      queryClient.invalidateQueries({ queryKey: QueryKeys.manualSnapshots(account.id) });
      toast.success(t("holdings:holdings_updated_success"));
      onClose();
    } catch (error) {
      console.error("Failed to save holdings:", error);
      toast.error(
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : t("holdings:failed_to_save_holdings"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [editableHoldings, cashBalances, account.id, snapshotDate, queryClient, onClose, t]);

  const handleDeleteSnapshot = useCallback(async () => {
    if (!existingSnapshotDate) return;
    setIsDeleting(true);
    try {
      await deleteSnapshot(account.id, existingSnapshotDate);
      // Invalidate all relevant queries
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS, account.id] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTS_SIMPLE_PERFORMANCE] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PERFORMANCE_HISTORY] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PERFORMANCE_SUMMARY] });
      queryClient.invalidateQueries({ queryKey: QueryKeys.valuationHistory(account.id) });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HISTORY_VALUATION] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.latestValuations] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.CURRENT_VALUATION] });
      queryClient.invalidateQueries({ queryKey: QueryKeys.manualSnapshots(account.id) });
      toast.success(t("holdings:snapshot_deleted_success"));
      onClose();
    } catch (error) {
      console.error("Failed to delete snapshot:", error);
      toast.error(error instanceof Error ? error.message : t("holdings:failed_to_delete_snapshot"));
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  }, [existingSnapshotDate, account.id, queryClient, onClose, t]);

  const handleCancel = useCallback(() => {
    if (hasChanges) {
      setShowDiscardDialog(true);
    } else {
      onClose();
    }
  }, [hasChanges, onClose]);

  // Calculate total value for a holding
  const getTotalValue = (holding: EditableHolding) => {
    const qty = parseFloat(holding.quantity) || 0;
    const cost = parseFloat(holding.averageCost) || 0;
    return qty * cost;
  };

  if (isLoading || (isEditingExistingSnapshot && isLoadingSnapshot)) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Scrollable Content */}
      <ScrollArea className="flex-1">
        <div className="space-y-6 py-4">
          {/* Holdings Card */}
          <Card>
            <CardContent className="space-y-4 pt-4">
              {/* Snapshot Date */}
              <div className="pb-2">
                <Label className="text-sm font-medium">{t("holdings:snapshot_date")}</Label>
                <p className="text-muted-foreground mb-2 text-xs">
                  {isEditingExistingSnapshot
                    ? t("holdings:snapshot_date_editing_hint")
                    : t("holdings:snapshot_date_hint")}
                </p>
                <DatePickerInput
                  value={snapshotDate}
                  onChange={(date) => date && setSnapshotDate(date)}
                  disabled={isEditingExistingSnapshot}
                />
              </div>

              {/* Table Header */}
              <div className="text-muted-foreground grid grid-cols-12 gap-2 border-b pb-2 text-xs font-medium">
                <div className="col-span-5">{t("holdings:symbol")}</div>
                <div className="col-span-2 text-right">{t("holdings:shares")}</div>
                <div className="col-span-2 text-right">{t("holdings:avg_cost")}</div>
                <div className="col-span-2 text-right">{t("holdings:total")}</div>
                <div className="col-span-1"></div>
              </div>

              {/* Holdings Rows */}
              <div className="space-y-1">
                {editableHoldings.length === 0 && !showAddHolding ? (
                  <div className="text-muted-foreground py-8 text-center text-sm">
                    {t("holdings:no_holdings_add_first")}
                  </div>
                ) : (
                  editableHoldings.map((holding) => {
                    const totalValue = getTotalValue(holding);
                    return (
                      <div
                        key={holding.assetId}
                        className="border-border/50 hover:bg-muted/50 grid grid-cols-12 items-center gap-2 rounded-lg border-b py-2 transition-colors last:border-b-0"
                      >
                        {/* Symbol */}
                        <div className="col-span-5">
                          <div className="flex items-center gap-2">
                            <TickerAvatar symbol={holding.symbol} className="h-7 w-7 shrink-0" />
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{holding.symbol}</div>
                              {holding.name && (
                                <div className="text-muted-foreground truncate text-xs">
                                  {holding.name}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Shares */}
                        <div className="col-span-2">
                          <QuantityInput
                            ref={(el) => {
                              holdingSharesInputRefs.current[holding.assetId] = el;
                            }}
                            value={holding.quantity}
                            onValueChange={(value) => handleQuantityChange(holding.assetId, value)}
                            placeholder="0"
                            className="h-8 text-sm"
                          />
                        </div>

                        {/* Avg Cost */}
                        <div className="col-span-2">
                          <MoneyInput
                            value={holding.averageCost}
                            onValueChange={(value) =>
                              handleAverageCostChange(holding.assetId, value)
                            }
                            placeholder="0.00"
                            className="h-8 text-sm"
                          />
                        </div>

                        {/* Total */}
                        <div className="col-span-2 text-right">
                          <span
                            className={cn(
                              "text-sm font-medium",
                              totalValue > 0 ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {totalValue.toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </span>
                        </div>

                        {/* Delete */}
                        <div className="col-span-1 flex justify-end">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveHolding(holding.assetId)}
                            className="hover:bg-destructive/20 hover:text-destructive h-7 w-7 p-0"
                          >
                            <Icons.Trash className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}

                {/* Add Holding Input */}
                {showAddHolding && (
                  <div className="flex items-center gap-2 py-2">
                    <div className="flex-1">
                      <TickerSearchInput
                        onSelectResult={handleAddHolding}
                        placeholder={t("holdings:search_for_symbol")}
                        defaultCurrency={account.currency}
                        open={isAddHoldingPickerOpen}
                        onOpenChange={setIsAddHoldingPickerOpen}
                        autoFocusSearch={true}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setIsAddHoldingPickerOpen(false);
                        setShowAddHolding(false);
                      }}
                      className="h-8"
                    >
                      {t("common:cancel")}
                    </Button>
                  </div>
                )}
              </div>

              {/* Add Row Button */}
              {!showAddHolding && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={openAddHolding}
                  className="border-muted-foreground/25 text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground h-10 w-full border border-dashed"
                >
                  <Icons.PlusCircle className="mr-2 h-4 w-4" />
                  {t("holdings:add_another_holding")}
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Cash Balances Card */}
          <Card>
            <CardContent className="space-y-4 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-medium">{t("holdings:cash_balances")}</h4>
                  <p className="text-muted-foreground text-xs">
                    {t("holdings:add_cash_by_currency")}
                  </p>
                </div>
              </div>

              {/* Cash Table Header */}
              {cashBalances.length > 0 && (
                <div className="text-muted-foreground grid grid-cols-12 gap-2 border-b pb-2 text-xs font-medium">
                  <div className="col-span-6">{t("holdings:currency")}</div>
                  <div className="col-span-5 text-right">{t("holdings:amount")}</div>
                  <div className="col-span-1"></div>
                </div>
              )}

              {/* Cash Rows */}
              <div className="space-y-1">
                {cashBalances.length === 0 && !showAddCurrency ? (
                  <div className="text-muted-foreground py-4 text-center text-sm">
                    {t("holdings:no_cash_balances")}
                  </div>
                ) : (
                  cashBalances.map((cash) => (
                    <div
                      key={cash.currency}
                      className="border-border/50 hover:bg-muted/50 grid grid-cols-12 items-center gap-2 rounded-lg border-b py-2 transition-colors last:border-b-0"
                    >
                      {/* Currency */}
                      <div className="col-span-6">
                        <div className="flex items-center gap-2">
                          <TickerAvatar symbol={`CASH:${cash.currency}`} className="size-7" />
                          <span className="text-sm font-medium">{cash.currency}</span>
                        </div>
                      </div>

                      {/* Amount */}
                      <div className="col-span-5">
                        <MoneyInput
                          ref={(el) => {
                            cashAmountInputRefs.current[cash.currency] = el;
                          }}
                          value={cash.amount}
                          onValueChange={(value) => handleCashAmountChange(cash.currency, value)}
                          placeholder="0.00"
                          className="h-8 text-sm"
                        />
                      </div>

                      {/* Delete */}
                      <div className="col-span-1 flex justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveCashBalance(cash.currency)}
                          className="hover:bg-destructive/20 hover:text-destructive h-7 w-7 p-0"
                        >
                          <Icons.Trash className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}

                {/* Add Currency Input */}
                {showAddCurrency && (
                  <div className="flex items-center gap-2 py-2">
                    <div className="w-[160px]">
                      <CurrencyInput
                        placeholder={t("holdings:select_currency")}
                        valueDisplay="code"
                        autoFocusSearch={true}
                        open={isAddCurrencyPickerOpen}
                        onOpenChange={(open) => {
                          setIsAddCurrencyPickerOpen(open);
                          if (!open) setShowAddCurrency(false);
                        }}
                        onChange={handleSelectCashCurrency}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setIsAddCurrencyPickerOpen(false);
                        setShowAddCurrency(false);
                      }}
                      className="h-8"
                    >
                      {t("common:cancel")}
                    </Button>
                  </div>
                )}
              </div>

              {/* Add Currency Button */}
              {!showAddCurrency && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={openAddCurrency}
                  className="border-muted-foreground/25 text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground h-10 w-full border border-dashed"
                >
                  <Icons.PlusCircle className="mr-2 h-4 w-4" />
                  {t("holdings:add_cash_balance")}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </ScrollArea>

      {/* Footer with Save/Cancel buttons */}
      <div className="bg-background border-t py-4">
        <div className="flex items-center justify-between">
          {/* Delete button (only when editing existing snapshot) */}
          <div>
            {isEditingExistingSnapshot && (
              <Button
                variant="outline"
                onClick={() => setShowDeleteDialog(true)}
                disabled={isSaving || isDeleting}
                className="text-destructive hover:bg-destructive hover:text-destructive-foreground"
              >
                <Icons.Trash className="mr-2 h-4 w-4" />
                {t("holdings:delete_snapshot")}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleCancel} disabled={isSaving || isDeleting}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleSave} disabled={isSaving || isDeleting || !hasChanges}>
              {isSaving ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {t("holdings:saving")}
                </>
              ) : (
                <>
                  <Icons.Check className="mr-2 h-4 w-4" />
                  {t("holdings:save_changes")}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Discard Changes Dialog */}
      <AlertDialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("holdings:discard_changes_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("holdings:discard_changes_desc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("holdings:keep_editing")}</AlertDialogCancel>
            <AlertDialogAction onClick={onClose}>{t("holdings:discard")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Snapshot Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("holdings:delete_snapshot_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                i18nKey="holdings:delete_snapshot_desc"
                values={{ date: existingSnapshotDate }}
                components={{ bold: <strong /> }}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSnapshot}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {t("holdings:deleting")}
                </>
              ) : (
                t("holdings:delete_snapshot")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default HoldingsEditMode;
