import { useMemo } from "react";
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
    if (tracked.length === 0) return "No accounts tracked";
    const currencies = Array.from(new Set(tracked.map((a) => a.currency)));
    const types = Array.from(new Set(tracked.map((a) => a.accountType)));
    const typeLabel =
      types.length === 1
        ? types[0] === "CREDIT_CARD"
          ? "Credit card"
          : types[0] === "CASH"
            ? "Cash"
            : "Mixed"
        : "Mixed";
    return `${typeLabel} · ${currencies.join(" · ")}`;
  }, [tracked]);

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
      aria-label="Tracker status"
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
              {enabled ? "Tracking active" : "Tracking disabled"}
            </span>
            {enabled && tracked.length > 0 && (
              <span className="text-background/45 hidden truncate sm:inline">
                · {tracked.length} account{tracked.length === 1 ? "" : "s"}
              </span>
            )}
          </div>

          <label className="flex shrink-0 cursor-pointer select-none items-center gap-2">
            <span className="text-background/55 hidden text-xs font-medium uppercase tracking-widest sm:inline">
              {enabled ? "Enabled" : "Disabled"}
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
            ? `Tracking ${tracked.length} of ${spendingAccounts.length} cash account${spendingAccounts.length === 1 ? "" : "s"}. Add transactions via import or manual entry.`
            : "Spending tracking is off. Enable to start categorizing cash and credit-card activity."}
        </div>
        <div className="text-background/50 mt-2 hidden text-xs sm:block">
          Disabling hides the spending UI without deleting any data.
        </div>

        {/* Stats grid — only meaningful when tracking is enabled */}
        {enabled && (
          <div className="border-background/10 mt-6 grid grid-cols-2 gap-y-5 border-t pt-5 sm:grid-cols-4">
            <HeroStat
              label="Spending accounts"
              value={tracked.length}
              unit={`of ${spendingAccounts.length} cash`}
              sub={trackedSummary}
            />
            <HeroStat
              label="Categorization"
              value={rulesUnavailable ? "—" : ruleCount}
              unit={rulesUnavailable ? undefined : ruleCount === 1 ? "rule" : "rules"}
              sub={
                rulesUnavailable
                  ? "Rules unavailable"
                  : regionCount > 0
                    ? `${regionCount} region${regionCount === 1 ? "" : "s"}`
                    : "—"
              }
            />
            <HeroStat
              label="Planned vs income"
              value={plannedPct ?? "—"}
              unit={plannedPct !== null ? "%" : undefined}
              valueClassName={overPlan ? "text-warning" : undefined}
              sub={
                spendingPlanned > 0 || incomePlanned > 0
                  ? `${fmt(spendingPlanned, currency)} / ${fmt(incomePlanned, currency)}`
                  : "Set up budget"
              }
            />
            <HeroStat
              label="Budget groups"
              value={activeGroups.length}
              unit={activeGroups.length === 1 ? "active" : "active"}
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
                No categorization rules yet — auto-tag transactions by name pattern.
              </span>
            </div>
            <span className="text-background/70 group-hover:text-background flex shrink-0 items-center gap-1 text-xs font-medium uppercase tracking-widest">
              <span className="hidden sm:inline">Set up rules</span>
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
