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

import { CategoryIconTile } from "./category-chips";

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

// Children's sortOrder is relative to their siblings, so a flat sort interleaves
// levels. Categories whose parent is missing are listed as top level.
function flattenTaxonomy(
  taxonomyId: string,
  cats: TaxonomyCategory[],
  group: FlatOption["group"],
): FlatOption[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const parentIdOf = (c: TaxonomyCategory) =>
    c.parentId && byId.has(c.parentId) ? c.parentId : null;
  const walk = (parent: TaxonomyCategory | null): FlatOption[] =>
    cats
      .filter((c) => parentIdOf(c) === (parent?.id ?? null))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .flatMap((c) => [{ taxonomyId, category: c, parent, group }, ...walk(c)]);
  return walk(null);
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
  const [search, setSearch] = useState("");
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

  // cmdk's own filter ranks rows by score, which breaks the tree and hides the
  // parent of a matching child. Keep tree order and show each match with its
  // ancestors and descendants. Ancestors that only give context are disabled so
  // cmdk highlights the first real match and Enter picks it.
  const { visible, contextOnly } = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return { visible: options, contextOnly: new Set<FlatOption>() };
    const byKey = new Map(options.map((o) => [`${o.taxonomyId}:${o.category.id}`, o]));
    const ancestorsOf = (o: FlatOption) => {
      const out: FlatOption[] = [];
      for (let p = o.parent; p;) {
        const po = byKey.get(`${o.taxonomyId}:${p.id}`);
        if (!po) break;
        out.push(po);
        p = po.parent;
      }
      return out;
    };
    const matches = (o: FlatOption) => o.category.name.toLowerCase().includes(query);
    const isHit = (o: FlatOption) => matches(o) || ancestorsOf(o).some(matches);
    const context = new Set<FlatOption>();
    options
      .filter(matches)
      .forEach((o) => ancestorsOf(o).forEach((a) => !isHit(a) && context.add(a)));
    return {
      visible: options.filter((o) => isHit(o) || context.has(o)),
      contextOnly: context,
    };
  }, [options, search]);

  const grouped = useMemo(() => {
    const groups: Record<FlatOption["group"], FlatOption[]> = {
      Expense: [],
      Savings: [],
      Income: [],
    };
    visible.forEach((o) => groups[o.group].push(o));
    return groups;
  }, [visible]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  const handleSelect = (opt: FlatOption) => {
    onSelect(opt.taxonomyId, opt.category.id);
    handleOpenChange(false);
  };

  const handleClear = () => {
    onClear?.();
    handleOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent className="w-70 p-0" align={align}>
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t("spending:category.searchCategories")}
          />
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
                        disabled={contextOnly.has(opt)}
                        className={cn("flex items-center gap-2", isChild && "ps-8")}
                      >
                        <CategoryIconTile
                          icon={opt.category.icon ?? null}
                          color={opt.category.color ?? null}
                        />
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
