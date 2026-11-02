import { FontSelector } from "@/components/font-selector";
import { gainColorLabelKeys, GainColorsSelector } from "@/components/gain-colors-selector";
import { TextSizeSelector } from "@/components/text-size-selector";
import { resolveGainColors, type GainColors } from "@/themes/gain-colors";
import { fontLabelKeys, type FontRole } from "@/themes/selection";
import type { TextSize } from "@/themes/text-size";
import type { ThemeDefinition } from "@/themes/themes";
import { Button } from "@wealthfolio/ui";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@wealthfolio/ui/components/ui/item";
import { useTranslation } from "react-i18next";

// The Font, Text size and Gain and loss colours rows of Settings → Appearance, which
// onboarding's Appearance step shows too.

// A row's text keeps this width, so on a phone its control wraps below it
// rather than squeezing the title.
const contentClassName = "min-w-48";
// On a phone the segmented controls under their text span the row, each option an
// equal share, so the page's controls line up and give larger targets.
const actionsClassName = "max-sm:w-full";
export const controlRowControlClassName =
  "max-sm:w-full max-sm:[&_button]:flex-1 max-sm:[&_button>span]:justify-center";

interface FontRowProps {
  value?: string;
  /** The selected theme: the row names the font it suggests. */
  theme?: ThemeDefinition;
  onChange: (font: FontRole) => void;
  /** Applies the theme's own choices again, offered once the font differs from them. */
  onUseThemeDefaults: () => void;
}

export function FontRow({ value, theme, onChange, onUseThemeDefaults }: FontRowProps) {
  const { t } = useTranslation();
  const differsFromTheme = !!theme?.font && value !== theme.font;
  return (
    <Item size="sm" className="px-0">
      <ItemContent className={contentClassName}>
        <ItemTitle>{t("settings:appearance_font_title")}</ItemTitle>
        <ItemDescription>
          {theme?.font
            ? t("settings:appearance_theme_suggests", {
                theme: theme.name,
                value: t(fontLabelKeys[theme.font]),
              })
            : t("settings:appearance_font_description")}
        </ItemDescription>
        {differsFromTheme && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto self-start px-0"
            onClick={onUseThemeDefaults}
          >
            {t("settings:appearance_use_theme_defaults")}
          </Button>
        )}
      </ItemContent>
      <ItemActions className={actionsClassName}>
        <FontSelector
          aria-label={t("settings:appearance_font_title")}
          className={controlRowControlClassName}
          value={value}
          onChange={onChange}
        />
      </ItemActions>
    </Item>
  );
}

export function TextSizeRow({
  value,
  onChange,
}: {
  value?: string;
  onChange: (size: TextSize) => void;
}) {
  const { t } = useTranslation();
  // A container: the size names show when this row has room for them. The
  // description wraps: at the larger sizes two lines can't hold it in some languages.
  return (
    <Item size="sm" className="@container px-0">
      <ItemContent className={contentClassName}>
        <ItemTitle>{t("settings:appearance_text_size_title")}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {t("settings:appearance_text_size_description")}
        </ItemDescription>
      </ItemContent>
      <ItemActions className={actionsClassName}>
        <TextSizeSelector
          aria-label={t("settings:appearance_text_size_title")}
          className={controlRowControlClassName}
          value={value}
          onChange={onChange}
        />
      </ItemActions>
    </Item>
  );
}

export function GainColorsRow({
  value,
  onChange,
}: {
  value?: string;
  onChange: (gainColors: GainColors) => void;
}) {
  const { t } = useTranslation();
  // The control shows each option's arrows only, so the selected option's
  // name sits under the description, which wraps rather than clamps.
  return (
    <Item size="sm" className="px-0">
      <ItemContent className={contentClassName}>
        <ItemTitle>{t("settings:appearance_gain_colors_title")}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {t("settings:appearance_gain_colors_description")}
        </ItemDescription>
        <p className="text-sm font-medium">{t(gainColorLabelKeys[resolveGainColors(value)])}</p>
      </ItemContent>
      <ItemActions className={actionsClassName}>
        <GainColorsSelector
          aria-label={t("settings:appearance_gain_colors_title")}
          className={controlRowControlClassName}
          value={value}
          onChange={onChange}
        />
      </ItemActions>
    </Item>
  );
}
