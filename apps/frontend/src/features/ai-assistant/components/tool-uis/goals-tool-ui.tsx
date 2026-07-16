import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Progress,
  Skeleton,
} from "@wealthfolio/ui";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useSettingsContext } from "@/lib/settings-provider";
import { CompactToolCard } from "./shared";

// ============================================================================
// Types
// ============================================================================

interface GetGoalsArgs {
  displayMode?: "compact" | "full";
}

interface GoalDto {
  id: string;
  title: string;
  description?: string | null;
  targetAmount: number;
  currentAmount: number;
  progressPercent: number;
  deadline?: string | null;
  isAchieved: boolean;
}

interface GetGoalsResult {
  goals: GoalDto[];
  count: number;
  totalTarget: number;
  totalCurrent: number;
  achievedCount: number;
  truncated?: boolean;
  originalCount?: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Safely converts an unknown value to a string.
 * Returns the fallback if the value is null, undefined, or not a primitive.
 */
function safeString(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/**
 * Normalizes the result to handle both wrapped and unwrapped formats,
 * as well as snake_case vs camelCase field names.
 */
function normalizeResult(result: unknown): GetGoalsResult | null {
  if (!result) {
    return null;
  }

  // Handle string (JSON) format
  if (typeof result === "string") {
    try {
      return normalizeResult(JSON.parse(result));
    } catch {
      return null;
    }
  }

  if (typeof result !== "object" || result === null) {
    return null;
  }

  const candidate = result as Record<string, unknown>;

  // Handle wrapped format: { data: { goals: [...] }, meta: {...} }
  if ("data" in candidate && typeof candidate.data === "object" && candidate.data !== null) {
    const data = candidate.data as Record<string, unknown>;
    if (Array.isArray(data.goals)) {
      return normalizeGoalsResult(data);
    }
  }

  // Handle direct format: { goals: [...], count: ... }
  if (Array.isArray(candidate.goals)) {
    return normalizeGoalsResult(candidate);
  }

  return null;
}

/**
 * Normalizes a candidate object with goals array to GetGoalsResult.
 */
function normalizeGoalsResult(candidate: Record<string, unknown>): GetGoalsResult {
  const goalsRaw = candidate.goals as unknown[];

  const goals: GoalDto[] = goalsRaw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      id: safeString(item.id ?? item.Id, ""),
      title: safeString(item.title ?? item.Title, ""),
      description:
        (item.description as string | undefined) ??
        (item.Description as string | undefined) ??
        null,
      targetAmount: Number(item.targetAmount ?? item.target_amount ?? item.TargetAmount ?? 0),
      currentAmount: Number(item.currentAmount ?? item.current_amount ?? item.CurrentAmount ?? 0),
      progressPercent: Number(
        item.progressPercent ?? item.progress_percent ?? item.ProgressPercent ?? 0,
      ),
      deadline:
        (item.deadline as string | undefined) ?? (item.Deadline as string | undefined) ?? null,
      isAchieved: Boolean(item.isAchieved ?? item.is_achieved ?? item.IsAchieved ?? false),
    }));

  return {
    goals,
    count: typeof candidate.count === "number" ? candidate.count : goals.length,
    totalTarget: Number(
      candidate.totalTarget ?? candidate.total_target ?? candidate.TotalTarget ?? 0,
    ),
    totalCurrent: Number(
      candidate.totalCurrent ?? candidate.total_current ?? candidate.TotalCurrent ?? 0,
    ),
    achievedCount: Number(
      candidate.achievedCount ?? candidate.achieved_count ?? candidate.AchievedCount ?? 0,
    ),
    truncated: candidate.truncated === true,
    originalCount:
      typeof candidate.originalCount === "number"
        ? candidate.originalCount
        : typeof candidate.original_count === "number"
          ? candidate.original_count
          : undefined,
  };
}

/**
 * Determines the progress color based on how close the current amount is to the target.
 * Green if on track (>= 80% of expected progress), yellow if behind (50-80%), red if far behind (<50%).
 * If deadline is not available, we only use the raw progress percent.
 */
function getProgressColor(progressPercent: number, deadline?: string | null): string {
  // If there's a deadline, calculate expected progress
  if (deadline) {
    const now = new Date();
    const deadlineDate = new Date(deadline);
    const startDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()); // Assume 1 year goal if no start date

    const totalDuration = deadlineDate.getTime() - startDate.getTime();
    const elapsed = now.getTime() - startDate.getTime();

    if (totalDuration > 0 && elapsed > 0) {
      const expectedProgress = Math.min((elapsed / totalDuration) * 100, 100);
      const progressRatio = progressPercent / expectedProgress;

      if (progressRatio >= 0.8) {
        return "bg-success"; // Green - on track
      } else if (progressRatio >= 0.5) {
        return "bg-warning"; // Yellow - behind
      } else {
        return "bg-destructive"; // Red - far behind
      }
    }
  }

  // Without deadline, use simple thresholds based on progress
  if (progressPercent >= 75) {
    return "bg-success";
  } else if (progressPercent >= 40) {
    return "bg-warning";
  } else if (progressPercent > 0) {
    return "bg-primary";
  }
  return "bg-muted-foreground/30";
}

/**
 * Formats a date string for display.
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return dateStr;
  }
}

// ============================================================================
// Components
// ============================================================================

function GoalsLoadingSkeleton() {
  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-16" />
        </div>
      </CardHeader>
      <CardContent className="max-h-[320px] space-y-3 overflow-y-auto">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="bg-background/60 flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-2 w-full" />
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function GoalCard({
  goal,
  formatter,
  isBalanceHidden,
}: {
  goal: GoalDto;
  formatter: Intl.NumberFormat;
  isBalanceHidden: boolean;
}) {
  const { t } = useTranslation();
  const progressColor = getProgressColor(goal.progressPercent, goal.deadline);

  const formatValue = (value: number) => {
    if (isBalanceHidden) {
      return "******";
    }
    return formatter.format(value);
  };

  return (
    <div className="bg-background/60 hover:bg-background/80 flex flex-col gap-2 rounded-lg border p-3 transition-colors">
      {/* Header: Title and Status */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {goal.isAchieved ? (
            <Icons.CheckCircle className="text-success h-4 w-4 flex-shrink-0" />
          ) : (
            <Icons.Target className="text-muted-foreground h-4 w-4 flex-shrink-0" />
          )}
          <span className="text-sm font-medium leading-tight">
            {goal.title || t("ai:goals.untitled")}
          </span>
        </div>
        <Badge
          variant={goal.isAchieved ? "default" : "secondary"}
          className={cn("text-xs", goal.isAchieved && "bg-success text-success-foreground")}
        >
          {goal.progressPercent.toFixed(0)}%
        </Badge>
      </div>

      {/* Progress Bar */}
      <div className="relative">
        <Progress value={Math.min(goal.progressPercent, 100)} className="h-2" />
        {/* Colored overlay for the progress indicator */}
        <div
          className={cn("absolute inset-y-0 left-0 h-2 rounded-full transition-all", progressColor)}
          style={{ width: `${Math.min(goal.progressPercent, 100)}%` }}
        />
      </div>

      {/* Details: Current/Target and Deadline */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {formatValue(goal.currentAmount)} / {formatValue(goal.targetAmount)}
        </span>
        {goal.deadline && (
          <span className="text-muted-foreground flex items-center gap-1">
            <Icons.Calendar className="h-3 w-3" />
            {formatDate(goal.deadline)}
          </span>
        )}
      </div>

      {/* Description if available */}
      {goal.description && (
        <p className="text-muted-foreground line-clamp-2 text-xs">{goal.description}</p>
      )}
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardContent className="flex flex-col items-center justify-center py-8 text-center">
        <Icons.Target className="text-muted-foreground mb-2 h-8 w-8" />
        <p className="text-muted-foreground text-sm">{t("ai:goals.empty")}</p>
        <p className="text-muted-foreground mt-1 text-xs">{t("ai:goals.emptyHint")}</p>
      </CardContent>
    </Card>
  );
}

function ErrorState({ message }: { message?: string }) {
  const { t } = useTranslation();
  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardContent className="py-4">
        <p className="text-destructive text-sm font-medium">{t("ai:goals.error")}</p>
        {message && <p className="text-muted-foreground mt-1 text-xs">{message}</p>}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Component
// ============================================================================

type GoalsToolUIContentProps = ToolCallMessagePartProps<GetGoalsArgs, GetGoalsResult>;

function GoalsToolUIContentImpl({ args, result, status }: GoalsToolUIContentProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const { isBalanceHidden } = useBalancePrivacy();
  const parsed = useMemo(() => normalizeResult(result), [result]);

  const isLoading = status?.type === "running";
  const isIncomplete = status?.type === "incomplete";

  // Compact mode — just show a one-liner when used as a prerequisite
  if (args?.displayMode === "compact" && parsed && !isLoading) {
    return <CompactToolCard label={t("ai:goals.fetched", { count: parsed.goals.length })} />;
  }

  // Currency formatter - default to base currency
  const formatter = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: baseCurrency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }),
    [baseCurrency],
  );

  // Show loading skeleton while running
  if (isLoading) {
    return <GoalsLoadingSkeleton />;
  }

  // Show error state for incomplete/failed status
  if (isIncomplete) {
    return <ErrorState message={t("ai:performance.interrupted")} />;
  }

  // Show empty state if no goals
  if (!parsed || parsed.goals.length === 0) {
    return <EmptyState />;
  }

  const { goals, count, achievedCount, truncated, originalCount } = parsed;

  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{t("ai:goals.title")}</CardTitle>
            <Badge variant="secondary" className="text-xs">
              {t("ai:goals.count", { count })}
            </Badge>
            {truncated && originalCount && (
              <Badge variant="outline" className="text-muted-foreground text-xs">
                {t("ai:goals.of", { count: originalCount })}
              </Badge>
            )}
          </div>
          {achievedCount > 0 && (
            <Badge variant="default" className="bg-success text-success-foreground text-xs">
              {t("ai:goals.achieved", { count: achievedCount })}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="max-h-[320px] space-y-3 overflow-y-auto">
        {goals.map((goal) => (
          <GoalCard
            key={goal.id}
            goal={goal}
            formatter={formatter}
            isBalanceHidden={isBalanceHidden}
          />
        ))}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Export
// ============================================================================

const GoalsToolUIContent = memo(GoalsToolUIContentImpl);

export const GoalsToolUI = makeAssistantToolUI<GetGoalsArgs, GetGoalsResult>({
  toolName: "get_goals",
  render: (props) => {
    return <GoalsToolUIContent {...props} />;
  },
});
