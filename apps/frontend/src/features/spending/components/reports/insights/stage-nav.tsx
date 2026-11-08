import { useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useEffectOnChange } from "@/hooks/use-effect-on-change";
import { cn } from "@/lib/utils";

export type InsightsStage = "where" | "changed" | "when";

interface StageNavProps {
  stage: InsightsStage;
  onStageChange: (s: InsightsStage) => void;
  actions?: ReactNode;
}

export function StageNav({ stage, onStageChange, actions }: StageNavProps) {
  const { t } = useTranslation();
  const STAGES = useMemo<{ id: InsightsStage; label: string }[]>(
    () => [
      { id: "where", label: t("spending:insights.stageWhere") },
      { id: "changed", label: t("spending:insights.stageChanged") },
      { id: "when", label: t("spending:insights.stageWhen") },
    ],
    [t],
  );
  const activeRef = useRef<HTMLButtonElement | null>(null);
  // When the URL deep-links to a stage on mount or `stage` changes
  // (e.g. via the dashboard "Where I am" link), scroll the active chip
  // into view so it isn't off-screen on a 375px column. Not when a phone
  // screen is shown again: the page keeps the scroll it was left with.
  useEffectOnChange(() => {
    activeRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [stage]);

  return (
    <div className="border-border/60 bg-card/40 @container rounded-2xl border p-1 backdrop-blur-xl">
      <div className="flex flex-col gap-1 @min-[40rem]:flex-row @min-[40rem]:items-center @min-[40rem]:gap-3">
        <nav
          aria-label={t("spending:insights.stagesLabel")}
          className="flex min-w-0 items-center gap-1 overflow-x-auto @min-[40rem]:flex-1"
        >
          {STAGES.map((s) => {
            const active = stage === s.id;
            return (
              <button
                key={s.id}
                type="button"
                ref={active ? activeRef : undefined}
                onClick={() => onStageChange(s.id)}
                className={cn(
                  "group inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 py-2.5 text-xs transition-colors",
                  "focus-visible:outline-ring focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2",
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                )}
                aria-current={active ? "step" : undefined}
              >
                <span className="font-medium">{s.label}</span>
              </button>
            );
          })}
        </nav>
        {actions && (
          <div className="flex min-w-0 justify-end px-1 @min-[40rem]:max-w-1/2">{actions}</div>
        )}
      </div>
    </div>
  );
}
