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
import { useNavigate, useParams } from "react-router-dom";
import { ActionPalette, type ActionPaletteGroup } from "@/components/action-palette";
import { useI18n } from "@/i18n/i18n-provider";
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

const GOAL_TYPE_LABELS: Record<string, string> = {
  retirement: "Retirement",
  education: "Education",
  home: "Home Purchase",
  car: "Car Purchase",
  wedding: "Wedding",
  custom_save_up: "Savings Goal",
};

export default function GoalDetailPage() {
  const { goalId } = useParams<{ goalId: string }>();
  const navigate = useNavigate();

  const { goal, plan, fundingRules, isLoading, error } = useGoalDetail(goalId);
  const { savePlanMutation } = useGoalPlanMutations(goalId ?? "");
  const { mutate: savePlan } = savePlanMutation;
  const { deleteMutation } = useGoalMutations();
  const { settings } = useSettingsContext();
  const { language } = useI18n();
  const isChinese = language === "zh-CN";

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
        <PageHeader heading="Loading..." />
        <PageContent>
          <Skeleton className="h-64 w-full" />
        </PageContent>
      </Page>
    );
  }

  if (error || !goal) {
    return (
      <Page>
        <PageHeader heading="Goal not found" />
        <PageContent>
          <div className="flex flex-col items-center gap-4 py-24">
            <p className="text-muted-foreground">This goal could not be found.</p>
            <Button onClick={() => navigate("/goals")}>Back to Goals</Button>
          </div>
        </PageContent>
      </Page>
    );
  }

  const typeLabel = GOAL_TYPE_LABELS[goal.goalType] ?? "Goal";
  const actionGroups = [
    {
      items: [
        {
          icon: Icons.Settings2,
          label: "Edit goal",
          onClick: () => setEditOpen(true),
        },
        {
          icon: Icons.Trash,
          label: "Delete goal",
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
          Overview
        </span>
      ),
    },
    {
      value: "risk-lab",
      label: (
        <span className="flex items-center gap-2">
          <Icons.ShieldAlert className="size-3.5" />
          What If
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
        aria-label="Open retirement guide"
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
      {goal.statusLifecycle === "achieved" && <Badge variant="default">Achieved</Badge>}
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
        text={goal.description ? `${typeLabel} goal · ${goal.description}` : `${typeLabel} goal`}
        onBack={() => navigate("/goals")}
        actions={headerActions}
      />
      {goal && <GoalEditDialog goal={goal} open={editOpen} onClose={() => setEditOpen(false)} />}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isChinese ? "删除目标" : "Delete goal"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isChinese
                ? `确定要删除“${goal.title}”吗？此操作无法撤销。`
                : `Are you sure you want to delete "${goal.title}"? This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {isChinese ? "取消" : "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {isChinese ? "删除中..." : "Deleting..."}
                </>
              ) : (
                isChinese ? "删除" : "Delete"
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
            <p className="text-muted-foreground text-sm">
              This goal doesn&apos;t have a detailed plan yet.
            </p>
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
