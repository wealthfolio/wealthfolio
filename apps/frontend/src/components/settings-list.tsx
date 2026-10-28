import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// One row style for the lists in Settings (accounts, providers, tokens, backups):
// a tile, the name with its badges, one muted line, and the row's controls at the end.

/** A list of rows separated by lines. Put each row in an `<li>`. */
export function SettingsList({
  label,
  className,
  children,
}: {
  /** The list's accessible name, usually its card's title. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        // settings-list: globals.css keeps its rows from clipping their controls below lg.
        "settings-list divide-y [&>li]:py-3 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0",
        className,
      )}
    >
      {children}
    </ul>
  );
}

/** The row's leading tile: a muted square holding an icon, or a logo filling it. */
export function SettingsListMedia({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg [&_img]:size-full [&_img]:object-contain [&>svg]:size-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A row: tile, name and badges, one muted line, extra content, then the controls. */
export function SettingsListRow({
  media,
  title,
  badges,
  meta,
  children,
  actions,
  inactive = false,
}: {
  media: ReactNode;
  title: ReactNode;
  /** Status badges use the status's subtle variant; facts use `secondary`. */
  badges?: ReactNode;
  meta?: ReactNode;
  /** Anything under the meta line, e.g. a provider's capabilities. */
  children?: ReactNode;
  actions?: ReactNode;
  /** Marks the row inactive (a hidden account, an expired token): a faded tile, a muted name. */
  inactive?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* Only the tile fades: the text and badges stay readable. */}
        <div className={cn("shrink-0", inactive && "opacity-60")}>{media}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn(
                "min-w-0 text-sm font-medium break-words",
                inactive && "text-muted-foreground",
              )}
            >
              {title}
            </span>
            {badges}
          </div>
          {meta && <div className="text-muted-foreground mt-0.5 text-xs">{meta}</div>}
          {children}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
