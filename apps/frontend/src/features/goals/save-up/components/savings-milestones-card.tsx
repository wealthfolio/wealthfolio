import type { SaveUpProjectionPointDTO } from "@/lib/types";
import { AmountDisplay } from "@wealthfolio/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useTranslation } from "react-i18next";

type TFn = ReturnType<typeof useTranslation>["t"];

type ProjectionPoint = SaveUpProjectionPointDTO;

export interface SavingsMilestone {
  ratio: number;
  label: string;
  amount: number;
  dateLabel: string;
  reached: boolean;
  isFinal: boolean;
}

const MILESTONE_RATIOS = [0.25, 0.5, 0.75, 1];

function formatMilestoneDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month) return "-";
  return new Date(year, month - 1, day || 1).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
  });
}

export function buildSavingsMilestones(
  data: ProjectionPoint[],
  targetAmount: number,
  currentValue: number,
  t: TFn,
): SavingsMilestone[] {
  if (targetAmount <= 0 || data.length === 0) return [];
  return MILESTONE_RATIOS.map((ratio) => {
    const amount = targetAmount * ratio;
    const reached = currentValue >= amount;
    const projected = reached ? null : data.find((p) => p.nominal >= amount);
    return {
      ratio,
      label: `${Math.round(ratio * 100)}%`,
      amount,
      dateLabel: reached
        ? t("goals:milestones.reached")
        : projected
          ? formatMilestoneDate(projected.date)
          : t("goals:milestones.not_reached"),
      reached,
      isFinal: ratio === 1,
    };
  });
}

export function SavingsMilestonesCard({
  milestones,
  currentValue,
  currency,
  isHidden,
}: {
  milestones: SavingsMilestone[];
  currentValue: number;
  currency: string;
  isHidden: boolean;
}) {
  const { t } = useTranslation();
  const railPositions = milestones.map((_, i) => (i / (milestones.length - 1)) * 100);
  const railFillPct = computeRailFillPct(milestones, currentValue, railPositions);

  return (
    <Card>
      <CardHeader>
        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-[0.15em]">
          {t("goals:milestones.kicker")}
        </div>
        <CardTitle className="text-md leading-none tracking-tight">
          {t("goals:milestones.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-7">
        {/* ── Desktop: horizontal timeline ── */}
        <div className="hidden md:block">
          {/*
            Layout anchors — rail center and dot center share y=32px.
            Above y=32: % label.
            Below y=32: amount + date.
          */}
          <div className="relative mx-16 h-[108px]">
            <div className="bg-muted absolute left-0 right-0 top-8 h-[3px] -translate-y-1/2 rounded-full" />
            <div
              className="bg-success absolute left-0 top-8 h-[3px] -translate-y-1/2 rounded-full transition-[width] duration-500 ease-out"
              style={{ width: `${railFillPct}%` }}
            />
            {milestones.map((m, i) => {
              const left = `${railPositions[i]}%`;
              return (
                <div key={m.ratio}>
                  <div
                    className={`absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider ${
                      m.reached ? "text-foreground" : "text-muted-foreground"
                    }`}
                    style={{ left }}
                  >
                    {m.label}
                  </div>
                  <div
                    className="absolute top-8 -translate-x-1/2 -translate-y-1/2"
                    style={{ left }}
                  >
                    <MilestoneDot milestone={m} />
                  </div>
                  <div
                    className="absolute top-[52px] flex -translate-x-1/2 flex-col items-center whitespace-nowrap"
                    style={{ left }}
                  >
                    <span className="text-sm font-semibold tabular-nums">
                      <AmountDisplay value={m.amount} currency={currency} isHidden={isHidden} />
                    </span>
                    <span
                      className={`mt-0.5 text-xs ${
                        m.reached ? "text-success" : "text-muted-foreground"
                      }`}
                    >
                      {m.dateLabel}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Mobile: vertical timeline ── */}
        <div className="md:hidden">
          <ol className="relative space-y-4">
            <span className="bg-muted absolute bottom-2 left-[15px] top-2 w-[2px] -translate-x-1/2 rounded-full" />
            <span
              className="bg-success absolute left-[15px] top-2 w-[2px] -translate-x-1/2 rounded-full transition-[height] duration-500 ease-out"
              style={{ height: `calc((100% - 1rem) * ${railFillPct / 100})` }}
            />
            {milestones.map((m) => (
              <li key={m.ratio} className="relative flex items-start gap-4">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center">
                  <MilestoneDot milestone={m} />
                </div>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={`text-xs font-semibold uppercase tracking-wider ${
                        m.reached ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {m.label}
                    </span>
                    <span
                      className={`text-xs ${m.reached ? "text-success" : "text-muted-foreground"}`}
                    >
                      {m.dateLabel}
                    </span>
                  </div>
                  <div className="mt-1 text-sm font-semibold tabular-nums">
                    <AmountDisplay value={m.amount} currency={currency} isHidden={isHidden} />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}

function MilestoneDot({ milestone }: { milestone: SavingsMilestone }) {
  const { reached, isFinal } = milestone;

  if (isFinal) {
    return (
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${
          reached
            ? "border-success bg-success text-success-foreground"
            : "border-muted-foreground/40 bg-background text-muted-foreground"
        }`}
        aria-hidden
      >
        <Icons.Target className="h-3 w-3" />
      </span>
    );
  }

  return (
    <span
      className={`flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors ${
        reached
          ? "border-success bg-success text-success-foreground"
          : "border-muted-foreground/30 bg-background"
      }`}
      aria-hidden
    >
      {reached ? (
        <Icons.Check className="h-3 w-3" strokeWidth={3} />
      ) : (
        <span className="bg-muted-foreground/40 h-1.5 w-1.5 rounded-full" />
      )}
    </span>
  );
}

function computeRailFillPct(
  milestones: SavingsMilestone[],
  currentValue: number,
  railPositions: number[],
): number {
  if (milestones.length === 0 || currentValue <= 0) return 0;
  if (currentValue <= milestones[0].amount) return 0;
  for (let i = 1; i < milestones.length; i++) {
    const prev = milestones[i - 1];
    const curr = milestones[i];
    if (currentValue < curr.amount) {
      const t = (currentValue - prev.amount) / (curr.amount - prev.amount);
      return railPositions[i - 1] + t * (railPositions[i] - railPositions[i - 1]);
    }
  }
  return 100;
}
