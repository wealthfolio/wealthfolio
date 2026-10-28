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

/**
 * Light, dark or follow the system, as one segmented control. Each option is its
 * icon, followed by its name when the row is at least 18rem wide (an `@container`
 * ancestor), like the text size control; the threshold is in rem, so at larger text
 * sizes on a phone the icons show alone. The name stays the accessible name and
 * tooltip everywhere.
 */
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
        "aria-label": t(labelKey),
        title: t(labelKey),
        label: (
          <span className="flex items-center gap-1.5">
            <Icon aria-hidden className="size-3.5" />
            <span className="hidden @2xs:inline">{t(labelKey)}</span>
          </span>
        ),
      }))}
    />
  );
}
