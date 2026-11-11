import * as React from "react";
import { NumericFormat } from "react-number-format";
import { DECIMAL_PRECISION } from "../../lib/constants";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { useNumberFormatting } from "../formatting-provider";

export interface MoneyInputProps {
  /** Current numeric value */
  value?: number | string | null;
  /**
   * Called when value changes with the new numeric value.
   * Preferred API - receives number directly.
   * `isUserEdit` is true for keystrokes/pastes and false for programmatic
   * value changes (e.g. form.setValue) that echo back through the input.
   */
  onValueChange?: (value: number | undefined, isUserEdit?: boolean) => void;
  /**
   * Legacy onChange handler for backward compatibility.
   * Receives a synthetic event with value in e.target.value.
   * @deprecated Use onValueChange instead
   */
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Maximum decimal places (default: 8) */
  maxDecimalPlaces?: number;
  /** Always display the configured number of decimal places */
  fixedDecimalScale?: boolean;
  /** Use thousand separators (default: false) */
  thousandSeparator?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Additional class names */
  className?: string;
  /** Input name for forms */
  name?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Read-only state */
  readOnly?: boolean;
  /** Aria label for accessibility */
  "aria-label"?: string;
  /** ID of the element that labels the input */
  "aria-labelledby"?: string;
  /** ID used to associate the input with its form label */
  id?: string;
  /** IDs of elements describing the input */
  "aria-describedby"?: string;
  /** Whether the input currently has a validation error */
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  /** Test ID for e2e testing */
  "data-testid"?: string;
  /** Auto focus on mount */
  autoFocus?: boolean;
  /** Key down handler */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Blur handler */
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
}

const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  (
    {
      value,
      onValueChange,
      onChange,
      maxDecimalPlaces = DECIMAL_PRECISION,
      fixedDecimalScale = false,
      thousandSeparator = false,
      placeholder,
      className,
      name,
      disabled,
      readOnly,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      id,
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
      "data-testid": testId,
      autoFocus,
      onKeyDown,
      onBlur,
    },
    ref,
  ) => {
    const formatting = useNumberFormatting();
    const resolvedPlaceholder =
      placeholder ??
      formatting.formatDecimal(0, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: false,
      });
    // Normalize value to number or empty string
    const numericValue = value === null || value === undefined || value === "" ? "" : Number(value);

    return (
      <NumericFormat
        customInput={Input}
        getInputRef={ref}
        name={name}
        className={cn("text-end", className)}
        placeholder={resolvedPlaceholder}
        disabled={disabled}
        readOnly={readOnly}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        id={id}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        data-testid={testId}
        autoFocus={autoFocus}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        allowNegative={false}
        decimalScale={maxDecimalPlaces}
        fixedDecimalScale={fixedDecimalScale}
        thousandSeparator={thousandSeparator ? formatting.groupSeparator : false}
        decimalSeparator={formatting.decimalSeparator}
        allowedDecimalSeparators={Array.from(new Set([formatting.decimalSeparator, ".", ","]))}
        valueIsNumericString={false}
        value={numericValue}
        onValueChange={(values, sourceInfo) => {
          // Prefer onValueChange if provided
          if (onValueChange) {
            // The SourceType enum is not exported from the package's type
            // entry, so compare its literal value ("event" | "prop") as string.
            onValueChange(values.floatValue, String(sourceInfo?.source) === "event");
          }
          // Fall back to legacy onChange for backward compatibility
          // Note: e.target.value will be a number, not a string
          else if (onChange) {
            const syntheticEvent = {
              target: { name, value: values.floatValue },
            } as unknown as React.ChangeEvent<HTMLInputElement>;
            onChange(syntheticEvent);
          }
        }}
        inputMode="decimal"
        onPaste={(event) => {
          if (readOnly || disabled) {
            event.preventDefault();
            return;
          }
          const clipboardValue = event.clipboardData.getData("text");
          const input = event.currentTarget;
          const hasSelection =
            input.selectionStart !== null &&
            input.selectionEnd !== null &&
            (input.selectionStart > 0 || input.selectionEnd < input.value.length);
          const plainFragmentPattern = new RegExp(
            `^[0-9${formatting.decimalSeparator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]*$`,
          );
          if (hasSelection && plainFragmentPattern.test(clipboardValue)) return;

          event.preventDefault();
          const parsed = formatting.parseNumber(clipboardValue);
          if (parsed === undefined || parsed < 0) return;
          onValueChange?.(parsed, true);
          if (!onValueChange && onChange) {
            onChange({ target: { name, value: parsed } } as unknown as React.ChangeEvent<HTMLInputElement>);
          }
        }}
      />
    );
  },
);

MoneyInput.displayName = "MoneyInput";

export { MoneyInput };
