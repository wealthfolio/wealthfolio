import { useSettingsContext } from "@/lib/settings-provider";
import type { SymbolSearchResult } from "@/lib/types";
import { zodResolver } from "@hookform/resolvers/zod";
import { CurrencyInput } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Input } from "@wealthfolio/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { z } from "zod";

const getAssetTypeOptions = (t: TFunction) =>
  [
    { value: "EQUITY", label: t("common:component.asset_type_equity") },
    { value: "CRYPTO", label: t("common:component.asset_type_crypto") },
    { value: "BOND", label: t("common:component.asset_type_bond") },
    { value: "OPTION", label: t("common:component.asset_type_option") },
    { value: "METAL", label: t("common:component.asset_type_metal") },
    { value: "OTHER", label: t("common:component.asset_type_other") },
  ] as const;

const createCustomAssetSchema = (t: TFunction) =>
  z.object({
    symbol: z
      .string()
      .min(1, t("common:component.symbol_required"))
      .max(100, t("common:component.symbol_max_length"))
      .transform((val) => val.toUpperCase().trim()),
    name: z
      .string()
      .min(1, t("common:component.name_required"))
      .max(100, t("common:component.name_max_length")),
    assetType: z.enum(["EQUITY", "CRYPTO", "BOND", "OPTION", "METAL", "OTHER"]),
    currency: z.string().min(1, t("common:component.currency_required")),
  });

type CustomAssetFormValues = z.infer<ReturnType<typeof createCustomAssetSchema>>;

interface CreateCustomAssetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssetCreated: (searchResult: SymbolSearchResult) => void;
  defaultSymbol?: string;
  defaultCurrency?: string;
}

export function CreateCustomAssetDialog({
  open,
  onOpenChange,
  onAssetCreated,
  defaultSymbol = "",
  defaultCurrency,
}: CreateCustomAssetDialogProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();

  // Use provided defaultCurrency, or fall back to settings base currency
  const currency = defaultCurrency || settings?.baseCurrency || "USD";

  const customAssetSchema = createCustomAssetSchema(t);
  const assetTypeOptions = getAssetTypeOptions(t);

  const form = useForm<CustomAssetFormValues>({
    resolver: zodResolver(customAssetSchema),
    defaultValues: {
      symbol: defaultSymbol.toUpperCase(),
      name: "",
      assetType: "EQUITY",
      currency,
    },
  });

  // Reset form with correct currency when dialog opens or currency changes
  useEffect(() => {
    if (open) {
      form.reset({
        symbol: defaultSymbol.toUpperCase(),
        name: "",
        assetType: "EQUITY",
        currency,
      });
    }
  }, [open, currency, defaultSymbol, form]);

  const handleSubmit = (values: CustomAssetFormValues) => {
    // Create a SymbolSearchResult-like object for the custom asset
    // The actual asset creation happens when the activity is created
    const searchResult: SymbolSearchResult = {
      symbol: values.symbol,
      longName: values.name,
      shortName: values.name,
      exchange: "MANUAL",
      quoteType:
        values.assetType === "CRYPTO"
          ? "CRYPTOCURRENCY"
          : values.assetType === "OTHER"
            ? "OTHER"
            : values.assetType,
      index: "MANUAL",
      typeDisplay: "Custom Asset",
      dataSource: "MANUAL",
      quoteMode: "MANUAL",
      score: 0,
      // Include currency so SymbolSearch can set it in the form
      currency: values.currency,
      // Include asset kind for custom assets (INVESTMENT, OTHER)
      assetKind: values.assetType === "OTHER" ? "OTHER" : "INVESTMENT",
      // We don't set exchangeMic - this will result in SEC:SYMBOL:UNKNOWN for the asset ID
    };

    onAssetCreated(searchResult);
    onOpenChange(false);
    form.reset();
  };

  const handleCancel = () => {
    onOpenChange(false);
    form.reset();
  };

  const handleCreateClick = () => {
    void form.handleSubmit(handleSubmit)();
  };

  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
    e.preventDefault();
    void form.handleSubmit(handleSubmit)();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("common:component.create_custom_asset")}</DialogTitle>
          <DialogDescription>
            {t("common:component.create_custom_asset_description")}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <div className="space-y-4" onKeyDown={handleDialogKeyDown}>
            <FormField
              control={form.control}
              name="symbol"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("common:component.symbol_ticker")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("common:component.symbol_placeholder")}
                      {...field}
                      onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                      className="uppercase"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("common:component.name")}</FormLabel>
                  <FormControl>
                    <Input placeholder={t("common:component.custom_coin_placeholder")} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="assetType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("common:component.asset_type")}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("common:component.select_type")} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {assetTypeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("common:component.currency")}</FormLabel>
                    <FormControl>
                      <CurrencyInput {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={handleCancel}>
                {t("common:cancel")}
              </Button>
              <Button type="button" onClick={handleCreateClick}>
                {t("common:component.create_asset")}
              </Button>
            </DialogFooter>
          </div>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
