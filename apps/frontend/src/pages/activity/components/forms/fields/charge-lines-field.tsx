import { sumChargeLines, type ChargeCategory, type ChargeLineValue } from "@/lib/activity-charges";
import { currencyFractionDigits, valueDecimalPlaces } from "@/lib/currency-decimals";
import {
  Button,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
  Icons,
  Input,
  MoneyInput,
} from "@wealthfolio/ui";
import {
  useFieldArray,
  useFormContext,
  useWatch,
  type ArrayPath,
  type FieldPath,
  type FieldValues,
  type PathValue,
} from "react-hook-form";
import { useTranslation } from "react-i18next";
import { AmountInput } from "./amount-input";

interface ChargeLinesEditorProps<TFieldValues extends FieldValues = FieldValues> {
  /** The fee or tax total the lines break down. */
  totalName: FieldPath<TFieldValues>;
  linesName: ArrayPath<TFieldValues>;
  category: ChargeCategory;
  currency?: string;
  maxDecimalPlaces?: number;
  /** Called after the lines have set a new total. */
  onTotalChange?: () => void;
}

/**
 * The labelled lines under a fee or tax total. While there are lines, the
 * total is their exact sum; removing the last one hands the total back to
 * the user as it stands.
 */
export function ChargeLinesEditor<TFieldValues extends FieldValues = FieldValues>({
  totalName,
  linesName,
  category,
  currency,
  maxDecimalPlaces,
  onTotalChange,
}: ChargeLinesEditorProps<TFieldValues>) {
  const { t } = useTranslation(["activity"]);
  const { control, getValues, setValue, formState } = useFormContext<TFieldValues>();
  const { fields, append, remove } = useFieldArray({ control, name: linesName });
  const locked = useWatch({ control, name: "chargeLinesLocked" as FieldPath<TFieldValues> });
  const decimalPlaces = maxDecimalPlaces ?? Math.max(2, currencyFractionDigits(currency));

  const setTotalFromLines = () => {
    const lines = (getValues(linesName as unknown as FieldPath<TFieldValues>) ??
      []) as ChargeLineValue[];
    if (lines.length === 0) return;
    setValue(totalName, sumChargeLines(lines) as PathValue<TFieldValues, typeof totalName>, {
      shouldDirty: true,
      shouldValidate: formState.isSubmitted,
    });
    onTotalChange?.();
  };

  const addLine = () => {
    // The first line starts with the whole total, so breaking it down doesn't change it.
    const total = fields.length === 0 ? Number(getValues(totalName)) : Number.NaN;
    append({
      label: "",
      amount: Number.isFinite(total) && total > 0 ? total : undefined,
    } as never);
  };

  if (locked) return null;

  const placeholder =
    category === "fee"
      ? t("activity:form.placeholder_fee_line")
      : t("activity:form.placeholder_tax_line");

  return (
    <div className="mt-2 space-y-2">
      {fields.map((field, index) => {
        const linePath = `${linesName}.${index}` as FieldPath<TFieldValues>;
        return (
          <div key={field.id} className="flex items-start gap-1.5">
            <FormField
              control={control}
              name={`${linePath}.label` as FieldPath<TFieldValues>}
              render={({ field: labelField }) => (
                <FormItem className="min-w-0 flex-1">
                  <FormControl>
                    <Input
                      {...labelField}
                      value={(labelField.value as string | undefined) ?? ""}
                      placeholder={placeholder}
                      aria-label={t("activity:form.charge_line_label")}
                      className="text-sm"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`${linePath}.amount` as FieldPath<TFieldValues>}
              render={({ field: amountField }) => (
                <FormItem className="w-24 shrink-0">
                  <FormControl>
                    <MoneyInput
                      ref={amountField.ref}
                      name={amountField.name}
                      value={amountField.value as number | undefined}
                      onValueChange={(value, isUserEdit) => {
                        if (!isUserEdit) return;
                        amountField.onChange(value);
                        setTotalFromLines();
                      }}
                      onBlur={amountField.onBlur}
                      maxDecimalPlaces={Math.max(
                        decimalPlaces,
                        valueDecimalPlaces(amountField.value),
                      )}
                      aria-label={t("activity:form.charge_line_amount")}
                      className="text-sm"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground -ms-1 shrink-0"
              aria-label={t("activity:form.remove_charge_line")}
              onClick={() => {
                remove(index);
                setTotalFromLines();
              }}
            >
              <Icons.Close className="h-4 w-4" />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="link"
        size="sm"
        className="text-muted-foreground h-auto px-0 text-xs"
        onClick={addLine}
      >
        <Icons.Plus className="me-1 h-3 w-3" />
        {fields.length === 0
          ? t("activity:form.break_down_charge")
          : t("activity:form.add_charge_line")}
      </Button>
    </div>
  );
}

interface ChargeLinesFieldProps<
  TFieldValues extends FieldValues = FieldValues,
> extends ChargeLinesEditorProps<TFieldValues> {
  label: string;
  /** Called for direct user edits of the total. */
  onValueChange?: (value: number | null | undefined) => void;
}

/** A fee or tax total with its optional labelled lines. */
export function ChargeLinesField<TFieldValues extends FieldValues = FieldValues>({
  label,
  onValueChange,
  ...editorProps
}: ChargeLinesFieldProps<TFieldValues>) {
  const { control } = useFormContext<TFieldValues>();
  const lines = useWatch({
    control,
    name: editorProps.linesName as unknown as FieldPath<TFieldValues>,
  }) as ChargeLineValue[] | undefined;
  const total = useWatch({ control, name: editorProps.totalName });

  return (
    <div className="min-w-0">
      <AmountInput
        name={editorProps.totalName}
        label={label}
        currency={editorProps.currency}
        maxDecimalPlaces={Math.max(
          editorProps.maxDecimalPlaces ?? Math.max(2, currencyFractionDigits(editorProps.currency)),
          valueDecimalPlaces(total),
        )}
        onValueChange={onValueChange}
        readOnly={(lines?.length ?? 0) > 0}
      />
      <ChargeLinesEditor {...editorProps} />
    </div>
  );
}
