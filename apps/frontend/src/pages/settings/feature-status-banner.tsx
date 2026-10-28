import type { ReactNode } from "react";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { cn } from "@/lib/utils";

interface FeatureStatusBannerProps {
  /** The banner's accessible name. */
  label: string;
  /** Whether the feature is on; drives the status dot. */
  active: boolean;
  /** The status line, e.g. "Tracking active". */
  status: string;
  /** A detail after the status line, shown from the small breakpoint up. */
  statusDetail?: string;
  /** What the feature is doing now. */
  headline: string;
  /** A smaller line under the headline, e.g. what turning it off does. */
  note?: ReactNode;
  /** Hides the note on phones, where the banner should stay short. */
  noteHiddenOnPhone?: boolean;
  /** The feature's on/off switch, when it can be switched here. */
  toggle?: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    /** The switch's accessible name. */
    label: string;
    /** The word beside the switch, e.g. "Enabled". */
    stateLabel: string;
  };
  /** Facts or prompts under the note. */
  children?: ReactNode;
}

/**
 * The banner at the top of a settings page that turns a whole feature on or off.
 * It stands out on the theme's text colour, the strongest contrast every theme
 * has; its secondary text stays at 75% so it keeps 4.5:1 in all of them. The
 * switch inverts the same way, so it stays visible on that surface.
 */
export function FeatureStatusBanner({
  label,
  active,
  status,
  statusDetail,
  headline,
  note,
  noteHiddenOnPhone = false,
  toggle,
  children,
}: FeatureStatusBannerProps) {
  return (
    <section
      aria-label={label}
      className="bg-foreground text-background relative overflow-hidden rounded-lg shadow-lg"
    >
      <div className="p-5 sm:px-7 sm:py-6">
        {/* Status and switch share the top row, so the headline gets the full width on phones. */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
            <span className="relative flex h-2 w-2 shrink-0">
              <span
                className={cn(
                  "absolute inline-flex h-full w-full rounded-full opacity-60",
                  active ? "bg-success animate-ping" : "bg-background/40",
                )}
              />
              <span
                className={cn(
                  "relative inline-flex h-2 w-2 rounded-full",
                  active ? "bg-success" : "bg-background/40",
                )}
              />
            </span>
            <span className="truncate">{status}</span>
            {statusDetail && (
              <span className="text-background/75 hidden truncate sm:inline">· {statusDetail}</span>
            )}
          </div>

          {toggle && (
            <label className="flex shrink-0 cursor-pointer items-center gap-2 select-none">
              <span className="text-background/75 hidden text-xs font-medium sm:inline">
                {toggle.stateLabel}
              </span>
              <Switch
                aria-label={toggle.label}
                checked={toggle.checked}
                onCheckedChange={toggle.onCheckedChange}
                disabled={toggle.disabled}
                className="focus-visible:outline-background data-checked:bg-background data-unchecked:bg-background/25 [&_[data-slot=switch-thumb]]:data-checked:bg-foreground [&_[data-slot=switch-thumb]]:data-unchecked:bg-background"
              />
            </label>
          )}
        </div>

        <div className="mt-4 text-sm font-medium tracking-tight sm:text-base">{headline}</div>
        {note && (
          <div
            className={cn(
              "text-background/75 mt-2 text-xs",
              noteHiddenOnPhone && "hidden sm:block",
            )}
          >
            {note}
          </div>
        )}

        {children}
      </div>
    </section>
  );
}
