import { cn } from "@/lib/utils";
import {
  resolveTextSize,
  subscribeSystemTextScale,
  systemTextScale,
  textSizeLabelKeys,
  textSizes,
  type TextSize,
} from "@/themes/text-size";
import { AnimatedToggleGroup } from "@wealthfolio/ui";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

interface TextSizeSelectorProps {
  value?: string;
  onChange: (value: TextSize) => void;
  className?: string;
  "aria-label"?: string;
}

// Each option is a letter at its own relative size, followed by its name when the
// row is at least 32rem wide (an `@container` ancestor), like the font control.
// The threshold is in rem, so it grows with the text size: on phones, narrow panes
// and longer languages the letter shows alone rather than the control scrolling.
// The name stays the accessible name and tooltip everywhere.
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
  // Until a size is picked, the size in effect follows the system's, which iOS
  // re-reads on returning to the foreground: re-render when it changes.
  useSyncExternalStore(subscribeSystemTextScale, systemTextScale, () => undefined);
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
          <span className="flex items-center gap-1.5">
            <span aria-hidden className={cn("font-semibold leading-none", glyphClasses[size])}>
              A
            </span>
            <span className="hidden @lg:inline">{t(textSizeLabelKeys[size])}</span>
          </span>
        ),
      }))}
    />
  );
}
