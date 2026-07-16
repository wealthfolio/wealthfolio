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
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGoalMutations } from "../hooks/use-goals";

interface Props {
  goal: Goal;
  open: boolean;
  onClose: () => void;
}

export function GoalEditDialog({ goal, open, onClose }: Props) {
  const { t } = useTranslation();
  const { updateMutation } = useGoalMutations();

  const goalTypeLabels = useMemo<Record<Goal["goalType"], string>>(
    () => ({
      retirement: t("goals:edit.type_retirement"),
      education: t("goals:edit.type_education"),
      home: t("goals:edit.type_home"),
      car: t("goals:edit.type_car"),
      wedding: t("goals:edit.type_wedding"),
      custom_save_up: t("goals:edit.type_custom_save_up"),
    }),
    [t],
  );

  const lifecycleOptions = useMemo<
    {
      value: Goal["statusLifecycle"];
      label: string;
      hint: string;
      description: string;
      icon: typeof Icons.Target;
    }[]
  >(
    () => [
      {
        value: "active",
        label: t("goals:edit.lifecycle_active_label"),
        hint: t("goals:edit.lifecycle_active_hint"),
        description: t("goals:edit.lifecycle_active_description"),
        icon: Icons.Target,
      },
      {
        value: "achieved",
        label: t("goals:edit.lifecycle_achieved_label"),
        hint: t("goals:edit.lifecycle_achieved_hint"),
        description: t("goals:edit.lifecycle_achieved_description"),
        icon: Icons.CheckCircle,
      },
      {
        value: "archived",
        hint: t("goals:edit.lifecycle_archived_hint"),
        label: t("goals:edit.lifecycle_archived_label"),
        description: t("goals:edit.lifecycle_archived_description"),
        icon: Icons.FileArchive,
      },
    ],
    [t],
  );

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
            <DialogTitle>{t("goals:edit.title")}</DialogTitle>
            <DialogDescription>
              {t("goals:edit.description")}{" "}
              {isRetirement
                ? t("goals:edit.description_retirement")
                : t("goals:edit.description_standard")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="bg-muted/30 rounded-xl border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{t("goals:edit.goal_type")}</p>
                  <p className="text-muted-foreground text-xs">{t("goals:edit.goal_type_hint")}</p>
                </div>
                <Badge variant="secondary">{goalTypeLabels[goal.goalType]}</Badge>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="goal-title">{t("goals:edit.title_label")}</Label>
              <Input
                id="goal-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("goals:edit.title_placeholder")}
                autoFocus
              />
              {!trimmedTitle && (
                <p className="text-destructive text-xs">{t("goals:edit.title_required")}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="goal-description">{t("goals:edit.notes_label")}</Label>
              <Textarea
                id="goal-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("goals:edit.notes_placeholder")}
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label>{t("goals:edit.status_label")}</Label>
              <p className="text-muted-foreground text-xs">{t("goals:edit.status_hint")}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {lifecycleOptions.map((option) => {
                  const selected = lifecycle === option.value;
                  const Icon = option.icon;

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
                          {option.hint}
                        </span>
                      </span>
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="text-muted-foreground mt-1.5 block text-xs leading-relaxed">
                        {option.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common:cancel")}
            </Button>
            <Button type="submit" disabled={updateMutation.isPending || !trimmedTitle}>
              {updateMutation.isPending ? t("goals:edit.saving") : t("goals:edit.save_changes")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
