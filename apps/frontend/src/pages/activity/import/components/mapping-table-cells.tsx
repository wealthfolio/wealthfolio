import { AccountSelector } from "@/components/account-selector";
import TickerSearchInput from "@/components/ticker-search";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { IMPORT_REQUIRED_FIELDS } from "@/lib/constants";
import {
  Account,
  ActivityType,
  CsvRowData,
  ImportFormat,
  ImportMappingData,
  ImportRequiredField,
  type SymbolSearchResult,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { isCashSymbol, needsImportAssetResolutionForRow } from "@/lib/activity-utils";
import {
  Badge,
  SearchableSelect,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui";
import { useState } from "react";
import { findMappedActivityType } from "../utils/activity-type-mapping";
import { ACTIVITY_SKIP } from "../utils/draft-utils";

const SKIP_FIELD_VALUE = "__skip__";

// Shared style for all mapping popover triggers — matches standard input look at sm size
const MAPPING_TRIGGER_CLASS = "h-8 rounded-md text-xs font-normal";

// Dashed style for unmapped/empty mapping triggers — orange dashed border to signal action needed
const MAPPING_TRIGGER_UNMAPPED_CLASS =
  "h-8 rounded-md text-xs font-normal !border-dashed !border-orange-300 !text-orange-500 !bg-transparent !shadow-none hover:!bg-orange-50 dark:!border-orange-400 dark:!text-orange-400 dark:hover:!bg-orange-950";

export function MappingHeaderCell({
  field,
  mapping,
  headers,
  handleColumnMapping,
}: {
  field: ImportFormat;
  mapping: ImportMappingData;
  headers: string[];
  handleColumnMapping: (field: ImportFormat, value: string) => void;
}) {
  const [editingHeader, setEditingHeader] = useState<ImportFormat | null>(null);
  const mappedHeader = mapping.fieldMappings[field];
  const displayHeader = Array.isArray(mappedHeader) ? mappedHeader[0] : mappedHeader;
  const isMapped = displayHeader ? headers.includes(displayHeader) : false;
  const isEditing = editingHeader === field || !isMapped;
  const isRequired = IMPORT_REQUIRED_FIELDS.includes(field as ImportRequiredField);

  return (
    <div>
      <div className="flex items-center gap-2 pb-0 pt-2">
        <span className="font-bold">
          {field}
          {isRequired && !isMapped && (
            <span className="ml-1 text-amber-600 dark:text-amber-400">*</span>
          )}
        </span>
      </div>
      {isEditing ? (
        <Select
          onValueChange={(val) => {
            handleColumnMapping(field, val === SKIP_FIELD_VALUE ? "" : val);
            setEditingHeader(null);
          }}
          value={displayHeader || SKIP_FIELD_VALUE}
          onOpenChange={(open) => !open && setEditingHeader(null)}
        >
          <SelectTrigger className={cn(MAPPING_TRIGGER_CLASS, "text-muted-foreground !h-8 w-full")}>
            <SelectValue placeholder={isRequired ? "Select column" : "Optional"} />
          </SelectTrigger>
          <SelectContent className="max-h-[300px] overflow-y-auto">
            {!isRequired && (
              <>
                <SelectItem value={SKIP_FIELD_VALUE}>
                  {field === ImportFormat.CURRENCY
                    ? "Account Currency"
                    : field === ImportFormat.ACCOUNT
                      ? "Default Account"
                      : "Ignore"}
                </SelectItem>
                <SelectSeparator />
              </>
            )}
            {headers.map((header) => (
              <SelectItem key={header || "-"} value={header || "-"}>
                {header || "-"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className="text-muted-foreground h-8 rounded-md py-0 pl-0 font-normal"
          onClick={() => setEditingHeader(field)}
        >
          {displayHeader || (isRequired ? "Select column" : "Ignore")}
        </Button>
      )}
    </div>
  );
}

interface ActivityTypeDisplayCellProps {
  csvType: string;
  appType: string | null;
  subtype?: string;
  handleActivityTypeMapping: (csvActivity: string, activityType: string) => void;
}
function ActivityTypeDisplayCell({
  csvType,
  appType,
  subtype,
  handleActivityTypeMapping,
}: ActivityTypeDisplayCellProps) {
  const trimmedCsvType = csvType.trim().toUpperCase();
  const displayValue =
    trimmedCsvType.length > 27 ? `${trimmedCsvType.substring(0, 27)}...` : trimmedCsvType;
  // Show subtype when it differs from the resolved activity type (provides context)
  const showSubtype = subtype && subtype.toUpperCase() !== trimmedCsvType;

  return (
    <div className="flex items-center gap-2">
      <div className="shrink-0">
        <span
          title={trimmedCsvType}
          className={cn("truncate text-xs font-medium", !appType && "text-destructive")}
        >
          {displayValue}
        </span>
        {showSubtype && <span className="text-muted-foreground ml-1 text-[10px]">{subtype}</span>}
      </div>
      <span className="text-muted-foreground shrink-0">→</span>
      <div className="ml-auto">
        {appType ? (
          <Badge
            variant={appType === ACTIVITY_SKIP ? "outline" : "secondary"}
            className={cn(
              "cursor-pointer text-xs transition-colors",
              appType === ACTIVITY_SKIP
                ? "text-muted-foreground hover:bg-muted/80 line-through"
                : "hover:bg-secondary/80",
            )}
            onClick={() => handleActivityTypeMapping(trimmedCsvType, "" as ActivityType)}
          >
            {appType === ACTIVITY_SKIP ? "Skipped" : appType}
          </Badge>
        ) : (
          <SearchableSelect
            options={[
              ...Object.values(ActivityType)
                .filter((t) => t !== "UNKNOWN")
                .map((type) => ({ value: type, label: type })),
              {
                value: ACTIVITY_SKIP,
                label: "SKIP",
                className: "text-muted-foreground italic line-through",
              },
            ]}
            value=""
            onValueChange={(newType) =>
              handleActivityTypeMapping(trimmedCsvType, newType as ActivityType)
            }
            placeholder="Map type"
            className={cn(MAPPING_TRIGGER_UNMAPPED_CLASS, "w-[140px]")}
          />
        )}
      </div>
    </div>
  );
}
interface AccountIdDisplayCellProps {
  csvAccountId: string;
  mappedAccountId: string | undefined;
  isInvalid: boolean;
  handleAccountIdMapping: (csvAccountId: string, accountId: string) => void;
}

function AccountIdDisplayCell({
  csvAccountId,
  mappedAccountId,
  isInvalid,
  handleAccountIdMapping,
}: AccountIdDisplayCellProps) {
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const trimmedAccountId = csvAccountId.trim();
  const sourceLabel = trimmedAccountId || "Missing account";

  if (mappedAccountId) {
    // When csvAccountId is empty the account comes from the default (no CSV column),
    // so skip the "Missing account →" prefix and just show the resolved account.
    if (!trimmedAccountId) {
      return (
        <Badge
          variant="secondary"
          className="hover:bg-secondary/80 cursor-pointer text-xs transition-colors"
          onClick={() => handleAccountIdMapping(csvAccountId, "")}
        >
          {mappedAccountId}
        </Badge>
      );
    }
    return (
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground shrink-0 truncate text-xs" title={trimmedAccountId}>
          {trimmedAccountId}
        </span>
        <span className="text-muted-foreground shrink-0">→</span>
        <Badge
          variant="secondary"
          className="hover:bg-secondary/80 ml-auto cursor-pointer text-xs transition-colors"
          onClick={() => handleAccountIdMapping(csvAccountId, "")}
        >
          {mappedAccountId}
        </Badge>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "shrink-0 truncate text-xs",
          isInvalid ? "text-destructive" : "text-muted-foreground",
        )}
        title={sourceLabel}
      >
        {sourceLabel}
      </span>
      <span className="text-muted-foreground shrink-0">→</span>
      <div className="ml-auto min-w-[180px]">
        <AccountSelector
          selectedAccount={selectedAccount}
          setSelectedAccount={(account) => {
            setSelectedAccount(account);
            handleAccountIdMapping(trimmedAccountId, account.id);
          }}
          variant="form"
          className={MAPPING_TRIGGER_UNMAPPED_CLASS}
        />
      </div>
    </div>
  );
}

interface SymbolDisplayCellProps {
  csvSymbol: string;
  mappedSymbol: string | undefined;
  isInvalid: boolean;
  handleSymbolMapping: (
    csvSymbol: string,
    newSymbol: string,
    searchResult?: SymbolSearchResult,
  ) => void;
}
function SymbolDisplayCell({
  csvSymbol,
  mappedSymbol,
  isInvalid,
  handleSymbolMapping,
}: SymbolDisplayCellProps) {
  const [isEditing, setIsEditing] = useState(false);

  // Don't show anything if the symbol is empty/doesn't exist AND it's not invalid
  // We still want to show invalid empty symbols so they can be mapped
  if ((!csvSymbol || csvSymbol.trim() === "") && !isInvalid) {
    return null;
  }

  const showSearchInput = isEditing || (isInvalid && !mappedSymbol);

  if (showSearchInput) {
    return (
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "shrink-0 truncate text-xs",
            isInvalid ? "text-destructive" : "text-muted-foreground",
          )}
          title={csvSymbol || "Empty symbol"}
        >
          {csvSymbol || "-"}
        </span>
        <span className="text-muted-foreground shrink-0">→</span>
        <div className="ml-auto min-w-[180px]">
          <TickerSearchInput
            defaultValue={mappedSymbol || ""}
            placeholder="Map symbol"
            onSelectResult={(newSymbol, searchResult) => {
              handleSymbolMapping(csvSymbol, newSymbol, searchResult);
              setIsEditing(false);
            }}
            className={MAPPING_TRIGGER_UNMAPPED_CLASS}
          />
        </div>
      </div>
    );
  }

  // Mapped symbol (source differs from target) — show source → target
  if (mappedSymbol) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground shrink-0 truncate text-xs" title={csvSymbol}>
          {csvSymbol}
        </span>
        <span className="text-muted-foreground shrink-0">→</span>
        <Badge
          variant="secondary"
          className="hover:bg-secondary/80 ml-auto cursor-pointer text-xs transition-colors"
          onClick={() => setIsEditing(true)}
        >
          {mappedSymbol}
        </Badge>
      </div>
    );
  }

  // Valid symbol, no mapping needed — single badge
  return (
    <Badge
      variant="secondary"
      className="hover:bg-secondary/80 cursor-pointer text-xs transition-colors"
      onClick={() => setIsEditing(true)}
    >
      {csvSymbol}
    </Badge>
  );
}

export function MappingCell({
  field,
  row,
  mapping,
  accounts,
  getMappedValue,
  handleActivityTypeMapping,
  handleSymbolMapping,
  handleAccountIdMapping,
  invalidSymbols,
  invalidAccounts,
}: {
  field: ImportFormat;
  row: CsvRowData;
  mapping: ImportMappingData;
  accounts: Account[];
  getMappedValue: (row: CsvRowData, field: ImportFormat) => string;
  handleActivityTypeMapping: (csvActivity: string, activityType: string) => void;
  handleSymbolMapping: (
    csvSymbol: string,
    newSymbol: string,
    searchResult?: SymbolSearchResult,
  ) => void;
  handleAccountIdMapping?: (csvAccountId: string, accountId: string) => void;
  invalidSymbols: string[];
  invalidAccounts: string[];
}) {
  // Get the field's value from the row
  const value = getMappedValue(row, field);

  // Nothing to display if value is empty and not a special field
  if (!value || value.trim() === "") {
    // For symbol field, if it's invalid (e.g. empty but required), we might still want to render SymbolDisplayCell
    if (field === ImportFormat.SYMBOL && invalidSymbols.includes(value.trim())) {
      // Fall through to SymbolDisplayCell rendering
    } else if (field === ImportFormat.ACCOUNT) {
      // Fall through so the row shows the missing-account state.
    } else {
      return <span className="text-muted-foreground text-xs">-</span>;
    }
  }

  // Special fields with custom renderers
  if (field === ImportFormat.ACTIVITY_TYPE) {
    const appType = findMappedActivityType(value, mapping.activityMappings);
    const subtype = getMappedValue(row, ImportFormat.SUBTYPE)?.trim();
    return (
      <ActivityTypeDisplayCell
        csvType={value}
        appType={appType}
        subtype={subtype}
        handleActivityTypeMapping={handleActivityTypeMapping}
      />
    );
  }

  if (field === ImportFormat.SYMBOL) {
    const symbol = value.trim();

    // Skip symbol display when not required (pure cash types, cash symbols)
    const csvType = getMappedValue(row, ImportFormat.ACTIVITY_TYPE)?.trim();
    const csvSubtype = getMappedValue(row, ImportFormat.SUBTYPE)?.trim();
    const quantity = getMappedValue(row, ImportFormat.QUANTITY)?.trim();
    const unitPrice = getMappedValue(row, ImportFormat.UNIT_PRICE)?.trim();
    const appType = csvType ? findMappedActivityType(csvType, mapping.activityMappings) : null;
    if (
      appType &&
      (!needsImportAssetResolutionForRow({
        activityType: appType,
        subtype: csvSubtype,
        symbol,
        quantity,
        unitPrice,
      }) ||
        isCashSymbol(symbol))
    ) {
      return <span className="text-muted-foreground text-xs">-</span>;
    }

    const isInvalid = invalidSymbols.includes(symbol);
    const mappedSymbol = mapping.symbolMappings[symbol];
    return (
      <SymbolDisplayCell
        csvSymbol={symbol}
        mappedSymbol={mappedSymbol}
        isInvalid={isInvalid}
        handleSymbolMapping={handleSymbolMapping}
      />
    );
  }

  if (field === ImportFormat.ACCOUNT) {
    const mappingKey = value?.trim() || "";
    const isInvalid = mappingKey === "" || invalidAccounts.includes(mappingKey);
    const mappedAccountId = mapping.accountMappings?.[mappingKey];
    const account = accounts.find((acc) => acc.id === mappedAccountId);
    return (
      <AccountIdDisplayCell
        csvAccountId={value}
        mappedAccountId={account?.name}
        isInvalid={isInvalid}
        handleAccountIdMapping={handleAccountIdMapping!}
      />
    );
  }

  // Default renderer for other fields
  return <span className="text-muted-foreground text-xs">{value}</span>;
}
