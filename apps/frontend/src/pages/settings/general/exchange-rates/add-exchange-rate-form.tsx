import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import * as z from "zod";

import { Button } from "@wealthfolio/ui/components/ui/button";

import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@wealthfolio/ui/components/ui/command";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { useMarketDataProviders } from "@/hooks/use-market-data-providers";
import { ExchangeRate } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MoneyInput, worldCurrencies } from "@wealthfolio/ui";

interface ExchangeRateFormData {
  fromCurrency: string;
  toCurrency: string;
  rate?: number;
  source: string;
}

interface AddExchangeRateFormProps {
  onSubmit: (newRate: Omit<ExchangeRate, "id">) => void;
  onCancel: () => void;
}

export function AddExchangeRateForm({ onSubmit, onCancel }: AddExchangeRateFormProps) {
  const { t } = useTranslation();
  const exchangeRateSchema = z
    .object({
      fromCurrency: z.string().min(1, t("settings:fx_err_from_required")),
      toCurrency: z.string().min(1, t("settings:fx_err_to_required")),
      rate: z.coerce
        .number({
          invalid_type_error: t("settings:fx_err_rate_type"),
        })
        .min(0, { message: t("settings:fx_err_rate_negative") })
        .optional(),
      source: z.string().min(1, t("settings:fx_err_source_required")),
    })
    .refine(
      (data) => {
        // Rate is required only for MANUAL source
        if (data.source === "MANUAL") {
          return data.rate !== undefined && data.rate > 0;
        }
        return true;
      },
      {
        message: t("settings:fx_err_rate_invalid"),
        path: ["rate"],
      },
    );

  const { data: providers } = useMarketDataProviders();
  const { data: customProviders = [] } = useCustomProviders();
  const form = useForm<ExchangeRateFormData>({
    resolver: zodResolver(exchangeRateSchema),
    defaultValues: {
      fromCurrency: "",
      toCurrency: "",
      rate: undefined,
      source: "MANUAL",
    },
  });

  const selectedSource = form.watch("source");
  const isManualSource = selectedSource === "MANUAL";

  const handleSubmit = (data: ExchangeRateFormData) => {
    onSubmit({
      fromCurrency: data.fromCurrency,
      toCurrency: data.toCurrency,
      source: data.source,
      // Only manual sources carry a user-entered rate. Provider-backed sources
      // are fetched by the market-data sync; the backend ignores this value for
      // them, so send a neutral 0 rather than a fake rate (#1143).
      rate: isManualSource ? data.rate! : 0,
      timestamp: new Date().toISOString(),
    });
  };

  const renderCurrencyField = (fieldName: "fromCurrency" | "toCurrency") => {
    const [searchValue, setSearchValue] = useState("");

    const handleSearchChange = (value: string) => {
      setSearchValue(value);
      const matchingCurrency = worldCurrencies.find(
        (currency) =>
          currency.label.toLowerCase().includes(value.toLowerCase()) ||
          currency.value.includes(value),
      );
      if (!matchingCurrency && value) {
        form.setValue(fieldName, value.toUpperCase());
      }
    };

    return (
      <FormField
        control={form.control}
        name={fieldName}
        render={({ field }) => (
          <FormItem className="flex flex-col">
            <FormLabel>
              {fieldName === "fromCurrency"
                ? t("settings:fx_from_currency")
                : t("settings:fx_to_currency")}
            </FormLabel>
            <Popover modal={true}>
              <PopoverTrigger asChild>
                <FormControl>
                  <Button
                    variant="outline"
                    role="combobox"
                    className={cn("justify-between", !field.value && "text-muted-foreground")}
                  >
                    {field.value
                      ? worldCurrencies.find((currency) => currency.value === field.value)?.label ||
                        field.value
                      : t("settings:fx_select_currency")}
                    <Icons.ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </FormControl>
              </PopoverTrigger>
              <PopoverContent className="w-full p-0">
                <Command>
                  <CommandInput
                    placeholder={t("settings:fx_search_currency")}
                    onValueChange={handleSearchChange}
                  />
                  <CommandList>
                    <CommandGroup>
                      <ScrollArea className="max-h-96 overflow-y-auto">
                        {searchValue && (
                          <CommandItem
                            value={searchValue}
                            key={searchValue}
                            onSelect={() => {
                              form.setValue(fieldName, searchValue);
                            }}
                          >
                            <Icons.Plus
                              className={cn(
                                "mr-2 h-4 w-4",
                                searchValue === field.value ? "opacity-100" : "opacity-0",
                              )}
                            />
                            <span className="font-semibold italic">
                              {t("settings:fx_custom_search", { value: searchValue })}
                            </span>
                          </CommandItem>
                        )}

                        {worldCurrencies
                          .filter(
                            (currency) =>
                              currency.label.toLowerCase().includes(searchValue.toLowerCase()) ||
                              currency.value.includes(searchValue),
                          )
                          .map((currency) => (
                            <CommandItem
                              value={currency.label}
                              key={currency.value}
                              onSelect={() => {
                                form.setValue(fieldName, currency.value);
                              }}
                            >
                              <Icons.Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  currency.value === field.value ? "opacity-100" : "opacity-0",
                                )}
                              />
                              {currency.label}
                            </CommandItem>
                          ))}
                      </ScrollArea>
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <FormMessage />
          </FormItem>
        )}
      />
    );
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-8">
        <DialogHeader>
          <DialogTitle>{t("settings:fx_add_title")}</DialogTitle>
          <DialogDescription>{t("settings:fx_add_subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-10 p-4">
          {renderCurrencyField("fromCurrency")}
          {renderCurrencyField("toCurrency")}

          <FormField
            control={form.control}
            name="source"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("settings:fx_data_source")}</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={t("settings:fx_select_data_source")} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="MANUAL">{t("settings:fx_source_manual")}</SelectItem>
                    {providers
                      ?.filter((p) => p.id !== "CUSTOM_SCRAPER" && p.providerType !== "custom")
                      .map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.name}
                        </SelectItem>
                      ))}
                    {customProviders
                      .filter((cp) => cp.enabled)
                      .map((cp) => (
                        <SelectItem key={cp.id} value={`CUSTOM_SCRAPER:${cp.id}`}>
                          {cp.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  {isManualSource ? t("settings:fx_manual_hint") : t("settings:fx_auto_hint")}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {isManualSource && (
            <FormField
              control={form.control}
              name="rate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings:fx_rate_label")}</FormLabel>
                  <FormControl>
                    <MoneyInput placeholder={t("settings:fx_rate_placeholder")} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>

        <DialogFooter>
          <DialogTrigger asChild>
            <Button variant="outline" onClick={onCancel}>
              {t("common:cancel")}
            </Button>
          </DialogTrigger>
          <Button type="submit">
            <Icons.Plus className="h-4 w-4" />
            <span className="hidden sm:ml-2 sm:inline">{t("settings:fx_add_title")}</span>
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
