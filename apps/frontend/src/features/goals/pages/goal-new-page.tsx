import type { Goal, GoalType, PlannerMode } from "@/lib/types";
import { useSettingsContext } from "@/lib/settings-provider";
import { formatDateISO } from "@/lib/utils";
import {
  Button,
  DatePickerInput,
  Input,
  Label,
  MoneyInput,
  Page,
  PageContent,
  PageHeader,
} from "@wealthfolio/ui";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useCreateGoalFlow } from "../hooks/use-create-goal-flow";
import { useGoals } from "../hooks/use-goals";
import { toast } from "sonner";
import {
  DEFAULT_RETIREMENT_PLAN,
  ageFromBirthYearMonth,
  inferBirthYearMonthFromAge,
  normalizeRetirementPlan,
} from "@/features/goals/retirement-planner/lib/plan-adapter";

const DEFAULT_RETIREMENT_CURRENT_AGE = 30;
const DEFAULT_TRADITIONAL_RETIREMENT_AGE = 65;
const DEFAULT_FIRE_INDEPENDENCE_AGE = 50;
const DEFAULT_RETIREMENT_BIRTH_YEAR_MONTH = inferBirthYearMonthFromAge(
  DEFAULT_RETIREMENT_CURRENT_AGE,
);

/** Cover image by convention: /goals/{goalType}.png */
function coverImageSrc(goalType: string): string {
  return `/goals/${goalType}.png`;
}

interface GoalTemplate {
  type: GoalType;
  title: string;
  description: string;
  icon: React.ReactNode;
  defaultTarget: number;
  requiresPlannerMode?: boolean;
}

function hasRetirementGoal(goals: Goal[]): boolean {
  return goals.some((g) => g.goalType === "retirement" && g.statusLifecycle !== "archived");
}

export default function GoalNewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const createGoalFlow = useCreateGoalFlow();
  const { goals } = useGoals();
  const { settings } = useSettingsContext();
  const [selectedType, setSelectedType] = useState<GoalType | null>(null);
  const [plannerMode, setPlannerMode] = useState<PlannerMode>("traditional");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [targetAmount, setTargetAmount] = useState(0);
  const [targetDate, setTargetDate] = useState("");
  const [retirementBirthYearMonth, setRetirementBirthYearMonth] = useState(
    DEFAULT_RETIREMENT_BIRTH_YEAR_MONTH,
  );
  const [retirementTargetAge, setRetirementTargetAge] = useState(
    DEFAULT_TRADITIONAL_RETIREMENT_AGE,
  );

  const goalTemplates = useMemo<GoalTemplate[]>(
    () => [
      {
        type: "retirement",
        title: t("goals:new.template_retirement_title"),
        description: t("goals:new.template_retirement_description"),
        icon: <Icons.Target className="h-6 w-6" />,
        defaultTarget: 0,
        requiresPlannerMode: true,
      },
      {
        type: "education",
        title: t("goals:new.template_education_title"),
        description: t("goals:new.template_education_description"),
        icon: <Icons.Briefcase className="h-6 w-6" />,
        defaultTarget: 50000,
      },
      {
        type: "home",
        title: t("goals:new.template_home_title"),
        description: t("goals:new.template_home_description"),
        icon: <Icons.Home className="h-6 w-6" />,
        defaultTarget: 100000,
      },
      {
        type: "car",
        title: t("goals:new.template_car_title"),
        description: t("goals:new.template_car_description"),
        icon: <Icons.Car className="h-6 w-6" />,
        defaultTarget: 40000,
      },
      {
        type: "wedding",
        title: t("goals:new.template_wedding_title"),
        description: t("goals:new.template_wedding_description"),
        icon: <Icons.Star className="h-6 w-6" />,
        defaultTarget: 30000,
      },
      {
        type: "custom_save_up",
        title: t("goals:new.template_custom_save_up_title"),
        description: t("goals:new.template_custom_save_up_description"),
        icon: <Icons.Wallet className="h-6 w-6" />,
        defaultTarget: 10000,
      },
    ],
    [t],
  );

  const retirementExists = hasRetirementGoal(goals);
  const template = goalTemplates.find((tmpl) => tmpl.type === selectedType);
  const isRetirement = selectedType === "retirement";
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const retirementBirthAge = ageFromBirthYearMonth(retirementBirthYearMonth);
  const retirementCurrentAge = retirementBirthAge ?? DEFAULT_RETIREMENT_CURRENT_AGE;
  const retirementBirthYearMonthForCreate =
    retirementBirthAge == null ? DEFAULT_RETIREMENT_BIRTH_YEAR_MONTH : retirementBirthYearMonth;
  const retirementTargetAgeLabel =
    plannerMode === "fire"
      ? t("goals:new.independence_age_label")
      : t("goals:new.retirement_age_label");
  const retirementTargetAgeDescription =
    plannerMode === "fire"
      ? t("goals:new.independence_age_description")
      : t("goals:new.retirement_age_description");

  const setPlannerModeWithDefaultAge = (mode: PlannerMode) => {
    const defaultAge =
      mode === "fire" ? DEFAULT_FIRE_INDEPENDENCE_AGE : DEFAULT_TRADITIONAL_RETIREMENT_AGE;
    setPlannerMode(mode);
    setRetirementTargetAge(Math.max(retirementCurrentAge + 1, defaultAge));
  };

  const handleSelectType = (type: GoalType) => {
    if (type === "retirement" && retirementExists) {
      toast.error(t("goals:new.retirement_exists_error"));
      return;
    }
    const nextTemplate = goalTemplates.find((tmpl) => tmpl.type === type);
    if (!nextTemplate) return;
    setSelectedType(type);
    setPlannerMode("traditional");
    setTitle(nextTemplate.title);
    setDescription(nextTemplate.description);
    setTargetAmount(nextTemplate.defaultTarget);
    setTargetDate("");
    setRetirementBirthYearMonth(DEFAULT_RETIREMENT_BIRTH_YEAR_MONTH);
    setRetirementTargetAge(DEFAULT_TRADITIONAL_RETIREMENT_AGE);
  };

  const handleCreate = () => {
    if (!selectedType || !template || !trimmedTitle) return;

    const goalInput = {
      goalType: selectedType,
      title: trimmedTitle,
      description: trimmedDescription || undefined,
      targetAmount: isRetirement ? undefined : Math.max(0, targetAmount),
      coverImageKey: selectedType,
      currency: baseCurrency,
      targetDate: !isRetirement && targetDate ? targetDate : undefined,
    };

    const initialPlan = isRetirement
      ? {
          planKind: "retirement" as const,
          plannerMode,
          settingsJson: JSON.stringify(
            normalizeRetirementPlan({
              ...DEFAULT_RETIREMENT_PLAN,
              currency: baseCurrency,
              personal: {
                ...DEFAULT_RETIREMENT_PLAN.personal,
                birthYearMonth: retirementBirthYearMonthForCreate,
                currentAge: retirementCurrentAge,
                targetRetirementAge: Math.max(retirementCurrentAge + 1, retirementTargetAge),
                planningHorizonAge: Math.max(
                  DEFAULT_RETIREMENT_PLAN.personal.planningHorizonAge,
                  retirementTargetAge + 1,
                ),
              },
            }),
          ),
        }
      : undefined;

    createGoalFlow.mutate(
      {
        goal: goalInput,
        initialPlan,
      },
      {
        onSuccess: ({ goal }) => {
          navigate(`/goals/${goal.id}`);
        },
      },
    );
  };

  return (
    <Page>
      <PageHeader
        heading={t("goals:new.create_goal")}
        text={t("goals:new.subtitle")}
        onBack={() => navigate("/goals")}
      />
      <PageContent>
        {!selectedType ? (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {goalTemplates.map((tmpl) => {
              const disabled = tmpl.type === "retirement" && retirementExists;
              return (
                <div
                  key={tmpl.type}
                  className={`border-border/60 bg-card shadow-xs group overflow-hidden rounded-xl border transition-all ${
                    disabled
                      ? "cursor-not-allowed opacity-50"
                      : "hover:border-border cursor-pointer hover:shadow-md"
                  }`}
                  onClick={() => handleSelectType(tmpl.type)}
                >
                  <div className="relative h-36 overflow-hidden sm:h-40">
                    <img
                      src={coverImageSrc(tmpl.type)}
                      alt={tmpl.title}
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                      onError={(e) => {
                        e.currentTarget.parentElement!.classList.add("goal-cover-fallback");
                        e.currentTarget.style.display = "none";
                      }}
                    />
                    <div className="bg-secondary/40 hidden h-full w-full items-center justify-center [.goal-cover-fallback>&]:flex">
                      <div className="text-muted-foreground/25">{tmpl.icon}</div>
                    </div>
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/60 to-transparent" />
                    <div className="absolute bottom-3 left-4">
                      <p className="text-base font-semibold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]">
                        {tmpl.title}
                      </p>
                    </div>
                  </div>
                  <CardHeader className="pb-4">
                    <CardDescription className="text-xs leading-relaxed">
                      {tmpl.description}
                      {disabled && (
                        <span className="text-muted-foreground mt-1 block text-[11px]">
                          {t("goals:new.retirement_exists_hint")}
                        </span>
                      )}
                    </CardDescription>
                  </CardHeader>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-full">
                    {template?.icon}
                  </div>
                  <div>
                    <CardTitle className="text-base">{template?.title}</CardTitle>
                    <CardDescription className="text-xs">{template?.description}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="goal-title">{t("goals:new.title_label")}</Label>
                    <Input
                      id="goal-title"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder={t("goals:new.title_placeholder")}
                      autoFocus
                    />
                    {!trimmedTitle && (
                      <p className="text-destructive text-xs">{t("goals:new.title_required")}</p>
                    )}
                  </div>

                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="goal-description">{t("goals:new.description_label")}</Label>
                    <Textarea
                      id="goal-description"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder={t("goals:new.description_placeholder")}
                      rows={3}
                    />
                  </div>

                  {template?.requiresPlannerMode && (
                    <div className="border-border/60 space-y-3 border-t pt-4 sm:col-span-2">
                      <div>
                        <p className="text-sm font-medium">{t("goals:new.planning_style")}</p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {t("goals:new.planning_style_hint")}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          className={`rounded-xl border p-3 text-left transition-colors ${
                            plannerMode === "traditional"
                              ? "border-primary bg-primary/5"
                              : "border-border/60 hover:border-muted-foreground/60"
                          }`}
                          onClick={() => setPlannerModeWithDefaultAge("traditional")}
                        >
                          <p className="text-sm font-medium">
                            {t("goals:new.planner_traditional")}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {t("goals:new.planner_traditional_hint")}
                          </p>
                        </button>
                        <button
                          type="button"
                          className={`rounded-xl border p-3 text-left transition-colors ${
                            plannerMode === "fire"
                              ? "border-primary bg-primary/5"
                              : "border-border/60 hover:border-muted-foreground/60"
                          }`}
                          onClick={() => setPlannerModeWithDefaultAge("fire")}
                        >
                          <p className="text-sm font-medium">{t("goals:new.planner_fire")}</p>
                          <p className="text-muted-foreground text-xs">
                            {t("goals:new.planner_fire_hint")}
                          </p>
                        </button>
                      </div>
                    </div>
                  )}

                  {isRetirement && (
                    <div className="border-border/60 space-y-4 border-t pt-4 sm:col-span-2">
                      <div>
                        <p className="text-sm font-medium">{t("goals:new.retirement_timeline")}</p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {t("goals:new.retirement_timeline_hint")}
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="retirement-birth-month">
                            {t("goals:new.birth_month")}
                          </Label>
                          <Input
                            id="retirement-birth-month"
                            type="month"
                            value={retirementBirthYearMonth}
                            onChange={(event) => {
                              const next = event.target.value;
                              const nextAge = ageFromBirthYearMonth(next);
                              setRetirementBirthYearMonth(next);
                              if (nextAge != null) {
                                setRetirementTargetAge((prev) => Math.max(nextAge + 1, prev));
                              }
                            }}
                            className="w-full"
                          />
                          <p className="text-muted-foreground mt-1 text-xs">
                            {t("goals:new.current_age", { age: retirementCurrentAge })}
                          </p>
                        </div>
                        <AgeNumberField
                          label={retirementTargetAgeLabel}
                          description={retirementTargetAgeDescription}
                          value={retirementTargetAge}
                          min={retirementCurrentAge + 1}
                          max={100}
                          onChange={(next) =>
                            setRetirementTargetAge(Math.max(retirementCurrentAge + 1, next))
                          }
                        />
                      </div>
                    </div>
                  )}

                  {!isRetirement && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="goal-target-amount">{t("goals:new.target_amount")}</Label>
                        <MoneyInput
                          name="goal-target-amount"
                          value={targetAmount}
                          onValueChange={(value) => setTargetAmount(value ?? 0)}
                          thousandSeparator
                          maxDecimalPlaces={2}
                          className="w-full"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="goal-target-date">{t("goals:new.target_date")}</Label>
                        <DatePickerInput
                          id="goal-target-date"
                          value={targetDate}
                          onChange={(date) => setTargetDate(date ? formatDateISO(date) : "")}
                        />
                      </div>

                      <div className="text-muted-foreground flex items-end text-xs leading-relaxed">
                        {t("goals:new.funding_hint")}
                      </div>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setSelectedType(null);
                  setTitle("");
                  setDescription("");
                  setTargetDate("");
                  setPlannerMode("traditional");
                  setRetirementBirthYearMonth(DEFAULT_RETIREMENT_BIRTH_YEAR_MONTH);
                  setRetirementTargetAge(DEFAULT_TRADITIONAL_RETIREMENT_AGE);
                }}
              >
                {t("common:back")}
              </Button>
              <Button
                className="flex-1"
                onClick={handleCreate}
                disabled={createGoalFlow.isPending || !trimmedTitle}
              >
                {createGoalFlow.isPending ? t("goals:new.creating") : t("goals:new.create_goal")}
              </Button>
            </div>
          </div>
        )}
      </PageContent>
    </Page>
  );
}

function AgeNumberField({
  label,
  description,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const clampedValue = Math.min(max, Math.max(min, value));
  const [draftValue, setDraftValue] = useState(String(clampedValue));
  const [inputFocused, setInputFocused] = useState(false);

  useEffect(() => {
    if (!inputFocused) {
      setDraftValue(String(clampedValue));
    }
  }, [clampedValue, inputFocused]);

  const commitDraftValue = () => {
    const raw = draftValue.trim();
    if (!raw) {
      setDraftValue(String(clampedValue));
      return;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setDraftValue(String(clampedValue));
      return;
    }

    const next = Math.min(max, Math.max(min, Math.round(parsed)));
    onChange(next);
    setDraftValue(String(next));
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={`retirement-${label.toLowerCase().replace(/\s+/g, "-")}`}>{label}</Label>
      <Input
        id={`retirement-${label.toLowerCase().replace(/\s+/g, "-")}`}
        type="text"
        inputMode="numeric"
        value={draftValue}
        onFocus={() => {
          setInputFocused(true);
          setDraftValue(String(clampedValue));
        }}
        onChange={(event) => {
          const next = event.target.value;
          if (/^\d*$/.test(next)) {
            setDraftValue(next);
          }
        }}
        onBlur={() => {
          setInputFocused(false);
          commitDraftValue();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraftValue(String(clampedValue));
            event.currentTarget.blur();
          }
        }}
        className="w-full tabular-nums"
      />
      <p className="text-muted-foreground mt-1 text-xs">{description}</p>
    </div>
  );
}
