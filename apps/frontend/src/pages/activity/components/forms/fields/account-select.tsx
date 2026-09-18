import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui";
import { useFormContext, type FieldPath, type FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";

export interface AccountSelectOption {
  value: string;
  label: string;
  currency: string;
  accountType?: string;
  /** Activity restriction level based on account tracking mode. */
  restrictionLevel?: "none" | "limited" | "blocked";
}

interface AccountSelectProps<TFieldValues extends FieldValues = FieldValues> {
  name: FieldPath<TFieldValues>;
  accounts: AccountSelectOption[];
  label?: string;
  placeholder?: string;
}

export function AccountSelect<TFieldValues extends FieldValues = FieldValues>({
  name,
  accounts,
  label,
  placeholder,
}: AccountSelectProps<TFieldValues>) {
  const { t } = useTranslation(["activity"]);
  const resolvedLabel = label ?? t("activity:field_account");
  const resolvedPlaceholder = placeholder ?? t("activity:select_account_placeholder");
  const { control } = useFormContext<TFieldValues>();

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{resolvedLabel}</FormLabel>
          <FormControl>
            <Select onValueChange={field.onChange} value={field.value ?? ""}>
              <SelectTrigger aria-label={resolvedLabel} data-testid="account-select">
                <SelectValue placeholder={resolvedPlaceholder} />
              </SelectTrigger>
              <SelectContent className="max-h-125 overflow-y-auto">
                {accounts.map((account) => (
                  <SelectItem
                    value={account.value}
                    key={account.value}
                    data-testid="account-option"
                    data-account-name={account.label}
                    data-account-currency={account.currency}
                  >
                    {account.label}
                    <span className="text-muted-foreground font-light">({account.currency})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
