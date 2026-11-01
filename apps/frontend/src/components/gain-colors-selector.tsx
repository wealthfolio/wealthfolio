import { gainColorOptions, resolveGainColors, type GainColors } from "@/themes/gain-colors";
import { AnimatedToggleGroup, Icons } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

interface GainColorsSelectorProps {
  value?: string;
  onChange: (value: GainColors) => void;
  className?: string;
  "aria-label"?: string;
}

export const gainColorLabelKeys: Record<GainColors, string> = {
  "green-up": "settings:appearance_gain_colors_green_up",
  "red-up": "settings:appearance_gain_colors_red_up",
  "red-up-blue-down": "settings:appearance_gain_colors_red_up_blue_down",
};

// Each option draws its own colours, whichever one is selected.
const sampleClasses: Record<GainColors, [rise: string, fall: string]> = {
  "green-up": ["text-success", "text-destructive"],
  "red-up": ["text-destructive", "text-success"],
  "red-up-blue-down": ["text-destructive", "text-loss-blue"],
};

/**
 * Green up, red up, or red up and blue down, as one segmented control. Each option
 * is an up and a down arrow in its own colours; the names are too long to sit beside
 * them, so each is the option's accessible name and tooltip, and the Appearance row
 * names the selected one.
 */
export function GainColorsSelector({
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: GainColorsSelectorProps) {
  const { t } = useTranslation();
  return (
    <AnimatedToggleGroup<GainColors>
      size="sm"
      value={resolveGainColors(value)}
      onValueChange={onChange}
      className={className}
      aria-label={ariaLabel}
      items={gainColorOptions.map((option) => {
        const [rise, fall] = sampleClasses[option];
        return {
          value: option,
          "aria-label": t(gainColorLabelKeys[option]),
          title: t(gainColorLabelKeys[option]),
          label: (
            <span aria-hidden className="flex">
              <Icons.ArrowUp className={`size-3.5 ${rise}`} />
              <Icons.ArrowDown className={`size-3.5 ${fall}`} />
            </span>
          ),
        };
      })}
    />
  );
}
