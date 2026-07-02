import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
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
import { useI18n } from "@/i18n/i18n-provider";
import { useSettingsContext } from "@/lib/settings-provider";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";

const baseCurrencyFormSchema = z.object({
  baseCurrency: z.string({ required_error: "Please select a base currency." }),
});

type BaseCurrencyFormValues = z.infer<typeof baseCurrencyFormSchema>;

// Extracted form component
export function BaseCurrencyForm() {
  const { settings, updateBaseCurrency } = useSettingsContext();
  const { t } = useI18n();
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
            <FormItem className="flex flex-col">
              <FormControl className="w-[300px]">
                <CurrencyInput value={field.value} onChange={field.onChange} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">{t("settings.currency.save")}</Button>
      </form>
    </Form>
  );
}

// Original component now uses the extracted form inside a Card
export function BaseCurrencySettings() {
  const { t } = useI18n();

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="text-lg">{t("settings.currency.title")}</CardTitle>
          <CardDescription>{t("settings.currency.description")}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <BaseCurrencyForm />
      </CardContent>
    </Card>
  );
}
