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
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AddExchangeRateForm } from "./add-exchange-rate-form";
import { RateCell } from "./rate-cell";
import { useExchangeRates } from "./use-exchange-rate";

export function ExchangeRatesSettings() {
  const { t } = useTranslation();
  const {
    exchangeRates,
    isLoadingRates,
    updateExchangeRate,
    addExchangeRate,
    deleteExchangeRate,
    isDeletingRate,
  } = useExchangeRates();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  const columns: ColumnDef<ExchangeRate>[] = [
    {
      accessorKey: "fromCurrency",
      header: t("settings:fx_col_from"),
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
      header: t("settings:fx_col_to"),
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
      header: t("settings:fx_col_source"),
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
          MANUAL: t("settings:fx_source_manual"),
          CUSTOM_SCRAPER: t("settings:fx_source_custom"),
          CUSTOMSCRAPER: t("settings:fx_source_custom"),
        };
        return <span>{names[source] ?? source}</span>;
      },
    },
    {
      accessorKey: "rate",
      header: t("settings:fx_col_rate"),
      enableHiding: false,
      cell: ({ row }) => <RateCell rate={row.original} onUpdate={updateExchangeRate} />,
      size: 180,
    },
    {
      accessorKey: "updatedAt",
      header: t("settings:fx_col_updated"),
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
            <span className="sr-only">{t("settings:fx_view_history")}</span>
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
            confirmTitle={t("settings:fx_delete_title")}
            confirmMessage={
              <>
                <p className="mb-2">
                  <Trans
                    i18nKey="settings:fx_delete_confirm"
                    values={{ pair: currencyPair }}
                    components={{ b: <strong /> }}
                  />
                </p>
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  <Icons.AlertTriangle className="mr-1 inline h-3 w-3" />
                  {t("settings:fx_delete_warning", { currency: rate.fromCurrency })}
                </p>
              </>
            }
            handleConfirm={() => deleteExchangeRate(rate.id)}
            isPending={isDeletingRate}
            confirmButtonText={t("common:delete")}
            confirmButtonVariant="destructive"
            button={
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <Icons.Trash className="h-4 w-4" />
                <span className="sr-only">{t("common:delete")}</span>
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
            <CardTitle className="text-lg">{t("settings:fx_title")}</CardTitle>
            <CardDescription>{t("settings:fx_description")}</CardDescription>
          </div>
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Icons.PlusCircle className="mr-2 h-4 w-4" />
                {t("settings:fx_add")}
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
            <h3 className="mt-4 text-lg font-semibold">{t("settings:fx_empty")}</h3>

            <Button className="mt-4" onClick={() => setIsAddDialogOpen(true)}>
              <Icons.PlusCircle className="mr-2 h-4 w-4" />
              {t("settings:fx_add")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
