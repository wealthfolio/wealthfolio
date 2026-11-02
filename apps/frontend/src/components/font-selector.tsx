import { cn } from "@/lib/utils";
import { fontLabelKeys, type FontRole } from "@/themes/selection";
import { AnimatedToggleGroup } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

interface FontSelectorProps {
  value?: string;
  onChange: (value: FontRole) => void;
  className?: string;
  "aria-label"?: string;
}

/** Sans, serif or mono, each option set in its own face, as one segmented control. */
export function FontSelector({
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: FontSelectorProps) {
  const { t } = useTranslation();
  return (
    <AnimatedToggleGroup<FontRole>
      size="sm"
      value={(value as FontRole | undefined) ?? null}
      onValueChange={onChange}
      className={className}
      aria-label={ariaLabel}
      items={(Object.keys(fontLabelKeys) as FontRole[]).map((font) => ({
        value: font,
        label: (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className={cn("text-sm font-semibold", font)}>
              Aa
            </span>
            {t(fontLabelKeys[font])}
          </span>
        ),
      }))}
    />
  );
}
