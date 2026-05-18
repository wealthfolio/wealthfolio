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
import { z } from "zod";

const ASSET_TYPE_OPTIONS = [
  { value: "EQUITY", label: "Equity (Stock, ETF, Fund)" },
  { value: "CRYPTO", label: "Cryptocurrency" },
  { value: "BOND", label: "Bond" },
  { value: "OPTION", label: "Option" },
  { value: "METAL", label: "Metal (Commodity)" },
  { value: "OTHER", label: "Other" },
] as const;

const customAssetSchema = z.object({
  symbol: z
    .string()
    .min(1, "Symbol is required")
    .max(20, "Symbol must be 20 characters or less")
    .transform((val) => val.toUpperCase().trim()),
  name: z.string().min(1, "Name is required").max(100, "Name must be 100 characters or less"),
  assetType: z.enum(["EQUITY", "CRYPTO", "BOND", "OPTION", "METAL", "OTHER"]),
  currency: z.string().min(1, "Currency is required"),
});

type CustomAssetFormValues = z.infer<typeof customAssetSchema>;

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
  const { settings } = useSettingsContext();

  // Use provided defaultCurrency, or fall back to settings base currency
  const currency = defaultCurrency || settings?.baseCurrency || "USD";

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
          <DialogTitle>Create Custom Asset</DialogTitle>
          <DialogDescription>
            You&apos;ll maintain prices manually, or map to a market ticker later for automatic
            updates.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <div className="space-y-4" onKeyDown={handleDialogKeyDown}>
            <FormField
              control={form.control}
              name="symbol"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Symbol / Ticker</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g., MYCOIN"
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
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., My Custom Coin" {...field} />
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
                    <FormLabel>Asset Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ASSET_TYPE_OPTIONS.map((option) => (
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
                    <FormLabel>Currency</FormLabel>
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
                Cancel
              </Button>
              <Button type="button" onClick={handleCreateClick}>
                Create Asset
              </Button>
            </DialogFooter>
          </div>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
