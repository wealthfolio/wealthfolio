import { getCategoryLabel } from "@/lib/taxonomy-labels";
import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RadioGroup, RadioGroupItem, Label, Skeleton, Icons } from "@wealthfolio/ui";
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
import { cn } from "@/lib/utils";
import {
  useTaxonomy,
  useAssetTaxonomyAssignments,
  useAssignAssetToCategory,
} from "@/hooks/use-taxonomies";
import type { TaxonomyCategory } from "@/lib/types";

const MAX_RADIO_ITEMS = 8;

// Top instrument types to show as quick toggles (by category ID)
const TOP_INSTRUMENT_TYPES = [
  "EQUITY_SECURITY", // Stocks
  "ETP", // ETFs
  "FUND", // Funds
  "DEBT_SECURITY", // Bonds
  "OTHER", // Other
];

interface CategoryNode extends TaxonomyCategory {
  children: CategoryNode[];
  level: number;
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

interface SingleSelectTaxonomyProps {
  taxonomyId: string;
  assetId: string;
  label?: string;
  disabled?: boolean;
}

/**
 * A component for selecting a single category from a taxonomy.
 * For taxonomies with many categories (like instrument types), shows quick toggles
 * for common types plus a "More" button that opens a tree select.
 * For smaller taxonomies, renders as a grid of pill buttons.
 */
export function SingleSelectTaxonomy({
  taxonomyId,
  assetId,
  label,
  disabled = false,
}: SingleSelectTaxonomyProps) {
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [openPillId, setOpenPillId] = useState<string | null>(null);
  const { data: taxonomyData, isLoading: isLoadingTaxonomy } = useTaxonomy(taxonomyId);
  const { data: assignments, isLoading: isLoadingAssignments } =
    useAssetTaxonomyAssignments(assetId);
  const assignMutation = useAssignAssetToCategory();

  const isLoading = isLoadingTaxonomy || isLoadingAssignments;

  // Get all categories sorted by sort order
  const allCategories = useMemo(() => {
    if (!taxonomyData?.categories) return [];
    return [...taxonomyData.categories].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [taxonomyData?.categories]);

  // Build category map for lookups
  const categoryMap = useMemo(() => {
    const map = new Map<string, TaxonomyCategory>();
    allCategories.forEach((cat) => map.set(cat.id, cat));
    return map;
  }, [allCategories]);

  // Build flattened tree for the "More" popover
  const flatCategories = useMemo(() => {
    if (!taxonomyData?.categories) return [];
    const tree = buildCategoryTree(taxonomyData.categories);
    return flattenTree(tree);
  }, [taxonomyData?.categories]);

  // Get top-level categories for quick toggles
  const topCategories = useMemo(() => {
    return TOP_INSTRUMENT_TYPES.map((id) => categoryMap.get(id)).filter(
      (c): c is TaxonomyCategory => c !== undefined,
    );
  }, [categoryMap]);

  // Children of each category, so a quick toggle can offer its leaves rather than
  // assign its own id. Already sorted, because allCategories is.
  const childrenByParent = useMemo(() => {
    const map = new Map<string, TaxonomyCategory[]>();
    allCategories.forEach((category) => {
      if (!category.parentId) return;
      const siblings = map.get(category.parentId);
      if (siblings) {
        siblings.push(category);
      } else {
        map.set(category.parentId, [category]);
      }
    });
    return map;
  }, [allCategories]);

  // Find current assignment for this taxonomy
  const currentAssignment = useMemo(() => {
    if (!assignments) return null;
    return assignments.find((a) => a.taxonomyId === taxonomyId);
  }, [assignments, taxonomyId]);

  const selectedCategoryId = currentAssignment?.categoryId ?? "";
  const selectedCategory = selectedCategoryId ? categoryMap.get(selectedCategoryId) : null;

  // Check if selected category is one of the quick toggles
  const isSelectedInTopCategories = useMemo(() => {
    if (!selectedCategoryId) return false;
    // Check if selected is a top category or a child of one
    const selected = categoryMap.get(selectedCategoryId);
    if (!selected) return false;
    // Direct match
    if (TOP_INSTRUMENT_TYPES.includes(selectedCategoryId)) return true;
    // Check if parent is a top category
    if (selected.parentId && TOP_INSTRUMENT_TYPES.includes(selected.parentId)) return true;
    return false;
  }, [selectedCategoryId, categoryMap]);

  const handleSelectionChange = (categoryId: string) => {
    if (!categoryId || categoryId === selectedCategoryId) return;

    assignMutation.mutate({
      assetId,
      taxonomyId,
      categoryId,
      weight: 10000, // 100% in basis points
      source: "manual",
    });
    setMoreOpen(false);
    setOpenPillId(null);
  };

  // Get abbreviated display name
  // Loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-2">
        {label && <Skeleton className="h-4 w-24" />}
        <div className="flex flex-wrap gap-2 pt-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-16 rounded-full" />
          ))}
        </div>
      </div>
    );
  }

  // No taxonomy found
  if (!taxonomyData) {
    return null;
  }

  const isDisabled = disabled || assignMutation.isPending;

  // For taxonomies with many categories: show quick toggles + "More" tree select
  if (allCategories.length > MAX_RADIO_ITEMS) {
    return (
      <div className="space-y-2">
        {label && <Label className="text-muted-foreground text-sm font-medium">{label}</Label>}
        <div className="flex flex-wrap gap-1.5 pt-2">
          {/* Quick toggles for top categories. A category with children opens a
              leaf picker instead of assigning itself, so a one-click shortcut can
              never write a container category over the classifier's choice. */}
          {topCategories.map((category) => {
            const children = childrenByParent.get(category.id) ?? [];
            const selectedChild =
              selectedCategory?.parentId === category.id ? selectedCategory : null;
            const isSelected = selectedCategoryId === category.id || selectedChild !== null;
            // Label with the assigned leaf when there is one, so a pill sitting on
            // the container reads differently from one sitting on a child.
            const shown = selectedChild ?? category;
            const displayName = getCategoryLabel(t, taxonomyId, shown.id, shown.name);
            const pillClassName = cn(
              "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-all",
              isSelected
                ? "border-transparent font-medium shadow-sm"
                : "border-border bg-background hover:bg-muted/50",
              isDisabled && "cursor-not-allowed opacity-50",
            );
            const pillStyle = isSelected
              ? {
                  backgroundColor: `${shown.color}20`,
                  color: shown.color,
                  borderColor: shown.color,
                }
              : undefined;
            const pillContent = (
              <>
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: shown.color }}
                  aria-hidden="true"
                />
                <span className="whitespace-nowrap">{displayName}</span>
              </>
            );

            if (children.length === 0) {
              return (
                <button
                  key={category.id}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => handleSelectionChange(category.id)}
                  className={pillClassName}
                  style={pillStyle}
                >
                  {pillContent}
                </button>
              );
            }

            return (
              <Popover
                key={category.id}
                open={openPillId === category.id}
                onOpenChange={(open) => setOpenPillId(open ? category.id : null)}
                modal={true}
              >
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      disabled={isDisabled}
                      className={pillClassName}
                      style={pillStyle}
                    />
                  }
                >
                  {pillContent}
                  <Icons.ChevronDown className="h-3 w-3 opacity-50" />
                </PopoverTrigger>
                <PopoverContent className="w-56 p-1" align="start" sideOffset={4}>
                  {children.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      onClick={() => handleSelectionChange(child.id)}
                      className={cn(
                        "hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm",
                        selectedCategoryId === child.id && "bg-accent",
                      )}
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: child.color }}
                        aria-hidden="true"
                      />
                      <span className="flex-1 truncate">
                        {getCategoryLabel(t, taxonomyId, child.id, child.name)}
                      </span>
                      {selectedCategoryId === child.id && (
                        <Icons.Check className="text-primary h-4 w-4 shrink-0" />
                      )}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            );
          })}

          {/* "More" button with tree select popover */}
          <Popover open={moreOpen} onOpenChange={setMoreOpen} modal={true}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  disabled={isDisabled}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-all",
                    !isSelectedInTopCategories && selectedCategory
                      ? "border-transparent font-medium shadow-sm"
                      : "border-border bg-background hover:bg-muted/50",
                    isDisabled && "cursor-not-allowed opacity-50",
                  )}
                  style={
                    !isSelectedInTopCategories && selectedCategory
                      ? {
                          backgroundColor: `${selectedCategory.color}20`,
                          color: selectedCategory.color,
                          borderColor: selectedCategory.color,
                        }
                      : undefined
                  }
                />
              }
            >
              {!isSelectedInTopCategories && selectedCategory ? (
                <>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: selectedCategory.color }}
                    aria-hidden="true"
                  />
                  <span className="whitespace-nowrap">
                    {getCategoryLabel(t, taxonomyId, selectedCategory.id, selectedCategory.name)}
                  </span>
                </>
              ) : (
                <>
                  <Icons.Ellipsis className="h-3.5 w-3.5" />
                  <span className="whitespace-nowrap">{t("asset:classification.more")}</span>
                </>
              )}
              <Icons.ChevronDown className="h-3 w-3 opacity-50" />
            </PopoverTrigger>
            <PopoverContent className="w-87.5 p-0" align="start" sideOffset={4}>
              <Command>
                <CommandInput placeholder={t("asset:classification.searchTypes")} className="h-9" />
                <CommandList className="max-h-72 overflow-y-auto">
                  <CommandEmpty>{t("asset:classification.noTypesFound")}</CommandEmpty>
                  <CommandGroup className="[&_[cmdk-group-items]]:!overflow-visible">
                    {flatCategories.map((category, index) => {
                      const isSelected = selectedCategoryId === category.id;
                      const hasChildren = category.children.length > 0;
                      const showSeparator = category.level === 0 && index > 0;

                      return (
                        <div key={category.id}>
                          {showSeparator && <CommandSeparator className="my-1" />}
                          <CommandItem
                            value={`${category.name} ${getCategoryLabel(t, taxonomyId, category.id, category.name)} ${category.id}`}
                            onSelect={() => handleSelectionChange(category.id)}
                            className={cn(
                              "flex items-center gap-2",
                              hasChildren && "font-medium",
                              isSelected && "bg-accent",
                            )}
                            style={{ paddingInlineStart: `${category.level * 16 + 8}px` }}
                          >
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: category.color }}
                            />
                            <span className="flex-1 truncate">
                              {getCategoryLabel(t, taxonomyId, category.id, category.name)}
                            </span>
                            {isSelected && (
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
        </div>
      </div>
    );
  }

  // Use pill buttons in a wrapping layout for small taxonomies
  return (
    <div className="space-y-2">
      {label && <Label className="text-muted-foreground text-sm font-medium">{label}</Label>}
      <RadioGroup
        value={selectedCategoryId}
        onValueChange={handleSelectionChange}
        disabled={isDisabled}
        className="flex flex-wrap gap-1.5 pt-2"
      >
        {allCategories.map((category) => {
          const isSelected = selectedCategoryId === category.id;
          const displayName = getCategoryLabel(t, taxonomyId, category.id, category.name);

          return (
            <label
              key={category.id}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-all",
                isSelected
                  ? "border-transparent font-medium shadow-sm"
                  : "border-border bg-background hover:bg-muted/50",
                isDisabled && "cursor-not-allowed opacity-50",
              )}
              style={
                isSelected
                  ? {
                      backgroundColor: `${category.color}20`,
                      color: category.color,
                      borderColor: category.color,
                    }
                  : undefined
              }
            >
              <RadioGroupItem
                value={category.id}
                id={`${taxonomyId}-${category.id}`}
                className="sr-only"
              />
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: category.color }}
                aria-hidden="true"
              />
              <span className="whitespace-nowrap">{displayName}</span>
            </label>
          );
        })}
      </RadioGroup>
    </div>
  );
}
