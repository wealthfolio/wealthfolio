import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Icons,
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  MoneyInput,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@wealthfolio/ui";
import { currencyFractionDigits } from "@/lib/currency-decimals";
import { useTranslation } from "react-i18next";
import { useFormContext, type FieldPath, type FieldValues } from "react-hook-form";

interface AmountInputProps<TFieldValues extends FieldValues = FieldValues> {
  name: FieldPath<TFieldValues>;
  label?: string;
  labelHelpText?: string;
  placeholder?: string;
  "data-testid"?: string;
  /** Maximum decimal places (default: the currency's minor unit, at least 2) */
  maxDecimalPlaces?: number;
  /** Currency code to display as adornment (e.g., "USD") */
  currency?: string;
  /** Called only for direct user edits, not form.setValue updates. */
  onValueChange?: (value: number | null | undefined) => void;
  /** Called when the input loses focus. */
  onBlur?: () => void;
}

function toInputTestId(name: string) {
  return `${name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/\s+/g, "-")}-input`;
}

export function AmountInput<TFieldValues extends FieldValues = FieldValues>({
  name,
  label,
  labelHelpText,
  placeholder,
  "data-testid": dataTestId,
  maxDecimalPlaces,
  currency,
  onValueChange,
  onBlur,
}: AmountInputProps<TFieldValues>) {
  const { t } = useTranslation(["activity"]);
  const resolvedLabel = label ?? t("activity:form.label_amount");
  const testId = dataTestId ?? toInputTestId(String(name));
  const { control } = useFormContext<TFieldValues>();
  // Never fewer than 2, so a zero-decimal currency such as JPY keeps
  // accepting the decimals it always has.
  const decimalPlaces = maxDecimalPlaces ?? Math.max(2, currencyFractionDigits(currency));

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <FormLabel>{resolvedLabel}</FormLabel>
            {labelHelpText && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="text-muted-foreground/70 hover:text-foreground inline-flex rounded-full transition-colors"
                      aria-label={t("activity:form.more_info_about", { label: resolvedLabel })}
                    />
                  }
                >
                  <Icons.Info className="h-3 w-3" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">{labelHelpText}</TooltipContent>
              </Tooltip>
            )}
          </div>
          {currency ? (
            <InputGroup className="bg-input-bg h-input-height min-w-0 rounded-md shadow-xs">
              <FormControl>
                <MoneyInput
                  data-slot="input-group-control"
                  className="min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:outline-none aria-invalid:ring-0"
                  ref={field.ref}
                  name={field.name}
                  value={field.value}
                  onValueChange={(value, isUserEdit) => {
                    field.onChange(value);
                    if (isUserEdit) onValueChange?.(value);
                  }}
                  onBlur={onBlur}
                  placeholder={placeholder}
                  maxDecimalPlaces={decimalPlaces}
                  aria-label={resolvedLabel}
                  data-testid={testId}
                />
              </FormControl>
              <InputGroupAddon align="inline-end" className="shrink-0">
                <InputGroupText className="shrink-0">{currency}</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          ) : (
            <FormControl>
              <MoneyInput
                ref={field.ref}
                name={field.name}
                value={field.value}
                onValueChange={(value, isUserEdit) => {
                  field.onChange(value);
                  if (isUserEdit) onValueChange?.(value);
                }}
                onBlur={onBlur}
                placeholder={placeholder}
                maxDecimalPlaces={decimalPlaces}
                aria-label={resolvedLabel}
                data-testid={testId}
              />
            </FormControl>
          )}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
