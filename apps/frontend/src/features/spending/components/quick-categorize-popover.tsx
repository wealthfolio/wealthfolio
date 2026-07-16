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

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";

export type QuickCategorizeScope = "expense" | "income" | "saving" | "both";

export interface QuickCategorizePopoverProps {
  trigger: React.ReactNode;
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

function flattenTaxonomy(
  taxonomyId: string,
  cats: TaxonomyCategory[],
  group: FlatOption["group"],
): FlatOption[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  return cats
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((c) => ({
      taxonomyId,
      category: c,
      parent: c.parentId ? (byId.get(c.parentId) ?? null) : null,
      group,
    }));
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
    if (scope === "expense" || scope === "both") {
      out.push(...flattenTaxonomy(SPENDING_TAXONOMY, spending.data?.categories ?? [], "Expense"));
    }
    if (scope === "saving") {
      out.push(...flattenTaxonomy(SAVINGS_TAXONOMY, savings.data?.categories ?? [], "Savings"));
    }
    if (scope === "income" || scope === "both") {
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
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
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
                    const label = opt.parent
                      ? `${opt.parent.name} / ${opt.category.name}`
                      : opt.category.name;
                    const isSelected = selectedCategoryId === opt.category.id;
                    return (
                      <CommandItem
                        key={`${opt.taxonomyId}:${opt.category.id}`}
                        value={`${groupKey} ${label}`}
                        onSelect={() => handleSelect(opt)}
                        className="flex items-center gap-2"
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor: opt.category.color ?? "var(--muted-foreground)",
                          }}
                        />
                        <span className="truncate">{label}</span>
                        {isSelected && (
                          <Icons.Check className="text-muted-foreground ml-auto h-3.5 w-3.5" />
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
                    className="text-destructive hover:bg-destructive/10 justify-center text-center text-sm"
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
