import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui/components/ui/table";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { IMPORT_REQUIRED_FIELDS } from "@/lib/constants";
import {
  Account,
  ActivityType,
  CsvRowData,
  ImportFormat,
  ImportMappingData,
  type SymbolSearchResult,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import { MappingCell, MappingHeaderCell } from "./mapping-table-cells";

interface MappingTableProps {
  mapping: ImportMappingData;
  headers: string[];
  data: CsvRowData[];
  accounts: Account[];
  handleColumnMapping: (field: ImportFormat, value: string) => void;
  handleActivityTypeMapping: (csvActivity: string, activityType: string) => void;
  handleSymbolMapping: (
    csvSymbol: string,
    newSymbol: string,
    searchResult?: SymbolSearchResult,
  ) => void;
  handleAccountIdMapping: (csvAccountId: string, accountId: string) => void;
  getMappedValue: (row: CsvRowData, field: ImportFormat) => string;
  invalidSymbols: string[];
  invalidAccounts: string[];
  visibleFields?: readonly ImportFormat[];
  requiredFields?: readonly ImportFormat[];
  allowedActivityTypes?: readonly ActivityType[];
  className?: string;
}

const importFormatFields = Object.values(ImportFormat);

export function MappingTable({
  mapping,
  headers,
  data,
  accounts,
  handleColumnMapping,
  handleActivityTypeMapping,
  handleSymbolMapping,
  handleAccountIdMapping,
  getMappedValue,
  invalidSymbols,
  invalidAccounts,
  visibleFields = importFormatFields,
  requiredFields = IMPORT_REQUIRED_FIELDS,
  allowedActivityTypes,
  className,
}: MappingTableProps) {
  // Check if a field is mapped (supports fallback column arrays)
  const checkFieldMapped = (field: ImportFormat) => {
    const mappedHeader = mapping.fieldMappings[field];
    if (!mappedHeader) return false;
    if (Array.isArray(mappedHeader)) return mappedHeader.some((h) => headers.includes(h));
    return headers.includes(mappedHeader);
  };

  return (
    <div
      className={cn(
        "border-border bg-card h-full w-full overflow-auto rounded-md border shadow-sm",
        className,
      )}
    >
      <div className="min-w-fit">
        <TooltipProvider>
          <Table>
            <TableHeader className="sticky top-0 z-20">
              <TableRow>
                <TableHead className="border-border sticky left-0 z-30 w-12 min-w-12 border-r">
                  <div className="bg-muted/50 flex items-center justify-center rounded-sm p-1">
                    <span className="text-muted-foreground text-xs font-semibold">#</span>
                  </div>
                </TableHead>
                {visibleFields.map((field) => (
                  <TableHead
                    key={field}
                    className={cn(
                      "border-border whitespace-nowrap border-r p-2 transition-colors last:border-r-0",
                      requiredFields.includes(field)
                        ? !checkFieldMapped(field)
                          ? "bg-amber-50 dark:bg-amber-950/20"
                          : ""
                        : "",
                    )}
                  >
                    <MappingHeaderCell
                      field={field}
                      mapping={mapping}
                      headers={headers}
                      requiredFields={requiredFields}
                      handleColumnMapping={handleColumnMapping}
                    />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row, index) => {
                return (
                  <motion.tr
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: index * 0.03 }}
                    key={`row-${row.lineNumber}`}
                    className={cn(
                      "hover:bg-muted/50 group transition-colors",
                      index % 2 === 0 ? "bg-background" : "bg-muted/20",
                    )}
                  >
                    <TableCell className="border-border bg-muted/30 text-muted-foreground sticky left-0 z-20 w-12 border-r font-mono text-xs font-medium">
                      {row.lineNumber}
                    </TableCell>
                    {visibleFields.map((field) => {
                      return (
                        <TableCell
                          key={field}
                          className={cn(
                            "border-border border-r p-2 text-xs transition-colors last:border-r-0",
                            "group-hover:bg-muted/50",
                          )}
                        >
                          <MappingCell
                            field={field}
                            row={row}
                            mapping={mapping}
                            accounts={accounts}
                            getMappedValue={getMappedValue}
                            handleActivityTypeMapping={handleActivityTypeMapping}
                            handleSymbolMapping={handleSymbolMapping}
                            handleAccountIdMapping={handleAccountIdMapping}
                            invalidSymbols={invalidSymbols}
                            invalidAccounts={invalidAccounts}
                            allowedActivityTypes={allowedActivityTypes}
                          />
                        </TableCell>
                      );
                    })}
                  </motion.tr>
                );
              })}
            </TableBody>
          </Table>
        </TooltipProvider>
      </div>
    </div>
  );
}
