import { formatZonedDateKey } from "@/features/spending/lib/timezone";
import { parseLocalDate } from "@/lib/utils";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSettingsContext } from "@/lib/settings-provider";
import type { Goal } from "@/lib/types";
import {
  Badge,
  Card,
  cn,
  useAmountFormatting,
  type FormattingApi,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

type TFn = ReturnType<typeof useTranslation>["t"];

function defaultQuote(goalType: string, t: TFn): string {
  const quotes: Record<string, string> = {
    car: t("goals:card.quote_car"),
    home: t("goals:card.quote_home"),
    education: t("goals:card.quote_education"),
    retirement: t("goals:card.quote_retirement"),
    wedding: t("goals:card.quote_wedding"),
    custom_save_up: t("goals:card.quote_custom_save_up"),
  };
  return quotes[goalType] ?? "";
}

function coverImageSrc(goalType: string): string {
  return `/goals/${goalType}.png`;
}

function formatTimeLeft(t: TFn, targetDate?: string, timezone?: string): string {
  if (!targetDate) return t("goals:card.no_deadline");
  const target = parseLocalDate(targetDate);
  const now = parseLocalDate(formatZonedDateKey(new Date(), timezone));
  if (!Number.isFinite(target.getTime())) return t("goals:card.no_deadline");
  if (target.getTime() <= now.getTime()) return t("goals:card.due");
  let months =
    (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
  if (target.getDate() < now.getDate()) months -= 1;
  if (months < 0) months = 0;
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  if (years === 0) return t("goals:card.months_left", { count: remMonths });
  if (remMonths === 0) return t("goals:card.years_left", { count: years });
  return t("goals:card.years_months_left", { years, months: remMonths });
}

function formatTargetDate(
  targetDate: string | undefined,
  formatting: Pick<FormattingApi, "formatCalendarDate">,
): string | null {
  if (!targetDate) return null;
  const value = targetDate.slice(0, 10);
  const formatted = formatting.formatCalendarDate(value, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return formatted === "-" ? null : formatted;
}

export function ProgressBar({ progress, fillClass }: { progress: number; fillClass: string }) {
  const pct = Math.max(0, Math.min(1, progress));
  return (
    <div className="bg-muted/60 relative h-[0.3125rem] w-full overflow-hidden">
      <div className={cn("h-full", fillClass)} style={{ width: `${pct * 100}%` }} />
      <div className="pointer-events-none absolute inset-0 flex">
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={i} className="border-card flex-1 border-e last:border-e-0" />
        ))}
      </div>
    </div>
  );
}

export function GoalCard({ goal }: { goal: Goal }) {
  const dateFormatting = useDateFormatting();
  const formatting = useAmountFormatting();
  const numberFormatting = useNumberFormatting();
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const { settings } = useSettingsContext();

  const currency = settings?.baseCurrency ?? goal.currency ?? "USD";
  const current = goal.summaryCurrentValue ?? 0;
  const target = goal.summaryTargetAmount ?? goal.targetAmount ?? 0;
  const progress = goal.summaryProgress ?? 0;
  const rawQuote = goal.description?.trim() || defaultQuote(goal.goalType, t) || "";
  const quote = rawQuote.length > 58 ? `${rawQuote.slice(0, 55).trimEnd()}…` : rawQuote;
  const coverImage = coverImageSrc(goal.coverImageKey ?? goal.goalType);

  const isOnTrack = goal.statusHealth === "on_track";
  const isAtRisk = goal.statusHealth === "at_risk";
  const isOffTrack = goal.statusHealth === "off_track";
  const isAchieved = goal.statusLifecycle === "achieved";

  // Health drives the accent color:
  //   positive  → success (green)
  //   at risk   → warning (orange)
  //   negative  → destructive (red)
  //   unknown   → neutral (muted) — e.g. "not_applicable" from the backend
  //               (no target set, no projection yet, brand-new goal)
  const isPositive = isOnTrack || isAchieved;
  const isNegative = isOffTrack;
  const accentClass = isPositive
    ? "text-success"
    : isAtRisk
      ? "text-warning"
      : isNegative
        ? "text-destructive"
        : "text-muted-foreground";
  const progressBarClass = isPositive
    ? "bg-success"
    : isAtRisk
      ? "bg-warning"
      : isNegative
        ? "bg-destructive"
        : "bg-muted-foreground/50";

  // Only render the status badge for attention-worthy states.
  let pill: {
    label: string;
    variant: "success-subtle" | "destructive-subtle" | "warning-subtle";
  } | null = null;
  if (isAchieved) {
    pill = { label: t("goals:card.achieved"), variant: "success-subtle" };
  } else if (isOffTrack) {
    pill = { label: t("goals:card.off_track"), variant: "destructive-subtle" };
  } else if (isAtRisk) {
    pill = { label: t("goals:card.at_risk"), variant: "warning-subtle" };
  }

  const deadline = goal.targetDate ?? goal.projectedCompletionDate;
  const targetDateStr = formatTargetDate(deadline, dateFormatting);
  const timeLeftStr = formatTimeLeft(t, deadline, settings?.timezone);

  const remaining = Math.max(0, target - current);
  const hasRemaining = target > 0 && remaining > 0;

  const currentDisplay = isBalanceHidden ? "••••" : formatting.formatAmount(current, currency);
  const targetDisplay = isBalanceHidden
    ? "••••"
    : target > 0
      ? formatting.formatAmount(target, currency)
      : "—";
  const remainingDisplay = isBalanceHidden
    ? "••••"
    : hasRemaining
      ? formatting.formatCompactAmount(remaining, currency)
      : "—";

  const progressPct = numberFormatting.formatPercent(progress, { digits: 1 });

  return (
    <Link to={`/goals/${goal.id}`} className="group block">
      <Card className="overflow-hidden p-0 transition-shadow hover:shadow-md">
        {/* Top cover image panel */}
        <div className="bg-secondary/50 relative h-24 overflow-hidden">
          <img
            src={coverImage}
            alt=""
            className="h-full w-full object-cover transition-all duration-500 group-hover:scale-[1.06] dark:brightness-[0.78] dark:contrast-[1.08] dark:saturate-[0.9]"
            style={{ objectPosition: "70% 50%" }}
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />

          {/* Dark-mode blend: softens bright image bg against the dark card */}
          <div className="pointer-events-none absolute inset-0 hidden bg-black/30 mix-blend-multiply dark:block" />

          {/* Bottom gradient — quote legibility in both themes */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 via-black/20 via-60% to-transparent" />

          {/* Top-left status badge — only for attention-worthy states */}
          {pill && (
            <Badge variant={pill.variant} className="absolute start-3 top-3">
              {pill.label}
            </Badge>
          )}

          {/* Bottom-left italic quote */}
          {quote && (
            <div className="absolute start-3 end-3 bottom-2.5">
              <span className="line-clamp-1 block text-xs text-white/95 italic drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)]">
                &ldquo;{quote}&rdquo;
              </span>
            </div>
          )}
        </div>

        {/* Bottom panel */}
        <div className="px-4 pt-3 pb-0">
          {/* Title + % */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-base leading-tight font-semibold">{goal.title}</h3>
              <p className="text-muted-foreground mt-0.5 text-sm">
                {targetDateStr ? `${targetDateStr} · ${timeLeftStr}` : timeLeftStr}
              </p>
            </div>
            <div className="text-end">
              <div
                className={cn("text-base font-semibold tabular-nums leading-tight", accentClass)}
              >
                {progressPct}
              </div>
              <div className="text-muted-foreground mt-0.5 text-sm">{t("goals:card.complete")}</div>
            </div>
          </div>

          {/* Amounts row: saved · remaining */}
          <div className="mt-2.5 flex items-end justify-between gap-3">
            <div>
              <div className="text-sm font-semibold tabular-nums">{currentDisplay}</div>
              <div className="text-muted-foreground mt-0.5 text-xs">
                {t("goals:card.saved_of")} <span className="tabular-nums">{targetDisplay}</span>
              </div>
            </div>
            <div className="text-end">
              <div className="text-sm font-semibold tabular-nums">{remainingDisplay}</div>
              <div className="text-muted-foreground mt-0.5 text-xs">
                {hasRemaining ? t("goals:card.remaining") : t("goals:card.target_met")}
              </div>
            </div>
          </div>

          {/* Progress bar */}
          <div className="-mx-4 mt-2.5">
            <ProgressBar progress={progress} fillClass={progressBarClass} />
          </div>
        </div>
      </Card>
    </Link>
  );
}
