import { useMemo, useState } from "react";

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

export interface QuickCategorizePopoverProps {
  trigger: React.ReactNode;
  selectedCategoryId?: string | null;
  /** Bias the picker towards expense or income categories. */
  scope?: "expense" | "income" | "both";
  onSelect: (taxonomyId: string, categoryId: string) => void;
  onClear?: () => void;
  align?: "start" | "center" | "end";
}

interface FlatOption {
  taxonomyId: string;
  category: TaxonomyCategory;
  parent: TaxonomyCategory | null;
  group: "Expense" | "Income";
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
  const [open, setOpen] = useState(false);
  const spending = useTaxonomy(SPENDING_TAXONOMY);
  const income = useTaxonomy(INCOME_TAXONOMY);

  const options = useMemo<FlatOption[]>(() => {
    const out: FlatOption[] = [];
    if (scope !== "income") {
      out.push(...flattenTaxonomy(SPENDING_TAXONOMY, spending.data?.categories ?? [], "Expense"));
    }
    if (scope !== "expense") {
      out.push(...flattenTaxonomy(INCOME_TAXONOMY, income.data?.categories ?? [], "Income"));
    }
    return out;
  }, [spending.data?.categories, income.data?.categories, scope]);

  const grouped = useMemo(() => {
    const groups: Record<FlatOption["group"], FlatOption[]> = { Expense: [], Income: [] };
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
      <PopoverContent className="w-[280px] p-0" align={align}>
        <Command>
          <CommandInput placeholder="Search categories..." />
          <CommandList>
            <CommandEmpty>No categories found.</CommandEmpty>
            {(["Expense", "Income"] as const).map((groupKey) => {
              const items = grouped[groupKey];
              if (items.length === 0) return null;
              return (
                <CommandGroup key={groupKey} heading={groupKey}>
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
                    Clear category
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
