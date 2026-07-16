import type { RetirementOverview } from "@/lib/types";
import { GoalFundingEditor } from "@/features/goals/components/goal-funding-editor";
import {
  GoalLeverRow as LeverRow,
  rateSliderMaxFor,
  sliderMaxFor,
} from "@/features/goals/components/goal-lever-row";
import {
  DEFAULT_RETURN_SLIDER_MAX,
  RATE_SLIDER_INCREMENT,
  highReturnWarning,
} from "@/features/goals/components/goal-lever-constants";
import {
  AnimatedToggleGroup,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  formatAmount,
  formatCurrencySymbol,
  formatPercent,
  Input,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { DEFAULT_DC_PAYOUT_ESTIMATE_RATE } from "../lib/constants";
import { incomeStreamMonthlyAmount, modeLabel, type PlannerMode } from "../lib/dashboard-math";
import {
  createExpenseItem,
  expenseAgeRangeLabel,
  expenseItems,
  totalMonthlyExpenseAtAge,
} from "../lib/expense-items";
import {
  ageFromBirthYearMonth,
  inferBirthYearMonthFromAge,
  normalizeDashboardRetirementPlan,
} from "../lib/plan-adapter";
import type {
  ExpenseItem,
  InvestmentAssumptions,
  RetirementIncomeStream,
  RetirementPlan,
  TaxProfile,
} from "../types";

const DEFAULT_INFLATION_SLIDER_MAX = 0.06;
const DEFAULT_FEE_SLIDER_MAX = 0.03;
const DEFAULT_VOLATILITY_SLIDER_MAX = 0.5;
const DEFAULT_CONTRIBUTION_GROWTH_SLIDER_MAX = 0.1;
// Keep hard caps in sync with validate_retirement_plan in crates/core/src/goals/goals_service.rs.
const MAX_RETIREMENT_RETURN = 0.5;
const MAX_RETIREMENT_INFLATION = 0.2;
const MAX_RETIREMENT_FEE = 0.1;
const MAX_RETIREMENT_VOLATILITY = 1;
const MAX_RETIREMENT_CONTRIBUTION_GROWTH = 0.25;
const MAX_RETIREMENT_INCOME_GROWTH = 0.2;
const FEE_SLIDER_INCREMENT = 0.01;
const VOLATILITY_SLIDER_INCREMENT = 0.1;
const CONTRIBUTION_GROWTH_SLIDER_INCREMENT = 0.05;
const HIGH_INFLATION_WARNING_THRESHOLD = DEFAULT_INFLATION_SLIDER_MAX;
const HIGH_FEE_WARNING_THRESHOLD = DEFAULT_FEE_SLIDER_MAX;
const HIGH_VOLATILITY_WARNING_THRESHOLD = DEFAULT_VOLATILITY_SLIDER_MAX;
const HIGH_CONTRIBUTION_GROWTH_WARNING_THRESHOLD = DEFAULT_CONTRIBUTION_GROWTH_SLIDER_MAX;

/** Read-only label:value row */
function InfoLabel({ label, children }: { label: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground/70 hover:text-foreground inline-flex rounded-full transition-colors"
            aria-label={t("goals:sidebar.more_info_about", { label })}
          >
            <Icons.Info className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">{children}</TooltipContent>
      </Tooltip>
    </span>
  );
}

function ConfigRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-2.5 first:pt-1 last:pb-1">
      <span className="text-foreground/85 text-sm">{label}</span>
      <span className="text-right text-sm font-semibold tabular-nums">{children}</span>
    </div>
  );
}

/** Sidebar monthly row: name + age-range meta on the left, big amount + /mo on the right. */
function SidebarMonthlyRow({
  label,
  meta,
  amount,
  currency,
}: {
  label: string;
  meta?: string;
  amount: number;
  currency: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
      <div className="min-w-0">
        <div className="text-foreground text-sm font-semibold leading-tight">{label}</div>
        {meta && <div className="text-muted-foreground mt-0.5 text-xs leading-tight">{meta}</div>}
      </div>
      <div className="whitespace-nowrap tabular-nums">
        <span className="text-foreground text-sm font-semibold">
          {formatAmount(amount, currency)}
        </span>
        <span className="text-muted-foreground text-xs">/mo</span>
      </div>
    </div>
  );
}

/** Sidebar totals row: uppercase tracked label on the left, amount + /mo on the right. */
function SidebarTotalRow({ amount, currency }: { amount: number; currency: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <span className="text-muted-foreground text-xs uppercase tracking-[0.15em]">
        {t("common:total")}
      </span>
      <div className="whitespace-nowrap tabular-nums">
        <span className="text-foreground text-sm font-semibold">
          {formatAmount(amount, currency)}
        </span>
        <span className="text-muted-foreground text-xs">/mo</span>
      </div>
    </div>
  );
}

function pctOfTotal(value: number, total: number) {
  return total > 0 ? ((value / total) * 100).toFixed(0) + "%" : "0%";
}

function highInflationWarning(value: number, t: TFunction) {
  return value > HIGH_INFLATION_WARNING_THRESHOLD
    ? t("goals:sidebar.warnings.high_inflation")
    : undefined;
}

function highFeeWarning(value: number, t: TFunction) {
  return value > HIGH_FEE_WARNING_THRESHOLD ? t("goals:sidebar.warnings.high_fee") : undefined;
}

function highVolatilityWarning(value: number, t: TFunction) {
  return value > HIGH_VOLATILITY_WARNING_THRESHOLD
    ? t("goals:sidebar.warnings.high_volatility")
    : undefined;
}

function highContributionGrowthWarning(value: number, t: TFunction) {
  return value > HIGH_CONTRIBUTION_GROWTH_WARNING_THRESHOLD
    ? t("goals:sidebar.warnings.high_contribution_growth")
    : undefined;
}

function AgeBoundInput({
  label,
  value,
  onChange,
  placeholder,
  min,
  max,
}: {
  label: string;
  value?: number;
  onChange: (value: number | undefined) => void;
  placeholder: string;
  min: number;
  max: number;
}) {
  const [draftValue, setDraftValue] = useState<string | null>(null);
  const displayValue = draftValue ?? (value === undefined ? "" : String(value));

  const commitDraftValue = () => {
    const raw = displayValue.trim();
    if (!raw) {
      onChange(undefined);
      setDraftValue(null);
      return;
    }

    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      setDraftValue(null);
      return;
    }

    const next = Math.min(max, Math.max(min, parsed));
    onChange(next);
    setDraftValue(null);
  };

  return (
    <label className="block space-y-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={displayValue}
        placeholder={placeholder}
        onFocus={() => {
          setDraftValue(value === undefined ? "" : String(value));
        }}
        onChange={(e) => {
          const next = e.target.value;
          if (/^\d*$/.test(next)) {
            setDraftValue(next);
          }
        }}
        onBlur={() => {
          commitDraftValue();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setDraftValue(null);
          }
        }}
        className="bg-muted/70 text-foreground h-8 w-full rounded-md border px-2.5 text-right text-sm tabular-nums outline-none placeholder:text-left placeholder:text-xs"
      />
    </label>
  );
}

function PercentOverrideInput({
  value,
  placeholder,
  max,
  onChange,
}: {
  value?: number;
  placeholder: string;
  max: number;
  onChange: (value: number | undefined) => void;
}) {
  const formatDraft = useCallback(
    (next?: number) => (next === undefined ? "" : (next * 100).toFixed(1)),
    [],
  );
  const [draft, setDraft] = useState<string | null>(null);
  const displayValue = draft ?? formatDraft(value);

  return (
    <div className="bg-muted/70 flex h-8 w-full items-center gap-1 rounded-md border px-2.5">
      <input
        type="text"
        inputMode="decimal"
        value={displayValue}
        placeholder={placeholder}
        onFocus={() => setDraft(formatDraft(value))}
        onBlur={() => {
          setDraft(null);
        }}
        onChange={(e) => {
          const raw = e.target.value.replace(/,/g, "");
          setDraft(raw);
          if (!raw.trim()) {
            onChange(undefined);
            return;
          }
          const parsed = parseFloat(raw);
          if (!Number.isNaN(parsed)) {
            onChange(Math.min(max * 100, Math.max(0, parsed)) / 100);
          }
        }}
        className="text-foreground min-w-0 flex-1 bg-transparent text-right text-sm tabular-nums outline-none placeholder:text-left placeholder:text-xs"
      />
      <span className="text-muted-foreground text-xs tabular-nums">%</span>
    </div>
  );
}

/** A single sidebar card: title + edit button → read rows or edit fields */
function SidebarCard({
  kicker,
  title,
  editing,
  onEdit,
  onSave,
  onCancel,
  dirty,
  readContent,
  editContent,
}: {
  kicker?: string;
  title: string;
  editing: boolean;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  dirty: boolean;
  readContent: React.ReactNode;
  editContent: React.ReactNode;
}) {
  const { t } = useTranslation();
  const renderEditActions = () => (
    <div className="flex items-center justify-end gap-1.5">
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
        {t("common:cancel")}
      </Button>
      <Button size="sm" className="h-7 text-xs" onClick={onSave} disabled={!dirty}>
        {t("common:save")}
      </Button>
    </div>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between pb-4">
        <div className="min-w-0">
          {kicker && (
            <div className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-[0.15em]">
              {kicker}
            </div>
          )}
          <CardTitle className="text-md leading-none tracking-tight">{title}</CardTitle>
        </div>
        {editing ? (
          renderEditActions()
        ) : (
          <button
            type="button"
            onClick={onEdit}
            aria-label={t("goals:sidebar.edit_section", { title })}
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
            <div className="space-y-2.5">{editContent}</div>
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

/** Complete sidebar configurator — each section is its own card */
export function SidebarConfigurator({
  plan,
  currency,
  plannerMode,
  onSavePlan,
  retirementOverview,
  goalId,
  dcLinkedAccountIds,
}: {
  plan: RetirementPlan;
  currency: string;
  plannerMode: PlannerMode;
  onSavePlan?: (plan: RetirementPlan, plannerMode?: PlannerMode) => void;
  retirementOverview?: RetirementOverview;
  goalId?: string;
  dcLinkedAccountIds?: string[];
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<RetirementPlan>(() => structuredClone(plan));
  const [draftMode, setDraftMode] = useState<PlannerMode>(plannerMode);
  const [dirty, setDirty] = useState(false);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [expandedExpenseId, setExpandedExpenseId] = useState<string | null>(null);
  const [expandedIncomeId, setExpandedIncomeId] = useState<string | null>(null);
  const L = modeLabel(draftMode);
  const moneyPrefix = formatCurrencySymbol(currency);

  const update = useCallback((updater: (d: RetirementPlan) => RetirementPlan) => {
    setDraft((prev) => updater(prev));
    setDirty(true);
  }, []);

  const saveDraft = useCallback(() => {
    onSavePlan?.(normalizeDashboardRetirementPlan(draft), draftMode);
    setDirty(false);
    setEditingSection(null);
    setExpandedExpenseId(null);
    setExpandedIncomeId(null);
  }, [draft, draftMode, onSavePlan]);

  const cancelEdit = useCallback(() => {
    setDraft(structuredClone(plan));
    setDraftMode(plannerMode);
    setDirty(false);
    setEditingSection(null);
    setExpandedExpenseId(null);
    setExpandedIncomeId(null);
  }, [plan, plannerMode]);

  // Shorthand updaters
  const setPersonal = <K extends keyof RetirementPlan["personal"]>(
    key: K,
    val: RetirementPlan["personal"][K],
  ) => update((d) => ({ ...d, personal: { ...d.personal, [key]: val } }));

  const setInvestment = <K extends keyof InvestmentAssumptions>(
    key: K,
    val: InvestmentAssumptions[K],
  ) => update((d) => ({ ...d, investment: { ...d.investment, [key]: val } }));

  const setPlannerModeDraft = (mode: PlannerMode) => {
    setDraftMode(mode);
    setDirty(true);
  };

  const setTax = <K extends keyof TaxProfile>(key: K, val: TaxProfile[K]) =>
    update((d) => ({
      ...d,
      tax: {
        taxableWithdrawalRate: 0,
        taxDeferredWithdrawalRate: 0,
        taxFreeWithdrawalRate: 0,
        ...d.tax,
        [key]: val,
      },
    }));

  const updateExpenseItem = (id: string, patch: Partial<ExpenseItem>) =>
    update((d) => ({
      ...d,
      expenses: {
        items: expenseItems(d.expenses).map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      },
    }));

  const addExpenseItem = (label: string, patch: Partial<ExpenseItem> = {}) => {
    const item = createExpenseItem(label, 0, patch);
    update((d) => ({
      ...d,
      expenses: {
        items: [...expenseItems(d.expenses), item],
      },
    }));
    setExpandedExpenseId(item.id);
  };

  const removeExpenseItem = (id: string) => {
    update((d) => ({
      ...d,
      expenses: { items: expenseItems(d.expenses).filter((item) => item.id !== id) },
    }));
    setExpandedExpenseId((current) => (current === id ? null : current));
  };

  const addStream = (preset?: Partial<RetirementIncomeStream>) => {
    const id = crypto.randomUUID?.() ?? `stream-${Date.now()}`;
    update((d) => ({
      ...d,
      incomeStreams: [
        ...d.incomeStreams,
        {
          id,
          label:
            preset?.label ??
            t("goals:sidebar.income.default_label", { n: d.incomeStreams.length + 1 }),
          streamType: "db" as const,
          startAge: preset?.startAge ?? d.personal.targetRetirementAge,
          adjustForInflation: preset?.adjustForInflation ?? true,
          monthlyAmount: preset?.monthlyAmount ?? 0,
          ...preset,
        },
      ],
    }));
    setEditingSection("income");
    setExpandedIncomeId(id);
  };

  const updateStream = (id: string, patch: Partial<RetirementIncomeStream>) =>
    update((d) => ({
      ...d,
      incomeStreams: d.incomeStreams.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));

  const removeStream = (id: string) => {
    update((d) => ({ ...d, incomeStreams: d.incomeStreams.filter((s) => s.id !== id) }));
    setExpandedIncomeId((current) => (current === id ? null : current));
  };

  const taxBucketBalances = retirementOverview?.taxBucketBalances;
  const taxBucketTotal = taxBucketBalances
    ? taxBucketBalances.taxable + taxBucketBalances.taxDeferred + taxBucketBalances.taxFree
    : 0;
  const averageWithdrawalTaxRate =
    taxBucketBalances && taxBucketTotal > 0
      ? (taxBucketBalances.taxable * (draft.tax?.taxableWithdrawalRate ?? 0) +
          taxBucketBalances.taxDeferred * (draft.tax?.taxDeferredWithdrawalRate ?? 0) +
          taxBucketBalances.taxFree * (draft.tax?.taxFreeWithdrawalRate ?? 0)) /
        taxBucketTotal
      : 0;
  const effectivePreRetirementReturn =
    draft.investment.preRetirementAnnualReturn - draft.investment.annualInvestmentFeeRate;
  const effectiveRetirementReturn =
    draft.investment.retirementAnnualReturn - draft.investment.annualInvestmentFeeRate;
  const allTaxRatesZero =
    (draft.tax?.taxableWithdrawalRate ?? 0) === 0 &&
    (draft.tax?.taxDeferredWithdrawalRate ?? 0) === 0 &&
    (draft.tax?.taxFreeWithdrawalRate ?? 0) === 0;

  const birthYearMonth =
    draft.personal.birthYearMonth ?? inferBirthYearMonthFromAge(draft.personal.currentAge);
  const maxBirthYearMonth = inferBirthYearMonthFromAge(0);
  const updateBirthYearMonth = (nextBirthYearMonth: string) => {
    if (!nextBirthYearMonth) return;
    const nextAge = ageFromBirthYearMonth(nextBirthYearMonth) ?? draft.personal.currentAge;
    update((d) => {
      const targetRetirementAge = Math.max(nextAge + 1, d.personal.targetRetirementAge);
      const planningHorizonAge = Math.max(targetRetirementAge + 1, d.personal.planningHorizonAge);
      return {
        ...d,
        personal: {
          ...d.personal,
          birthYearMonth: nextBirthYearMonth,
          currentAge: nextAge,
          targetRetirementAge,
          planningHorizonAge,
        },
      };
    });
  };

  return (
    <div className="space-y-4">
      {/* ── Plan ── */}
      <SidebarCard
        kicker={t("goals:sidebar.plan.kicker")}
        title={t("goals:sidebar.plan.title")}
        editing={editingSection === "plan"}
        onEdit={() => setEditingSection("plan")}
        onSave={saveDraft}
        onCancel={cancelEdit}
        dirty={dirty}
        readContent={
          <div className="divide-border divide-y">
            <ConfigRow label={t("goals:sidebar.plan.plan_type")}>
              {draftMode === "fire" ? "FIRE" : t("goals:sidebar.plan.traditional")}
            </ConfigRow>
            <ConfigRow label={t("goals:sidebar.plan.current_age")}>
              {draft.personal.currentAge}
            </ConfigRow>
            <ConfigRow label={L.targetAge}>{draft.personal.targetRetirementAge}</ConfigRow>
            <ConfigRow label={L.horizonAge}>{draft.personal.planningHorizonAge}</ConfigRow>
            <ConfigRow label={t("goals:sidebar.plan.monthly_contribution_until_retirement")}>
              {formatAmount(draft.investment.monthlyContribution, currency)}
            </ConfigRow>
          </div>
        }
        editContent={
          <div className="divide-border -my-1 divide-y">
            <div className="space-y-3 py-4 first:pt-0">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{t("goals:sidebar.plan.plan_type")}</p>
                  <p className="text-muted-foreground mt-1 max-w-[260px] text-xs leading-snug">
                    {t("goals:sidebar.plan.plan_type_help")}
                  </p>
                </div>
                <AnimatedToggleGroup<PlannerMode>
                  value={draftMode}
                  onValueChange={setPlannerModeDraft}
                  items={[
                    { value: "fire", label: "FIRE" },
                    { value: "traditional", label: t("goals:sidebar.plan.traditional") },
                  ]}
                  size="xs"
                  rounded="md"
                  className="bg-muted/30 shrink-0 border"
                />
              </div>
              {draftMode !== plannerMode && (
                <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
                  {t("goals:sidebar.plan.mode_change_prefix")}{" "}
                  {draftMode === "traditional"
                    ? t("goals:sidebar.plan.mode_change_traditional")
                    : t("goals:sidebar.plan.mode_change_fire")}
                </p>
              )}
            </div>
            <div className="py-4 first:pt-1 last:pb-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-foreground text-sm font-semibold leading-tight">
                    {t("goals:sidebar.plan.birth_month")}
                  </div>
                  <div className="text-muted-foreground mt-1 max-w-[240px] text-xs leading-tight">
                    {t("goals:sidebar.plan.birth_month_help")}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <input
                    type="month"
                    value={birthYearMonth}
                    max={maxBirthYearMonth}
                    onChange={(e) => updateBirthYearMonth(e.target.value)}
                    className="bg-muted/70 text-foreground h-8 w-36 rounded-md border px-2.5 text-right text-sm tabular-nums outline-none"
                  />
                  <span className="text-muted-foreground text-xs">
                    {t("goals:sidebar.plan.current_age_value", { age: draft.personal.currentAge })}
                  </span>
                </div>
              </div>
            </div>
            <LeverRow
              label={
                draftMode === "fire"
                  ? t("goals:sidebar.plan.desired_retirement_age")
                  : t("goals:sidebar.plan.retirement_age")
              }
              hint={
                draftMode === "fire"
                  ? t("goals:sidebar.plan.desired_retirement_age_hint")
                  : t("goals:sidebar.plan.retirement_age_hint")
              }
              value={draft.personal.targetRetirementAge}
              onChange={(v) => {
                const targetRetirementAge = Math.round(v);
                update((d) => ({
                  ...d,
                  personal: {
                    ...d.personal,
                    targetRetirementAge: Math.min(
                      targetRetirementAge,
                      d.personal.planningHorizonAge - 1,
                    ),
                  },
                }));
              }}
              min={draft.personal.currentAge + 1}
              max={110}
              step={1}
              format={(v) => String(Math.round(v))}
            />
            <LeverRow
              label={L.horizonAge}
              hint={t("goals:sidebar.plan.horizon_hint")}
              value={draft.personal.planningHorizonAge}
              onChange={(v) =>
                setPersonal(
                  "planningHorizonAge",
                  Math.max(Math.round(v), draft.personal.targetRetirementAge + 1),
                )
              }
              min={draft.personal.currentAge + 2}
              max={110}
              step={1}
              format={(v) => String(Math.round(v))}
            />
            <LeverRow
              label={t("goals:sidebar.plan.monthly_contribution")}
              hint={t("goals:sidebar.plan.monthly_contribution_hint")}
              kind="money"
              value={draft.investment.monthlyContribution}
              onChange={(v) => setInvestment("monthlyContribution", v)}
              min={0}
              max={sliderMaxFor(draft.investment.monthlyContribution, 20000, 5000)}
              step={100}
              prefix={moneyPrefix}
              format={(v) => String(Math.round(v))}
            />
            <LeverRow
              label={t("goals:sidebar.assumptions.return_before_retirement")}
              hint={t("goals:sidebar.plan.return_before_hint")}
              value={draft.investment.preRetirementAnnualReturn}
              onChange={(v) => setInvestment("preRetirementAnnualReturn", v)}
              min={0}
              max={rateSliderMaxFor(
                draft.investment.preRetirementAnnualReturn,
                DEFAULT_RETURN_SLIDER_MAX,
                RATE_SLIDER_INCREMENT,
                MAX_RETIREMENT_RETURN,
              )}
              inputMax={MAX_RETIREMENT_RETURN}
              step={0.001}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
              warning={highReturnWarning(draft.investment.preRetirementAnnualReturn)}
            />
            <LeverRow
              label={t("goals:sidebar.assumptions.return_during_retirement")}
              hint={t("goals:sidebar.plan.return_during_hint")}
              value={draft.investment.retirementAnnualReturn}
              onChange={(v) => setInvestment("retirementAnnualReturn", v)}
              min={0}
              max={rateSliderMaxFor(
                draft.investment.retirementAnnualReturn,
                DEFAULT_RETURN_SLIDER_MAX,
                RATE_SLIDER_INCREMENT,
                MAX_RETIREMENT_RETURN,
              )}
              inputMax={MAX_RETIREMENT_RETURN}
              step={0.001}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
              warning={highReturnWarning(draft.investment.retirementAnnualReturn)}
            />
            <LeverRow
              label={t("goals:sidebar.assumptions.annual_investment_fee")}
              hint={t("goals:sidebar.plan.annual_fee_hint")}
              value={draft.investment.annualInvestmentFeeRate}
              onChange={(v) => setInvestment("annualInvestmentFeeRate", v)}
              min={0}
              max={rateSliderMaxFor(
                draft.investment.annualInvestmentFeeRate,
                DEFAULT_FEE_SLIDER_MAX,
                FEE_SLIDER_INCREMENT,
                MAX_RETIREMENT_FEE,
              )}
              inputMax={MAX_RETIREMENT_FEE}
              step={0.0005}
              suffix="%"
              format={(v) => (v * 100).toFixed(2)}
              warning={highFeeWarning(draft.investment.annualInvestmentFeeRate, t)}
            />
            <LeverRow
              label={t("goals:sidebar.assumptions.inflation")}
              hint={t("goals:sidebar.plan.inflation_hint")}
              value={draft.investment.inflationRate}
              onChange={(v) => setInvestment("inflationRate", v)}
              min={0}
              max={rateSliderMaxFor(
                draft.investment.inflationRate,
                DEFAULT_INFLATION_SLIDER_MAX,
                RATE_SLIDER_INCREMENT,
                MAX_RETIREMENT_INFLATION,
              )}
              inputMax={MAX_RETIREMENT_INFLATION}
              step={0.001}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
              warning={highInflationWarning(draft.investment.inflationRate, t)}
            />
          </div>
        }
      />

      {/* ── Expenses ── */}
      <SidebarCard
        kicker={t("goals:sidebar.spending.kicker")}
        title={t("goals:sidebar.spending.title")}
        editing={editingSection === "expenses"}
        onEdit={() => {
          setEditingSection("expenses");
          setExpandedExpenseId(null);
        }}
        onSave={saveDraft}
        onCancel={cancelEdit}
        dirty={dirty}
        readContent={(() => {
          const retireAge = draft.personal.targetRetirementAge;
          const horizonAge = draft.personal.planningHorizonAge;
          const items = expenseItems(draft.expenses);
          const total = totalMonthlyExpenseAtAge(draft.expenses, retireAge);
          if (items.length === 0) {
            return (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs">
                  {t("goals:sidebar.spending.none_configured")}
                </p>
                <SidebarTotalRow amount={0} currency={currency} />
              </div>
            );
          }
          return (
            <div className="divide-border divide-y">
              {items.map((it) => (
                <SidebarMonthlyRow
                  key={it.id}
                  label={it.label}
                  meta={[
                    expenseAgeRangeLabel(it, horizonAge),
                    (it.essential ?? true)
                      ? t("goals:sidebar.spending.must_have")
                      : t("goals:sidebar.spending.flexible"),
                    it.inflationRate !== undefined
                      ? t("goals:sidebar.spending.inflation_meta", {
                          pct: (it.inflationRate * 100).toFixed(1),
                        })
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  amount={it.monthlyAmount}
                  currency={currency}
                />
              ))}
              <SidebarTotalRow amount={total} currency={currency} />
            </div>
          );
        })()}
        editContent={
          <div className="space-y-3">
            {expenseItems(draft.expenses).map((item) => {
              const expanded = expandedExpenseId === item.id;
              const meta = [
                expenseAgeRangeLabel(item, draft.personal.planningHorizonAge),
                (item.essential ?? true)
                  ? t("goals:sidebar.spending.must_have")
                  : t("goals:sidebar.spending.flexible"),
                item.inflationRate !== undefined
                  ? t("goals:sidebar.spending.inflation_meta", {
                      pct: (item.inflationRate * 100).toFixed(1),
                    })
                  : undefined,
              ].join(" · ");

              return (
                <div
                  key={item.id}
                  className={`overflow-hidden rounded-lg border transition-colors ${
                    expanded ? "bg-muted/20" : "bg-transparent"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setExpandedExpenseId(expanded ? null : item.id)}
                      className="hover:bg-muted/30 flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left transition-colors"
                      aria-expanded={expanded}
                    >
                      <Icons.ChevronDown
                        className={`text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform ${
                          expanded ? "rotate-180" : ""
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block truncate text-sm font-semibold">
                          {item.label || t("goals:sidebar.spending.default_label")}
                        </span>
                        <span className="text-muted-foreground mt-0.5 block truncate text-[11px]">
                          {meta}
                        </span>
                      </span>
                      <span className="text-foreground shrink-0 text-sm font-semibold tabular-nums">
                        {formatAmount(item.monthlyAmount, currency)}
                        <span className="text-muted-foreground text-xs font-normal">/mo</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeExpenseItem(item.id)}
                      className="text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground mr-2 rounded-md p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label={t("goals:sidebar.spending.remove", {
                        label: item.label || t("goals:sidebar.spending.item_fallback"),
                      })}
                    >
                      <Icons.X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {expanded && (
                    <div className="space-y-4 border-t px-3 pb-3 pt-3">
                      <Input
                        value={item.label}
                        onChange={(e) => updateExpenseItem(item.id, { label: e.target.value })}
                        placeholder={t("goals:sidebar.spending.name_placeholder")}
                        className="bg-muted/70 h-8 px-2 text-sm font-semibold shadow-none"
                      />
                      <LeverRow
                        label={t("goals:sidebar.spending.monthly_spending")}
                        kind="money"
                        value={item.monthlyAmount}
                        onChange={(v) => updateExpenseItem(item.id, { monthlyAmount: v })}
                        min={0}
                        max={sliderMaxFor(item.monthlyAmount, 20000, 5000)}
                        step={100}
                        prefix={moneyPrefix}
                        suffix="/mo"
                        format={(v) => String(Math.round(v))}
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <AgeBoundInput
                          label={t("goals:sidebar.spending.from_age")}
                          value={item.startAge}
                          onChange={(v) => updateExpenseItem(item.id, { startAge: v })}
                          placeholder={t("goals:sidebar.spending.from_age_placeholder")}
                          min={draft.personal.currentAge}
                          max={draft.personal.planningHorizonAge}
                        />
                        <AgeBoundInput
                          label={t("goals:sidebar.spending.to_age")}
                          value={item.endAge}
                          onChange={(v) => updateExpenseItem(item.id, { endAge: v })}
                          placeholder={`${draft.personal.planningHorizonAge}`}
                          min={draft.personal.currentAge + 1}
                          max={draft.personal.planningHorizonAge}
                        />
                      </div>
                      <div className="bg-muted/20 grid gap-3 rounded-lg border p-3">
                        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-3">
                          <div className="min-w-0">
                            <div className="text-foreground text-xs font-semibold">
                              {t("goals:sidebar.spending.spending_type")}
                            </div>
                            <div className="text-muted-foreground mt-0.5 text-[11px] leading-tight">
                              {t("goals:sidebar.spending.spending_type_help")}
                            </div>
                          </div>
                          <AnimatedToggleGroup<"essential" | "flexible">
                            variant="secondary"
                            size="xs"
                            items={[
                              { value: "essential", label: t("goals:sidebar.spending.must_have") },
                              { value: "flexible", label: t("goals:sidebar.spending.flexible") },
                            ]}
                            value={(item.essential ?? true) ? "essential" : "flexible"}
                            onValueChange={(value) =>
                              updateExpenseItem(item.id, { essential: value === "essential" })
                            }
                          />
                        </div>
                        <div className="border-border grid gap-2 border-t pt-3 sm:grid-cols-[1fr_8rem] sm:items-center sm:gap-3">
                          <div className="min-w-0">
                            <div className="text-foreground text-xs font-semibold">
                              {t("goals:sidebar.spending.inflation_override")}
                            </div>
                            <div className="text-muted-foreground mt-0.5 text-[11px] leading-tight">
                              {t("goals:sidebar.spending.inflation_override_help")}
                            </div>
                          </div>
                          <PercentOverrideInput
                            value={item.inflationRate}
                            placeholder={t("goals:sidebar.spending.plan_inflation_placeholder", {
                              pct: (draft.investment.inflationRate * 100).toFixed(1),
                            })}
                            max={MAX_RETIREMENT_INFLATION}
                            onChange={(value) =>
                              updateExpenseItem(item.id, { inflationRate: value })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {expenseItems(draft.expenses).length === 0 && (
              <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs leading-relaxed">
                {t("goals:sidebar.spending.empty_hint")}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 pt-3">
              <button
                className="text-muted-foreground hover:text-foreground rounded-md border border-dashed py-1.5 text-xs transition-colors"
                onClick={() =>
                  addExpenseItem(t("goals:sidebar.spending.preset_living"), { essential: true })
                }
              >
                {t("goals:sidebar.spending.add_living")}
              </button>
              <button
                className="text-muted-foreground hover:text-foreground rounded-md border border-dashed py-1.5 text-xs transition-colors"
                onClick={() =>
                  addExpenseItem(t("goals:sidebar.spending.preset_healthcare"), {
                    essential: true,
                  })
                }
              >
                {t("goals:sidebar.spending.add_healthcare")}
              </button>
              <button
                className="text-muted-foreground hover:text-foreground rounded-md border border-dashed py-1.5 text-xs transition-colors"
                onClick={() =>
                  addExpenseItem(t("goals:sidebar.spending.preset_housing"), { essential: false })
                }
              >
                {t("goals:sidebar.spending.add_housing")}
              </button>
              <button
                className="text-muted-foreground hover:text-foreground rounded-md border border-dashed py-1.5 text-xs transition-colors"
                onClick={() =>
                  addExpenseItem(t("goals:sidebar.spending.preset_travel"), { essential: false })
                }
              >
                {t("goals:sidebar.spending.add_travel")}
              </button>
              <button
                className="text-muted-foreground hover:text-foreground col-span-2 rounded-md border border-dashed py-1.5 text-xs transition-colors"
                onClick={() =>
                  addExpenseItem(t("goals:sidebar.spending.preset_other"), { essential: false })
                }
              >
                {t("goals:sidebar.spending.add_other")}
              </button>
            </div>
          </div>
        }
      />

      {/* ── Income Streams ── */}
      <SidebarCard
        kicker={t("goals:sidebar.income.kicker")}
        title={t("goals:sidebar.income.title")}
        editing={editingSection === "income"}
        onEdit={() => {
          setEditingSection("income");
          setExpandedIncomeId(null);
        }}
        onSave={saveDraft}
        onCancel={cancelEdit}
        dirty={dirty}
        readContent={
          draft.incomeStreams.length > 0 ? (
            <div className="space-y-2.5">
              <div className="divide-border divide-y">
                {draft.incomeStreams.map((s) => (
                  <SidebarMonthlyRow
                    key={s.id}
                    label={s.label || t("goals:sidebar.income.stream_fallback")}
                    meta={t("goals:sidebar.income.read_meta", {
                      type:
                        s.streamType === "dc"
                          ? t("goals:sidebar.income.pension_fund")
                          : t("goals:sidebar.income.income"),
                      start: s.startAge,
                      end: draft.personal.planningHorizonAge,
                    })}
                    amount={incomeStreamMonthlyAmount(draft, s)}
                    currency={currency}
                  />
                ))}
                <SidebarTotalRow
                  amount={draft.incomeStreams.reduce(
                    (sum, s) => sum + incomeStreamMonthlyAmount(draft, s),
                    0,
                  )}
                  currency={currency}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs">
                {t("goals:sidebar.income.none_configured")}
              </p>
              <p className="text-muted-foreground rounded-md border border-dashed px-2.5 py-2 text-xs leading-relaxed">
                {t("goals:sidebar.income.public_pensions_note")}
              </p>
            </div>
          )
        }
        editContent={
          <div className="space-y-3">
            {draft.incomeStreams.map((s) => {
              const expanded = expandedIncomeId === s.id;
              const amount = incomeStreamMonthlyAmount(draft, s);
              const growthMeta =
                s.streamType === "dc"
                  ? t("goals:sidebar.income.balance_derived_payout")
                  : s.annualGrowthRate !== undefined
                    ? t("goals:sidebar.income.growth_meta", {
                        pct: (s.annualGrowthRate * 100).toFixed(1),
                      })
                    : s.adjustForInflation
                      ? t("goals:sidebar.income.inflation_indexed")
                      : t("goals:sidebar.income.fixed_nominal");
              const meta = [
                t("goals:sidebar.income.age_range", {
                  start: s.startAge,
                  end: draft.personal.planningHorizonAge,
                }),
                growthMeta,
              ].join(" · ");

              return (
                <div
                  key={s.id}
                  className={`overflow-hidden rounded-lg border transition-colors ${
                    expanded ? "bg-muted/20" : "bg-transparent"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setExpandedIncomeId(expanded ? null : s.id)}
                      className="hover:bg-muted/30 flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left transition-colors"
                      aria-expanded={expanded}
                    >
                      <Icons.ChevronDown
                        className={`text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform ${
                          expanded ? "rotate-180" : ""
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block truncate text-sm font-semibold">
                          {s.label || t("goals:sidebar.income.income")}
                        </span>
                        <span className="text-muted-foreground mt-0.5 block truncate text-[11px]">
                          {meta}
                        </span>
                      </span>
                      <span className="text-foreground shrink-0 text-sm font-semibold tabular-nums">
                        {formatAmount(amount, currency)}
                        <span className="text-muted-foreground text-xs font-normal">/mo</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeStream(s.id)}
                      className="text-muted-foreground hover:text-foreground mr-2 rounded-md p-1 transition-colors"
                      aria-label={t("goals:sidebar.income.remove", {
                        label: s.label || t("goals:sidebar.income.item_fallback"),
                      })}
                    >
                      <Icons.X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {expanded && (
                    <div className="space-y-4 border-t px-3 pb-3 pt-3">
                      <Input
                        value={s.label}
                        onChange={(e) => updateStream(s.id, { label: e.target.value })}
                        placeholder={t("goals:sidebar.income.name_placeholder")}
                        className="bg-muted/70 h-8 px-2 text-sm font-semibold shadow-none"
                      />
                      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-3">
                        <div className="min-w-0">
                          <div className="text-foreground text-xs font-semibold">
                            {t("goals:sidebar.income.income_type")}
                          </div>
                          <div className="text-muted-foreground mt-0.5 text-[11px] leading-tight">
                            {t("goals:sidebar.income.income_type_help")}
                          </div>
                        </div>
                        <AnimatedToggleGroup<"db" | "dc">
                          variant="secondary"
                          size="xs"
                          items={[
                            { value: "db", label: t("goals:sidebar.income.income") },
                            { value: "dc", label: t("goals:sidebar.income.fund") },
                          ]}
                          value={s.streamType}
                          onValueChange={(value) =>
                            updateStream(s.id, {
                              streamType: value,
                              currentValue: value === "dc" ? (s.currentValue ?? 0) : s.currentValue,
                              monthlyContribution:
                                value === "dc"
                                  ? (s.monthlyContribution ?? 0)
                                  : s.monthlyContribution,
                              accumulationReturn:
                                value === "dc"
                                  ? (s.accumulationReturn ??
                                    draft.investment.preRetirementAnnualReturn)
                                  : s.accumulationReturn,
                            })
                          }
                        />
                      </div>
                      <div className="divide-border divide-y">
                        {s.streamType !== "dc" && (
                          <LeverRow
                            label={t("goals:sidebar.income.monthly_income_after_tax")}
                            kind="money"
                            value={s.monthlyAmount ?? 0}
                            onChange={(v) => updateStream(s.id, { monthlyAmount: v })}
                            min={0}
                            max={sliderMaxFor(amount, 10000, 2500)}
                            step={50}
                            prefix={moneyPrefix}
                            suffix="/mo"
                            format={(v) => String(Math.round(v))}
                          />
                        )}
                        {s.streamType === "dc" && (
                          <>
                            <LeverRow
                              label={t("goals:sidebar.income.current_fund_balance")}
                              kind="money"
                              value={s.currentValue ?? 0}
                              onChange={(v) => updateStream(s.id, { currentValue: v })}
                              min={0}
                              max={sliderMaxFor(s.currentValue ?? 0, 2_000_000, 250_000)}
                              step={1000}
                              prefix={moneyPrefix}
                              format={(v) => String(Math.round(v))}
                            />
                            <LeverRow
                              label={t("goals:sidebar.income.monthly_fund_contribution")}
                              kind="money"
                              value={s.monthlyContribution ?? 0}
                              onChange={(v) => updateStream(s.id, { monthlyContribution: v })}
                              min={0}
                              max={sliderMaxFor(s.monthlyContribution ?? 0, 10000, 2500)}
                              step={50}
                              prefix={moneyPrefix}
                              suffix="/mo"
                              format={(v) => String(Math.round(v))}
                            />
                            <LeverRow
                              label={t("goals:sidebar.income.fund_return_before_payout")}
                              value={
                                s.accumulationReturn ?? draft.investment.preRetirementAnnualReturn
                              }
                              onChange={(v) => updateStream(s.id, { accumulationReturn: v })}
                              min={0}
                              max={rateSliderMaxFor(
                                s.accumulationReturn ?? draft.investment.preRetirementAnnualReturn,
                                DEFAULT_RETURN_SLIDER_MAX,
                                RATE_SLIDER_INCREMENT,
                                MAX_RETIREMENT_RETURN,
                              )}
                              inputMax={MAX_RETIREMENT_RETURN}
                              step={0.001}
                              suffix="%"
                              format={(v) => (v * 100).toFixed(1)}
                              warning={highReturnWarning(
                                s.accumulationReturn ?? draft.investment.preRetirementAnnualReturn,
                              )}
                            />
                            {s.startAge <= draft.personal.currentAge && (
                              <LeverRow
                                label={t("goals:sidebar.income.monthly_payout_after_tax")}
                                kind="money"
                                value={s.monthlyAmount ?? amount}
                                onChange={(v) => updateStream(s.id, { monthlyAmount: v })}
                                min={0}
                                max={sliderMaxFor(s.monthlyAmount ?? amount, 10000, 2500)}
                                step={50}
                                prefix={moneyPrefix}
                                suffix="/mo"
                                format={(v) => String(Math.round(v))}
                              />
                            )}
                            <p className="text-muted-foreground px-1 text-[11px] leading-relaxed">
                              {t("goals:sidebar.income.payout_estimate_note", {
                                pct: (DEFAULT_DC_PAYOUT_ESTIMATE_RATE * 100).toFixed(1),
                              })}
                            </p>
                          </>
                        )}
                        <LeverRow
                          label={t("goals:sidebar.income.start_age")}
                          value={s.startAge}
                          onChange={(v) => updateStream(s.id, { startAge: Math.round(v) })}
                          min={draft.personal.currentAge}
                          max={draft.personal.planningHorizonAge}
                          step={1}
                          format={(v) => String(Math.round(v))}
                        />
                      </div>
                      <div className="bg-muted/20 grid gap-3 rounded-lg border p-3">
                        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-3">
                          <div className="min-w-0">
                            <div className="text-foreground text-xs font-semibold">
                              {t("goals:sidebar.income.income_growth")}
                            </div>
                            <div className="text-muted-foreground mt-0.5 text-[11px] leading-tight">
                              {t("goals:sidebar.income.income_growth_help")}
                            </div>
                          </div>
                          <AnimatedToggleGroup<"indexed" | "fixed">
                            variant="secondary"
                            size="xs"
                            items={[
                              { value: "indexed", label: t("goals:sidebar.income.indexed") },
                              { value: "fixed", label: t("goals:sidebar.income.fixed") },
                            ]}
                            value={s.adjustForInflation ? "indexed" : "fixed"}
                            onValueChange={(value) =>
                              updateStream(s.id, {
                                adjustForInflation: value === "indexed",
                                annualGrowthRate: undefined,
                              })
                            }
                          />
                        </div>
                        <div className="border-border grid gap-2 border-t pt-3 sm:grid-cols-[1fr_8rem] sm:items-center sm:gap-3">
                          <div className="min-w-0">
                            <div className="text-foreground text-xs font-semibold">
                              {t("goals:sidebar.income.custom_annual_growth")}
                            </div>
                            <div className="text-muted-foreground mt-0.5 text-[11px] leading-tight">
                              {t("goals:sidebar.income.custom_annual_growth_help")}
                            </div>
                          </div>
                          <PercentOverrideInput
                            value={s.annualGrowthRate}
                            placeholder={
                              s.adjustForInflation
                                ? t("goals:sidebar.income.growth_placeholder_inflation", {
                                    pct: (draft.investment.inflationRate * 100).toFixed(1),
                                  })
                                : t("goals:sidebar.income.growth_placeholder_fixed")
                            }
                            max={MAX_RETIREMENT_INCOME_GROWTH}
                            onChange={(value) => updateStream(s.id, { annualGrowthRate: value })}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <button
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-xs transition-colors"
              onClick={() => addStream()}
            >
              <Icons.Plus className="h-3 w-3" /> {t("goals:sidebar.income.add_income")}
            </button>
            <button
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-xs transition-colors"
              onClick={() =>
                addStream({
                  label: t("goals:sidebar.income.pension_fund"),
                  streamType: "dc",
                  startAge: draft.personal.targetRetirementAge,
                  monthlyAmount: undefined,
                  currentValue: 0,
                  monthlyContribution: 0,
                  accumulationReturn: draft.investment.preRetirementAnnualReturn,
                  adjustForInflation: false,
                })
              }
            >
              <Icons.Plus className="h-3 w-3" /> {t("goals:sidebar.income.add_pension_fund")}
            </button>
          </div>
        }
      />

      {/* ── Investment ── */}
      <SidebarCard
        kicker={t("goals:sidebar.assumptions.kicker")}
        title={t("goals:sidebar.assumptions.title")}
        editing={editingSection === "investment"}
        onEdit={() => setEditingSection("investment")}
        onSave={saveDraft}
        onCancel={cancelEdit}
        dirty={dirty}
        readContent={
          <div className="divide-border divide-y">
            <ConfigRow label={t("goals:sidebar.assumptions.return_before_retirement")}>
              {formatPercent(draft.investment.preRetirementAnnualReturn)}
            </ConfigRow>
            <ConfigRow label={t("goals:sidebar.assumptions.return_during_retirement")}>
              {formatPercent(draft.investment.retirementAnnualReturn)}
            </ConfigRow>
            <ConfigRow label={t("goals:sidebar.assumptions.annual_investment_fee")}>
              {formatPercent(draft.investment.annualInvestmentFeeRate)}
            </ConfigRow>
            <ConfigRow label={t("goals:sidebar.assumptions.effective_before_return")}>
              {formatPercent(effectivePreRetirementReturn)}
            </ConfigRow>
            <ConfigRow label={t("goals:sidebar.assumptions.effective_retirement_return")}>
              {formatPercent(effectiveRetirementReturn)}
            </ConfigRow>
            <ConfigRow
              label={
                <InfoLabel label={t("goals:sidebar.assumptions.annual_volatility")}>
                  {t("goals:sidebar.assumptions.annual_volatility_tip")}
                </InfoLabel>
              }
            >
              {formatPercent(draft.investment.annualVolatility)}
            </ConfigRow>
            <ConfigRow label={t("goals:sidebar.assumptions.inflation")}>
              {formatPercent(draft.investment.inflationRate)}
            </ConfigRow>
            {draft.investment.contributionGrowthRate > 0 && (
              <ConfigRow label={t("goals:sidebar.assumptions.contribution_growth_per_year")}>
                {formatPercent(draft.investment.contributionGrowthRate)}
              </ConfigRow>
            )}
          </div>
        }
        editContent={
          <div className="divide-border -my-1 divide-y">
            <LeverRow
              label={t("goals:sidebar.assumptions.return_before_retirement")}
              value={draft.investment.preRetirementAnnualReturn}
              onChange={(v) => setInvestment("preRetirementAnnualReturn", v)}
              min={0}
              max={rateSliderMaxFor(
                draft.investment.preRetirementAnnualReturn,
                DEFAULT_RETURN_SLIDER_MAX,
                RATE_SLIDER_INCREMENT,
                MAX_RETIREMENT_RETURN,
              )}
              inputMax={MAX_RETIREMENT_RETURN}
              step={0.001}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
              warning={highReturnWarning(draft.investment.preRetirementAnnualReturn)}
            />
            <LeverRow
              label={t("goals:sidebar.assumptions.return_during_retirement")}
              value={draft.investment.retirementAnnualReturn}
              onChange={(v) => setInvestment("retirementAnnualReturn", v)}
              min={0}
              max={rateSliderMaxFor(
                draft.investment.retirementAnnualReturn,
                DEFAULT_RETURN_SLIDER_MAX,
                RATE_SLIDER_INCREMENT,
                MAX_RETIREMENT_RETURN,
              )}
              inputMax={MAX_RETIREMENT_RETURN}
              step={0.001}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
              warning={highReturnWarning(draft.investment.retirementAnnualReturn)}
            />
            <LeverRow
              label={t("goals:sidebar.assumptions.annual_investment_fee")}
              value={draft.investment.annualInvestmentFeeRate}
              onChange={(v) => setInvestment("annualInvestmentFeeRate", v)}
              min={0}
              max={rateSliderMaxFor(
                draft.investment.annualInvestmentFeeRate,
                DEFAULT_FEE_SLIDER_MAX,
                FEE_SLIDER_INCREMENT,
                MAX_RETIREMENT_FEE,
              )}
              inputMax={MAX_RETIREMENT_FEE}
              step={0.0005}
              suffix="%"
              format={(v) => (v * 100).toFixed(2)}
              warning={highFeeWarning(draft.investment.annualInvestmentFeeRate, t)}
            />
            <LeverRow
              label={
                <InfoLabel label={t("goals:sidebar.assumptions.annual_volatility")}>
                  {t("goals:sidebar.assumptions.annual_volatility_tip")}
                </InfoLabel>
              }
              value={draft.investment.annualVolatility}
              onChange={(v) => setInvestment("annualVolatility", v)}
              min={0}
              max={rateSliderMaxFor(
                draft.investment.annualVolatility,
                DEFAULT_VOLATILITY_SLIDER_MAX,
                VOLATILITY_SLIDER_INCREMENT,
                MAX_RETIREMENT_VOLATILITY,
              )}
              inputMax={MAX_RETIREMENT_VOLATILITY}
              step={0.005}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
              warning={highVolatilityWarning(draft.investment.annualVolatility, t)}
            />
            <LeverRow
              label={t("goals:sidebar.assumptions.inflation")}
              value={draft.investment.inflationRate}
              onChange={(v) => setInvestment("inflationRate", v)}
              min={0}
              max={rateSliderMaxFor(
                draft.investment.inflationRate,
                DEFAULT_INFLATION_SLIDER_MAX,
                RATE_SLIDER_INCREMENT,
                MAX_RETIREMENT_INFLATION,
              )}
              inputMax={MAX_RETIREMENT_INFLATION}
              step={0.001}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
              warning={highInflationWarning(draft.investment.inflationRate, t)}
            />
            <LeverRow
              label={t("goals:sidebar.assumptions.contribution_growth_per_year")}
              value={draft.investment.contributionGrowthRate}
              onChange={(v) => setInvestment("contributionGrowthRate", v)}
              min={0}
              max={rateSliderMaxFor(
                draft.investment.contributionGrowthRate,
                DEFAULT_CONTRIBUTION_GROWTH_SLIDER_MAX,
                CONTRIBUTION_GROWTH_SLIDER_INCREMENT,
                MAX_RETIREMENT_CONTRIBUTION_GROWTH,
              )}
              inputMax={MAX_RETIREMENT_CONTRIBUTION_GROWTH}
              step={0.001}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
              warning={highContributionGrowthWarning(draft.investment.contributionGrowthRate, t)}
            />
          </div>
        }
      />

      {/* ── Tax ── */}
      <SidebarCard
        kicker={t("goals:sidebar.taxes.kicker")}
        title={t("goals:sidebar.taxes.title")}
        editing={editingSection === "tax"}
        onEdit={() => setEditingSection("tax")}
        onSave={saveDraft}
        onCancel={cancelEdit}
        dirty={dirty}
        readContent={
          <div className="space-y-3">
            <div className="divide-border divide-y">
              <ConfigRow
                label={
                  <InfoLabel label={t("goals:sidebar.taxes.taxable_account_rate")}>
                    {t("goals:sidebar.taxes.taxable_account_rate_tip")}
                  </InfoLabel>
                }
              >
                {formatPercent(draft.tax?.taxableWithdrawalRate ?? 0)}
              </ConfigRow>
              <ConfigRow
                label={
                  <InfoLabel label={t("goals:sidebar.taxes.tax_deferred_account_rate")}>
                    {t("goals:sidebar.taxes.tax_deferred_account_rate_tip")}
                  </InfoLabel>
                }
              >
                {formatPercent(draft.tax?.taxDeferredWithdrawalRate ?? 0)}
              </ConfigRow>
              <ConfigRow
                label={
                  <InfoLabel label={t("goals:sidebar.taxes.tax_free_account_rate")}>
                    {t("goals:sidebar.taxes.tax_free_account_rate_tip")}
                  </InfoLabel>
                }
              >
                {formatPercent(draft.tax?.taxFreeWithdrawalRate ?? 0)}
              </ConfigRow>
              <ConfigRow
                label={
                  <InfoLabel label={t("goals:sidebar.taxes.early_withdrawal_penalty")}>
                    {t("goals:sidebar.taxes.early_withdrawal_penalty_tip")}
                  </InfoLabel>
                }
              >
                {formatPercent(draft.tax?.earlyWithdrawalPenaltyRate ?? 0)}
              </ConfigRow>
              {(draft.tax?.earlyWithdrawalPenaltyRate ?? 0) > 0 && (
                <ConfigRow
                  label={
                    <InfoLabel label={t("goals:sidebar.taxes.penalty_cutoff_age")}>
                      {t("goals:sidebar.taxes.penalty_cutoff_age_tip_read")}
                    </InfoLabel>
                  }
                >
                  {draft.tax?.earlyWithdrawalPenaltyAge ?? 59}
                </ConfigRow>
              )}
              {averageWithdrawalTaxRate > 0 && (
                <ConfigRow
                  label={
                    <InfoLabel label={t("goals:sidebar.taxes.estimated_avg_withdrawal_tax")}>
                      {t("goals:sidebar.taxes.estimated_avg_withdrawal_tax_tip")}
                    </InfoLabel>
                  }
                >
                  {(averageWithdrawalTaxRate * 100).toFixed(1)}%
                </ConfigRow>
              )}
            </div>

            {taxBucketBalances && taxBucketTotal > 0 && (
              <div className="border-t pt-3">
                <p className="text-muted-foreground mb-1.5 flex items-center gap-1 text-[10px] uppercase tracking-wider">
                  {t("goals:sidebar.taxes.account_buckets")}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground/70 hover:text-foreground rounded-full transition-colors"
                        aria-label={t("goals:sidebar.taxes.account_buckets_aria")}
                      >
                        <Icons.Info className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-xs">
                      {t("goals:sidebar.taxes.account_buckets_tip")}
                    </TooltipContent>
                  </Tooltip>
                </p>
                <div className="divide-border divide-y">
                  <ConfigRow
                    label={
                      <InfoLabel label={t("goals:sidebar.taxes.taxable_bucket")}>
                        {t("goals:sidebar.taxes.taxable_bucket_tip")}
                      </InfoLabel>
                    }
                  >
                    {formatAmount(taxBucketBalances.taxable, currency)}{" "}
                    <span className="text-muted-foreground ml-1 font-normal">
                      {pctOfTotal(taxBucketBalances.taxable, taxBucketTotal)}
                    </span>
                  </ConfigRow>
                  <ConfigRow
                    label={
                      <InfoLabel label={t("goals:sidebar.taxes.tax_deferred_bucket")}>
                        {t("goals:sidebar.taxes.tax_deferred_bucket_tip")}
                      </InfoLabel>
                    }
                  >
                    {formatAmount(taxBucketBalances.taxDeferred, currency)}{" "}
                    <span className="text-muted-foreground ml-1 font-normal">
                      {pctOfTotal(taxBucketBalances.taxDeferred, taxBucketTotal)}
                    </span>
                  </ConfigRow>
                  <ConfigRow
                    label={
                      <InfoLabel label={t("goals:sidebar.taxes.tax_free_bucket")}>
                        {t("goals:sidebar.taxes.tax_free_bucket_tip")}
                      </InfoLabel>
                    }
                  >
                    {formatAmount(taxBucketBalances.taxFree, currency)}{" "}
                    <span className="text-muted-foreground ml-1 font-normal">
                      {pctOfTotal(taxBucketBalances.taxFree, taxBucketTotal)}
                    </span>
                  </ConfigRow>
                </div>
              </div>
            )}

            {allTaxRatesZero && taxBucketTotal > 0 && (
              <p className="text-muted-foreground text-[10px]">
                {t("goals:sidebar.taxes.zero_rates_note")}
              </p>
            )}
          </div>
        }
        editContent={
          <div className="divide-border -my-1 divide-y">
            <LeverRow
              label={
                <InfoLabel label={t("goals:sidebar.taxes.taxable_account_rate")}>
                  {t("goals:sidebar.taxes.taxable_account_rate_edit_tip")}
                </InfoLabel>
              }
              value={draft.tax?.taxableWithdrawalRate ?? 0}
              onChange={(v) => setTax("taxableWithdrawalRate", v)}
              min={0}
              max={0.6}
              step={0.005}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
            />
            <LeverRow
              label={
                <InfoLabel label={t("goals:sidebar.taxes.tax_deferred_account_rate")}>
                  {t("goals:sidebar.taxes.tax_deferred_account_rate_edit_tip")}
                </InfoLabel>
              }
              value={draft.tax?.taxDeferredWithdrawalRate ?? 0}
              onChange={(v) => setTax("taxDeferredWithdrawalRate", v)}
              min={0}
              max={0.6}
              step={0.005}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
            />
            <LeverRow
              label={
                <InfoLabel label={t("goals:sidebar.taxes.tax_free_account_rate")}>
                  {t("goals:sidebar.taxes.tax_free_account_rate_edit_tip")}
                </InfoLabel>
              }
              value={draft.tax?.taxFreeWithdrawalRate ?? 0}
              onChange={(v) => setTax("taxFreeWithdrawalRate", v)}
              min={0}
              max={0.3}
              step={0.005}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
            />
            <LeverRow
              label={
                <InfoLabel label={t("goals:sidebar.taxes.early_withdrawal_penalty")}>
                  {t("goals:sidebar.taxes.early_withdrawal_penalty_edit_tip")}
                </InfoLabel>
              }
              hint={t("goals:sidebar.taxes.early_withdrawal_penalty_hint")}
              value={draft.tax?.earlyWithdrawalPenaltyRate ?? 0}
              onChange={(v) => setTax("earlyWithdrawalPenaltyRate", v)}
              min={0}
              max={0.3}
              step={0.005}
              suffix="%"
              format={(v) => (v * 100).toFixed(1)}
            />
            <LeverRow
              label={
                <InfoLabel label={t("goals:sidebar.taxes.penalty_cutoff_age")}>
                  {t("goals:sidebar.taxes.penalty_cutoff_age_edit_tip")}
                </InfoLabel>
              }
              value={draft.tax?.earlyWithdrawalPenaltyAge ?? 59}
              onChange={(v) => setTax("earlyWithdrawalPenaltyAge", Math.round(v))}
              min={draft.personal.currentAge}
              max={draft.personal.planningHorizonAge}
              step={1}
              format={(v) => String(Math.round(v))}
            />
          </div>
        }
      />

      {/* ── Eligible Accounts ── */}
      {goalId && (
        <GoalFundingEditor
          goalId={goalId}
          goalType="retirement"
          dcLinkedAccountIds={dcLinkedAccountIds}
          editing={editingSection === "funding"}
          onEditingChange={(next) => setEditingSection(next ? "funding" : null)}
        />
      )}
    </div>
  );
}
