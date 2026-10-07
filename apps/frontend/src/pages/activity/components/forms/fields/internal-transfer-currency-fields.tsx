import {
  CurrencyInput,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";

export function InternalTransferCurrencyFields() {
  const { control } = useFormContext();
  const { t } = useTranslation("activity");
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {(["sourceCurrency", "destinationCurrency"] as const).map((name) => {
        const label = t(
          name === "sourceCurrency" ? "form.source_currency" : "form.destination_currency",
        );
        return (
          <FormField
            key={name}
            control={control}
            name={name}
            render={({ field }) => (
              <FormItem>
                <FormLabel>{label}</FormLabel>
                <FormControl>
                  <CurrencyInput
                    {...field}
                    value={field.value ?? ""}
                    aria-label={label}
                    data-testid={name}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        );
      })}
    </div>
  );
}
