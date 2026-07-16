import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Icons, Switch } from "@wealthfolio/ui";

import {
  useSpendingSettings,
  useSpendingSettingsMutation,
} from "@/features/spending/hooks/use-spending-settings";
import { useBudget } from "@/features/spending/hooks/use-budget";
import {
  useCategorizationRules,
  useRulePresets,
} from "@/features/spending/hooks/use-categorization-rules";
import { isSpendingAccountType } from "@/features/spending/lib/constants";
import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";

import { formatAmountWhole } from "./format";

export function ModuleCard() {
  const { t } = useTranslation();
  const { settings, isLoading } = useSpendingSettings();
  const { isBalanceHidden } = useBalancePrivacy();
  const fmt = (amount: number, currency: string) =>
    isBalanceHidden ? "••••" : formatAmountWhole(amount, currency);
  const mutation = useSpendingSettingsMutation();
  const { accounts } = useAccounts({ filterActive: true });
  const { data: budget } = useBudget();
  const { data: rules, isError: rulesErrored } = useCategorizationRules();
  const { data: presets, isError: presetsErrored } = useRulePresets();

  const enabled = settings?.enabled ?? false;
  const accountIds = useMemo(() => settings?.accountIds ?? [], [settings?.accountIds]);

  const spendingAccounts = useMemo<Account[]>(
    () => (accounts ?? []).filter((a) => isSpendingAccountType(a.accountType)),
    [accounts],
  );
  const tracked = useMemo(
    () => spendingAccounts.filter((a) => accountIds.includes(a.id)),
    [spendingAccounts, accountIds],
  );

  const handleToggle = (next: boolean) => {
    let nextIds = accountIds;
    if (next && accountIds.length === 0 && spendingAccounts.length > 0) {
      nextIds = spendingAccounts.map((a) => a.id);
    }
    mutation.mutate({ enabled: next, accountIds: nextIds });
  };

  // Spending-accounts subline: dominant type · currency
  const trackedSummary = useMemo(() => {
    if (tracked.length === 0) return t("settings:spending.module.no_accounts_tracked");
    const currencies = Array.from(new Set(tracked.map((a) => a.currency)));
    const types = Array.from(new Set(tracked.map((a) => a.accountType)));
    const typeLabel =
      types.length === 1
        ? types[0] === "CREDIT_CARD"
          ? t("settings:spending.module.type_credit_card")
          : types[0] === "CASH"
            ? t("settings:spending.module.type_cash")
            : t("settings:spending.module.type_mixed")
        : t("settings:spending.module.type_mixed");
    return `${typeLabel} · ${currencies.join(" · ")}`;
  }, [tracked, t]);

  // Rules + region count (regions = installed country presets)
  const rulesUnavailable = rulesErrored || presetsErrored;
  const ruleCount = rules?.length ?? 0;
  const regionCount = useMemo(() => (presets ?? []).filter((p) => p.installed).length, [presets]);

  // Budget totals
  const spendingPlanned = budget?.computed.totals.spendingPlanned ?? 0;
  const incomePlanned = budget?.computed.totals.incomePlanned ?? 0;
  const currency = budget?.computed.currency ?? "USD";
  const plannedPct = incomePlanned > 0 ? Math.round((spendingPlanned / incomePlanned) * 100) : null;
  const overPlan = plannedPct !== null && plannedPct > 100;

  const activeGroups = useMemo(
    () =>
      (budget?.computed.groupRows ?? []).filter((row) => row.plannedTotal > 0 || row.actual > 0),
    [budget?.computed.groupRows],
  );

  const groupNamesSubline = useMemo(() => {
    if (activeGroups.length === 0) return "—";
    return (
      activeGroups
        .slice(0, 3)
        .map((g) => g.group.name)
        .join(" · ") + (activeGroups.length > 3 ? "…" : "")
    );
  }, [activeGroups]);

  return (
    <section
      aria-label={t("settings:spending.module.tracker_status_aria")}
      className="bg-foreground text-background relative overflow-hidden rounded-lg shadow-lg"
    >
      <div className="p-5 sm:px-7 sm:py-6">
        {/* Top row: state pulse + master toggle share the full row so the
            headline below gets full width on mobile. */}
        <div className="flex items-center justify-between gap-3">
          <div className="text-background/60 flex min-w-0 items-center gap-2 text-xs font-medium uppercase tracking-widest">
            <span className="relative flex h-2 w-2 shrink-0">
              <span
                className={cn(
                  "absolute inline-flex h-full w-full rounded-full opacity-60",
                  enabled ? "animate-ping bg-green-300" : "bg-background/40",
                )}
              />
              <span
                className={cn(
                  "relative inline-flex h-2 w-2 rounded-full",
                  enabled ? "bg-green-300" : "bg-background/40",
                )}
              />
            </span>
            <span className="text-background truncate font-medium">
              {enabled
                ? t("settings:spending.module.tracking_active")
                : t("settings:spending.module.tracking_disabled")}
            </span>
            {enabled && tracked.length > 0 && (
              <span className="text-background/45 hidden truncate sm:inline">
                · {t("settings:spending.module.account_count", { count: tracked.length })}
              </span>
            )}
          </div>

          <label className="flex shrink-0 cursor-pointer select-none items-center gap-2">
            <span className="text-background/55 hidden text-xs font-medium uppercase tracking-widest sm:inline">
              {enabled
                ? t("settings:spending.module.enabled")
                : t("settings:spending.module.disabled")}
            </span>
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              disabled={isLoading || mutation.isPending}
              className={cn(
                "data-[state=checked]:bg-warning data-[state=unchecked]:bg-background/15",
                "[&_[data-slot=switch-thumb]]:data-[state=checked]:bg-foreground",
                "[&_[data-slot=switch-thumb]]:data-[state=unchecked]:bg-background/40",
              )}
            />
          </label>
        </div>

        {/* Headline + subtitle now span the full width. */}
        <div className="mt-4 text-sm font-medium tracking-tight sm:text-base lg:text-lg">
          {enabled
            ? t("settings:spending.module.headline_enabled", {
                tracked: tracked.length,
                total: spendingAccounts.length,
                count: spendingAccounts.length,
              })
            : t("settings:spending.module.headline_disabled")}
        </div>
        <div className="text-background/50 mt-2 hidden text-xs sm:block">
          {t("settings:spending.module.disable_note")}
        </div>

        {/* Stats grid — only meaningful when tracking is enabled */}
        {enabled && (
          <div className="border-background/10 mt-6 grid grid-cols-2 gap-y-5 border-t pt-5 sm:grid-cols-4">
            <HeroStat
              label={t("settings:spending.module.stat_accounts")}
              value={tracked.length}
              unit={t("settings:spending.module.stat_accounts_unit", {
                count: spendingAccounts.length,
              })}
              sub={trackedSummary}
            />
            <HeroStat
              label={t("settings:spending.module.stat_categorization")}
              value={rulesUnavailable ? "—" : ruleCount}
              unit={
                rulesUnavailable
                  ? undefined
                  : t("settings:spending.module.stat_rules_unit", { count: ruleCount })
              }
              sub={
                rulesUnavailable
                  ? t("settings:spending.module.rules_unavailable")
                  : regionCount > 0
                    ? t("settings:spending.module.region_count", { count: regionCount })
                    : "—"
              }
            />
            <HeroStat
              label={t("settings:spending.module.stat_planned_vs_income")}
              value={plannedPct ?? "—"}
              unit={plannedPct !== null ? "%" : undefined}
              valueClassName={overPlan ? "text-warning" : undefined}
              sub={
                spendingPlanned > 0 || incomePlanned > 0
                  ? `${fmt(spendingPlanned, currency)} / ${fmt(incomePlanned, currency)}`
                  : t("settings:spending.module.setup_budget")
              }
            />
            <HeroStat
              label={t("settings:spending.module.stat_budget_groups")}
              value={activeGroups.length}
              unit={t("settings:spending.module.stat_active")}
              sub={groupNamesSubline}
              sublineClassName="truncate"
            />
          </div>
        )}

        {/* Categorization rules live in the Automation section at the bottom of
            the page — easy to scroll past. When tracking is on but no rules
            exist yet, surface a direct jump-link from the hero card so users
            don't miss the auto-tagging setup. */}
        {enabled && !rulesUnavailable && ruleCount === 0 && (
          <Link
            to="/settings/spending/rules"
            className="border-warning/30 bg-warning/15 hover:bg-warning/25 group mt-6 flex items-center justify-between gap-3 rounded-md border px-3.5 py-2.5 transition-colors"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <Icons.Sparkles className="text-warning h-4 w-4 shrink-0" aria-hidden />
              <span className="text-background/90 truncate text-xs sm:text-sm">
                {t("settings:spending.module.no_rules_prompt")}
              </span>
            </div>
            <span className="text-background/70 group-hover:text-background flex shrink-0 items-center gap-1 text-xs font-medium uppercase tracking-widest">
              <span className="hidden sm:inline">{t("settings:spending.module.setup_rules")}</span>
              <Icons.ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        )}
      </div>
    </section>
  );
}

interface HeroStatProps {
  label: string;
  value: number | string;
  unit?: string;
  sub?: string;
  valueClassName?: string;
  sublineClassName?: string;
}

function HeroStat({ label, value, unit, sub, valueClassName, sublineClassName }: HeroStatProps) {
  return (
    <div className="pr-4">
      <div className="text-background/55 text-[10px] font-medium uppercase tracking-widest">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1 tabular-nums">
        <span className={cn("text-2xl font-semibold leading-none tracking-tight", valueClassName)}>
          {value}
        </span>
        {unit && <span className="text-background/55 ml-1 text-xs font-normal">{unit}</span>}
      </div>
      {sub && <div className={cn("text-background/45 mt-1 text-xs", sublineClassName)}>{sub}</div>}
    </div>
  );
}
