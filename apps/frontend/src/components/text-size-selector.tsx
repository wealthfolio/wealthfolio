import { cn } from "@/lib/utils";
import { resolveTextSize, textSizeLabelKeys, textSizes, type TextSize } from "@/themes/text-size";
import { AnimatedToggleGroup } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

interface TextSizeSelectorProps {
  value?: string;
  onChange: (value: TextSize) => void;
  className?: string;
  "aria-label"?: string;
}

// Each option is a letter at its own relative size, so the control stays narrow
// in every language and at every size; its name is the accessible name and tooltip.
const glyphClasses: Record<TextSize, string> = {
  small: "text-xs",
  default: "text-sm",
  large: "text-base",
  "extra-large": "text-lg",
};

/** Small to extra large, as one segmented control. */
export function TextSizeSelector({
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: TextSizeSelectorProps) {
  const { t } = useTranslation();
  return (
    <AnimatedToggleGroup<TextSize>
      size="sm"
      value={resolveTextSize(value)}
      onValueChange={onChange}
      className={className}
      aria-label={ariaLabel}
      items={textSizes.map((size) => ({
        value: size,
        "aria-label": t(textSizeLabelKeys[size]),
        title: t(textSizeLabelKeys[size]),
        label: (
          <span aria-hidden className={cn("font-semibold leading-none", glyphClasses[size])}>
            A
          </span>
        ),
      }))}
    />
  );
}
