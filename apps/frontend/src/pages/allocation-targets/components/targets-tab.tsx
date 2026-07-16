import React, { useState, useEffect } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AnimatedToggleGroup,
  Button,
  Icons,
  Skeleton,
} from "@wealthfolio/ui";

import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { AccountScopeSelector } from "@/components/account-filter-selector";
import { useAccounts } from "@/hooks/use-accounts";
import { useHoldings } from "@/hooks/use-holdings";
import { usePortfolioAllocations } from "@/hooks/use-portfolio-allocations";
import { usePortfolios } from "@/hooks/use-portfolios";
import { useTaxonomies, useTaxonomy } from "@/hooks/use-taxonomies";
import {
  useDeleteAllocationTarget,
  useAllocationTargetWeights,
  useSaveAllocationTargetWithWeights,
} from "../hooks/use-allocation-target-mutations";
import type {
  BandType,
  CategoryAllocation,
  PortfolioAllocations,
  AllocationTarget,
  AllocationTargetConstraint,
  ConstraintSubjectType,
  AccountScope,
  RebalanceGoal,
  TargetScopeType,
  TaxonomyCategory,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { BUILT_IN_PRESETS, ModelPresetPicker, type ModelPreset } from "./model-preset-picker";
import { TargetWeightEditor, type WeightDraft } from "./target-weight-editor";
import { DriftBandSlider } from "./drift-band-slider";
import { useTargetConstraints } from "../hooks/use-target-constraints";
import { accountScopeFromTarget, accountScopeKey } from "./target-scope";

type EditorMode =
  | { kind: "guided" }
  | {
      kind: "edit";
      targetId: string;
    };
type TargetEditorMode = "create" | "edit";

const UNKNOWN_ALLOCATION_CATEGORY_ID = "__UNKNOWN__";
const ROUNDING_TOLERANCE_BPS = 5;

function defaultScopeFromAccountScope(scope: AccountScope): {
  scopeType: TargetScopeType;
  scopeId: string | null;
} {
  if (scope.type === "account") return { scopeType: "account", scopeId: scope.accountId };
  if (scope.type === "portfolio") return { scopeType: "portfolio", scopeId: scope.portfolioId };
  return { scopeType: "all", scopeId: null };
}

function targetScopeLabel(
  target: AllocationTarget,
  accounts: { id: string; name: string }[],
  portfolios: { id: string; name: string }[],
  t: TFunction,
): string {
  if (target.scopeType === "all") return t("allocation:scope.allAccounts");
  if (target.scopeType === "account" && target.scopeId) {
    return (
      accounts.find((account) => account.id === target.scopeId)?.name ??
      t("allocation:scope.accountTarget")
    );
  }
  if (target.scopeType === "portfolio" && target.scopeId) {
    return (
      portfolios.find((portfolio) => portfolio.id === target.scopeId)?.name ??
      t("allocation:scope.portfolioTarget")
    );
  }
  return t("allocation:scope.targetScope");
}

function TargetScopeIcon({ scopeType }: { scopeType: TargetScopeType }) {
  if (scopeType === "portfolio") return <Icons.Folder className="h-4 w-4 shrink-0 opacity-70" />;
  if (scopeType === "account") {
    return <Icons.CreditCard className="h-4 w-4 shrink-0 opacity-70" />;
  }
  return <Icons.Wallet className="h-4 w-4 shrink-0 opacity-70" />;
}

function currentPreset(
  taxonomyId: string,
  categories: CategoryAllocation[],
  t: TFunction,
): ModelPreset {
  return {
    id: "current",
    taxonomyId,
    name: t("allocation:presets.currentAllocation"),
    description: t("allocation:presets.currentAllocationDescription"),
    risk: "From holdings",
    weights: Object.fromEntries(categories.map((c) => [c.categoryId, c.percentage])),
  };
}

function categoriesForTaxonomy(
  allocations: PortfolioAllocations | undefined,
  taxonomyId: string,
): CategoryAllocation[] {
  if (!allocations) return [];
  const byTaxonomy: Record<string, CategoryAllocation[]> = {
    asset_classes: allocations.assetClasses.categories,
    industries_gics: allocations.sectors.categories,
    regions: allocations.regions.categories,
    instrument_type: allocations.securityTypes.categories,
    risk_category: allocations.riskCategory.categories,
  };
  return (
    byTaxonomy[taxonomyId] ??
    allocations.customGroups.find((allocation) => allocation.taxonomyId === taxonomyId)
      ?.categories ??
    []
  );
}

function topLevelCategories(categories: CategoryAllocation[]): CategoryAllocation[] {
  return categories.filter(
    (c) =>
      c.categoryId !== UNKNOWN_ALLOCATION_CATEGORY_ID && (!c.children?.length || c.percentage > 0),
  );
}

function categoryLabelForTaxonomy(taxonomyName: string | undefined, t: TFunction): string {
  if (!taxonomyName) return t("allocation:editor.category");
  const normalized = taxonomyName.toLowerCase();
  if (normalized.includes("regions")) return t("allocation:editor.region");
  if (normalized.includes("industries")) return t("allocation:editor.industry");
  if (normalized.includes("risk")) return t("allocation:editor.riskCategory");
  if (normalized.includes("custom")) return t("allocation:editor.customGroup");
  if (normalized.includes("asset classes")) return t("allocation:editor.assetClass");
  return t("allocation:editor.category");
}

function normalizeWeights(
  weights: WeightDraft[],
  options: { roundingOnly?: boolean } = {},
): WeightDraft[] {
  const sum = weights.reduce((total, weight) => total + weight.targetBps, 0);
  if (sum <= 0 || sum === 10000) return weights;
  const diff = 10000 - sum;
  if (options.roundingOnly && Math.abs(diff) > ROUNDING_TOLERANCE_BPS) return weights;

  const maxIndex = weights.reduce(
    (max, weight, index) => (weight.targetBps > weights[max].targetBps ? index : max),
    0,
  );
  return weights.map((weight, index) =>
    index === maxIndex ? { ...weight, targetBps: weight.targetBps + diff } : weight,
  );
}

function buildGuidedWeights(
  startId: string,
  categories: TaxonomyCategory[],
  currentAllocation: Record<string, number>,
): WeightDraft[] {
  if (startId === "scratch") {
    return categories.map((category) => ({
      categoryId: category.id,
      targetBps: 0,
      isLocked: false,
    }));
  }

  if (startId === "current") {
    return normalizeWeights(
      categories.map((category) => ({
        categoryId: category.id,
        targetBps: Math.round((currentAllocation[category.id] ?? 0) * 100),
        isLocked: false,
      })),
      { roundingOnly: true },
    );
  }

  const preset = BUILT_IN_PRESETS.find((item) => item.id === startId);
  return normalizeWeights(
    categories.map((category) => ({
      categoryId: category.id,
      targetBps: Math.round((preset?.weights[category.id] ?? 0) * 100),
      isLocked: false,
    })),
  );
}

function StepHeader({
  number,
  children,
  className,
}: {
  number: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center gap-2 text-[11px] font-medium uppercase tracking-normal",
        className,
      )}
    >
      <span className="bg-muted inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums tracking-normal">
        {number}
      </span>
      <span>{children}</span>
    </div>
  );
}

function savedWeightsToDraft(
  weights: { categoryId: string; targetBps: number; isLocked: boolean }[],
): WeightDraft[] {
  return weights.map((weight) => ({
    categoryId: weight.categoryId,
    targetBps: weight.targetBps,
    isLocked: weight.isLocked,
  }));
}

function editorModeFromRequest(
  editorMode: TargetEditorMode | undefined,
  selectedTargetId: string | null,
  liveTargets: AllocationTarget[],
): EditorMode {
  if (editorMode === "create") return { kind: "guided" };
  if (selectedTargetId) return { kind: "edit", targetId: selectedTargetId };
  return liveTargets.length === 0
    ? { kind: "guided" }
    : { kind: "edit", targetId: liveTargets[0].id };
}

function isSameEditorMode(left: EditorMode, right: EditorMode): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "guided") return true;
  if (right.kind === "guided") return false;
  return left.targetId === right.targetId;
}

function SellProtectionSection({
  constraints,
  onToggle,
  holdings,
  accounts,
}: {
  constraints: AllocationTargetConstraint[];
  onToggle: (subjectType: ConstraintSubjectType, subjectId: string) => void;
  holdings: {
    id: string;
    instrument?: { id: string; symbol: string; name?: string | null } | null;
    marketValue: { base: number };
  }[];
  accounts: { id: string; name: string }[];
}) {
  const { t } = useTranslation();
  const [assetPopoverOpen, setAssetPopoverOpen] = useState(false);
  const [accountPopoverOpen, setAccountPopoverOpen] = useState(false);
  const [assetSearch, setAssetSearch] = useState("");

  const protectedAssetIds = new Set(
    constraints
      .filter((c) => c.subjectType === "asset" && c.action === "sell" && c.effect === "block")
      .map((c) => c.subjectId),
  );
  const protectedAccountIds = new Set(
    constraints
      .filter((c) => c.subjectType === "account" && c.action === "sell" && c.effect === "block")
      .map((c) => c.subjectId),
  );

  const uniqueAssets = holdings.reduce<
    { assetId: string; symbol: string; name: string; value: number }[]
  >((acc, h) => {
    if (!h.instrument) return acc;
    if (acc.some((a) => a.assetId === h.instrument!.id)) return acc;
    acc.push({
      assetId: h.instrument.id,
      symbol: h.instrument.symbol,
      name: h.instrument.name ?? h.instrument.symbol,
      value: h.marketValue.base,
    });
    return acc;
  }, []);

  const availableAssets = uniqueAssets
    .filter((a) => !protectedAssetIds.has(a.assetId))
    .filter(
      (a) =>
        !assetSearch ||
        a.symbol.toLowerCase().includes(assetSearch.toLowerCase()) ||
        a.name.toLowerCase().includes(assetSearch.toLowerCase()),
    )
    .sort((a, b) => b.value - a.value);

  const protectedAssets = uniqueAssets.filter((a) => protectedAssetIds.has(a.assetId));
  const availableAccounts = accounts.filter((a) => !protectedAccountIds.has(a.id));
  const protectedAccounts = accounts.filter((a) => protectedAccountIds.has(a.id));

  return (
    <section className="bg-card/80 rounded-lg border p-5 shadow-sm">
      <div className="mb-1">
        <h3 className="text-foreground text-[13px] font-semibold">
          {t("allocation:sellProtection.title")}
        </h3>
      </div>

      <div className="border-border border-b py-4">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-foreground text-[12.5px] font-medium">
            {t("allocation:sellProtection.protectedAssets")}
          </span>
          {protectedAssets.length > 0 && (
            <span className="bg-muted text-muted-foreground inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 font-mono text-[10.5px] font-semibold">
              {protectedAssets.length}
            </span>
          )}
        </div>
        <p className="text-muted-foreground mb-3 text-[11px] leading-relaxed">
          {t("allocation:sellProtection.protectedAssetsNote")}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {protectedAssets.map((a) => (
            <span
              key={a.assetId}
              className="border-border bg-background inline-flex items-center gap-1.5 rounded-full border py-1 pl-2 pr-1 font-mono text-[11.5px]"
            >
              <span className="bg-muted text-muted-foreground flex h-5 w-5 items-center justify-center rounded-full text-[8.5px] font-bold uppercase">
                {a.symbol.slice(0, 2)}
              </span>
              <span className="text-foreground font-semibold">{a.symbol}</span>
              <span className="text-muted-foreground max-w-[120px] truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => onToggle("asset", a.assetId)}
                className="text-muted-foreground hover:text-foreground hover:bg-muted ml-0.5 flex h-[17px] w-[17px] items-center justify-center rounded-full"
              >
                <Icons.X className="h-3 w-3" />
              </button>
            </span>
          ))}

          <Popover open={assetPopoverOpen} onOpenChange={setAssetPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-[11.5px] font-medium"
              >
                <Icons.Plus className="h-3.5 w-3.5" />
                {t("allocation:sellProtection.addAsset")}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start">
              <div className="border-border flex items-center gap-2 border-b px-3 py-2">
                <Icons.Search className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                <input
                  value={assetSearch}
                  onChange={(e) => setAssetSearch(e.target.value)}
                  placeholder={t("allocation:sellProtection.searchHoldings")}
                  className="text-foreground placeholder:text-muted-foreground/60 w-full bg-transparent text-[12.5px] outline-none"
                  autoFocus
                />
              </div>
              <div className="max-h-[228px] overflow-auto p-1">
                {availableAssets.length === 0 ? (
                  <p className="text-muted-foreground px-3 py-4 text-center text-[11px]">
                    {assetSearch
                      ? t("allocation:sellProtection.noMatchingHoldings")
                      : t("allocation:sellProtection.allHoldingsProtected")}
                  </p>
                ) : (
                  availableAssets.map((a) => (
                    <button
                      key={a.assetId}
                      type="button"
                      onClick={() => {
                        onToggle("asset", a.assetId);
                        setAssetPopoverOpen(false);
                        setAssetSearch("");
                      }}
                      className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left"
                    >
                      <span className="bg-muted text-muted-foreground flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full font-mono text-[8.5px] font-bold uppercase">
                        {a.symbol.slice(0, 2)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block font-mono text-[12px] font-semibold">
                          {a.symbol}
                        </span>
                        <span className="text-muted-foreground block truncate text-[11px]">
                          {a.name}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="pt-4">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-foreground text-[12.5px] font-medium">
            {t("allocation:sellProtection.protectedAccounts")}
          </span>
          {protectedAccounts.length > 0 && (
            <span className="bg-muted text-muted-foreground inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 font-mono text-[10.5px] font-semibold">
              {protectedAccounts.length}
            </span>
          )}
        </div>
        <p className="text-muted-foreground mb-3 text-[11px] leading-relaxed">
          {t("allocation:sellProtection.protectedAccountsNote")}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {protectedAccounts.map((a) => (
            <span
              key={a.id}
              className="border-border bg-background inline-flex items-center gap-1.5 rounded-full border py-1 pl-2.5 pr-1 text-[11.5px]"
            >
              <Icons.Wallet className="text-muted-foreground h-3.5 w-3.5" />
              <span className="text-foreground font-medium">{a.name}</span>
              <button
                type="button"
                onClick={() => onToggle("account", a.id)}
                className="text-muted-foreground hover:text-foreground hover:bg-muted ml-0.5 flex h-[17px] w-[17px] items-center justify-center rounded-full"
              >
                <Icons.X className="h-3 w-3" />
              </button>
            </span>
          ))}

          <Popover open={accountPopoverOpen} onOpenChange={setAccountPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-[11.5px] font-medium"
              >
                <Icons.Plus className="h-3.5 w-3.5" />
                {t("allocation:sellProtection.addAccount")}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-1" align="start">
              {availableAccounts.length === 0 ? (
                <p className="text-muted-foreground px-3 py-4 text-center text-[11px]">
                  {t("allocation:sellProtection.allAccountsProtected")}
                </p>
              ) : (
                availableAccounts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => {
                      onToggle("account", a.id);
                      setAccountPopoverOpen(false);
                    }}
                    className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left"
                  >
                    <Icons.Wallet className="text-muted-foreground h-4 w-4 shrink-0" />
                    <span className="text-foreground text-[12px] font-medium">{a.name}</span>
                  </button>
                ))
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </section>
  );
}

function TargetEditor({
  target,
  accountScope,
  onAccountScopeChange,
  allocations,
  actionsPlacement = "inline",
  onSaved,
  onCancel,
  onDelete,
  onUnsavedChange,
}: {
  target: AllocationTarget | null;
  accountScope: AccountScope;
  onAccountScopeChange?: (scope: AccountScope) => void;
  allocations?: PortfolioAllocations;
  actionsPlacement?: "inline" | "page-header";
  onSaved: (target: AllocationTarget) => void;
  onCancel: () => void;
  onDelete?: () => void;
  onUnsavedChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const { data: taxonomies = [] } = useTaxonomies({ scope: "asset" });
  const { accounts } = useAccounts({ filterActive: false, includeArchived: true });
  const { data: portfolios = [] } = usePortfolios();
  const guidedTaxonomies = taxonomies.filter((taxonomy) => taxonomy.id !== "instrument_type");
  const saveTarget = useSaveAllocationTargetWithWeights();
  const { data: existingWeightsData, isLoading: existingWeightsLoading } =
    useAllocationTargetWeights(target?.id ?? null);
  const targetConstraintsQuery = useTargetConstraints(target?.id);
  const { holdings } = useHoldings(accountScope);
  const [constraintsDraft, setConstraintsDraft] = useState<AllocationTargetConstraint[]>([]);
  const constraintsDraftLoaded = React.useRef(false);

  useEffect(() => {
    if (targetConstraintsQuery.constraints.length > 0 && !constraintsDraftLoaded.current) {
      setConstraintsDraft(targetConstraintsQuery.constraints);
      constraintsDraftLoaded.current = true;
    } else if (
      targetConstraintsQuery.constraints.length === 0 &&
      !targetConstraintsQuery.isLoading &&
      !constraintsDraftLoaded.current
    ) {
      constraintsDraftLoaded.current = true;
    }
  }, [targetConstraintsQuery.constraints, targetConstraintsQuery.isLoading]);

  function toggleConstraint(subjectType: ConstraintSubjectType, subjectId: string) {
    const existing = constraintsDraft.find(
      (c) =>
        c.subjectType === subjectType &&
        c.subjectId === subjectId &&
        c.action === "sell" &&
        c.effect === "block",
    );
    const now = new Date().toISOString();
    setConstraintsDraft(
      existing
        ? constraintsDraft.filter((c) => c.id !== existing.id)
        : [
            ...constraintsDraft,
            {
              id: crypto.randomUUID(),
              targetId: target?.id ?? "",
              subjectType,
              subjectId,
              action: "sell" as const,
              effect: "block" as const,
              reason: null,
              metadataJson: null,
              createdAt: now,
              updatedAt: now,
            },
          ],
    );
    markDirty();
  }

  const [taxonomyId, setTaxonomyId] = useState(target?.taxonomyId ?? "asset_classes");
  const [startId, setStartId] = useState<string>(target ? "saved" : "current");
  const [targetName, setTargetName] = useState(target?.name ?? "");
  const [nameTouched, setNameTouched] = useState(!!target);
  const [driftBandPct, setDriftBandPct] = useState(target ? target.driftBandBps / 100 : 1);
  const [bandType, setBandType] = useState<BandType>(
    target ? (target.bandType ?? "absolute") : "hybrid",
  );
  const [relativeFactorPct, setRelativeFactorPct] = useState(
    target ? target.relativeFactorBps / 100 : 20,
  );
  const [allowSells, setAllowSells] = useState(target?.allowSells ?? true);
  const [rebalanceGoal, setRebalanceGoal] = useState<RebalanceGoal>(
    target?.rebalanceGoal ?? "nearest_band",
  );
  const [minTradeAmount, setMinTradeAmount] = useState(target?.minTradeAmount ?? "0");
  const [wholeSharesOnly, setWholeSharesOnly] = useState(target?.wholeSharesOnly ?? false);
  const [maxTurnoverPctDisplay, setMaxTurnoverPctDisplay] = useState(
    target?.maxTurnoverBps != null ? String(target.maxTurnoverBps / 100) : "",
  );
  const [weights, setWeights] = useState<WeightDraft[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const loadedWeightsTargetId = React.useRef<string | null>(null);
  const initializedGuidedWeightsKey = React.useRef<string | null>(null);
  const resetTargetId = target?.id ?? null;
  const resetTargetTaxonomyId = target?.taxonomyId ?? "asset_classes";
  const resetTargetName = target?.name ?? "";
  const resetTargetDriftBandBps = target?.driftBandBps ?? 100;
  const resetTargetBandType = target?.bandType ?? "absolute";
  const resetTargetRelativeFactorBps = target?.relativeFactorBps ?? 2000;

  const { data: taxonomy, isLoading: taxonomyLoading } = useTaxonomy(taxonomyId);
  const targetCategories = React.useMemo(
    () => taxonomy?.categories.filter((category) => !category.parentId) ?? [],
    [taxonomy],
  );
  const categories = React.useMemo(
    () => topLevelCategories(categoriesForTaxonomy(allocations, taxonomyId)),
    [allocations, taxonomyId],
  );
  const currentAllocation = React.useMemo(
    () =>
      Object.fromEntries(categories.map((category) => [category.categoryId, category.percentage])),
    [categories],
  );
  const guidedWeightsKey = React.useMemo(() => {
    if (target && startId === "saved") return null;
    const categoryKey = targetCategories.map((category) => category.id).join("|");
    const currentKey =
      startId === "current"
        ? Object.entries(currentAllocation)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([categoryId, percentage]) => `${categoryId}:${percentage}`)
            .join("|")
        : "";
    return `${taxonomyId}:${startId}:${categoryKey}:${currentKey}`;
  }, [currentAllocation, startId, target, targetCategories, taxonomyId]);
  const presets = React.useMemo(
    () => BUILT_IN_PRESETS.filter((preset) => preset.taxonomyId === taxonomyId),
    [taxonomyId],
  );
  const selectedPreset =
    startId === "scratch" || startId === "saved"
      ? null
      : startId === "current"
        ? currentPreset(taxonomyId, categories, t)
        : (presets.find((preset) => preset.id === startId) ?? null);
  const scope = target
    ? { scopeType: target.scopeType, scopeId: target.scopeId ?? null }
    : defaultScopeFromAccountScope(accountScope);
  const cannotTargetScope = !target && accountScope.type === "accounts";
  const selectedTaxonomy = taxonomies.find((taxonomy) => taxonomy.id === taxonomyId);
  const suggestedTargetName =
    startId === "scratch" || startId === "current"
      ? t("allocation:editor.suggestedTargetName", {
          name: selectedTaxonomy?.name ?? t("allocation:editor.customFallback"),
        })
      : t("allocation:editor.suggestedTargetName", {
          name:
            selectedPreset?.name ?? selectedTaxonomy?.name ?? t("allocation:editor.customFallback"),
        });
  const savedWeightDrafts = React.useMemo(
    () => (existingWeightsData ? savedWeightsToDraft(existingWeightsData) : null),
    [existingWeightsData],
  );

  useEffect(() => {
    if (resetTargetId) return;
    if (!nameTouched) setTargetName(suggestedTargetName);
  }, [resetTargetId, nameTouched, suggestedTargetName]);

  useEffect(() => {
    if (resetTargetId) {
      setTaxonomyId(resetTargetTaxonomyId);
      setStartId("saved");
      setTargetName(resetTargetName);
      setNameTouched(true);
      setDriftBandPct(resetTargetDriftBandBps / 100);
      setBandType(resetTargetBandType);
      setRelativeFactorPct(resetTargetRelativeFactorBps / 100);
      setAllowSells(target?.allowSells ?? false);
      setRebalanceGoal(target?.rebalanceGoal ?? "nearest_band");
      setMinTradeAmount(target?.minTradeAmount ?? "0");
      setWholeSharesOnly(target?.wholeSharesOnly ?? false);
      setMaxTurnoverPctDisplay(
        target?.maxTurnoverBps != null ? String(target.maxTurnoverBps / 100) : "",
      );
    } else {
      setTaxonomyId("asset_classes");
      setStartId("current");
      setTargetName("");
      setNameTouched(false);
      setDriftBandPct(1);
      setBandType("hybrid");
      setRelativeFactorPct(20);
      setAllowSells(true);
      setRebalanceGoal("nearest_band");
      setMinTradeAmount("0");
      setWholeSharesOnly(false);
      setMaxTurnoverPctDisplay("");
    }
    setWeights([]);
    setHasUnsavedChanges(false);
    setDeleteOpen(false);
    loadedWeightsTargetId.current = null;
    initializedGuidedWeightsKey.current = null;
    onUnsavedChange?.(false);
  }, [
    resetTargetDriftBandBps,
    resetTargetBandType,
    resetTargetRelativeFactorBps,
    resetTargetId,
    resetTargetName,
    resetTargetTaxonomyId,
    onUnsavedChange,
    target?.allowSells,
    target?.rebalanceGoal,
    target?.minTradeAmount,
    target?.wholeSharesOnly,
  ]);

  useEffect(() => {
    if (!target || !savedWeightDrafts || loadedWeightsTargetId.current === target.id) return;
    loadedWeightsTargetId.current = target.id;
    setWeights(savedWeightDrafts);
    initializedGuidedWeightsKey.current = null;
  }, [target, savedWeightDrafts]);

  useEffect(() => {
    if (target && startId === "saved") return;
    if (!guidedWeightsKey || targetCategories.length === 0) return;
    if (hasUnsavedChanges && weights.length > 0) return;
    if (initializedGuidedWeightsKey.current === guidedWeightsKey) return;
    initializedGuidedWeightsKey.current = guidedWeightsKey;
    setWeights(buildGuidedWeights(startId, targetCategories, currentAllocation));
  }, [
    currentAllocation,
    guidedWeightsKey,
    hasUnsavedChanges,
    startId,
    target,
    targetCategories,
    weights.length,
  ]);

  function markDirty() {
    setHasUnsavedChanges(true);
    onUnsavedChange?.(true);
  }

  const handleTaxonomySelect = (id: string) => {
    if (id === taxonomyId) return;
    setTaxonomyId(id);
    if (target?.taxonomyId === id && savedWeightDrafts) {
      setStartId("saved");
      setWeights(savedWeightDrafts);
    } else {
      setStartId("current");
      setWeights([]);
    }
    initializedGuidedWeightsKey.current = null;
    if (!target) setNameTouched(false);
    markDirty();
  };

  const totalBps = weights.reduce((sum, weight) => sum + weight.targetBps, 0);
  const isSaving = saveTarget.isPending;
  const canSave = !cannotTargetScope && targetName.trim().length > 0 && totalBps === 10000;
  const selectedStartName =
    startId === "saved"
      ? t("allocation:editor.savedTarget")
      : startId === "scratch"
        ? t("allocation:presets.buildFromScratch")
        : (selectedPreset?.name ?? t("allocation:presets.currentAllocation"));
  const showEditorSkeleton =
    taxonomyLoading || (!!target && existingWeightsLoading && weights.length === 0);

  async function persistTarget() {
    if (!canSave || isSaving) return;

    try {
      const input = {
        name: targetName.trim(),
        scopeType: scope.scopeType,
        scopeId: scope.scopeType === "all" ? null : scope.scopeId,
        taxonomyId,
        triggerType: "threshold",
        driftBandBps: Math.round(driftBandPct * 100),
        bandType,
        relativeFactorBps: Math.round(relativeFactorPct * 100),
        allowSells,
        rebalanceGoal,
        minTradeAmount: minTradeAmount === "" ? "0" : minTradeAmount,
        wholeSharesOnly,
        maxTurnoverBps:
          maxTurnoverPctDisplay === "" ? null : Math.round(parseFloat(maxTurnoverPctDisplay) * 100),
      } as const;

      const saved = await saveTarget.mutateAsync({
        id: target?.id ?? null,
        input,
        weights: weights.map((weight) => ({
          categoryId: weight.categoryId,
          targetBps: weight.targetBps,
          isLocked: weight.isLocked,
          isRequired: true,
        })),
      });

      if (saved.target.id && constraintsDraft.length > 0) {
        const constraintsWithTargetId = constraintsDraft.map((c) => ({
          ...c,
          targetId: saved.target.id,
        }));
        await targetConstraintsQuery.saveConstraints(constraintsWithTargetId);
      } else if (
        saved.target.id &&
        constraintsDraft.length === 0 &&
        targetConstraintsQuery.constraints.length > 0
      ) {
        await targetConstraintsQuery.saveConstraints([]);
      }

      setHasUnsavedChanges(false);
      onUnsavedChange?.(false);
      toast.success(
        target ? t("allocation:toast.targetSaved") : t("allocation:toast.targetCreated"),
      );
      onSaved(saved.target);
    } catch (error) {
      toast.error(target ? t("allocation:toast.saveFailed") : t("allocation:toast.createFailed"));
      console.error(error);
    }
  }

  function handleCancel() {
    if (target) {
      setTaxonomyId(target.taxonomyId);
      setStartId("saved");
      setTargetName(target.name);
      setNameTouched(true);
      setDriftBandPct(target.driftBandBps / 100);
      setBandType(target.bandType ?? "absolute");
      setRelativeFactorPct((target.relativeFactorBps ?? 2000) / 100);
      setAllowSells(target.allowSells ?? false);
      setRebalanceGoal(target.rebalanceGoal ?? "nearest_band");
      setMinTradeAmount(target.minTradeAmount ?? "0");
      setWholeSharesOnly(target.wholeSharesOnly ?? false);
      setMaxTurnoverPctDisplay(
        target.maxTurnoverBps != null ? String(target.maxTurnoverBps / 100) : "",
      );
      if (savedWeightDrafts) setWeights(savedWeightDrafts);
    } else {
      setTaxonomyId("asset_classes");
      setStartId("current");
      setTargetName("");
      setNameTouched(false);
      setDriftBandPct(1);
      setBandType("hybrid");
      setRelativeFactorPct(20);
      setRebalanceGoal("nearest_band");
      setMinTradeAmount("0");
      setWholeSharesOnly(false);
      setWeights([]);
    }
    initializedGuidedWeightsKey.current = null;
    setHasUnsavedChanges(false);
    onUnsavedChange?.(false);
    onCancel();
  }

  return (
    <div className="space-y-5">
      <div
        className={cn(
          "flex",
          actionsPlacement === "page-header"
            ? "mb-4 justify-start lg:-mt-14 lg:justify-end"
            : "justify-end",
        )}
      >
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <Button variant="ghost" size="sm" onClick={handleCancel}>
            <Icons.X className="mr-1.5 h-4 w-4" />
            {t("common:cancel")}
          </Button>
          {target ? (
            <>
              <Button
                size="sm"
                disabled={!canSave || isSaving || !hasUnsavedChanges}
                onClick={() => persistTarget()}
              >
                {isSaving ? t("allocation:editor.saving") : t("allocation:editor.saveTarget")}
              </Button>
              {onDelete && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-destructive hover:text-destructive"
                  aria-label={t("allocation:editor.deleteTarget")}
                  title={t("allocation:editor.deleteTarget")}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Icons.Trash className="h-4 w-4" />
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" disabled={!canSave || isSaving} onClick={() => persistTarget()}>
              {isSaving ? t("allocation:editor.creating") : t("allocation:editor.createTarget")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-4">
          <section className="bg-card/80 rounded-lg border p-5 shadow-sm">
            <StepHeader number={1} className="mb-3">
              {t("allocation:editor.step1")}
            </StepHeader>
            <label className="block">
              <span className="text-muted-foreground mb-1.5 block text-[11px] font-medium uppercase tracking-wider">
                {t("allocation:editor.targetName")}
              </span>
              <input
                value={targetName}
                onChange={(event) => {
                  setNameTouched(true);
                  setTargetName(event.target.value);
                  markDirty();
                }}
                placeholder={t("allocation:editor.targetName")}
                className="bg-background/70 text-foreground placeholder:text-muted-foreground focus:border-foreground w-full rounded-lg border px-3 py-2.5 text-[14px] font-semibold outline-none transition-colors placeholder:font-normal"
              />
            </label>
            <div className="mt-4">
              <div className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wider">
                {t("allocation:editor.accountScope")}
              </div>
              {target ? (
                <div className="bg-muted/20 text-foreground flex items-center gap-2 rounded-lg border px-3 py-2.5 text-[14px] font-semibold">
                  <TargetScopeIcon scopeType={target.scopeType} />
                  <span className="min-w-0 truncate">
                    {targetScopeLabel(target, accounts, portfolios, t)}
                  </span>
                </div>
              ) : (
                <AccountScopeSelector
                  value={accountScope}
                  onChange={(nextScope) => {
                    onAccountScopeChange?.(nextScope);
                    markDirty();
                  }}
                  triggerVariant="input"
                  allowMultiAccount={false}
                />
              )}
            </div>
            {!target ? (
              <p className="text-muted-foreground mt-3 text-[12px] leading-relaxed">
                {t("allocation:editor.scopeSavedNote")}
              </p>
            ) : null}
            {cannotTargetScope && (
              <p className="text-destructive mt-3 text-[12px] leading-relaxed">
                {t("allocation:editor.cannotTargetScope")}
              </p>
            )}
          </section>

          <section className="bg-card/80 rounded-lg border p-5 shadow-sm">
            <StepHeader number={2} className="mb-3">
              {t("allocation:editor.step2")}
            </StepHeader>
            <div className="space-y-2">
              {guidedTaxonomies.map((taxonomy) => {
                const count = topLevelCategories(
                  categoriesForTaxonomy(allocations, taxonomy.id),
                ).length;
                const selected = taxonomyId === taxonomy.id;
                return (
                  <button
                    key={taxonomy.id}
                    type="button"
                    onClick={() => handleTaxonomySelect(taxonomy.id)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors",
                      selected ? "border-foreground bg-card" : "bg-muted/20 hover:bg-muted/40",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="text-foreground block truncate text-[12.5px] font-semibold">
                        {taxonomy.name}
                      </span>
                      <span className="text-muted-foreground text-[11px]">
                        {t("allocation:editor.currentCategories", { count })}
                      </span>
                    </span>
                    {selected && (
                      <span className="bg-foreground text-background flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="bg-card/80 rounded-lg border p-5 shadow-sm">
            <StepHeader number={3} className="mb-3">
              {t("allocation:editor.step3")}
            </StepHeader>
            <DriftBandSlider
              driftBandPct={driftBandPct}
              onDriftBandChange={(value) => {
                setDriftBandPct(value);
                markDirty();
              }}
              bandType={bandType}
              onBandTypeChange={(value) => {
                setBandType(value);
                markDirty();
              }}
              relativeFactorPct={relativeFactorPct}
              onRelativeFactorChange={(value) => {
                setRelativeFactorPct(value);
                markDirty();
              }}
            />
          </section>

          <section className="bg-card/80 rounded-lg border p-5 shadow-sm">
            <div className="text-muted-foreground mb-4 text-[11px] font-medium uppercase tracking-wider">
              {t("allocation:editor.rebalanceSettings")}
            </div>
            <div className="divide-border/50 divide-y [&>*:first-child]:pt-0 [&>*:last-child]:pb-0 [&>*]:py-4">
              <div>
                <div className="text-foreground mb-2 text-[12.5px] font-medium">
                  {t("allocation:editor.mode")}
                </div>
                <AnimatedToggleGroup<"buy_only" | "allow_sells">
                  value={allowSells ? "allow_sells" : "buy_only"}
                  onValueChange={(v) => {
                    setAllowSells(v === "allow_sells");
                    markDirty();
                  }}
                  items={[
                    { value: "buy_only", label: t("allocation:editor.buyOnly") },
                    { value: "allow_sells", label: t("allocation:editor.allowSells") },
                  ]}
                  rounded="lg"
                  className="bg-muted/30 [&_button:has(>div)]:text-primary-foreground [&_button:not(:has(>div))]:text-muted-foreground [&_button>div]:bg-primary w-full border [&_button]:flex-1 [&_button]:py-2 [&_button]:text-[12px]"
                />
                <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
                  {allowSells
                    ? t("allocation:editor.modeSellNote")
                    : t("allocation:editor.modeBuyNote")}
                </p>
              </div>

              <div>
                <div className="text-foreground mb-2 text-[12.5px] font-medium">
                  {t("allocation:editor.goal")}
                </div>
                <AnimatedToggleGroup<RebalanceGoal>
                  value={rebalanceGoal}
                  onValueChange={(v) => {
                    setRebalanceGoal(v);
                    markDirty();
                  }}
                  items={[
                    { value: "nearest_band", label: t("allocation:editor.nearestBand") },
                    { value: "exact_target", label: t("allocation:editor.exactTarget") },
                  ]}
                  rounded="lg"
                  className="bg-muted/30 [&_button:has(>div)]:text-primary-foreground [&_button:not(:has(>div))]:text-muted-foreground [&_button>div]:bg-primary w-full border [&_button]:flex-1 [&_button]:py-2 [&_button]:text-[12px]"
                />
                <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
                  {rebalanceGoal === "exact_target"
                    ? t("allocation:editor.goalExactNote")
                    : t("allocation:editor.goalNearestNote")}
                </p>
              </div>

              <div>
                <div className="text-foreground mb-2 text-[12.5px] font-medium">
                  {t("allocation:editor.shareSizing")}
                </div>
                <AnimatedToggleGroup<"fractional" | "whole">
                  value={wholeSharesOnly ? "whole" : "fractional"}
                  onValueChange={(v) => {
                    setWholeSharesOnly(v === "whole");
                    markDirty();
                  }}
                  items={[
                    { value: "fractional", label: t("allocation:editor.fractional") },
                    { value: "whole", label: t("allocation:editor.wholeShares") },
                  ]}
                  rounded="lg"
                  className="bg-muted/30 [&_button:has(>div)]:text-primary-foreground [&_button:not(:has(>div))]:text-muted-foreground [&_button>div]:bg-primary w-full border [&_button]:flex-1 [&_button]:py-2 [&_button]:text-[12px]"
                />
                <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
                  {wholeSharesOnly
                    ? t("allocation:editor.shareWholeNote")
                    : t("allocation:editor.shareFractionalNote")}
                </p>
              </div>

              <label className="block">
                <div className="text-foreground mb-2 text-[12.5px] font-medium">
                  {t("allocation:editor.minTradeAmount")}
                </div>
                <div className="border-input bg-background focus-within:ring-ring flex h-9 items-center rounded-md border px-3 focus-within:ring-2">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={minTradeAmount === "0" ? "" : minTradeAmount}
                    onChange={(e) => {
                      const v = e.target.value;
                      setMinTradeAmount(v === "" ? "0" : v);
                      markDirty();
                    }}
                    placeholder="0"
                    className="text-foreground placeholder:text-muted-foreground/60 w-full bg-transparent text-[13px] outline-none"
                  />
                </div>
                <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
                  {t("allocation:editor.minTradeNote")}
                </p>
              </label>

              <label className="mt-4 block">
                <div className="text-foreground mb-2 text-[12.5px] font-medium">
                  {t("allocation:editor.maxTurnover")}
                </div>
                <div className="border-input bg-background focus-within:ring-ring flex h-9 items-center rounded-md border px-3 focus-within:ring-2">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={maxTurnoverPctDisplay}
                    onChange={(e) => {
                      setMaxTurnoverPctDisplay(e.target.value);
                      markDirty();
                    }}
                    placeholder={t("allocation:editor.noLimit")}
                    className="text-foreground placeholder:text-muted-foreground/60 w-full bg-transparent text-[13px] outline-none"
                  />
                  <span className="text-muted-foreground ml-1 text-[13px]">%</span>
                </div>
                <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
                  {t("allocation:editor.maxTurnoverNote")}
                </p>
              </label>
            </div>
          </section>
        </div>

        <div className="space-y-4">
          <section className="bg-card/80 rounded-lg border p-5 shadow-sm">
            <div className="mb-3">
              <StepHeader number={4}>{t("allocation:editor.step4")}</StepHeader>
            </div>

            <ModelPresetPicker
              taxonomyId={taxonomyId}
              selected={startId === "saved" ? null : startId}
              onSelect={(presetId) => {
                setStartId(presetId);
                setWeights(buildGuidedWeights(presetId, targetCategories, currentAllocation));
                initializedGuidedWeightsKey.current = null;
                markDirty();
              }}
              currentCategories={categories}
              compact
            />
          </section>

          <section className="bg-card/80 rounded-lg border p-5 shadow-sm">
            <div className="mb-7">
              <h3 className="text-foreground text-[15px] font-semibold">
                {t("allocation:editor.targetWeightsTitle", { start: selectedStartName })}
              </h3>
              <p className="text-muted-foreground mt-1 text-[12px]">
                {t("allocation:editor.targetWeightsHint")}
              </p>
              {cannotTargetScope && (
                <p className="text-destructive mt-2 text-[11px] leading-relaxed">
                  {t("allocation:editor.selectScopeBeforeSaving")}
                </p>
              )}
              {targetName.trim().length === 0 && (
                <p className="text-destructive mt-2 text-[11px] leading-relaxed">
                  {t("allocation:editor.addNameBeforeSaving")}
                </p>
              )}
            </div>

            {showEditorSkeleton ? (
              <Skeleton className="h-64 w-full" />
            ) : targetCategories.length > 0 ? (
              <TargetWeightEditor
                categories={targetCategories}
                weights={weights}
                currentAllocation={currentAllocation}
                categoryLabel={categoryLabelForTaxonomy(selectedTaxonomy?.name, t)}
                bandType={bandType}
                driftBandBps={Math.round(driftBandPct * 100)}
                relativeFactorBps={Math.round(relativeFactorPct * 100)}
                onChange={(nextWeights) => {
                  setWeights(nextWeights);
                  markDirty();
                }}
              />
            ) : (
              <p className="text-muted-foreground rounded-lg border px-4 py-6 text-[12px]">
                {t("allocation:editor.noCategoriesFound")}
              </p>
            )}
          </section>

          {target && allowSells && (
            <SellProtectionSection
              constraints={constraintsDraft}
              onToggle={toggleConstraint}
              holdings={holdings.filter((h) => h.holdingType !== "cash" && h.quantity > 0)}
              accounts={accounts.filter((a) => a.isActive)}
            />
          )}
        </div>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("allocation:editor.deleteDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("allocation:editor.deleteDialogDescription", { name: targetName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setDeleteOpen(false);
                setHasUnsavedChanges(false);
                onUnsavedChange?.(false);
                onDelete?.();
              }}
            >
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface TargetsTabProps {
  targets: AllocationTarget[];
  selectedTargetId: string | null;
  onTargetChange: (id: string) => void;
  editorMode?: TargetEditorMode;
  accountScope: AccountScope;
  onAccountScopeChange?: (scope: AccountScope) => void;
  actionsPlacement?: "inline" | "page-header";
  onUnsavedChange?: (dirty: boolean) => void;
  onCancel?: () => void;
  onSaved?: (target: AllocationTarget) => void;
}

export function TargetsTab({
  targets,
  selectedTargetId,
  onTargetChange,
  editorMode,
  accountScope,
  onAccountScopeChange,
  actionsPlacement = "inline",
  onUnsavedChange,
  onCancel,
  onSaved,
}: TargetsTabProps) {
  const liveTargets = React.useMemo(() => targets.filter((p) => !p.archivedAt), [targets]);
  const parentAccountScopeKey = accountScopeKey(accountScope);
  const accountScopeRef = React.useRef(accountScope);
  const [draftAccountScope, setDraftAccountScope] = useState<AccountScope>(accountScope);

  const [mode, setMode] = useState<EditorMode>(() =>
    editorModeFromRequest(editorMode, selectedTargetId, liveTargets),
  );
  const modeTargetId = mode.kind === "edit" ? mode.targetId : null;

  useEffect(() => {
    accountScopeRef.current = accountScope;
  }, [accountScope]);

  // Sync editor when selected target changes from header dropdown.
  useEffect(() => {
    if (editorMode === "create") return;
    if (!selectedTargetId) return;
    if (mode.kind !== "edit" || modeTargetId !== selectedTargetId) {
      setMode({ kind: "edit", targetId: selectedTargetId });
    }
  }, [editorMode, mode.kind, modeTargetId, selectedTargetId]);

  // Explicit parent intent: create opens a blank target, edit opens the selected target.
  useEffect(() => {
    if (!editorMode) return;
    if (editorMode === "create") {
      setDraftAccountScope((current) =>
        accountScopeKey(current) === accountScopeKey(accountScopeRef.current)
          ? current
          : accountScopeRef.current,
      );
      setMode((current) => (current.kind === "guided" ? current : { kind: "guided" }));
      return;
    }
    const nextMode = editorModeFromRequest(editorMode, selectedTargetId, liveTargets);
    setMode((current) => (isSameEditorMode(current, nextMode) ? current : nextMode));
  }, [editorMode, selectedTargetId, liveTargets, parentAccountScopeKey]);

  useEffect(() => {
    setDraftAccountScope(accountScopeRef.current);
  }, [parentAccountScopeKey]);

  const editingModeTargetId = modeTargetId;

  useEffect(() => {
    if (!editingModeTargetId) return;
    if (liveTargets.some((p) => p.id === editingModeTargetId)) return;
    const fallback = liveTargets[0] ?? null;
    setMode(fallback ? { kind: "edit", targetId: fallback.id } : { kind: "guided" });
  }, [liveTargets, editingModeTargetId]);

  const editingTarget = React.useMemo(
    () =>
      mode.kind === "edit" && mode.targetId
        ? (targets.find((p) => p.id === mode.targetId) ?? null)
        : null,
    [mode, targets],
  );
  const editorAccountScope = React.useMemo(
    () =>
      mode.kind === "guided"
        ? draftAccountScope
        : (accountScopeFromTarget(editingTarget) ?? accountScope),
    [accountScope, draftAccountScope, editingTarget, mode.kind],
  );

  const { allocations, isLoading: allocationsLoading } = usePortfolioAllocations(
    editorAccountScope,
    { keepPreviousData: true },
  );
  const deleteTarget = useDeleteAllocationTarget();

  function handleDraftAccountScopeChange(nextScope: AccountScope) {
    setDraftAccountScope(nextScope);
    onAccountScopeChange?.(nextScope);
  }

  function handleEditorSaved(target: AllocationTarget) {
    onTargetChange(target.id);
    setMode({ kind: "edit", targetId: target.id });
    onSaved?.(target);
  }

  function handleEditorCancel() {
    if (onCancel) {
      onCancel();
      return;
    }

    if (liveTargets.length === 0) {
      setMode({ kind: "guided" });
    } else {
      const fallbackId = selectedTargetId ?? liveTargets[0].id;
      setMode({ kind: "edit", targetId: fallbackId });
    }
  }

  function navigateAfterRemove(removedId: string) {
    const remaining = liveTargets.filter((p) => p.id !== removedId);
    const fallback = remaining[0] ?? null;
    if (fallback) {
      onTargetChange(fallback.id);
      setMode({ kind: "edit", targetId: fallback.id });
    } else {
      setMode({ kind: "guided" });
    }
  }

  function handleEditorDelete() {
    if (!editingTarget) return;
    deleteTarget.mutate(editingTarget.id, {
      onSuccess: () => navigateAfterRemove(editingTarget.id),
    });
  }

  if (allocationsLoading && !allocations) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (mode.kind === "guided") {
    return (
      <TargetEditor
        key="new"
        target={null}
        accountScope={editorAccountScope}
        onAccountScopeChange={handleDraftAccountScopeChange}
        allocations={allocations}
        actionsPlacement={actionsPlacement}
        onSaved={handleEditorSaved}
        onCancel={handleEditorCancel}
        onUnsavedChange={onUnsavedChange}
      />
    );
  }

  return (
    <TargetEditor
      key={mode.targetId}
      target={editingTarget}
      accountScope={editorAccountScope}
      allocations={allocations}
      actionsPlacement={actionsPlacement}
      onSaved={handleEditorSaved}
      onCancel={handleEditorCancel}
      onDelete={editingTarget ? handleEditorDelete : undefined}
      onUnsavedChange={onUnsavedChange}
    />
  );
}
