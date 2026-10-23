import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@wealthfolio/ui";

import { useTaxonomy } from "@/hooks/use-taxonomies";
import type { TaxonomyCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

import { CategoryIcon } from "./category-chips";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";

export type QuickCategorizeScope = "expense" | "income" | "saving" | "both" | "all";

export interface QuickCategorizePopoverProps {
  trigger: React.ReactElement;
  selectedCategoryId?: string | null;
  /** Category bucket to show. Categories label the cash-flow bucket; they do not change it. */
  scope?: QuickCategorizeScope;
  onSelect: (taxonomyId: string, categoryId: string) => void;
  onClear?: () => void;
  align?: "start" | "center" | "end";
}

interface FlatOption {
  taxonomyId: string;
  category: TaxonomyCategory;
  parent: TaxonomyCategory | null;
  group: "Expense" | "Savings" | "Income";
}

// Children's sortOrder is relative to their siblings, so a flat sort interleaves levels.
function flattenTaxonomy(
  taxonomyId: string,
  cats: TaxonomyCategory[],
  group: FlatOption["group"],
): FlatOption[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const bySortOrder = (a: TaxonomyCategory, b: TaxonomyCategory) => a.sortOrder - b.sortOrder;
  const toOption = (c: TaxonomyCategory, parent: TaxonomyCategory | null) => ({
    taxonomyId,
    category: c,
    parent,
    group,
  });
  const roots = cats.filter((c) => !c.parentId || !byId.has(c.parentId)).sort(bySortOrder);
  return roots.flatMap((root) => [
    toOption(root, null),
    ...cats
      .filter((c) => c.parentId === root.id)
      .sort(bySortOrder)
      .map((c) => toOption(c, root)),
  ]);
}

export function QuickCategorizePopover({
  trigger,
  selectedCategoryId,
  scope = "both",
  onSelect,
  onClear,
  align = "start",
}: QuickCategorizePopoverProps) {
  const { t } = useTranslation();
  const groupLabels: Record<FlatOption["group"], string> = {
    Expense: t("spending:cashFlow.spending"),
    Savings: t("spending:cashFlow.saving"),
    Income: t("spending:cashFlow.income"),
  };
  const [open, setOpen] = useState(false);
  const spending = useTaxonomy(SPENDING_TAXONOMY);
  const income = useTaxonomy(INCOME_TAXONOMY);
  const savings = useTaxonomy(SAVINGS_TAXONOMY);

  const options = useMemo<FlatOption[]>(() => {
    const out: FlatOption[] = [];
    if (scope === "expense" || scope === "both" || scope === "all") {
      out.push(...flattenTaxonomy(SPENDING_TAXONOMY, spending.data?.categories ?? [], "Expense"));
    }
    if (scope === "saving" || scope === "all") {
      out.push(...flattenTaxonomy(SAVINGS_TAXONOMY, savings.data?.categories ?? [], "Savings"));
    }
    if (scope === "income" || scope === "both" || scope === "all") {
      out.push(...flattenTaxonomy(INCOME_TAXONOMY, income.data?.categories ?? [], "Income"));
    }
    return out;
  }, [spending.data?.categories, savings.data?.categories, income.data?.categories, scope]);

  const grouped = useMemo(() => {
    const groups: Record<FlatOption["group"], FlatOption[]> = {
      Expense: [],
      Savings: [],
      Income: [],
    };
    options.forEach((o) => groups[o.group].push(o));
    return groups;
  }, [options]);

  const handleSelect = (opt: FlatOption) => {
    onSelect(opt.taxonomyId, opt.category.id);
    setOpen(false);
  };

  const handleClear = () => {
    onClear?.();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent className="w-70 p-0" align={align}>
        <Command>
          <CommandInput placeholder={t("spending:category.searchCategories")} />
          <CommandList>
            <CommandEmpty>{t("spending:category.noCategoriesFound")}</CommandEmpty>
            {(["Expense", "Savings", "Income"] as const).map((groupKey) => {
              const items = grouped[groupKey];
              if (items.length === 0) return null;
              return (
                <CommandGroup key={groupKey} heading={groupLabels[groupKey]}>
                  {items.map((opt) => {
                    const isSelected = selectedCategoryId === opt.category.id;
                    const isChild = opt.parent !== null;
                    return (
                      <CommandItem
                        key={`${opt.taxonomyId}:${opt.category.id}`}
                        value={`${groupKey} ${opt.parent?.name ?? ""} / ${opt.category.name}`}
                        onSelect={() => handleSelect(opt)}
                        className={cn("flex items-center gap-2", isChild && "ps-8")}
                      >
                        <span
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                          style={{
                            backgroundColor: opt.category.color
                              ? `${opt.category.color}1F`
                              : "var(--muted)",
                            color: opt.category.color ?? "var(--muted-foreground)",
                          }}
                        >
                          <CategoryIcon icon={opt.category.icon ?? null} className="h-3.5 w-3.5" />
                        </span>
                        <span className={cn("truncate", !isChild && "font-medium")}>
                          {opt.category.name}
                        </span>
                        {isSelected && (
                          <Icons.Check className="text-muted-foreground ms-auto h-3.5 w-3.5" />
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
            {selectedCategoryId && onClear && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={handleClear}
                    className="text-destructive hover:bg-destructive-subtle hover:text-destructive-subtle-foreground justify-center text-center text-sm"
                  >
                    {t("spending:category.clearCategory")}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
