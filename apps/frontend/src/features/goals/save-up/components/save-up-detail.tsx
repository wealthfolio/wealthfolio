import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSettingsContext } from "@/lib/settings-provider";
import type {
  Goal,
  GoalPlan,
  SaveUpOverviewDTO,
  SaveUpPreviewInputDTO,
  SaveUpProjectionPointDTO,
} from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import { AmountDisplay, Button, DatePickerInput, formatCurrencySymbol } from "@wealthfolio/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GoalLeverRow as LeverRow,
  rateSliderMaxFor,
  sliderMaxFor,
} from "../../components/goal-lever-row";
import {
  DEFAULT_RETURN_SLIDER_MAX,
  RATE_SLIDER_INCREMENT,
  highReturnWarning,
} from "../../components/goal-lever-constants";
import { GoalFundingEditor } from "../../components/goal-funding-editor";
import { useGoalPlanMutations, useSaveUpPreview } from "../../hooks/use-goal-detail";
import { useGoalMutations } from "../../hooks/use-goals";
import { SaveUpProjectionCard } from "./save-up-projection-card";
import { buildSavingsMilestones, SavingsMilestonesCard } from "./savings-milestones-card";

type TFn = ReturnType<typeof useTranslation>["t"];

// Keep in sync with crates/core/src/planning/save_up.rs validator limits.
const SAVE_UP_MAX_TARGET_AMOUNT = 1_000_000_000_000;
const SAVE_UP_MAX_MONTHLY_CONTRIBUTION = 1_000_000_000;
const SAVE_UP_MAX_ANNUAL_RETURN = 0.5;

interface SaveUpPlanSettings {
  targetDate?: string;
  targetAmount?: number;
  monthlyContribution?: number;
  /** Legacy field name; read-only fallback for goals saved before the rename. */
  plannedMonthlyContribution?: number;
  expectedAnnualReturn?: number;
}

function parseSaveUpSettings(plan: GoalPlan | null | undefined): SaveUpPlanSettings {
  if (!plan?.settingsJson || plan.planKind !== "save_up") return {};
  try {
    const parsed: unknown = JSON.parse(plan.settingsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const settings = parsed as Record<string, unknown>;
    return {
      targetDate: typeof settings.targetDate === "string" ? settings.targetDate : undefined,
      targetAmount: typeof settings.targetAmount === "number" ? settings.targetAmount : undefined,
      monthlyContribution:
        typeof settings.monthlyContribution === "number" ? settings.monthlyContribution : undefined,
      plannedMonthlyContribution:
        typeof settings.plannedMonthlyContribution === "number"
          ? settings.plannedMonthlyContribution
          : undefined,
      expectedAnnualReturn:
        typeof settings.expectedAnnualReturn === "number"
          ? settings.expectedAnnualReturn
          : undefined,
    };
  } catch {
    return {};
  }
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);

  return debouncedValue;
}

interface Props {
  goal: Goal;
  plan: GoalPlan | null | undefined;
  overview?: SaveUpOverviewDTO;
}

export default function SaveUpDetailPage({ goal, plan, overview }: Props) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const { settings } = useSettingsContext();
  const { savePlanMutation } = useGoalPlanMutations(goal.id);
  const { updateMutation } = useGoalMutations();
  const existingSettings = parseSaveUpSettings(plan);
  const progress = overview?.progress ?? goal.summaryProgress ?? 0;
  const currentValue = overview?.currentValue ?? goal.summaryCurrentValue ?? 0;
  const currency = settings?.baseCurrency ?? goal.currency ?? "USD";
  const moneyPrefix = formatCurrencySymbol(currency);
  const initialTargetAmount = goal.targetAmount ?? 0;
  const initialTargetDate = existingSettings.targetDate ?? goal.targetDate ?? "";
  const initialMonthlyContribution =
    existingSettings.monthlyContribution ?? existingSettings.plannedMonthlyContribution ?? 0;
  const initialAnnualReturn = existingSettings.expectedAnnualReturn ?? 0.05;

  // Editable fields
  const [targetAmount, setTargetAmount] = useState(initialTargetAmount);
  const [targetDate, setTargetDate] = useState(initialTargetDate);
  const [monthlyContribution, setMonthlyContribution] = useState(initialMonthlyContribution);
  const [annualReturn, setAnnualReturn] = useState(initialAnnualReturn);

  const [isEditingPlan, setIsEditingPlan] = useState(false);
  const displayProgress = targetAmount > 0 ? Math.min(currentValue / targetAmount, 1) : progress;
  const remainingNow = Math.max(targetAmount - currentValue, 0);
  const isPlanDirty =
    targetAmount !== initialTargetAmount ||
    targetDate !== initialTargetDate ||
    monthlyContribution !== initialMonthlyContribution ||
    annualReturn !== initialAnnualReturn;
  const persistedPlanKey = JSON.stringify([
    initialTargetAmount,
    initialTargetDate,
    initialMonthlyContribution,
    initialAnnualReturn,
  ]);

  useEffect(() => {
    if (isEditingPlan) return;
    setTargetAmount(initialTargetAmount);
    setTargetDate(initialTargetDate);
    setMonthlyContribution(initialMonthlyContribution);
    setAnnualReturn(initialAnnualReturn);
    // Only sync when persisted values change. Toggling edit mode should not snap drafts back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedPlanKey]);

  const previewInput = useMemo<SaveUpPreviewInputDTO | null>(
    () =>
      isEditingPlan
        ? {
            currentValue,
            targetAmount,
            targetDate: targetDate || null,
            monthlyContribution,
            expectedAnnualReturn: annualReturn,
          }
        : null,
    [annualReturn, currentValue, isEditingPlan, monthlyContribution, targetAmount, targetDate],
  );
  const debouncedPreviewInput = useDebouncedValue(previewInput, 250);
  const previewQuery = useSaveUpPreview(debouncedPreviewInput);
  const previewPending =
    isEditingPlan &&
    (previewInput !== debouncedPreviewInput || previewQuery.isFetching || previewQuery.isLoading);
  const previewUnavailable = isEditingPlan && !!debouncedPreviewInput && previewQuery.isError;
  const projection: SaveUpOverviewDTO | null = isEditingPlan
    ? (previewQuery.data ?? null)
    : (overview ?? null);

  const savePending = savePlanMutation.isPending;
  const actionPending = savePending || previewPending || previewUnavailable;
  const actionPendingLabel = previewUnavailable
    ? t("goals:save_up.preview_failed")
    : previewPending
      ? t("goals:save_up.previewing")
      : t("goals:save_up.saving");

  const chartData: SaveUpProjectionPointDTO[] = useMemo(() => {
    const raw = projection?.trajectory ?? [];
    if (raw.length === 0 || !targetAmount) return [];

    const start = raw[0]?.nominal ?? currentValue;
    const span = Math.max(1, raw.length - 1);
    return raw.map((p, i) => ({
      ...p,
      target: start + (targetAmount - start) * (i / span),
      range: [p.pessimistic, p.optimistic] as [number, number],
    }));
  }, [projection, currentValue, targetAmount]);

  const handleSave = useCallback(() => {
    const settings: SaveUpPlanSettings = {
      targetDate,
      targetAmount,
      monthlyContribution,
      expectedAnnualReturn: annualReturn,
    };

    savePlanMutation.mutate({
      goalId: goal.id,
      planKind: "save_up",
      settingsJson: JSON.stringify(settings),
    });

    const prog = targetAmount > 0 ? Math.min(currentValue / targetAmount, 1) : 0;
    updateMutation.mutate({
      ...goal,
      targetAmount: targetAmount || undefined,
      targetDate: targetDate || undefined,
      summaryCurrentValue: currentValue,
      summaryProgress: prog,
      projectedValueAtTargetDate: projection?.projectedValueAtTargetDate,
      projectedCompletionDate: projection?.projectedCompletionDate ?? undefined,
      statusHealth: projection?.health ?? "not_applicable",
    });

    setIsEditingPlan(false);
  }, [
    goal,
    targetAmount,
    targetDate,
    monthlyContribution,
    annualReturn,
    currentValue,
    projection,
    savePlanMutation,
    updateMutation,
  ]);

  const handleCancelEdit = useCallback(() => {
    setTargetAmount(initialTargetAmount);
    setTargetDate(initialTargetDate);
    setMonthlyContribution(initialMonthlyContribution);
    setAnnualReturn(initialAnnualReturn);
    setIsEditingPlan(false);
  }, [initialTargetAmount, initialTargetDate, initialMonthlyContribution, initialAnnualReturn]);

  const status = getSaveUpStatus(
    {
      goalTitle: goal.title,
      currentValue,
      targetAmount,
      targetDate,
      projection,
    },
    t,
  );
  const projectedGap = projection ? projection.projectedValueAtTargetDate - targetAmount : null;
  const monthlyDifference = projection
    ? projection.requiredMonthlyContribution - monthlyContribution
    : null;
  const monthlyDifferenceLabel =
    monthlyDifference === null || Math.abs(monthlyDifference) < 0.5
      ? t("goals:save_up.monthly_difference")
      : monthlyDifference > 0
        ? t("goals:save_up.monthly_gap")
        : t("goals:save_up.monthly_cushion");
  const monthlyDifferenceClass =
    monthlyDifference === null || Math.abs(monthlyDifference) < 0.5
      ? "text-foreground font-semibold"
      : monthlyDifference > 0
        ? "text-destructive font-semibold"
        : "text-success font-semibold";
  const gapMetricLabel =
    projectedGap === null
      ? t("goals:save_up.remaining")
      : projectedGap >= 0
        ? t("goals:save_up.surplus")
        : t("goals:save_up.gap");
  const gapMetricValue = projectedGap === null ? remainingNow : Math.abs(projectedGap);
  const targetDateLabel = formatGoalDate(targetDate);
  const savingsMilestones = useMemo(
    () => buildSavingsMilestones(chartData, targetAmount, currentValue, t),
    [chartData, targetAmount, currentValue, t],
  );

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      {/* ── Main column ── */}
      <div className="space-y-6 lg:col-span-2">
        {/* Hero card */}
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="p-6">
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${status.badgeClass}`}
                  >
                    {status.label}
                  </span>
                  <span className="text-muted-foreground text-xs font-medium uppercase tracking-[0.15em]">
                    {t("goals:save_up.savings_plan")}
                  </span>
                </div>
                <h2 className="font-serif text-2xl leading-tight tracking-tight">
                  {status.headlinePrefix}{" "}
                  <span className={status.textClass}>{status.headlineEmphasis}</span>
                  {status.headlineSuffix}
                </h2>
                <p className="text-muted-foreground mt-4 max-w-3xl text-sm leading-6">
                  {t("goals:save_up.summary_prefix")}{" "}
                  <AmountDisplay
                    value={monthlyContribution}
                    currency={currency}
                    isHidden={isBalanceHidden}
                    className="text-foreground font-semibold"
                  />
                  {t("goals:save_up.summary_per_month")}{" "}
                  {projection && targetDateLabel && projectedGap !== null ? (
                    projectedGap >= 0 ? (
                      <>
                        {t("goals:save_up.summary_projected_prefix")}{" "}
                        <AmountDisplay
                          value={projectedGap}
                          currency={currency}
                          isHidden={isBalanceHidden}
                          className="text-success font-semibold"
                        />{" "}
                        {t("goals:save_up.summary_above_target", { date: targetDateLabel })}
                      </>
                    ) : (
                      <>
                        {t("goals:save_up.summary_projected_prefix")}{" "}
                        <AmountDisplay
                          value={Math.abs(projectedGap)}
                          currency={currency}
                          isHidden={isBalanceHidden}
                          className="text-destructive font-semibold"
                        />{" "}
                        {t("goals:save_up.summary_short_by", { date: targetDateLabel })}
                      </>
                    )
                  ) : (
                    t("goals:save_up.summary_set_target")
                  )}
                </p>
                <div className="bg-muted mt-5 h-2 overflow-hidden rounded-full">
                  <div
                    className={`h-full rounded-full ${status.progressClass}`}
                    style={{ width: `${Math.min(displayProgress * 100, 100)}%` }}
                  />
                </div>
              </div>
            </div>
            <div className="border-border grid grid-cols-2 divide-x divide-y border-t md:grid-cols-4 md:divide-y-0">
              <HeroMetric label={t("goals:save_up.saved")}>
                <AmountDisplay
                  value={currentValue}
                  currency={currency}
                  isHidden={isBalanceHidden}
                />
              </HeroMetric>
              <HeroMetric label={t("goals:save_up.target")}>
                {targetAmount > 0 ? (
                  <AmountDisplay
                    value={targetAmount}
                    currency={currency}
                    isHidden={isBalanceHidden}
                  />
                ) : (
                  t("goals:save_up.not_set")
                )}
              </HeroMetric>
              <HeroMetric label={gapMetricLabel}>
                <AmountDisplay
                  value={gapMetricValue}
                  currency={currency}
                  isHidden={isBalanceHidden}
                />
              </HeroMetric>
              <HeroMetric label={t("goals:save_up.target_date")}>
                {targetDateLabel ?? t("goals:save_up.not_set")}
              </HeroMetric>
            </div>
          </CardContent>
        </Card>

        {projection && monthlyDifference !== null && (
          <MonthlyPlanCallout
            currentMonthly={monthlyContribution}
            neededMonthly={projection.requiredMonthlyContribution}
            monthlyDifference={monthlyDifference}
            monthlyDifferenceLabel={monthlyDifferenceLabel}
            monthlyDifferenceClass={monthlyDifferenceClass}
            completionDate={projection.projectedCompletionDate}
            currency={currency}
            isHidden={isBalanceHidden}
          />
        )}

        {/* Projection chart */}
        {chartData.length > 2 && (
          <SaveUpProjectionCard
            data={chartData}
            currency={currency}
            isHidden={isBalanceHidden}
            annualReturn={annualReturn}
          />
        )}

        {savingsMilestones.length > 0 && (
          <SavingsMilestonesCard
            milestones={savingsMilestones}
            currentValue={currentValue}
            currency={currency}
            isHidden={isBalanceHidden}
          />
        )}

        {!plan && !projection && (
          <Card>
            <CardContent className="py-10 text-center">
              <p className="text-muted-foreground text-sm">{t("goals:save_up.configure_plan")}</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ── Sidebar ── */}
      <div className="space-y-6 lg:sticky lg:top-6 lg:col-span-1 lg:self-start">
        <SidebarCard
          kicker={t("goals:save_up.plan_kicker")}
          title={t("goals:save_up.savings_inputs")}
          editing={isEditingPlan}
          onEdit={() => setIsEditingPlan(true)}
          onSave={handleSave}
          onCancel={handleCancelEdit}
          dirty={isPlanDirty}
          pending={actionPending}
          pendingLabel={actionPendingLabel}
          readContent={
            <div className="divide-border divide-y">
              <SidebarRow label={t("goals:save_up.field_target_amount")}>
                <AmountDisplay
                  value={targetAmount}
                  currency={currency}
                  isHidden={isBalanceHidden}
                />
              </SidebarRow>
              <SidebarRow label={t("goals:save_up.field_target_date")}>
                {targetDateLabel ?? t("goals:save_up.not_set")}
              </SidebarRow>
              <SidebarRow label={t("goals:save_up.field_monthly_contribution")}>
                <AmountDisplay
                  value={monthlyContribution}
                  currency={currency}
                  isHidden={isBalanceHidden}
                />
                <span className="text-muted-foreground font-normal">
                  {t("goals:save_up.per_month_suffix")}
                </span>
              </SidebarRow>
              <SidebarRow label={t("goals:save_up.field_expected_return")}>
                {(annualReturn * 100).toFixed(1)}%
              </SidebarRow>
            </div>
          }
          editContent={
            <>
              <LeverRow
                label={t("goals:save_up.field_target_amount")}
                hint={t("goals:save_up.hint_target_amount")}
                kind="money"
                value={targetAmount}
                onChange={setTargetAmount}
                min={0}
                max={sliderMaxFor(Math.max(targetAmount, currentValue), 100_000, 25_000)}
                inputMax={SAVE_UP_MAX_TARGET_AMOUNT}
                step={100}
                prefix={moneyPrefix}
                format={(v) => Math.round(v).toLocaleString()}
              />
              <DateRow
                label={t("goals:save_up.field_target_date")}
                hint={t("goals:save_up.hint_target_date")}
                value={targetDate}
                onChange={setTargetDate}
              />
              <LeverRow
                label={t("goals:save_up.field_monthly_contribution")}
                hint={t("goals:save_up.hint_monthly_contribution")}
                kind="money"
                value={monthlyContribution}
                onChange={setMonthlyContribution}
                min={0}
                max={sliderMaxFor(monthlyContribution, 5_000, 500)}
                inputMax={SAVE_UP_MAX_MONTHLY_CONTRIBUTION}
                step={25}
                prefix={moneyPrefix}
                format={(v) => Math.round(v).toLocaleString()}
              />
              <LeverRow
                label={t("goals:save_up.field_expected_annual_return")}
                hint={t("goals:save_up.hint_expected_annual_return")}
                value={annualReturn}
                onChange={setAnnualReturn}
                min={0}
                max={rateSliderMaxFor(
                  annualReturn,
                  DEFAULT_RETURN_SLIDER_MAX,
                  RATE_SLIDER_INCREMENT,
                  SAVE_UP_MAX_ANNUAL_RETURN,
                )}
                inputMax={SAVE_UP_MAX_ANNUAL_RETURN}
                step={0.001}
                suffix="%"
                format={(v) => (v * 100).toFixed(1)}
                warning={highReturnWarning(annualReturn)}
              />
            </>
          }
        />

        {/* Funding */}
        <GoalFundingEditor goalId={goal.id} goalType={goal.goalType} />
      </div>
    </div>
  );
}

// ─── Shared helpers ──────────────────────────────────────────────

interface SaveUpStatus {
  label: string;
  headlinePrefix: string;
  headlineEmphasis: string;
  headlineSuffix: string;
  badgeClass: string;
  textClass: string;
  progressClass: string;
}

function getSaveUpStatus(
  {
    goalTitle,
    currentValue,
    targetAmount,
    targetDate,
    projection,
  }: {
    goalTitle: string;
    currentValue: number;
    targetAmount: number;
    targetDate: string;
    projection: SaveUpOverviewDTO | null;
  },
  t: TFn,
): SaveUpStatus {
  const dateLabel = formatGoalDate(targetDate) ?? t("goals:save_up.your_target_date");

  if (!targetAmount || !targetDate) {
    return {
      label: t("goals:save_up.status_setup_needed"),
      headlinePrefix: t("goals:save_up.headline_setup_prefix"),
      headlineEmphasis: t("goals:save_up.headline_setup_emphasis"),
      headlineSuffix: t("goals:save_up.headline_setup_suffix", { title: goalTitle }),
      badgeClass: "bg-muted text-muted-foreground",
      textClass: "text-muted-foreground",
      progressClass: "bg-muted-foreground/40",
    };
  }

  if (currentValue >= targetAmount) {
    return {
      label: t("goals:save_up.status_reached"),
      headlinePrefix: t("goals:save_up.headline_reached_prefix"),
      headlineEmphasis: t("goals:save_up.headline_reached_emphasis"),
      headlineSuffix: t("goals:save_up.headline_reached_suffix", { title: goalTitle }),
      badgeClass: "bg-success text-success-foreground",
      textClass: "text-success",
      progressClass: "bg-success",
    };
  }

  if (projection?.health === "on_track") {
    return {
      label: t("goals:save_up.status_on_track"),
      headlinePrefix: t("goals:save_up.headline_on_track_prefix"),
      headlineEmphasis: t("goals:save_up.headline_on_track_emphasis"),
      headlineSuffix: t("goals:save_up.headline_on_track_suffix", {
        title: goalTitle,
        date: dateLabel,
      }),
      badgeClass: "bg-success text-success-foreground",
      textClass: "text-success",
      progressClass: "bg-success",
    };
  }

  if (projection?.health === "at_risk") {
    return {
      label: t("goals:save_up.status_at_risk"),
      headlinePrefix: t("goals:save_up.headline_at_risk_prefix", { title: goalTitle }),
      headlineEmphasis: t("goals:save_up.headline_at_risk_emphasis"),
      headlineSuffix: t("goals:save_up.headline_at_risk_suffix", { date: dateLabel }),
      badgeClass: "bg-yellow-100 text-yellow-800",
      textClass: "text-yellow-700",
      progressClass: "bg-yellow-600",
    };
  }

  return {
    label: t("goals:save_up.status_off_track"),
    headlinePrefix: t("goals:save_up.headline_off_track_prefix"),
    headlineEmphasis: t("goals:save_up.headline_off_track_emphasis"),
    headlineSuffix: t("goals:save_up.headline_off_track_suffix", {
      title: goalTitle,
      date: dateLabel,
    }),
    badgeClass: "bg-destructive text-destructive-foreground",
    textClass: "text-destructive",
    progressClass: "bg-destructive",
  };
}

function formatGoalDate(value?: string | null) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month) return null;
  return new Date(year, month - 1, day || 1).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
  });
}

function HeroMetric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
        {label}
      </div>
      <div className="mt-2 truncate text-lg font-semibold tabular-nums">{children}</div>
    </div>
  );
}

function MonthlyPlanCallout({
  currentMonthly,
  neededMonthly,
  monthlyDifference,
  monthlyDifferenceLabel,
  monthlyDifferenceClass,
  completionDate,
  currency,
  isHidden,
}: {
  currentMonthly: number;
  neededMonthly: number;
  monthlyDifference: number;
  monthlyDifferenceLabel: string;
  monthlyDifferenceClass: string;
  completionDate: string | null;
  currency: string;
  isHidden: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-[0.15em]">
              {t("goals:save_up.action")}
            </div>
            <h3 className="text-md font-semibold leading-none tracking-tight">
              {t("goals:save_up.monthly_plan")}
            </h3>
          </div>

          <div className="grid flex-1 grid-cols-2 gap-3 md:max-w-3xl md:grid-cols-4">
            <CalloutMetric label={t("goals:save_up.current")}>
              <AmountDisplay value={currentMonthly} currency={currency} isHidden={isHidden} />
              <span className="text-muted-foreground font-normal">
                {t("goals:save_up.per_month_suffix")}
              </span>
            </CalloutMetric>
            <CalloutMetric label={t("goals:save_up.needed")}>
              <AmountDisplay value={neededMonthly} currency={currency} isHidden={isHidden} />
              <span className="text-muted-foreground font-normal">
                {t("goals:save_up.per_month_suffix")}
              </span>
            </CalloutMetric>
            <CalloutMetric label={monthlyDifferenceLabel}>
              <AmountDisplay
                value={Math.abs(monthlyDifference)}
                currency={currency}
                isHidden={isHidden}
                className={monthlyDifferenceClass}
              />
              <span className="text-muted-foreground font-normal">
                {t("goals:save_up.per_month_suffix")}
              </span>
            </CalloutMetric>
            <CalloutMetric label={t("goals:save_up.finish")}>
              {formatGoalDate(completionDate) ?? t("goals:save_up.not_reached")}
            </CalloutMetric>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CalloutMetric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-border/70 bg-muted/20 rounded-lg border px-3 py-2.5">
      <div className="text-muted-foreground text-[11px]">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums">{children}</div>
    </div>
  );
}

function SidebarRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{children}</span>
    </div>
  );
}

function SidebarCard({
  kicker,
  title,
  editing,
  onEdit,
  onSave,
  onCancel,
  dirty,
  pending,
  pendingLabel,
  readContent,
  editContent,
}: {
  kicker: string;
  title: string;
  editing: boolean;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  dirty: boolean;
  pending: boolean;
  pendingLabel?: string;
  readContent: React.ReactNode;
  editContent: React.ReactNode;
}) {
  const { t } = useTranslation();
  const renderEditActions = () => (
    <div className="flex items-center justify-end gap-1.5">
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
        {t("common:cancel")}
      </Button>
      <Button size="sm" className="h-7 text-xs" onClick={onSave} disabled={!dirty || pending}>
        {pending ? (pendingLabel ?? t("goals:save_up.saving")) : t("common:save")}
      </Button>
    </div>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between pb-4">
        <div className="min-w-0">
          <div className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-[0.15em]">
            {kicker}
          </div>
          <CardTitle className="text-md leading-none tracking-tight">{title}</CardTitle>
        </div>
        {editing ? (
          renderEditActions()
        ) : (
          <button
            type="button"
            onClick={onEdit}
            aria-label={t("goals:save_up.edit_aria", { title })}
            className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1.5 text-sm transition-colors"
          >
            <Icons.Pencil className="h-3.5 w-3.5" />
            {t("common:edit")}
          </button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <div className="space-y-3">
            <div className="divide-border divide-y">{editContent}</div>
            <div className="border-border flex justify-end border-t pt-3">
              {renderEditActions()}
            </div>
          </div>
        ) : (
          readContent
        )}
      </CardContent>
    </Card>
  );
}

function DateRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="py-4 first:pt-1 last:pb-1">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <div className="text-foreground text-sm font-semibold leading-tight">{label}</div>
          <div className="text-muted-foreground mt-1 text-xs leading-tight">{hint}</div>
        </div>
      </div>
      <DatePickerInput
        value={value || undefined}
        onChange={(date) => onChange(date ? formatDateISO(date) : "")}
      />
    </div>
  );
}
