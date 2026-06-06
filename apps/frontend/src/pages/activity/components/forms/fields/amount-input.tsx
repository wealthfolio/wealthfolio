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
import { useFormContext, type FieldPath, type FieldValues } from "react-hook-form";

interface AmountInputProps<TFieldValues extends FieldValues = FieldValues> {
  name: FieldPath<TFieldValues>;
  label?: string;
  labelHelpText?: string;
  placeholder?: string;
  /** Maximum decimal places (default: 2 for currency) */
  maxDecimalPlaces?: number;
  /** Currency code to display as adornment (e.g., "USD") */
  currency?: string;
}

export function AmountInput<TFieldValues extends FieldValues = FieldValues>({
  name,
  label = "Amount",
  labelHelpText,
  placeholder = "0.00",
  maxDecimalPlaces = 2,
  currency,
}: AmountInputProps<TFieldValues>) {
  const { control } = useFormContext<TFieldValues>();

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <div className="flex shrink-0 items-center gap-1.5 overflow-hidden">
            <FormLabel>{label}</FormLabel>
            {labelHelpText && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground/70 hover:text-foreground inline-flex rounded-full transition-colors"
                    aria-label={`More info about ${label}`}
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
              <InputGroup className="bg-input-bg h-input-height shadow-xs shrink-0 overflow-hidden rounded-md">
                <MoneyInput
                  data-slot="input-group-control"
                  className="aria-invalid:ring-0 flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0"
                  ref={field.ref}
                  name={field.name}
                  value={field.value}
                  onValueChange={field.onChange}
                  placeholder={placeholder}
                  maxDecimalPlaces={maxDecimalPlaces}
                  aria-label={label}
                  data-testid={`${label.toLowerCase().replace(/\s+/g, "-")}-input`}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>{currency}</InputGroupText>
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
                aria-label={label}
                data-testid={`${label.toLowerCase().replace(/\s+/g, "-")}-input`}
              />
            )}
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
