import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import * as z from "zod";

import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { QuoteMode } from "@/lib/constants";
import { ResponsiveSelect, type ResponsiveSelectOption } from "@wealthfolio/ui";
import { SingleSelectTaxonomy } from "@/components/classification/single-select-taxonomy";
import { MultiSelectTaxonomy } from "@/components/classification/multi-select-taxonomy";
import { useTaxonomies } from "@/hooks/use-taxonomies";

import { ParsedAsset } from "./asset-utils";

const assetFormSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().optional(),
  currency: z.string().min(1),
  quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]),
  notes: z.string().optional(),
});

export type AssetFormValues = z.infer<typeof assetFormSchema>;

interface AssetFormProps {
  asset: ParsedAsset;
  onSubmit: (values: AssetFormValues) => Promise<void>;
  onCancel?: () => void;
  isSaving?: boolean;
}

export function AssetForm({ asset, onSubmit, onCancel, isSaving }: AssetFormProps) {
  const { t } = useTranslation();
  const quoteModeOptions: ResponsiveSelectOption[] = useMemo(
    () => [
      { label: t("asset:assetForm.market_data"), value: QuoteMode.MARKET },
      { label: t("asset:assetForm.manual"), value: QuoteMode.MANUAL },
    ],
    [t],
  );
  const { data: taxonomies = [] } = useTaxonomies({ scope: "asset" });

  // Split taxonomies by selection type and sort by sortOrder
  const { singleSelectTaxonomies, multiSelectTaxonomies } = useMemo(() => {
    const sorted = [...taxonomies].sort((a, b) => a.sortOrder - b.sortOrder);
    return {
      singleSelectTaxonomies: sorted.filter((t) => t.isSingleSelect),
      multiSelectTaxonomies: sorted.filter((t) => !t.isSingleSelect),
    };
  }, [taxonomies]);

  const defaultValues: AssetFormValues = {
    symbol: asset.id,
    name: asset.name ?? "",
    currency: asset.quoteCcy,
    quoteMode: asset.quoteMode === "MANUAL" ? QuoteMode.MANUAL : QuoteMode.MARKET,
    notes: asset.notes ?? "",
  };

  const form = useForm<AssetFormValues>({
    resolver: zodResolver(assetFormSchema),
    defaultValues,
  });

  useEffect(() => {
    form.reset(defaultValues);
  }, [asset, form]);

  const handleSubmit = async (values: AssetFormValues) => {
    await onSubmit(values);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="symbol"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("asset:assetForm.symbol")}</FormLabel>
                <FormControl>
                  <Input {...field} disabled className="bg-muted/50" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="currency"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("asset:assetForm.currency")}</FormLabel>
                <FormControl>
                  <Input {...field} disabled className="bg-muted/50" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="md:col-span-2">
                <FormLabel>{t("asset:assetForm.name")}</FormLabel>
                <FormControl>
                  <Input placeholder={t("asset:assetForm.name_placeholder")} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="quoteMode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("asset:assetForm.quote_mode")}</FormLabel>
                <FormControl>
                  <ResponsiveSelect
                    value={field.value}
                    onValueChange={field.onChange}
                    options={quoteModeOptions}
                    placeholder={t("asset:assetForm.select_quote_mode")}
                    sheetTitle={t("asset:assetForm.quote_mode")}
                    sheetDescription={t("asset:assetForm.quote_mode_sheet_description")}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Classifications Section */}
        {asset.id && (singleSelectTaxonomies.length > 0 || multiSelectTaxonomies.length > 0) && (
          <div className="space-y-4 border-t pt-4">
            <h4 className="text-sm font-medium">{t("asset:assetForm.classifications")}</h4>

            {/* Single-select taxonomies */}
            {singleSelectTaxonomies.map((tax) => (
              <SingleSelectTaxonomy
                key={tax.id}
                taxonomyId={tax.id}
                assetId={asset.id}
                label={tax.name}
              />
            ))}

            {/* Multi-select taxonomies */}
            {multiSelectTaxonomies.map((tax) => (
              <MultiSelectTaxonomy
                key={tax.id}
                taxonomyId={tax.id}
                assetId={asset.id}
                label={tax.name}
              />
            ))}
          </div>
        )}

        <div className="grid gap-4">
          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("asset:assetForm.notes")}</FormLabel>
                <FormControl>
                  <Textarea
                    rows={5}
                    placeholder={t("asset:assetForm.notes_placeholder")}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end gap-3">
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isSaving}>
              {t("common:cancel")}
            </Button>
          ) : null}
          <Button type="submit" disabled={isSaving || form.formState.isSubmitting}>
            {isSaving || form.formState.isSubmitting ? (
              <span className="flex items-center gap-2">
                <Icons.Spinner className="h-4 w-4 animate-spin" /> {t("asset:assetForm.saving")}
              </span>
            ) : (
              t("asset:assetForm.save_changes")
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
