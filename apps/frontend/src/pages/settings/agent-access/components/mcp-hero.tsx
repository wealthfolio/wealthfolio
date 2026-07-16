import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** Shared "hero" banner for AI Agent Access, used on both desktop and web. */
export function McpHero({
  active,
  title,
  description,
  hint,
  action,
}: {
  /** Whether the feature is on (drives the status dot + pulse). */
  active: boolean;
  /** Status line, e.g. "AI Agent Access · off". */
  title: string;
  /** Primary sentence. */
  description: string;
  /** Optional secondary line (e.g. how to enable). */
  hint?: ReactNode;
  /** Optional right-slot control (the enable toggle on desktop). */
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("settings:agentAccess.hero_aria")}
      className="bg-foreground text-background relative overflow-hidden rounded-lg shadow-lg"
    >
      <div className="p-5 sm:px-7 sm:py-6">
        <div className="flex items-center justify-between gap-3">
          <div className="text-background/60 flex min-w-0 items-center gap-2 text-xs font-medium uppercase tracking-widest">
            <span className="relative flex h-2 w-2 shrink-0">
              <span
                className={cn(
                  "absolute inline-flex h-full w-full rounded-full opacity-60",
                  active ? "animate-ping bg-green-300" : "bg-background/40",
                )}
              />
              <span
                className={cn(
                  "relative inline-flex h-2 w-2 rounded-full",
                  active ? "bg-green-300" : "bg-background/40",
                )}
              />
            </span>
            <span className="text-background truncate font-medium">{title}</span>
          </div>
          {action}
        </div>

        <div className="mt-4 text-sm font-medium tracking-tight sm:text-base">{description}</div>
        {hint && <div className="text-background/50 mt-2 text-xs">{hint}</div>}
      </div>
    </section>
  );
}
