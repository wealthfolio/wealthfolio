import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyPlaceholder,
  Icons,
  Input,
  Skeleton,
} from "@wealthfolio/ui";
import { cn } from "@/lib/utils";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import type { TaxonomyCategory } from "@/lib/types";

import { RuleEditModal } from "@/features/spending/components/rule-edit-modal";
import {
  RuleItem,
  type RuleCategoryMeta,
  type RulePresetMeta,
} from "@/features/spending/components/rule-item";
import { PRESET_FLAGS } from "@/features/spending/components/rule-preset-constants";
import { RulePresetPicker } from "@/features/spending/components/rule-preset-picker";
import type {
  RuleFormCategoryOption,
  RuleFormValues,
} from "@/features/spending/components/rule-form";
import {
  useCategorizationRuleMutations,
  useCategorizationRules,
  useRulePresets,
} from "@/features/spending/hooks/use-categorization-rules";
import { useSpendingSettings } from "@/features/spending/hooks/use-spending-settings";
import type { CategorizationRule } from "@/features/spending/types/rule";

import { SettingsHeader } from "../../settings-header";
import { SpendingBackLink } from "../components/spending-back-link";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";

export default function SpendingRulesPage() {
  const { t } = useTranslation();
  const { isEnabled, isLoading: settingsLoading } = useSpendingSettings();
  const {
    data: rules = [],
    isLoading: rulesLoading,
    isError: rulesErrored,
    error: rulesError,
  } = useCategorizationRules();
  const { data: presets = [], isError: presetsErrored, error: presetsError } = useRulePresets();
  const spending = useTaxonomy(SPENDING_TAXONOMY);
  const income = useTaxonomy(INCOME_TAXONOMY);
  const savings = useTaxonomy(SAVINGS_TAXONOMY);
  const { create, update, remove, rerun } = useCategorizationRuleMutations();

  const [visibleModal, setVisibleModal] = useState(false);
  const [selectedRule, setSelectedRule] = useState<CategorizationRule | undefined>();
  const [searchQuery, setSearchQuery] = useState("");
  // `presetFilter`: null = all, presetId = installed preset, "custom" = user-created rules.
  const [presetFilter, setPresetFilter] = useState<string | null>(null);
  const [confirmRerunAllOpen, setConfirmRerunAllOpen] = useState(false);

  const isLoading = rulesLoading || spending.isLoading || income.isLoading || savings.isLoading;
  const hasLoadError =
    rulesErrored || presetsErrored || spending.isError || income.isError || savings.isError;
  const loadError =
    rulesError?.message ??
    presetsError?.message ??
    spending.error?.message ??
    income.error?.message ??
    savings.error?.message ??
    t("settings:spending.rules.load_error");

  const { categoryOptions, categoryMeta } = useMemo(() => {
    const buildOptions = (taxonomyId: string, cats: TaxonomyCategory[]) => {
      const byId = new Map(cats.map((c) => [c.id, c]));
      return cats
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => {
          const parent = c.parentId ? byId.get(c.parentId) : null;
          return {
            value: `${taxonomyId}:${c.id}`,
            label: c.name,
            taxonomyId,
            categoryId: c.id,
            color: c.color,
            parentName: parent?.name ?? null,
          } satisfies RuleFormCategoryOption;
        });
    };
    const opts: RuleFormCategoryOption[] = [
      ...buildOptions(SPENDING_TAXONOMY, spending.data?.categories ?? []),
      ...buildOptions(INCOME_TAXONOMY, income.data?.categories ?? []),
      ...buildOptions(SAVINGS_TAXONOMY, savings.data?.categories ?? []),
    ];
    const meta: Record<string, RuleCategoryMeta> = {};
    opts.forEach((o) => {
      const entry = {
        name: o.label,
        color: o.color ?? null,
        parentName: o.parentName ?? null,
      };
      meta[o.value] = entry;
      meta[o.categoryId] ??= entry;
    });
    return { categoryOptions: opts, categoryMeta: meta };
  }, [spending.data?.categories, income.data?.categories, savings.data?.categories]);

  const presetMeta = useMemo<Record<string, RulePresetMeta>>(() => {
    const meta: Record<string, RulePresetMeta> = {};
    presets.forEach((p) => {
      meta[p.presetId] = {
        name: p.name,
        flag: PRESET_FLAGS[p.presetId] ?? "🌐",
      };
    });
    return meta;
  }, [presets]);

  if (!settingsLoading && !isEnabled) {
    return <Navigate to="/settings/spending" replace />;
  }

  const handleAddRule = () => {
    setSelectedRule(undefined);
    setVisibleModal(true);
  };

  const handleEditRule = (rule: CategorizationRule) => {
    setSelectedRule(rule);
    setVisibleModal(true);
  };

  const handleDeleteRule = (rule: CategorizationRule) => {
    remove.mutate(rule.id);
  };

  const handleSave = (values: RuleFormValues) => {
    if (selectedRule) {
      update.mutate(
        {
          id: selectedRule.id,
          patch: {
            name: values.name,
            pattern: values.pattern,
            matchType: values.matchType,
            taxonomyId: values.taxonomyId || null,
            categoryId: values.categoryId || null,
            activityType: values.activityType || null,
            priority: values.priority,
            isGlobal: values.isGlobal,
          },
        },
        {
          onSuccess: () => setVisibleModal(false),
        },
      );
    } else {
      create.mutate(
        {
          name: values.name,
          pattern: values.pattern,
          matchType: values.matchType,
          taxonomyId: values.taxonomyId || null,
          categoryId: values.categoryId || null,
          activityType: values.activityType || null,
          priority: values.priority,
          isGlobal: values.isGlobal,
        },
        {
          onSuccess: () => setVisibleModal(false),
        },
      );
    }
  };

  const installedPresets = useMemo(() => presets.filter((p) => p.installed), [presets]);

  const filteredRules = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return [...rules]
      .sort((a, b) => b.priority - a.priority)
      .filter((rule) => {
        if (presetFilter === "custom" && rule.presetId) return false;
        if (presetFilter && presetFilter !== "custom" && rule.presetId !== presetFilter)
          return false;
        if (!query) return true;
        const name = rule.name?.toLowerCase() ?? "";
        const pattern = rule.pattern?.toLowerCase() ?? "";
        return name.includes(query) || pattern.includes(query);
      });
  }, [rules, searchQuery, presetFilter]);

  const customRulesCount = useMemo(() => rules.filter((r) => !r.presetId).length, [rules]);
  const totalRulesCount = rules.length;

  return (
    <>
      <div className="space-y-6">
        <SpendingBackLink />
        <SettingsHeader
          heading={t("settings:spending.rules.heading")}
          text={t("settings:spending.rules.text")}
          backTo="/settings/spending"
        >
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rerun.isPending || rules.length === 0}
                >
                  {rerun.isPending ? (
                    <Icons.Spinner className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Icons.Refresh className="mr-2 h-3.5 w-3.5" />
                  )}
                  {t("settings:spending.rules.rerun")}
                  <Icons.ChevronDown className="ml-2 h-3.5 w-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuItem
                  onClick={() => rerun.mutate(true)}
                  className="flex-col items-start gap-0.5"
                >
                  <span className="text-sm font-medium">
                    {t("settings:spending.rules.rerun_uncategorized")}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t("settings:spending.rules.rerun_uncategorized_desc")}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    setConfirmRerunAllOpen(true);
                  }}
                  className="flex-col items-start gap-0.5"
                >
                  <span className="text-sm font-medium">
                    {t("settings:spending.rules.recategorize_all")}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t("settings:spending.rules.recategorize_all_desc")}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              className="sm:hidden"
              onClick={handleAddRule}
              aria-label={t("settings:spending.rules.add")}
            >
              <Icons.Plus className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" className="hidden sm:inline-flex" onClick={handleAddRule}>
              <Icons.Plus className="mr-2 h-3.5 w-3.5" />
              {t("settings:spending.rules.add")}
            </Button>
          </div>
        </SettingsHeader>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : hasLoadError ? (
          <EmptyPlaceholder>
            <EmptyPlaceholder.Icon name="AlertTriangle" />
            <EmptyPlaceholder.Title>
              {t("settings:spending.rules.error_title")}
            </EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>{loadError}</EmptyPlaceholder.Description>
          </EmptyPlaceholder>
        ) : totalRulesCount === 0 ? (
          <div className="space-y-6">
            <div className="bg-muted/30 rounded-lg border p-4">
              <RulePresetPicker />
            </div>
            <EmptyPlaceholder>
              <EmptyPlaceholder.Icon name="ListFilter" />
              <EmptyPlaceholder.Title>
                {t("settings:spending.rules.empty_title")}
              </EmptyPlaceholder.Title>
              <EmptyPlaceholder.Description>
                {t("settings:spending.rules.empty_description")}
              </EmptyPlaceholder.Description>
              <Button variant="outline" onClick={handleAddRule}>
                <Icons.Plus className="mr-2 h-4 w-4" />
                {t("settings:spending.rules.add_manually")}
              </Button>
            </EmptyPlaceholder>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-muted/30 rounded-md border p-3">
              <RulePresetPicker compact />
            </div>

            {/* Search + preset filter chips */}
            <div className="space-y-2">
              <div className="relative">
                <Icons.Search className="text-muted-foreground/60 absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
                <Input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("settings:spending.rules.search_placeholder")}
                  className="bg-muted/40 border-border/60 placeholder:text-muted-foreground/60 h-7 pl-8 text-xs"
                  aria-label={t("settings:spending.rules.search_aria")}
                />
              </div>

              {(installedPresets.length > 0 || customRulesCount > 0) && (
                <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1">
                  <FilterChip
                    label={t("settings:spending.rules.filter_all")}
                    count={totalRulesCount}
                    active={presetFilter === null}
                    onClick={() => setPresetFilter(null)}
                  />
                  {installedPresets.map((p) => (
                    <FilterChip
                      key={p.presetId}
                      label={`${PRESET_FLAGS[p.presetId] ?? "🌐"} ${p.name}`}
                      count={rules.filter((r) => r.presetId === p.presetId).length}
                      active={presetFilter === p.presetId}
                      onClick={() => setPresetFilter(p.presetId)}
                    />
                  ))}
                  {customRulesCount > 0 && (
                    <FilterChip
                      label={t("settings:spending.rules.filter_custom")}
                      count={customRulesCount}
                      active={presetFilter === "custom"}
                      onClick={() => setPresetFilter("custom")}
                    />
                  )}
                </div>
              )}
            </div>

            {filteredRules.length === 0 ? (
              <div className="text-muted-foreground rounded-md border border-dashed py-8 text-center text-sm">
                {searchQuery
                  ? t("settings:spending.rules.no_match_query", { query: searchQuery })
                  : t("settings:spending.rules.no_match_filter")}{" "}
                <button
                  type="button"
                  className="text-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    setSearchQuery("");
                    setPresetFilter(null);
                  }}
                >
                  {t("settings:spending.rules.clear_filters")}
                </button>
                .
              </div>
            ) : (
              <div className="divide-border divide-y rounded-md border">
                {filteredRules.map((rule) => (
                  <RuleItem
                    key={rule.id}
                    rule={rule}
                    categoryMeta={categoryMeta}
                    presetMeta={presetMeta}
                    onEdit={handleEditRule}
                    onDelete={handleDeleteRule}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <RuleEditModal
        open={visibleModal}
        onClose={() => setVisibleModal(false)}
        rule={selectedRule}
        categoryOptions={categoryOptions}
        onSave={handleSave}
        isLoading={create.isPending || update.isPending}
      />

      <AlertDialog open={confirmRerunAllOpen} onOpenChange={setConfirmRerunAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings:spending.rules.recategorize_confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:spending.rules.recategorize_confirm_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => rerun.mutate(false)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("settings:spending.rules.recategorize_all")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-foreground text-background border-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/50",
      )}
    >
      <span>{label}</span>
      <span
        className={cn("tabular-nums", active ? "text-background/60" : "text-muted-foreground/70")}
      >
        {count}
      </span>
    </button>
  );
}
