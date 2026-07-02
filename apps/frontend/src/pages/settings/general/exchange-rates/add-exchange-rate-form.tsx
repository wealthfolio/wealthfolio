import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
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
import { useI18n } from "@/i18n/i18n-provider";
import { useMarketDataProviders } from "@/hooks/use-market-data-providers";
import { ExchangeRate } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MoneyInput, worldCurrencies } from "@wealthfolio/ui";

const exchangeRateSchema = z
  .object({
    fromCurrency: z.string().min(1, "From Currency is required"),
    toCurrency: z.string().min(1, "To Currency is required"),
    rate: z.coerce
      .number({
        invalid_type_error: "Rate must be a valid positive number.",
      })
      .min(0, { message: "Rate must be a non-negative number." })
      .optional(),
    source: z.string().min(1, "Data source is required"),
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
      message: "Please enter a valid exchange rate.",
      path: ["rate"],
    },
  );

type ExchangeRateFormData = z.infer<typeof exchangeRateSchema>;

interface AddExchangeRateFormProps {
  onSubmit: (newRate: Omit<ExchangeRate, "id">) => void;
  onCancel: () => void;
}

export function AddExchangeRateForm({ onSubmit, onCancel }: AddExchangeRateFormProps) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
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
                ? isChinese
                  ? "源货币"
                  : "From Currency"
                : isChinese
                  ? "目标货币"
                  : "To Currency"}
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
                      : isChinese
                        ? "选择货币"
                        : "Select currency"}
                    <Icons.ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </FormControl>
              </PopoverTrigger>
              <PopoverContent className="w-full p-0">
                <Command>
                  <CommandInput
                    placeholder={isChinese ? "搜索货币..." : "Search currency..."}
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
                              {isChinese ? `自定义（${searchValue}）` : `Custom (${searchValue})`}
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
          <DialogTitle>{isChinese ? "添加汇率" : "Add Exchange Rate"}</DialogTitle>
          <DialogDescription>
            {isChinese ? "向系统添加新的汇率。" : "Add a new exchange rate to the system."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-10 p-4">
          {renderCurrencyField("fromCurrency")}
          {renderCurrencyField("toCurrency")}

          <FormField
            control={form.control}
            name="source"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{isChinese ? "数据源" : "Data Source"}</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={isChinese ? "选择数据源" : "Select a data source"}
                      />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="MANUAL">{isChinese ? "手动" : "Manual"}</SelectItem>
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
                  {isManualSource
                    ? isChinese
                      ? "你需要手动更新此汇率。"
                      : "You'll need to manually update this rate."
                    : isChinese
                      ? "汇率会从所选服务商自动获取。"
                      : "Rate will be automatically fetched from the selected provider."}
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
                  <FormLabel>{isChinese ? "汇率" : "Exchange Rate"}</FormLabel>
                  <FormControl>
                    <MoneyInput
                      placeholder={isChinese ? "输入汇率" : "Enter exchange rate"}
                      {...field}
                    />
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
              {isChinese ? "取消" : "Cancel"}
            </Button>
          </DialogTrigger>
          <Button type="submit">
            <Icons.Plus className="h-4 w-4" />
            <span className="hidden sm:ml-2 sm:inline">
              {isChinese ? "添加汇率" : "Add Exchange Rate"}
            </span>
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
