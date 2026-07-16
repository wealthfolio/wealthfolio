import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button, Icons } from "@wealthfolio/ui";

import {
  useCategorizationRules,
  useRulePresets,
} from "@/features/spending/hooks/use-categorization-rules";
import { PRESET_FLAGS } from "@/features/spending/components/rule-preset-constants";

export function RulesOverviewCard() {
  const { t } = useTranslation();
  const {
    data: rules = [],
    isLoading: rulesLoading,
    isError: rulesErrored,
  } = useCategorizationRules();
  const {
    data: presets = [],
    isLoading: presetsLoading,
    isError: presetsErrored,
  } = useRulePresets();
  const isLoading = rulesLoading || presetsLoading;

  const total = rules.length;

  const presetRules = useMemo(() => {
    const counts = new Map<string, number>();
    rules.forEach((r) => {
      if (r.presetId) counts.set(r.presetId, (counts.get(r.presetId) ?? 0) + 1);
    });
    return presets
      .filter((p) => p.installed)
      .map((p) => ({
        id: p.presetId,
        name: p.name,
        flag: PRESET_FLAGS[p.presetId] ?? "🌐",
        count: counts.get(p.presetId) ?? p.ruleCount,
      }));
  }, [rules, presets]);

  const userRulesCount = useMemo(() => rules.filter((r) => !r.presetId).length, [rules]);

  if (isLoading) {
    return <div className="bg-muted/40 h-44 w-full animate-pulse rounded-lg" />;
  }

  if (rulesErrored || presetsErrored) {
    return (
      <div className="bg-card rounded-lg border p-6">
        <div className="flex items-start gap-3">
          <Icons.AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <h3 className="text-base font-semibold">
              {t("settings:spending.rules_overview.title")}
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("settings:spending.rules_overview.load_error")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="bg-card rounded-lg border p-6">
        <div className="space-y-3">
          <div>
            <h3 className="text-base font-semibold">
              {t("settings:spending.rules_overview.title")}
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("settings:spending.rules_overview.empty_description")}
            </p>
          </div>
          <Button asChild size="sm">
            <Link to="/settings/spending/rules">
              <Icons.Plus className="mr-1.5 h-3.5 w-3.5" />
              {t("settings:spending.rules_overview.setup_cta")}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Link
      to="/settings/spending/rules"
      aria-label={t("settings:spending.rules_overview.open_aria")}
      className="bg-card hover:border-foreground/20 group flex flex-col items-stretch overflow-hidden rounded-lg border transition-all hover:shadow-md sm:flex-row"
    >
      <div className="min-w-0 flex-1 p-6">
        <div className="mb-4">
          <h3 className="text-base font-semibold tracking-tight">
            {t("settings:spending.rules_overview.title")}
          </h3>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("settings:spending.rules_overview.description")}
          </p>
        </div>

        <div className="border-border/60 mb-3.5 grid grid-cols-3 gap-3 border-y py-3.5 sm:flex sm:gap-8">
          <Stat value={total} label={t("settings:spending.rules_overview.stat_total")} />
          <Stat
            value={presetRules.length}
            label={t("settings:spending.rules_overview.stat_regions")}
          />
          <Stat value={userRulesCount} label={t("settings:spending.rules_overview.stat_custom")} />
        </div>

        {presetRules.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {presetRules.map((r) => (
              <span
                key={r.id}
                className="bg-muted/60 border-border/60 text-foreground inline-flex items-center gap-2 rounded-sm border px-2.5 py-1 text-xs"
              >
                <span className="text-sm leading-none">{r.flag}</span>
                <span>{r.name}</span>
                <span className="text-muted-foreground border-border/60 ml-1 border-l pl-2 tabular-nums">
                  {r.count}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="bg-muted/30 group-hover:bg-foreground group-hover:text-background text-muted-foreground flex shrink-0 items-center justify-center gap-1.5 border-t px-4 py-3 text-xs font-medium uppercase tracking-widest transition-colors sm:w-24 sm:flex-col sm:gap-2 sm:border-l sm:border-t-0 sm:px-0 sm:py-0">
        <span>{t("settings:spending.rules_overview.open")}</span>
        <Icons.ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="text-foreground text-xl font-semibold tabular-nums tracking-tight sm:text-2xl">
        {value}
      </div>
      <div className="text-muted-foreground mt-0.5 text-[10px] font-medium uppercase tracking-widest">
        {label}
      </div>
    </div>
  );
}
