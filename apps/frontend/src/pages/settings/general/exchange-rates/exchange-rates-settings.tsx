import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { DataTable } from "@wealthfolio/ui/components/ui/data-table";
import { Dialog, DialogContent, DialogTrigger } from "@wealthfolio/ui/components/ui/dialog";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { ExchangeRate } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { ColumnDef } from "@tanstack/react-table";
import { ActionConfirm } from "@wealthfolio/ui";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/i18n/i18n-provider";
import { AddExchangeRateForm } from "./add-exchange-rate-form";
import { RateCell } from "./rate-cell";
import { useExchangeRates } from "./use-exchange-rate";

export function ExchangeRatesSettings() {
  const {
    exchangeRates,
    isLoadingRates,
    updateExchangeRate,
    addExchangeRate,
    deleteExchangeRate,
    isDeletingRate,
  } = useExchangeRates();
  const { t, language } = useI18n();
  const isChinese = language === "zh-CN";
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  const columns: ColumnDef<ExchangeRate>[] = [
    {
      accessorKey: "fromCurrency",
      header: "From",
      enableHiding: false,
      cell: ({ row }) => (
        <div>
          <div>{row.original.fromCurrency}</div>
          <div className="text-muted-foreground text-xs">{row.original.fromCurrencyName}</div>
        </div>
      ),
    },
    {
      accessorKey: "toCurrency",
      header: "To",
      enableHiding: false,
      cell: ({ row }) => (
        <div>
          <div>{row.original.toCurrency}</div>
          <div className="text-muted-foreground text-xs">{row.original.toCurrencyName}</div>
        </div>
      ),
    },
    {
      accessorKey: "source",
      header: "Source",
      enableHiding: false,
      cell: ({ row }) => {
        const source = row.original.source;
        if (source.startsWith("CUSTOM_SCRAPER:")) {
          const code = source.slice("CUSTOM_SCRAPER:".length);
          return <span className="capitalize">{code}</span>;
        }
        const names: Record<string, string> = {
          YAHOO: "Yahoo Finance",
          ALPHA_VANTAGE: "Alpha Vantage",
          MANUAL: "Manual",
          CUSTOM_SCRAPER: "Custom",
          CUSTOMSCRAPER: "Custom",
        };
        return <span>{names[source] ?? source}</span>;
      },
    },
    {
      accessorKey: "rate",
      header: "Rate",
      enableHiding: false,
      cell: ({ row }) => <RateCell rate={row.original} onUpdate={updateExchangeRate} />,
      size: 180,
    },
    {
      accessorKey: "updatedAt",
      header: "Last Updated",
      enableHiding: false,
      cell: ({ row }) => (
        <div className="text-muted-foreground text-sm">{formatDate(row.original.timestamp)}</div>
      ),
    },
    {
      id: "history",
      enableHiding: false,
      cell: ({ row }) => (
        <Link
          to={`/holdings/${encodeURIComponent(row.original.id)}`}
          className="flex items-center justify-center"
        >
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
            <Icons.Clock className="h-4 w-4" />
            <span className="sr-only">View history</span>
          </Button>
        </Link>
      ),
    },
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => {
        const rate = row.original;
        const currencyPair = `${rate.fromCurrency}/${rate.toCurrency}`;

        return (
          <ActionConfirm
            confirmTitle={isChinese ? "删除汇率" : "Delete Exchange Rate"}
            confirmMessage={
              <>
                <p className="mb-2">
                  {isChinese ? (
                    <>
                      确定要删除 <strong>{currencyPair}</strong> 汇率吗？
                    </>
                  ) : (
                    <>
                      Are you sure you want to delete the <strong>{currencyPair}</strong> exchange
                      rate?
                    </>
                  )}
                </p>
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  <Icons.AlertTriangle className="mr-1 inline h-3 w-3" />
                  {isChinese
                    ? `如果你有以 ${rate.fromCurrency} 计价的持仓或交易，可能需要重新创建此汇率，以保证投资组合计算准确。`
                    : `If you have holdings or transactions in ${rate.fromCurrency}, you may need to recreate this exchange rate for accurate portfolio calculations.`}
                </p>
              </>
            }
            handleConfirm={() => deleteExchangeRate(rate.id)}
            isPending={isDeletingRate}
            confirmButtonText={isChinese ? "删除" : "Delete"}
            cancelButtonText={isChinese ? "取消" : "Cancel"}
            confirmButtonVariant="destructive"
            button={
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <Icons.Trash className="h-4 w-4" />
                <span className="sr-only">Delete</span>
              </Button>
            }
          />
        );
      },
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">{t("settings.exchangeRates.title")}</CardTitle>
            <CardDescription>{t("settings.exchangeRates.description")}</CardDescription>
          </div>
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Icons.PlusCircle className="mr-2 h-4 w-4" />
                {t("settings.exchangeRates.add")}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto">
              <AddExchangeRateForm
                onSubmit={(newRate) => {
                  addExchangeRate(newRate);
                  setIsAddDialogOpen(false);
                }}
                onCancel={() => setIsAddDialogOpen(false)}
              />
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {isLoadingRates ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : exchangeRates && exchangeRates.length > 0 ? (
          <DataTable columns={columns} data={exchangeRates} />
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Icons.DollarSign className="text-muted-foreground h-12 w-12" />
            <h3 className="mt-4 text-lg font-semibold">{t("settings.exchangeRates.empty")}</h3>

            <Button className="mt-4" onClick={() => setIsAddDialogOpen(true)}>
              <Icons.PlusCircle className="mr-2 h-4 w-4" />
              {t("settings.exchangeRates.add")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
