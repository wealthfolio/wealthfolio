import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@wealthfolio/ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Icons } from "@wealthfolio/ui";
import { cn } from "@/lib/utils";
import {
  useTaxonomy,
  useAssetTaxonomyAssignments,
  useAssignAssetToCategory,
  useRemoveAssetTaxonomyAssignment,
} from "@/hooks/use-taxonomies";
import type { TaxonomyCategory, AssetTaxonomyAssignment } from "@/lib/types";

interface MultiSelectTaxonomyProps {
  taxonomyId: string;
  assetId: string;
  label?: string;
  disabled?: boolean;
}

interface CategoryNode extends TaxonomyCategory {
  children: CategoryNode[];
  level: number;
}

interface PendingCategory {
  category: CategoryNode;
  weight: string;
}

function buildCategoryTree(categories: TaxonomyCategory[]): CategoryNode[] {
  const nodeMap = new Map<string, CategoryNode>();
  const roots: CategoryNode[] = [];

  categories.forEach((cat) => {
    nodeMap.set(cat.id, { ...cat, children: [], level: 0 });
  });

  categories.forEach((cat) => {
    const node = nodeMap.get(cat.id)!;
    if (cat.parentId && nodeMap.has(cat.parentId)) {
      const parent = nodeMap.get(cat.parentId)!;
      node.level = parent.level + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });

  const sortWeights = (nodes: CategoryNode[]): CategoryNode[] => {
    return nodes
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((node) => ({
        ...node,
        children: sortWeights(node.children),
      }));
  };

  return sortWeights(roots);
}

function flattenTree(nodes: CategoryNode[]): CategoryNode[] {
  const result: CategoryNode[] = [];

  const traverse = (nodeList: CategoryNode[], level: number) => {
    nodeList.forEach((node) => {
      result.push({ ...node, level });
      if (node.children.length > 0) {
        traverse(node.children, level + 1);
      }
    });
  };

  traverse(nodes, 0);
  return result;
}

function parseWeightInput(value: string): number | null {
  const num = parseFloat(value.replace("%", ""));
  if (isNaN(num) || num < 0 || num > 100) return null;
  return Math.round(num * 100);
}

function basisPointsToPercent(bp: number): string {
  const pct = bp / 100;
  return pct % 1 === 0 ? String(pct) : pct.toFixed(1);
}

export function MultiSelectTaxonomy({
  taxonomyId,
  assetId,
  label,
  disabled = false,
}: MultiSelectTaxonomyProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pendingCategory, setPendingCategory] = useState<PendingCategory | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const { data: taxonomyData, isLoading: isLoadingTaxonomy } = useTaxonomy(taxonomyId);
  const { data: allAssignments = [], isLoading: isLoadingAssignments } =
    useAssetTaxonomyAssignments(assetId);

  const assignMutation = useAssignAssetToCategory();
  const removeMutation = useRemoveAssetTaxonomyAssignment();

  const assignments = useMemo(
    () => allAssignments.filter((a) => a.taxonomyId === taxonomyId),
    [allAssignments, taxonomyId],
  );

  const categoryMap = useMemo(() => {
    const map = new Map<string, TaxonomyCategory>();
    if (taxonomyData?.categories) {
      taxonomyData.categories.forEach((cat) => map.set(cat.id, cat));
    }
    return map;
  }, [taxonomyData?.categories]);

  const flatCategories = useMemo(() => {
    if (!taxonomyData?.categories) return [];
    const tree = buildCategoryTree(taxonomyData.categories);
    return flattenTree(tree);
  }, [taxonomyData?.categories]);

  const assignedCategoryIds = useMemo(
    () => new Set(assignments.map((a) => a.categoryId)),
    [assignments],
  );

  const isLoading = isLoadingTaxonomy || isLoadingAssignments;
  const isPending = assignMutation.isPending || removeMutation.isPending;

  const totalWeight = useMemo(() => {
    return assignments.reduce((sum, a) => sum + a.weight, 0) / 100;
  }, [assignments]);

  const handleSelectCategory = (category: CategoryNode) => {
    if (assignedCategoryIds.has(category.id) || isPending) return;
    setPendingCategory({ category, weight: "100" });
  };

  const handleConfirmCategory = async () => {
    if (!pendingCategory || isPending) return;

    const weight = parseWeightInput(pendingCategory.weight);
    if (weight === null) {
      setPendingCategory({ ...pendingCategory, weight: "100" });
      return;
    }

    await assignMutation.mutateAsync({
      assetId,
      taxonomyId,
      categoryId: pendingCategory.category.id,
      weight,
      source: "manual",
    });

    setPendingCategory(null);
    setOpen(false);
  };

  const handleCancelPending = () => {
    setPendingCategory(null);
  };

  const handleRemoveCategory = async (assignmentId: string) => {
    if (isPending) return;
    await removeMutation.mutateAsync({
      id: assignmentId,
      assetId,
    });
  };

  const handleWeightBlur = async (assignment: AssetTaxonomyAssignment) => {
    const newWeight = parseWeightInput(editingValue);
    if (newWeight !== null && newWeight !== assignment.weight) {
      await assignMutation.mutateAsync({
        assetId,
        taxonomyId,
        categoryId: assignment.categoryId,
        weight: newWeight,
        source: "manual",
      });
    }
    setEditingId(null);
    setEditingValue("");
  };

  const startEditing = (assignment: AssetTaxonomyAssignment) => {
    setEditingId(assignment.id);
    setEditingValue(basisPointsToPercent(assignment.weight));
  };

  const assignedCategories = useMemo(() => {
    return assignments
      .map((assignment) => {
        const category = categoryMap.get(assignment.categoryId);
        return category ? { assignment, category } : null;
      })
      .filter((item): item is { assignment: AssetTaxonomyAssignment; category: TaxonomyCategory } =>
        Boolean(item),
      )
      .sort((a, b) => {
        const weightComparison = b.assignment.weight - a.assignment.weight;
        if (weightComparison !== 0) return weightComparison;

        const sortOrderComparison = a.category.sortOrder - b.category.sortOrder;
        if (sortOrderComparison !== 0) return sortOrderComparison;

        return a.category.name.localeCompare(b.category.name);
      });
  }, [assignments, categoryMap]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {label && <Skeleton className="h-4 w-24" />}
        <div className="space-y-1">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Header with label and Add button */}
      <div className="flex items-center justify-between">
        {label && <label className="text-muted-foreground text-sm font-medium">{label}</label>}

        {!disabled && (
          <Popover
            open={open}
            onOpenChange={(isOpen) => {
              setOpen(isOpen);
              if (!isOpen) setPendingCategory(null);
            }}
            modal={true}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
                disabled={isPending}
              >
                <Icons.Plus className="h-3.5 w-3.5" />
                {t("asset:classification.add")}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[450px] p-0" align="end" sideOffset={4}>
              {/* Pending category weight input */}
              {pendingCategory && (
                <div className="border-b p-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: pendingCategory.category.color }}
                    />
                    <span className="flex-1 truncate text-sm font-medium">
                      {pendingCategory.category.name}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <label className="text-muted-foreground text-xs">
                      {t("asset:classification.weight")}
                    </label>
                    <div className="relative flex-1">
                      <Input
                        type="text"
                        value={pendingCategory.weight}
                        onChange={(e) =>
                          setPendingCategory({ ...pendingCategory, weight: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleConfirmCategory();
                          if (e.key === "Escape") handleCancelPending();
                        }}
                        onFocus={(e) => e.target.select()}
                        autoFocus
                        className="h-8 pr-6 text-sm"
                        placeholder="100"
                      />
                      <span className="text-muted-foreground pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm">
                        %
                      </span>
                    </div>
                    <Button
                      size="sm"
                      className="h-8"
                      onClick={handleConfirmCategory}
                      disabled={isPending}
                    >
                      {isPending ? (
                        <Icons.Loader className="h-3 w-3 animate-spin" />
                      ) : (
                        <Icons.Check className="h-3 w-3" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0"
                      onClick={handleCancelPending}
                    >
                      <Icons.Close className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}

              {/* Category tree */}
              <Command>
                <CommandInput
                  placeholder={t("asset:classification.searchCategories")}
                  className="h-9"
                />
                <CommandList className="max-h-72 overflow-y-auto">
                  <CommandEmpty>{t("asset:classification.noCategoriesFound")}</CommandEmpty>
                  <CommandGroup className="[&_[cmdk-group-items]]:!overflow-visible">
                    {flatCategories.map((category, index) => {
                      const isAssigned = assignedCategoryIds.has(category.id);
                      const hasChildren = category.children.length > 0;
                      const isPendingThis = pendingCategory?.category.id === category.id;
                      const showSeparator = category.level === 0 && index > 0;

                      return (
                        <div key={category.id}>
                          {showSeparator && <CommandSeparator className="my-1" />}
                          <CommandItem
                            value={`${category.name} ${category.id}`}
                            onSelect={() => {
                              if (!isAssigned) {
                                handleSelectCategory(category);
                              }
                            }}
                            disabled={isAssigned}
                            className={cn(
                              "flex items-center gap-2",
                              isAssigned && "opacity-40",
                              hasChildren && "font-medium",
                              isPendingThis && "bg-accent",
                            )}
                            style={{ paddingLeft: `${category.level * 16 + 8}px` }}
                          >
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: category.color }}
                            />
                            <span className="flex-1 truncate">{category.name}</span>
                            {isAssigned && (
                              <Icons.Check className="text-primary h-4 w-4 shrink-0" />
                            )}
                            {hasChildren && (
                              <span className="text-muted-foreground text-xs">
                                ({category.children.length})
                              </span>
                            )}
                          </CommandItem>
                        </div>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {/* Table-like list of assigned categories */}
      {assignedCategories.length > 0 && (
        <div className="bg-muted/30 divide-y rounded-md border">
          {assignedCategories.map(({ assignment, category }) => (
            <div key={assignment.id} className="flex items-center gap-2 px-3 py-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: category.color }}
              />
              <span className="min-w-0 flex-1 truncate text-sm">{category.name}</span>

              {/* Weight input */}
              <div className="relative w-20">
                {editingId === assignment.id ? (
                  <Input
                    type="text"
                    value={editingValue}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onBlur={() => handleWeightBlur(assignment)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleWeightBlur(assignment);
                      if (e.key === "Escape") {
                        setEditingId(null);
                        setEditingValue("");
                      }
                    }}
                    className="h-7 pr-5 text-right text-sm"
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => !disabled && startEditing(assignment)}
                    disabled={disabled}
                    className={cn(
                      "bg-background hover:bg-muted flex h-7 w-full items-center justify-end rounded-md border px-2 text-sm transition-colors",
                      disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {basisPointsToPercent(assignment.weight)}%
                  </button>
                )}
              </div>

              {/* Remove button */}
              {!disabled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => handleRemoveCategory(assignment.id)}
                  disabled={isPending}
                >
                  <Icons.Close className="h-3.5 w-3.5 opacity-60" />
                </Button>
              )}
            </div>
          ))}

          {/* Total row */}
          {assignedCategories.length > 1 && (
            <div className="bg-muted/50 flex items-center gap-2 px-3 py-2">
              <span className="text-muted-foreground flex-1 text-right text-xs font-medium">
                {t("asset:classification.total")}
              </span>
              <div
                className={cn(
                  "w-20 text-right text-sm font-semibold",
                  totalWeight === 100
                    ? "text-green-600 dark:text-green-400"
                    : totalWeight > 100
                      ? "text-red-600 dark:text-red-400"
                      : "text-amber-600 dark:text-amber-400",
                )}
              >
                {totalWeight % 1 === 0 ? totalWeight : totalWeight.toFixed(1)}%
              </div>
              <div className="w-7" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
