import type { Goal } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button, Input, Label } from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n/i18n-provider";
import { useGoalMutations } from "../hooks/use-goals";

const GOAL_TYPE_LABELS: Record<Goal["goalType"], string> = {
  retirement: "Retirement",
  education: "Education",
  home: "Home Purchase",
  car: "Car Purchase",
  wedding: "Wedding",
  custom_save_up: "Savings Goal",
};

const LIFECYCLE_OPTIONS: {
  value: Goal["statusLifecycle"];
  label: string;
  hint: string;
  description: string;
  icon: typeof Icons.Target;
}[] = [
  {
    value: "active",
    label: "Active",
    hint: "Still in progress",
    description: "Shows in planning, progress, and active goal lists.",
    icon: Icons.Target,
  },
  {
    value: "achieved",
    label: "Completed",
    hint: "Goal is done",
    description: "Marks the goal complete and releases its assigned account shares.",
    icon: Icons.CheckCircle,
  },
  {
    value: "archived",
    hint: "Hide from active goals",
    label: "Archived",
    description: "Keeps the goal for reference, but removes it from active planning.",
    icon: Icons.FileArchive,
  },
];

interface Props {
  goal: Goal;
  open: boolean;
  onClose: () => void;
}

export function GoalEditDialog({ goal, open, onClose }: Props) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const { updateMutation } = useGoalMutations();
  const [title, setTitle] = useState(goal.title);
  const [description, setDescription] = useState(goal.description ?? "");
  const [lifecycle, setLifecycle] = useState<Goal["statusLifecycle"]>(goal.statusLifecycle);

  useEffect(() => {
    if (!open) return;
    setTitle(goal.title);
    setDescription(goal.description ?? "");
    setLifecycle(goal.statusLifecycle);
  }, [goal, open]);

  const isRetirement = goal.goalType === "retirement";
  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const goalTypeLabels = isChinese
    ? {
        retirement: "退休",
        education: "教育",
        home: "购房",
        car: "购车",
        wedding: "婚礼",
        custom_save_up: "储蓄目标",
      }
    : GOAL_TYPE_LABELS;
  const lifecycleLabels = {
    active: isChinese
      ? {
          label: "进行中",
          hint: "仍在推进",
          description: "显示在规划、进度和活跃目标列表中。",
        }
      : LIFECYCLE_OPTIONS[0],
    achieved: isChinese
      ? {
          label: "已完成",
          hint: "目标已完成",
          description: "将目标标记为完成，并释放已分配的账户份额。",
        }
      : LIFECYCLE_OPTIONS[1],
    archived: isChinese
      ? {
          label: "已归档",
          hint: "从活跃目标隐藏",
          description: "保留目标用于参考，但从活跃规划中移除。",
        }
      : LIFECYCLE_OPTIONS[2],
  };

  const handleSave = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedTitle) return;

    updateMutation.mutate(
      {
        ...goal,
        title: trimmedTitle,
        description: trimmedDescription || undefined,
        statusLifecycle: lifecycle,
      },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={handleSave} className="space-y-6">
          <DialogHeader>
            <DialogTitle>{isChinese ? "编辑目标" : "Edit goal"}</DialogTitle>
            <DialogDescription>
              {isChinese ? (
                <>
                  更新目标名称、备注和状态。已完成表示目标已达成；已归档表示从活跃目标中隐藏但不删除。
                  {isRetirement
                    ? " 退休假设、支出、税费和账户份额会保留在规划器中。"
                    : " 目标金额、目标日期和资金安排会保留在目标计划中。"}
                </>
              ) : (
                <>
                  Update the goal name, notes, and status. Completed means the goal is done.
                  Archived means you want to hide it from active goals without deleting it.{" "}
                  {isRetirement
                    ? "Retirement assumptions, spending, taxes, and account shares stay in the planner."
                    : "Target amount, target date, and funding stay in the goal plan."}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="bg-muted/30 rounded-xl border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{isChinese ? "目标类型" : "Goal type"}</p>
                  <p className="text-muted-foreground text-xs">
                    {isChinese
                      ? "创建后固定，确保规划逻辑保持一致。"
                      : "Fixed after creation so the planner logic stays consistent."}
                  </p>
                </div>
                <Badge variant="secondary">{goalTypeLabels[goal.goalType]}</Badge>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="goal-title">{isChinese ? "标题" : "Title"}</Label>
              <Input
                id="goal-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={isChinese ? "目标名称" : "Goal name"}
                autoFocus
              />
              {!trimmedTitle && (
                <p className="text-destructive text-xs">
                  {isChinese ? "请输入标题。" : "Title is required."}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="goal-description">{isChinese ? "备注" : "Notes"}</Label>
              <Textarea
                id="goal-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={isChinese ? "此目标的可选说明" : "Optional context for this goal"}
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label>{isChinese ? "目标状态" : "Goal status"}</Label>
              <p className="text-muted-foreground text-xs">
                {isChinese
                  ? "选择下一步：继续推进、标记完成，或从活跃规划中隐藏。"
                  : "Choose what should happen next: keep working on it, mark it done, or hide it from active planning."}
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                {LIFECYCLE_OPTIONS.map((option) => {
                  const selected = lifecycle === option.value;
                  const Icon = option.icon;
                  const display = lifecycleLabels[option.value];

                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setLifecycle(option.value)}
                      className={cn(
                        "rounded-xl border p-4 text-left transition-colors",
                        "focus-visible:ring-ring focus:outline-none focus-visible:ring-2",
                        selected
                          ? "border-primary bg-primary/5"
                          : "border-border/70 bg-card hover:bg-accent",
                      )}
                    >
                      <span className="mb-3 flex items-center gap-2">
                        <span
                          className={cn(
                            "bg-muted inline-flex h-8 w-8 items-center justify-center rounded-full",
                            option.value === "achieved" && "text-green-600",
                            option.value === "active" && "text-primary",
                          )}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
                          {display.hint}
                        </span>
                      </span>
                      <span className="block text-sm font-medium">{display.label}</span>
                      <span className="text-muted-foreground mt-1.5 block text-xs leading-relaxed">
                        {display.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {isChinese ? "取消" : "Cancel"}
            </Button>
            <Button type="submit" disabled={updateMutation.isPending || !trimmedTitle}>
              {updateMutation.isPending
                ? isChinese
                  ? "保存中..."
                  : "Saving..."
                : isChinese
                  ? "保存更改"
                  : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
