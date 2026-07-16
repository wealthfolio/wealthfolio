import type { ComponentPropsWithoutRef } from "react";
import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { CurrencyInput } from "@wealthfolio/ui";

type CurrencyInputComponentProps = ComponentPropsWithoutRef<typeof CurrencyInput>;

interface CurrencySelectorMobileProps extends Omit<
  CurrencyInputComponentProps,
  "value" | "onChange" | "displayMode" | "placeholder" | "onSelect"
> {
  onSelect: (currency: string) => void;
  value?: string;
  placeholder?: string;
}

export const CurrencySelectorMobile = forwardRef<HTMLButtonElement, CurrencySelectorMobileProps>(
  ({ onSelect, value, placeholder, className, ...props }, ref) => {
    const { t } = useTranslation();
    const { size = "lg", ...rest } = props;

    return (
      <CurrencyInput
        ref={ref}
        value={value}
        onChange={onSelect}
        placeholder={placeholder ?? t("common:component.select_currency")}
        className={className}
        displayMode="mobile"
        size={size}
        {...rest}
      />
    );
  },
);

CurrencySelectorMobile.displayName = "CurrencySelectorMobile";
