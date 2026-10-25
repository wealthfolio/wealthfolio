import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import * as z from "zod";

import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { CurrencyInput } from "@wealthfolio/ui";
import { getQuoteUnitCurrency } from "@wealthfolio/ui/lib/currencies";
import { useSettingsContext } from "@/lib/settings-provider";
import { requiredError } from "@/lib/zod-errors";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";

interface BaseCurrencyFormValues {
  baseCurrency: string;
}

// Matches the server's check. The picker also offers custom codes, but only
// three capital letters that aren't a quote unit such as GBX can be the base.
function isBaseCurrencyCode(code: string) {
  return /^[A-Z]{3}$/.test(code) && !getQuoteUnitCurrency(code);
}

// Extracted form component
export function BaseCurrencyForm() {
  const { t } = useTranslation();
  const { settings, updateBaseCurrency } = useSettingsContext();
  const baseCurrencyFormSchema = z.object({
    baseCurrency: z
      .string({ error: requiredError(t("settings:currency_select_error")) })
      .refine(isBaseCurrencyCode, t("settings:currency_code_error")),
  });
  const defaultValues: Partial<BaseCurrencyFormValues> = {
    baseCurrency: settings?.baseCurrency || "USD",
  };
  const form = useForm<BaseCurrencyFormValues>({
    resolver: zodResolver(baseCurrencyFormSchema),
    defaultValues,
    // Reset form when settings change from external source
    values: { baseCurrency: settings?.baseCurrency || "USD" },
  });

  async function onSubmit(data: BaseCurrencyFormValues) {
    try {
      await updateBaseCurrency(data.baseCurrency);
    } catch (error) {
      console.error("Failed to update currency settings:", error);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        <FormField
          control={form.control}
          name="baseCurrency"
          render={({ field }) => (
            <FormItem>
              <FormControl className="w-[min(100%,18.75rem)]">
                <CurrencyInput
                  value={field.value}
                  onChange={field.onChange}
                  aria-label={t("settings:base_currency")}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">{t("settings:currency_save_button")}</Button>
      </form>
    </Form>
  );
}

// Original component now uses the extracted form inside a Card
export function BaseCurrencySettings() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="text-lg">{t("settings:base_currency")}</CardTitle>
          <CardDescription>{t("settings:currency_description")}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <BaseCurrencyForm />
      </CardContent>
    </Card>
  );
}
