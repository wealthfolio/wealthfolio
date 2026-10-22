import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icons, useNumberFormatting } from "@wealthfolio/ui";
import { cn } from "@/lib/utils";
import { designedForKeys, fontLabelKeys, type FontRole } from "@/themes/selection";
import { isThemeId, resolveThemeId, themes, type ThemeDefinition } from "@/themes/themes";

const ALLOCATION = [38, 24, 16, 13, 9];
const TREND = "M0,23 C8,22 12,14 20,15 S32,24 40,19 S54,9 62,12 S78,21 86,12 S102,5 120,6";

function PreviewCard({ children }: { children: ReactNode }) {
  return (
    <div className="bg-card flex min-w-0 flex-col gap-1 rounded-md border p-1.5">{children}</div>
  );
}

/**
 * A miniature of the dashboard in one theme, drawn in the current mode. The
 * theme's CSS applies to [data-theme-preview], so every colour, radius and font
 * is the theme's own. That CSS carries only the tokens in
 * theme-preview-tokens.json: list any token a new class here reads (the picker
 * test checks). Decorative: the picker names each option.
 */
export function ThemePreview({
  theme,
  font,
  className,
}: {
  theme: ThemeDefinition;
  /** The font role drawn when the theme suggests none: the user's current one. */
  font: FontRole;
  className?: string;
}) {
  const gradientId = `theme-trend-${useId().replace(/[^\w-]/g, "")}`;
  const { formatDecimal } = useNumberFormatting();
  return (
    <div
      aria-hidden="true"
      data-theme-preview={theme.id}
      className={cn(
        "bg-background text-foreground flex h-28 w-full min-w-0 overflow-hidden",
        // Always a role class, so the family resolves from this miniature's own
        // stacks; an inherited font-family is already the selected theme's.
        theme.font ?? font,
        className,
      )}
    >
      {/* Icon rail: logo, active page, other pages. */}
      <div className="bg-sidebar border-sidebar-border flex w-1/6 flex-col items-center gap-1.5 border-e pt-2">
        <span className="bg-primary size-2 rounded-full" />
        <span className="bg-sidebar-accent flex size-3 items-center justify-center rounded-sm">
          <span className="bg-sidebar-foreground/80 rounded-xs size-1.5" />
        </span>
        {[0, 1, 2].map((item) => (
          <span key={item} className="bg-sidebar-foreground/35 rounded-xs size-1.5" />
        ))}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-hidden p-2">
        {/* Page tabs and the page's primary action. */}
        <div className="flex items-center justify-between gap-1">
          <span className="bg-muted flex gap-0.5 rounded-full p-0.5">
            {[0, 1, 2].map((tab) => (
              <span
                key={tab}
                className={cn(
                  "flex h-2.5 w-4 items-center justify-center rounded-full",
                  tab === 0 && "bg-background shadow-xs",
                )}
              >
                <span
                  className={cn(
                    "h-0.5 w-2 rounded-full",
                    tab === 0 ? "bg-foreground/70" : "bg-muted-foreground/55",
                  )}
                />
              </span>
            ))}
          </span>
          <span className="bg-primary h-2.5 w-6 shrink-0 rounded-full" />
        </div>

        {/* Portfolio value in the theme's type, with its change below. */}
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold tabular-nums leading-none tracking-tight">
            {formatDecimal(48250.12, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span className="flex gap-1">
            <span className="bg-success h-1 w-4 rounded-full" />
            <span className="bg-success/70 h-1 w-3 rounded-full" />
            <span className="bg-muted-foreground/45 h-1 w-3.5 rounded-full" />
          </span>
        </div>

        <svg
          className="text-success -mx-2 min-h-4 w-[calc(100%+1rem)] flex-1"
          viewBox="0 0 120 30"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity={0.28} />
              <stop offset="1" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={`${TREND} L120,30 L0,30 Z`} fill={`url(#${gradientId})`} />
          <path
            d={TREND}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* Allocation and holdings cards. */}
        <div className="grid grid-cols-2 gap-1.5">
          <PreviewCard>
            <span className="flex h-1 overflow-hidden rounded-full">
              {ALLOCATION.map((share, index) => (
                <span
                  key={index}
                  className={
                    ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"][index]
                  }
                  style={{ width: `${share}%` }}
                />
              ))}
            </span>
            {[60, 45].map((width) => (
              <span key={width} className="flex items-center justify-between">
                <span
                  className="bg-foreground/45 h-0.5 rounded-full"
                  style={{ width: `${width}%` }}
                />
                <span className="bg-foreground/70 h-0.5 w-1/5 rounded-full" />
              </span>
            ))}
          </PreviewCard>
          <PreviewCard>
            {["bg-success-subtle", "bg-destructive-subtle"].map((tone) => (
              <span key={tone} className="flex items-center gap-1">
                <span className="bg-muted size-2 shrink-0 rounded-full" />
                <span className="bg-foreground/45 h-0.5 w-1/3 rounded-full" />
                <span className={cn("ms-auto h-1 w-3.5 shrink-0 rounded-full", tone)} />
              </span>
            ))}
          </PreviewCard>
        </div>
      </div>
    </div>
  );
}

interface ThemePickerProps {
  value?: string;
  /** The user's current font role, for themes that suggest none. */
  font?: string;
  onChange: (value: string) => void;
  className?: string;
}

/** The themes as radio cards, each with a miniature drawn in that theme. */
export function ThemePicker({ value, font, onChange, className }: ThemePickerProps) {
  const currentFont: FontRole = font && font in fontLabelKeys ? (font as FontRole) : "font-mono";
  const { t } = useTranslation();
  const name = useId();
  const selectedId = resolveThemeId(value);
  return (
    <fieldset className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>
      <legend className="sr-only">{t("settings:appearance_theme_title")}</legend>
      {themes.map((theme) => {
        const selected = selectedId === theme.id;
        const ModeIcon = theme.mode === "dark" ? Icons.Moon : Icons.Sun;
        const designedFor = theme.mode && t(designedForKeys[theme.mode], { theme: theme.name });
        const descriptionId = `${name}-${theme.id}-mode`;
        return (
          <label key={theme.id} className="relative min-w-0 cursor-pointer">
            <input
              type="radio"
              name={name}
              value={theme.id}
              checked={selected}
              aria-describedby={designedFor ? descriptionId : undefined}
              onChange={(event) => {
                if (isThemeId(event.target.value)) onChange(event.target.value);
              }}
              className="peer sr-only"
            />
            <div
              className={cn(
                "peer-focus-visible:outline-ring peer-focus-visible:outline-solid overflow-hidden rounded-xl border-2 transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2",
                selected ? "border-primary" : "border-border hover:border-primary/50",
              )}
            >
              <ThemePreview theme={theme} font={currentFont} />
              <span
                className={cn(
                  "relative flex items-center justify-center gap-1.5 py-2 text-sm font-medium",
                  selected ? "bg-primary/10" : "bg-muted/50",
                )}
              >
                {theme.name}
                {designedFor && (
                  <>
                    <ModeIcon aria-hidden="true" className="text-muted-foreground size-3.5" />
                    <span id={descriptionId} className="sr-only">
                      {designedFor}
                    </span>
                  </>
                )}
                {selected && (
                  <span aria-hidden="true" className="bg-primary absolute end-2 rounded-full p-0.5">
                    <Icons.Check className="text-primary-foreground size-3" />
                  </span>
                )}
              </span>
            </div>
          </label>
        );
      })}
    </fieldset>
  );
}
