import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Textarea,
} from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { useFormContext, type FieldPath, type FieldValues } from "react-hook-form";

interface NotesInputProps<TFieldValues extends FieldValues = FieldValues> {
  name: FieldPath<TFieldValues>;
  label?: string;
  placeholder?: string;
  /** Number of visible rows (default: 3) */
  rows?: number;
}

export function NotesInput<TFieldValues extends FieldValues = FieldValues>({
  name,
  label,
  placeholder,
  rows = 3,
}: NotesInputProps<TFieldValues>) {
  const { t } = useTranslation(["activity"]);
  const resolvedLabel = label ?? t("activity:form.label_notes");
  const resolvedPlaceholder = placeholder ?? t("activity:form.placeholder_note_or_comment");
  const { control } = useFormContext<TFieldValues>();

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{resolvedLabel}</FormLabel>
          <FormControl>
            <Textarea
              placeholder={resolvedPlaceholder}
              className="resize-none"
              rows={rows}
              {...field}
              value={field.value || ""}
              aria-label={resolvedLabel}
              data-testid="notes-input"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
