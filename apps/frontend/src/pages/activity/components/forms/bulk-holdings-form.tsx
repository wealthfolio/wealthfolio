import { AccountSelector } from "@/components/account-selector";
import { TickerAvatar } from "@/components/ticker-avatar";
import TickerSearchInput from "@/components/ticker-search";
import { useAccounts } from "@/hooks/use-accounts";
import { quoteModeFromSearchResult } from "@/lib/asset-utils";
import { AccountPurpose, QuoteMode } from "@/lib/constants";
import { Account, SymbolSearchResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Button,
  Card,
  CardContent,
  DatePickerInput,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  MoneyInput,
  QuantityInput,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFieldArray, useFormContext, useWatch } from "react-hook-form";
import { z } from "zod";
import { bulkHoldingsFormSchema } from "./schemas";

type BulkHoldingsFormValues = z.infer<typeof bulkHoldingsFormSchema>;

export interface BulkHoldingRow {
  id: string;
  ticker: string;
  name?: string;
  assetKind?: string;
  sharesOwned: number | string;
  averageCost: number | string;
  totalValue: number;
  assetId?: string;
  quoteMode?: QuoteMode;
  symbolQuoteCcy?: string;
  symbolInstrumentType?: string;
}

interface BulkHoldingsFormProps {
  onAccountChange?: (account: Account | null) => void;
  defaultAccount?: Account | null;
}

// Memoized row component to prevent unnecessary re-renders
const HoldingRow = memo(
  ({
    index,
    field,
    onRemove,
    onAddRow,
    isLast,
    isSelected,
    onSelectRow,
    setFocus,
    canRemove,
  }: {
    index: number;
    field: BulkHoldingRow;
    onRemove: (index: number) => void;
    onAddRow: () => void;
    isLast: boolean;
    isSelected: boolean;
    onSelectRow: (id: string) => void;
    setFocus: ReturnType<typeof useFormContext<BulkHoldingsFormValues>>["setFocus"];
    canRemove: boolean;
  }) => {
    const { t } = useTranslation(["activity"]);
    const { control, setValue, getValues } = useFormContext<BulkHoldingsFormValues>();

    // Use useWatch for specific fields instead of watch() in parent
    const ticker = useWatch({
      control,
      name: `holdings.${index}.ticker`,
      defaultValue: "",
    });

    const sharesOwned = useWatch({
      control,
      name: `holdings.${index}.sharesOwned`,
      defaultValue: 0,
    });

    const averageCost = useWatch({
      control,
      name: `holdings.${index}.averageCost`,
      defaultValue: 0,
    });

    // Memoize total value calculation
    const totalValue = useMemo(() => {
      const shares = Number(sharesOwned) || 0;
      const cost = Number(averageCost) || 0;
      return shares * cost;
    }, [sharesOwned, averageCost]);

    // Memoize event handlers
    const handleSharesKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          setFocus(`holdings.${index}.averageCost`);
        }
      },
      [index, setFocus],
    );

    const handleCostKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (isLast) {
            onAddRow();
          } else {
            setFocus(`holdings.${index + 1}.ticker`);
          }
        }
      },
      [index, isLast, onAddRow, setFocus],
    );

    const handleAssetSelect = useCallback(
      (_symbol: string, searchResult?: SymbolSearchResult) => {
        const quoteMode = quoteModeFromSearchResult(searchResult);
        const isManualAsset = quoteMode === QuoteMode.MANUAL;
        setValue(`holdings.${index}.quoteMode`, quoteMode, { shouldDirty: true });

        // Always update symbol metadata to avoid carrying stale values across selections.
        // Fall back to the account currency when the search result has no currency
        // (common for bonds/OTC securities).
        const accountCurrency = getValues("currency") || "";
        setValue(`holdings.${index}.assetId`, searchResult?.existingAssetId ?? "", {
          shouldDirty: true,
        });
        setValue(`holdings.${index}.exchangeMic`, searchResult?.exchangeMic ?? "", {
          shouldDirty: true,
        });
        setValue(`holdings.${index}.symbolQuoteCcy`, searchResult?.currency || accountCurrency, {
          shouldDirty: true,
        });
        setValue(`holdings.${index}.assetKind`, searchResult?.assetKind ?? "", {
          shouldDirty: true,
        });
        setValue(`holdings.${index}.symbolInstrumentType`, searchResult?.quoteType ?? "", {
          shouldDirty: true,
        });

        // Capture name for custom assets
        if (isManualAsset && searchResult?.longName) {
          setValue(`holdings.${index}.name`, searchResult.longName, { shouldDirty: true });
        } else if (!isManualAsset) {
          setValue(`holdings.${index}.name`, "", { shouldDirty: true });
          setValue(`holdings.${index}.assetKind`, "", { shouldDirty: true });
        }

        setFocus(`holdings.${index}.sharesOwned`);
      },
      [index, setFocus, setValue],
    );

    const handleRemoveClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        onRemove(index);
      },
      [index, onRemove],
    );

    const handleRowClick = useCallback(() => {
      onSelectRow(field.id);
    }, [field.id, onSelectRow]);

    return (
      <div
        className={cn(
          "border-border/50 hover:bg-muted/50 grid grid-cols-3 gap-x-2 gap-y-2 rounded-lg border-b px-3 py-3 transition-colors last:border-b-0 sm:grid-cols-12 sm:gap-3",
          isSelected && "bg-muted",
        )}
        onClick={handleRowClick}
      >
        {/* Ticker Input */}
        <div className="col-span-3 sm:col-span-6">
          <div className="flex min-w-0 items-center gap-2">
            <TickerAvatar symbol={ticker} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <FormField
                control={control}
                name={`holdings.${index}.ticker`}
                render={({ field: tickerField }) => (
                  <TickerSearchInput
                    ref={tickerField.ref}
                    onSelectResult={(symbol: string, searchResult) => {
                      tickerField.onChange(symbol);
                      handleAssetSelect(symbol, searchResult);
                    }}
                    value={tickerField.value}
                    placeholder={t("activity:search_ticker_placeholder")}
                    className="focus:border-input focus:bg-background bg-muted/40 border-border/40 h-9 truncate rounded-md border text-sm focus:border"
                    data-testid={`bulk-holding-ticker-${index}`}
                  />
                )}
              />
            </div>
            {/* Delete button inline with ticker on mobile */}
            {canRemove && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleRemoveClick}
                className="hover:bg-destructive/20 hover:text-destructive h-6 w-6 shrink-0 p-0 sm:hidden"
              >
                <Icons.Trash className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>

        {/* Shares Input */}
        <div className="col-start-1 sm:col-span-1">
          <FormField
            control={control}
            name={`holdings.${index}.sharesOwned`}
            render={({ field: sharesField }) => (
              <QuantityInput
                {...sharesField}
                placeholder={t("activity:form.bulk_placeholder_shares")}
                className="focus:border-input focus:bg-background bg-muted/40 border-border/40 h-9 rounded-md border text-sm focus:border"
                onKeyDown={handleSharesKeyDown}
                data-testid={`bulk-holding-shares-${index}`}
              />
            )}
          />
        </div>

        {/* Average Cost Input */}
        <div className="sm:col-span-2">
          <FormField
            control={control}
            name={`holdings.${index}.averageCost`}
            render={({ field: priceField }) => (
              <MoneyInput
                {...priceField}
                placeholder={t("activity:form.bulk_placeholder_avg_cost")}
                className="focus:border-input focus:bg-background bg-muted/40 border-border/40 h-9 rounded-md border text-sm focus:border"
                onKeyDown={handleCostKeyDown}
                data-testid={`bulk-holding-cost-${index}`}
              />
            )}
          />
        </div>

        {/* Total Value */}
        <div className="flex items-center justify-end sm:col-span-2">
          <span
            className={cn(
              "text-sm font-medium",
              totalValue > 0 ? "text-foreground" : "text-muted-foreground",
            )}
          >
            ${totalValue.toFixed(2)}
          </span>
        </div>

        {/* Delete Button - desktop only */}
        <div className="hidden items-center justify-end sm:col-span-1 sm:flex">
          {canRemove && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRemoveClick}
              className="hover:bg-destructive/20 hover:text-destructive h-6 w-6 p-0"
            >
              <Icons.Trash className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    );
  },
);

HoldingRow.displayName = "HoldingRow";

export const BulkHoldingsForm = ({ onAccountChange, defaultAccount }: BulkHoldingsFormProps) => {
  const { t } = useTranslation(["activity"]);
  const { control, setFocus } = useFormContext<BulkHoldingsFormValues>();
  const { fields, append, remove } = useFieldArray({
    control,
    name: "holdings",
  });
  const { accounts } = useAccounts({ filterActive: true, includeArchived: false });
  const selectedAccountId = useWatch({ control, name: "accountId" });

  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const selectedAccount = useMemo(
    () =>
      accounts.find((acc) => acc.id === selectedAccountId) ??
      (defaultAccount?.id === selectedAccountId ? defaultAccount : null),
    [accounts, defaultAccount, selectedAccountId],
  );

  // Handle account selection with improved focus management
  const handleAccountSelect = useCallback(
    (account: Account) => {
      onAccountChange?.(account);
      // Focus first ticker field after account selection, with proper timing
      if (fields.length > 0) {
        requestAnimationFrame(() => {
          setFocus("holdings.0.ticker");
        });
      }
    },
    [onAccountChange, fields.length, setFocus],
  );

  // Add a new holding row
  const addRow = useCallback(() => {
    const newIndex = fields.length;
    append({
      id: `holding-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, // More unique ID
      ticker: "",
      name: "",
      assetKind: "",
      assetId: "",
      quoteMode: QuoteMode.MARKET,
      symbolQuoteCcy: "",
      symbolInstrumentType: "",
      sharesOwned: 0,
      averageCost: 0,
    });

    // Use requestAnimationFrame for smoother focus transition
    requestAnimationFrame(() => {
      setFocus(`holdings.${newIndex}.ticker`);
    });
  }, [append, fields.length, setFocus]);

  // Remove a holding row
  const removeRow = useCallback(
    (index: number) => {
      if (fields.length > 1) {
        remove(index);
        // Focus previous row if removing current selection
        if (index > 0) {
          requestAnimationFrame(() => {
            setFocus(`holdings.${index - 1}.ticker`);
          });
        }
      }
    },
    [remove, fields.length, setFocus],
  );

  // Memoize row selection handler
  const handleRowSelect = useCallback((id: string) => {
    setSelectedRowId(id);
  }, []);

  return (
    <div className="space-y-6">
      {/* Holdings Table */}
      <Card>
        <CardContent className="space-y-4 pt-4">
          {/* Account and Date Selection */}
          <div className="grid grid-cols-1 gap-4 pb-4 sm:grid-cols-2">
            <FormField
              control={control}
              name="accountId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("activity:field_account")}</FormLabel>
                  <FormControl>
                    <AccountSelector
                      ref={field.ref}
                      selectedAccount={selectedAccount}
                      setSelectedAccount={(account) => {
                        field.onChange(account?.id || "");
                        handleAccountSelect(account);
                      }}
                      variant="form"
                      filterActive={true}
                      trackingModes={["TRANSACTIONS"]}
                      accountPurpose={AccountPurpose.HOLDINGS}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={control}
              name="activityDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("activity:form.label_acquisition_date")}</FormLabel>
                  <FormControl>
                    <DatePickerInput value={field.value} onChange={field.onChange} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* Table Header */}
          <div className="text-muted-foreground hidden gap-3 border-b pb-3 text-sm sm:grid sm:grid-cols-12">
            <div className="col-span-6">{t("activity:tickers")}</div>
            <div className="col-span-1 text-right">{t("activity:form.bulk_col_shares")}</div>
            <div className="col-span-2 text-right">{t("activity:form.bulk_col_average_cost")}</div>
            <div className="col-span-2 whitespace-nowrap text-right">
              {t("activity:total_value")}
            </div>
            <div className="col-span-1 text-right"></div>
          </div>

          {/* Table Rows - Virtualization candidate for large lists */}
          <div className="max-h-96 space-y-1 overflow-y-auto">
            {fields.map((field, index) => (
              <HoldingRow
                key={field.id}
                index={index}
                field={field as BulkHoldingRow}
                onRemove={removeRow}
                onAddRow={addRow}
                isLast={index === fields.length - 1}
                isSelected={selectedRowId === field.id}
                onSelectRow={handleRowSelect}
                setFocus={setFocus}
                canRemove={fields.length > 1}
              />
            ))}
          </div>

          {/* Add Row Button */}
          <div className="pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={addRow}
              className="border-muted-foreground/25 text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground h-10 w-full border border-dashed"
              data-testid="bulk-holdings-add-row"
            >
              <Icons.PlusCircle className="mr-2 h-4 w-4" />
              {t("activity:add_another_holding")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
