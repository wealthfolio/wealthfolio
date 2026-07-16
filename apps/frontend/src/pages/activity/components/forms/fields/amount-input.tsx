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
import { useTranslation } from "react-i18next";
import { useFormContext, type FieldPath, type FieldValues } from "react-hook-form";

interface AmountInputProps<TFieldValues extends FieldValues = FieldValues> {
  name: FieldPath<TFieldValues>;
  label?: string;
  labelHelpText?: string;
  placeholder?: string;
  "data-testid"?: string;
  /** Maximum decimal places (default: 2 for currency) */
  maxDecimalPlaces?: number;
  /** Currency code to display as adornment (e.g., "USD") */
  currency?: string;
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
  placeholder = "0.00",
  "data-testid": dataTestId,
  maxDecimalPlaces = 2,
  currency,
}: AmountInputProps<TFieldValues>) {
  const { t } = useTranslation(["activity"]);
  const resolvedLabel = label ?? t("activity:form.label_amount");
  const testId = dataTestId ?? toInputTestId(String(name));
  const { control } = useFormContext<TFieldValues>();

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
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground/70 hover:text-foreground inline-flex rounded-full transition-colors"
                    aria-label={t("activity:form.more_info_about", { label: resolvedLabel })}
                  >
                    <Icons.Info className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">{labelHelpText}</TooltipContent>
              </Tooltip>
            )}
          </div>
          <FormControl>
            {currency ? (
              <InputGroup className="bg-input-bg h-input-height shadow-xs min-w-0 rounded-md">
                <MoneyInput
                  data-slot="input-group-control"
                  className="aria-invalid:ring-0 min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0"
                  ref={field.ref}
                  name={field.name}
                  value={field.value}
                  onValueChange={field.onChange}
                  placeholder={placeholder}
                  maxDecimalPlaces={maxDecimalPlaces}
                  aria-label={resolvedLabel}
                  data-testid={testId}
                />
                <InputGroupAddon align="inline-end" className="shrink-0">
                  <InputGroupText className="shrink-0">{currency}</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            ) : (
              <MoneyInput
                ref={field.ref}
                name={field.name}
                value={field.value}
                onValueChange={field.onChange}
                placeholder={placeholder}
                maxDecimalPlaces={maxDecimalPlaces}
                aria-label={resolvedLabel}
                data-testid={testId}
              />
            )}
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
