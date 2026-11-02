import { designedForKeys } from "@/themes/selection";
import type { ThemeDefinition } from "@/themes/themes";
import { Button, Icons } from "@wealthfolio/ui";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const switchModeKeys = {
  dark: "settings:appearance_switch_to_dark",
  light: "settings:appearance_switch_to_light",
} as const;

interface ThemeModeNoteProps {
  theme?: ThemeDefinition;
  onSwitch: (mode: "light" | "dark") => void;
}

/**
 * Says the theme looks best in the other mode, with a button that switches to it.
 * Shown only while the other mode is in effect, including through System; picking a
 * theme never changes the mode itself.
 */
export function ThemeModeNote({ theme, onSwitch }: ThemeModeNoteProps) {
  const { t } = useTranslation();
  const mode = theme?.mode;
  if (!theme || !mode) return null;
  const ModeIcon = mode === "dark" ? Icons.Moon : Icons.Sun;
  return (
    <div
      className={cn(
        "bg-muted/40 items-center gap-3 rounded-lg border px-4 py-3",
        mode === "dark" ? "flex dark:hidden" : "hidden dark:flex",
      )}
    >
      <ModeIcon className="text-muted-foreground size-4 shrink-0" />
      <p className="min-w-0 flex-1 text-sm">{t(designedForKeys[mode], { theme: theme.name })}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => onSwitch(mode)}
      >
        {t(switchModeKeys[mode])}
      </Button>
    </div>
  );
}
