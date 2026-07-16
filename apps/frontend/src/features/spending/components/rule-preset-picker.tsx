import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Icons,
} from "@wealthfolio/ui";
import { cn } from "@/lib/utils";

import {
  useCategorizationRules,
  useImportRulePreset,
  useRemoveRulePreset,
  useRulePresets,
} from "../hooks/use-categorization-rules";
import { PRESET_FLAGS } from "./rule-preset-constants";

interface RulePresetPickerProps {
  /** Compact rendering for inline placement on overview cards. */
  compact?: boolean;
}

/**
 * Country picker that seeds the categorization-rules table from a bundled
 * preset (US/CA/GB). Idempotent — re-importing skips already-installed rules.
 * Installed presets expose a remove control that uninstalls them (user-edited
 * rules are detached and kept).
 */
export function RulePresetPicker({ compact = false }: RulePresetPickerProps) {
  const { t } = useTranslation();
  const { data: presets = [], isLoading, isError: presetsErrored } = useRulePresets();
  const { data: rules = [], isError: rulesErrored } = useCategorizationRules();
  const importMutation = useImportRulePreset();
  const removeMutation = useRemoveRulePreset();
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  const presetCounts = useMemo(() => {
    const counts: Record<string, { total: number; modified: number }> = {};
    for (const r of rules) {
      if (!r.presetId) continue;
      const entry = counts[r.presetId] ?? { total: 0, modified: 0 };
      entry.total += 1;
      if (r.presetModified) entry.modified += 1;
      counts[r.presetId] = entry;
    }
    return counts;
  }, [rules]);

  if (isLoading) {
    return <div className="text-muted-foreground text-xs">{t("spending:presets.loading")}</div>;
  }
  if (presetsErrored || rulesErrored) {
    return <div className="text-destructive text-xs">{t("spending:presets.loadError")}</div>;
  }
  if (presets.length === 0) return null;

  const pendingPreset = pendingRemove ? presets.find((p) => p.presetId === pendingRemove) : null;
  const pendingCounts = pendingRemove ? (presetCounts[pendingRemove] ?? null) : null;
  const unmodifiedToRemove = pendingCounts ? pendingCounts.total - pendingCounts.modified : null;

  const busy = importMutation.isPending || removeMutation.isPending;

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {!compact && (
        <div className="space-y-0.5">
          <div className="text-foreground text-sm font-medium">{t("spending:presets.title")}</div>
          <p className="text-muted-foreground text-xs">{t("spending:presets.subtitle")}</p>
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch">
        {presets.map((preset) => {
          const flag = PRESET_FLAGS[preset.presetId] ?? "🌐";
          const isImporting =
            importMutation.isPending && importMutation.variables === preset.presetId;
          const isRemoving =
            removeMutation.isPending && removeMutation.variables === preset.presetId;
          return (
            <div key={preset.presetId} className="group relative">
              <button
                type="button"
                onClick={() => importMutation.mutate(preset.presetId)}
                disabled={busy}
                aria-label={
                  preset.installed
                    ? t("spending:presets.reimportLabel", {
                        name: preset.name,
                        count: preset.ruleCount,
                      })
                    : t("spending:presets.importLabel", {
                        name: preset.name,
                        count: preset.ruleCount,
                      })
                }
                className={cn(
                  "border-input bg-card hover:bg-muted/50 group flex w-full items-center gap-3 rounded-lg border py-2.5 pl-3 text-left transition-colors sm:w-auto sm:min-w-[160px]",
                  "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  preset.installed && "border-success/40 bg-success/5",
                  preset.installed ? "pr-9" : "pr-3",
                )}
              >
                <span className="text-xl leading-none" aria-hidden="true">
                  {flag}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-foreground text-sm font-medium leading-tight">
                    {preset.name}
                  </span>
                  <span className="text-muted-foreground text-[11px] leading-tight">
                    {t("spending:presets.rulesCount", { count: preset.ruleCount })}
                  </span>
                </div>
                {isImporting || isRemoving ? (
                  <Icons.Spinner
                    className="text-muted-foreground h-4 w-4 shrink-0 animate-spin"
                    aria-hidden="true"
                  />
                ) : preset.installed ? (
                  <Icons.Check className="text-success h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Icons.ArrowRight
                    className="text-muted-foreground h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden="true"
                  />
                )}
              </button>
              {preset.installed && !isImporting && !isRemoving && (
                <button
                  type="button"
                  onClick={() => setPendingRemove(preset.presetId)}
                  disabled={busy}
                  aria-label={t("spending:presets.removeLabel", { name: preset.name })}
                  title={t("spending:presets.removeLabel", { name: preset.name })}
                  className={cn(
                    "text-muted-foreground hover:bg-destructive/10 hover:text-destructive absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md transition-all",
                    "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
                    "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
                    "disabled:cursor-not-allowed disabled:opacity-40",
                  )}
                >
                  <Icons.X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("spending:presets.removeTitle", {
                name: pendingPreset?.name ?? t("spending:presets.presetFallback"),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCounts && unmodifiedToRemove !== null ? (
                <>
                  {t("spending:presets.removeCount", { count: unmodifiedToRemove })}
                  {pendingCounts.modified > 0 && (
                    <>
                      {" "}
                      {t("spending:presets.removeKeptEdited", { count: pendingCounts.modified })}
                    </>
                  )}
                </>
              ) : (
                <>{t("spending:presets.removeGeneric")}</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRemove) {
                  removeMutation.mutate(pendingRemove);
                }
                setPendingRemove(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("spending:presets.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
