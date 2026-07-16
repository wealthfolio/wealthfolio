import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  AnimatedToggleGroup,
  Page,
  PageContent,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { ActionPalette, type ActionPaletteGroup } from "@/components/action-palette";
import {
  useGoalDetail,
  useGoalPlanMutations,
  useRetirementOverview,
  useSaveUpOverview,
} from "../hooks/use-goal-detail";
import { useGoalMutations } from "../hooks/use-goals";
import { useSettingsContext } from "@/lib/settings-provider";
import type { PlannerMode, RetirementOverview } from "@/lib/types";
import type { RetirementPlan } from "@/features/goals/retirement-planner/types";
import {
  parseSettingsJson,
  DEFAULT_RETIREMENT_PLAN,
  normalizeRetirementPlan,
} from "@/features/goals/retirement-planner/lib/plan-adapter";
import { usePortfolioData } from "@/features/goals/retirement-planner/hooks/use-portfolio";
import DashboardPage from "@/features/goals/retirement-planner/pages/dashboard-page";
import RiskLabPage from "@/features/goals/retirement-planner/pages/risk-lab-page";
import SaveUpDetailPage from "../save-up/components/save-up-detail";
import { GoalEditDialog } from "../components/goal-edit-dialog";

const GOAL_TYPE_KEYS: Record<string, string> = {
  retirement: "type.retirement",
  education: "type.education",
  home: "type.home",
  car: "type.car",
  wedding: "type.wedding",
  custom_save_up: "type.custom_save_up",
};

export default function GoalDetailPage() {
  const { t } = useTranslation();
  const { goalId } = useParams<{ goalId: string }>();
  const navigate = useNavigate();

  const { goal, plan, fundingRules, isLoading, error } = useGoalDetail(goalId);
  const { savePlanMutation } = useGoalPlanMutations(goalId ?? "");
  const { mutate: savePlan } = savePlanMutation;
  const { deleteMutation } = useGoalMutations();
  const { settings } = useSettingsContext();

  const isRetirement = goal?.goalType === "retirement";
  const isSaveUp = goal && !isRetirement;
  const baseCurrency = settings?.baseCurrency ?? goal?.currency ?? "USD";

  // Fetch backend-computed retirement overview when a retirement plan exists
  const retirementOverviewQuery = useRetirementOverview(isRetirement && plan ? goalId : undefined);
  const { data: retirementOverview } = retirementOverviewQuery;

  // Fetch backend-computed save-up overview when this is a save-up goal
  const { data: saveUpOverview } = useSaveUpOverview(isSaveUp ? goalId : undefined);

  const eligibleAccountIds = useMemo(() => fundingRules.map((r) => r.accountId), [fundingRules]);

  // Parse retirement plan from settings JSON
  const retirementPlan: RetirementPlan = useMemo(() => {
    if (!plan?.settingsJson || plan.planKind !== "retirement") {
      return { ...DEFAULT_RETIREMENT_PLAN, currency: baseCurrency };
    }
    return { ...parseSettingsJson(plan.settingsJson), currency: baseCurrency };
  }, [baseCurrency, plan]);

  // DC-linked account IDs from retirement plan income streams
  const dcLinkedAccountIds = useMemo(() => {
    return retirementPlan.incomeStreams
      .filter((s) => s.streamType === "dc" && s.linkedAccountId)
      .map((s) => s.linkedAccountId!);
  }, [retirementPlan]);

  // Feed portfolio data from funding-rule-derived accounts
  const portfolioData = usePortfolioData(isRetirement ? eligibleAccountIds : undefined);

  // Retirement pages land on Overview because all primary settings live in the dashboard sidebar.
  const [activeTab, setActiveTab] = useState("overview");

  const handleSaveRetirementPlan = useCallback(
    (updated: RetirementPlan, nextPlannerMode?: PlannerMode) => {
      if (!goalId) return;
      savePlan(
        {
          goalId,
          planKind: "retirement",
          plannerMode: nextPlannerMode ?? plan?.plannerMode ?? "traditional",
          settingsJson: JSON.stringify(
            normalizeRetirementPlan({ ...updated, currency: baseCurrency }),
          ),
        },
        {
          onSuccess: () => {
            // Backend auto-refreshes summary after plan save
          },
        },
      );
    },
    [baseCurrency, goalId, plan?.plannerMode, savePlan],
  );

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionPaletteOpen, setActionPaletteOpen] = useState(false);

  const handleDelete = () => {
    if (!goalId) return;
    deleteMutation.mutate(goalId, {
      onSuccess: () => navigate("/goals"),
    });
  };

  if (isLoading) {
    return (
      <Page>
        <PageHeader heading={t("common:loading")} />
        <PageContent>
          <Skeleton className="h-64 w-full" />
        </PageContent>
      </Page>
    );
  }

  if (error || !goal) {
    return (
      <Page>
        <PageHeader heading={t("goals:detail.not_found_title")} />
        <PageContent>
          <div className="flex flex-col items-center gap-4 py-24">
            <p className="text-muted-foreground">{t("goals:detail.not_found_body")}</p>
            <Button onClick={() => navigate("/goals")}>{t("goals:detail.back_to_goals")}</Button>
          </div>
        </PageContent>
      </Page>
    );
  }

  const typeKey = GOAL_TYPE_KEYS[goal.goalType];
  const typeLabel = typeKey ? t(`goals:${typeKey}`) : t("goals:detail.goal_fallback");
  const actionGroups = [
    {
      items: [
        {
          icon: Icons.Settings2,
          label: t("goals:detail.edit_goal"),
          onClick: () => setEditOpen(true),
        },
        {
          icon: Icons.Trash,
          label: t("goals:detail.delete_goal"),
          onClick: () => setDeleteOpen(true),
          variant: "destructive",
        },
      ],
    },
  ] satisfies ActionPaletteGroup[];
  const hasRetirementTabs = isRetirement && Boolean(plan);
  const retirementTabItems = [
    {
      value: "overview",
      label: (
        <span className="flex items-center gap-2">
          <Icons.CircleGauge className="size-3.5" />
          {t("goals:detail.tab_overview")}
        </span>
      ),
    },
    {
      value: "risk-lab",
      label: (
        <span className="flex items-center gap-2">
          <Icons.ShieldAlert className="size-3.5" />
          {t("goals:detail.tab_what_if")}
        </span>
      ),
    },
  ];
  const retirementTabs = hasRetirementTabs ? (
    <div className="hidden md:block">
      <AnimatedToggleGroup
        variant="default"
        size="sm"
        rounded="full"
        className="bg-muted/60 p-1"
        items={retirementTabItems}
        value={activeTab}
        onValueChange={setActiveTab}
      />
    </div>
  ) : null;
  const retirementGuideAction =
    hasRetirementTabs && goalId ? (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-9 w-9 rounded-full"
        aria-label={t("goals:detail.open_retirement_guide")}
        onClick={() => navigate(`/goals/${goalId}/guide`)}
      >
        <Icons.HelpCircle className="size-4" />
      </Button>
    ) : null;
  const mobileRetirementTabs = hasRetirementTabs ? (
    <div className="mb-4 overflow-x-auto pb-1 md:hidden">
      <AnimatedToggleGroup
        variant="default"
        size="sm"
        rounded="full"
        className="bg-muted/60 p-1"
        items={retirementTabItems}
        value={activeTab}
        onValueChange={setActiveTab}
      />
    </div>
  ) : null;
  const headerActions = (
    <div className="flex items-center gap-2">
      {retirementGuideAction}
      {retirementTabs}
      {goal.statusLifecycle === "achieved" && (
        <Badge variant="default">{t("goals:detail.achieved")}</Badge>
      )}
      <ActionPalette
        open={actionPaletteOpen}
        onOpenChange={setActionPaletteOpen}
        title={goal.title}
        groups={actionGroups}
      />
    </div>
  );
  const content = (
    <>
      <PageHeader
        heading={goal.title}
        text={
          goal.description
            ? t("goals:detail.header_with_description", {
                type: typeLabel,
                description: goal.description,
              })
            : t("goals:detail.header", { type: typeLabel })
        }
        onBack={() => navigate("/goals")}
        actions={headerActions}
      />
      {goal && <GoalEditDialog goal={goal} open={editOpen} onClose={() => setEditOpen(false)} />}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("goals:detail.delete_goal")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("goals:detail.delete_confirm", { title: goal.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {t("goals:detail.deleting")}
                </>
              ) : (
                t("common:delete")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PageContent>
        {isRetirement ? (
          plan ? (
            <>
              {mobileRetirementTabs}
              <RetirementDetail
                onTabChange={setActiveTab}
                plan={retirementPlan}
                portfolioData={portfolioData}
                onSavePlan={handleSaveRetirementPlan}
                plannerMode={plan.plannerMode ?? "traditional"}
                goalId={goalId!}
                dcLinkedAccountIds={dcLinkedAccountIds}
                retirementOverview={retirementOverview}
                retirementOverviewError={retirementOverviewQuery.error}
                retirementOverviewIsFetching={retirementOverviewQuery.isFetching}
              />
            </>
          ) : (
            <div className="space-y-3">
              <Skeleton className="h-10 w-64" />
              <Skeleton className="h-64 w-full" />
            </div>
          )
        ) : isSaveUp ? (
          <SaveUpDetailPage goal={goal} plan={plan} overview={saveUpOverview} />
        ) : (
          <div className="flex flex-col items-center gap-4 py-12">
            <p className="text-muted-foreground text-sm">{t("goals:detail.no_plan_yet")}</p>
          </div>
        )}
      </PageContent>
    </>
  );

  return (
    <Page>
      {hasRetirementTabs ? (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="contents">
          {content}
        </Tabs>
      ) : (
        content
      )}
    </Page>
  );
}

function RetirementDetail({
  onTabChange,
  plan,
  portfolioData,
  onSavePlan,
  plannerMode,
  goalId,
  dcLinkedAccountIds,
  retirementOverview,
  retirementOverviewError,
  retirementOverviewIsFetching,
}: {
  onTabChange: (tab: string) => void;
  plan: RetirementPlan;
  portfolioData: ReturnType<typeof usePortfolioData>;
  onSavePlan: (p: RetirementPlan, plannerMode?: PlannerMode) => void;
  plannerMode: PlannerMode;
  goalId: string;
  dcLinkedAccountIds: string[];
  retirementOverview?: RetirementOverview;
  retirementOverviewError?: Error | null;
  retirementOverviewIsFetching?: boolean;
}) {
  return (
    <>
      <TabsContent value="overview">
        <DashboardPage
          plan={plan}
          portfolioData={portfolioData}
          isLoading={portfolioData.isLoading}
          plannerMode={plannerMode}
          onSavePlan={onSavePlan}
          onNavigateToTab={onTabChange}
          retirementOverview={retirementOverview}
          retirementOverviewError={retirementOverviewError}
          retirementOverviewIsFetching={retirementOverviewIsFetching}
          goalId={goalId}
          dcLinkedAccountIds={dcLinkedAccountIds}
        />
      </TabsContent>

      <TabsContent value="risk-lab">
        <RiskLabPage
          plan={plan}
          totalValue={portfolioData.totalValue}
          isLoading={portfolioData.isLoading}
          retirementOverview={retirementOverview}
          plannerMode={plannerMode}
          goalId={goalId}
        />
      </TabsContent>
    </>
  );
}
