import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  QuantityInput as BaseQuantityInput,
} from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { useFormContext, type FieldPath, type FieldValues } from "react-hook-form";

interface QuantityInputProps<TFieldValues extends FieldValues = FieldValues> {
  name: FieldPath<TFieldValues>;
  label?: string;
  placeholder?: string;
  "data-testid"?: string;
  /** Maximum decimal places (default: 8 for shares) */
  maxDecimalPlaces?: number;
  /** Allow negative values (default: false) */
  allowNegative?: boolean;
}

function toInputTestId(name: string) {
  return `${name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/\s+/g, "-")}-input`;
}

export function QuantityInput<TFieldValues extends FieldValues = FieldValues>({
  name,
  label,
  placeholder = "0.00",
  "data-testid": dataTestId,
  maxDecimalPlaces = 8,
  allowNegative = false,
}: QuantityInputProps<TFieldValues>) {
  const { t } = useTranslation(["activity"]);
  const resolvedLabel = label ?? t("activity:form.label_quantity");
  const testId = dataTestId ?? toInputTestId(String(name));
  const { control } = useFormContext<TFieldValues>();

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{resolvedLabel}</FormLabel>
          <FormControl>
            <BaseQuantityInput
              ref={field.ref}
              name={field.name}
              value={field.value}
              onValueChange={field.onChange}
              placeholder={placeholder}
              maxDecimalPlaces={maxDecimalPlaces}
              allowNegative={allowNegative}
              aria-label={resolvedLabel}
              data-testid={testId}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
