import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui/components/ui/table";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { Card } from "@wealthfolio/ui/components/ui/card";
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
  getActivityTypeLabel?: (activityType: ActivityType) => string;
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
  getActivityTypeLabel,
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
    <Card
      className={cn(
        // `isolate` stops WebKitGTK painting rows over this scrollbar inside a scrolling parent
        // `scroll-pt-21` (pinned header + focus outline) keeps keyboard focus out from under the header
        "scroll-pt-21 isolate h-full w-full overflow-auto",
        className,
      )}
    >
      <div className="min-w-fit">
        <TooltipProvider>
          {/* Let the header and # column stick to the scroll box above, not the Table wrapper */}
          <Table containerClassName="overflow-visible" className="border-separate border-spacing-0">
            {/* WebKit can pin the header a pixel below the box's top edge; the shadow covers the rows there */}
            <TableHeader className="bg-card sticky top-0 z-30 [&_th]:shadow-[0_-1px_0_var(--card)]">
              <TableRow>
                <TableHead className="border-border bg-card sticky start-0 z-30 w-12 min-w-12 border-b border-e">
                  <div className="bg-muted/50 flex items-center justify-center rounded-sm p-1">
                    <span className="text-muted-foreground text-xs font-semibold">#</span>
                  </div>
                </TableHead>
                {visibleFields.map((field) => (
                  <TableHead
                    key={field}
                    className={cn(
                      "border-border whitespace-nowrap border-b border-e p-2 transition-colors last:border-e-0",
                      requiredFields.includes(field)
                        ? !checkFieldMapped(field)
                          ? "bg-warning-subtle"
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
                    <TableCell className="border-border text-muted-foreground sticky start-0 z-20 w-12 border-e bg-[color-mix(in_srgb,var(--muted)_30%,var(--card))] font-mono text-xs font-medium group-hover:bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))]">
                      {row.lineNumber}
                    </TableCell>
                    {visibleFields.map((field) => {
                      return (
                        <TableCell
                          key={field}
                          className={cn(
                            "border-border border-e p-2 text-xs transition-colors last:border-e-0",
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
                            getActivityTypeLabel={getActivityTypeLabel}
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
    </Card>
  );
}
