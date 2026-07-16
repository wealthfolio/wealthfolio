import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { ImportValidationStatus, QuoteImport } from "@/lib/types/quote-import";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";

function formatValidationStatus(status: ImportValidationStatus, t: TFunction): string {
  switch (status) {
    case "valid":
      return t("settings:market_data_page.status_valid");
    case "warning":
      return t("settings:market_data_page.status_warning");
    case "error":
      return t("settings:market_data_page.status_error_label");
    default:
      return status;
  }
}

function getStatusVariant(status: ImportValidationStatus): "success" | "destructive" | "warning" {
  switch (status) {
    case "valid":
      return "success";
    case "warning":
      return "warning";
    case "error":
      return "destructive";
    default:
      return "destructive";
  }
}

interface QuotePreviewTableProps {
  quotes: QuoteImport[];
  maxRows?: number;
}

export function QuotePreviewTable({ quotes, maxRows = 10 }: QuotePreviewTableProps) {
  const { t } = useTranslation();
  const displayQuotes = quotes.slice(0, maxRows);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icons.FileText className="h-5 w-5" />
          {t("settings:market_data_page.preview_data_rows", { count: quotes.length })}
        </CardTitle>
        <CardDescription>
          {t("settings:market_data_page.review_first_rows", { count: maxRows })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings:market_data_page.field_symbol")}</TableHead>
                <TableHead>{t("common:date")}</TableHead>
                <TableHead>{t("settings:market_data_page.field_open")}</TableHead>
                <TableHead>{t("settings:market_data_page.field_high")}</TableHead>
                <TableHead>{t("settings:market_data_page.field_low")}</TableHead>
                <TableHead>{t("settings:market_data_page.field_close")}</TableHead>
                <TableHead>{t("settings:market_data_page.field_volume")}</TableHead>
                <TableHead>{t("common:currency")}</TableHead>
                <TableHead>{t("settings:market_data_page.field_status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TooltipProvider>
                {displayQuotes.map((quote, index) => {
                  const hasError = quote.validationStatus === "error";
                  const hasWarning = quote.validationStatus === "warning";
                  const errorMessage = quote.errorMessage;

                  return (
                    <TableRow
                      key={index}
                      className={
                        hasError
                          ? "bg-destructive/5 hover:bg-destructive/10"
                          : hasWarning
                            ? "bg-warning/5 hover:bg-warning/10"
                            : undefined
                      }
                    >
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-1.5">
                          {errorMessage && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Icons.AlertCircle className="text-destructive h-4 w-4 shrink-0 cursor-help" />
                              </TooltipTrigger>
                              <TooltipContent
                                side="right"
                                className="bg-destructive text-destructive-foreground max-w-xs"
                              >
                                <p>{errorMessage}</p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {quote.displaySymbol ?? quote.symbol}
                        </div>
                      </TableCell>
                      <TableCell>{quote.date}</TableCell>
                      <TableCell>{quote.open ?? "-"}</TableCell>
                      <TableCell>{quote.high ?? "-"}</TableCell>
                      <TableCell>{quote.low ?? "-"}</TableCell>
                      <TableCell className="font-medium">{quote.close}</TableCell>
                      <TableCell>{quote.volume ?? "-"}</TableCell>
                      <TableCell>{quote.currency}</TableCell>
                      <TableCell>
                        <Badge
                          variant={getStatusVariant(quote.validationStatus)}
                          className="whitespace-nowrap"
                        >
                          {formatValidationStatus(quote.validationStatus, t)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TooltipProvider>
            </TableBody>
          </Table>
        </div>
        {quotes.length > maxRows && (
          <p className="text-muted-foreground mt-2 text-sm">
            {t("settings:market_data_page.showing_first_rows", {
              max: maxRows,
              total: quotes.length,
            })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
