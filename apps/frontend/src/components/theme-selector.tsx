import { AnimatedToggleGroup, Icons } from "@wealthfolio/ui";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";

export type AppearanceMode = "light" | "dark" | "system";

interface ThemeSelectorProps {
  value?: string;
  onChange: (value: AppearanceMode) => void;
  className?: string;
  "aria-label"?: string;
}

const modes: {
  value: AppearanceMode;
  labelKey: string;
  Icon: ComponentType<{ className?: string }>;
}[] = [
  { value: "light", labelKey: "common:component.theme_light_label", Icon: Icons.Sun },
  { value: "dark", labelKey: "common:component.theme_dark_label", Icon: Icons.Moon },
  { value: "system", labelKey: "common:component.theme_system_label", Icon: Icons.Monitor },
];

/** Light, dark or follow the system, as one segmented control. */
export function ThemeSelector({
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: ThemeSelectorProps) {
  const { t } = useTranslation();
  return (
    <AnimatedToggleGroup<AppearanceMode>
      size="sm"
      value={(value as AppearanceMode | undefined) ?? null}
      onValueChange={onChange}
      className={className}
      aria-label={ariaLabel}
      items={modes.map(({ value: mode, labelKey, Icon }) => ({
        value: mode,
        label: (
          <span className="flex items-center gap-1.5">
            <Icon className="size-3.5" />
            {t(labelKey)}
          </span>
        ),
      }))}
    />
  );
}
