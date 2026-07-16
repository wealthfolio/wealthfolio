import * as React from "react";
import { Badge } from "./badge";
import { Button } from "./button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./command";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Separator } from "./separator";
import { Icons } from "./icons";
import { cn } from "../../lib/utils";
import { useTranslation } from "react-i18next";

export interface FacetedFilterProps {
  title?: string;
  contentClassName?: string;
  options: {
    label: string;
    value: string;
    count?: number;
    icon?: React.ComponentType<{ className?: string }>;
  }[];
  selectedValues: Set<string>;
  onFilterChange: (values: Set<string>) => void;
}

export function FacetedFilter({
  title,
  contentClassName,
  options,
  selectedValues,
  onFilterChange,
}: FacetedFilterProps) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'hover:bg-muted/80" bg-secondary/30 h-8 gap-1.5 rounded-md border-[1.5px] border-none px-3 py-1 text-sm font-medium',
            selectedValues?.size > 0 ? "bg-muted/40" : "shadow-inner-xs bg-muted/90",
          )}
        >
          <Icons.PlusCircle className="mr-2 h-4 w-4 shrink-0" />
          {title}
          {selectedValues?.size > 0 && (
            <>
              <Separator orientation="vertical" className="mx-2 h-4 shrink-0" />
              <Badge variant="secondary" className="shrink-0 rounded-sm px-1 font-normal lg:hidden">
                {selectedValues.size}
              </Badge>
              <div className="hidden space-x-1 lg:flex">
                {selectedValues.size > 2 ? (
                  <Badge variant="secondary" className="text-foreground rounded-sm px-1 font-normal">
                    {t("ui:faceted.selected", "{{count}} selected", { count: selectedValues.size })}
                  </Badge>
                ) : (
                  options
                    .filter((option) => selectedValues.has(option.value))
                    .map((option) => (
                      <Badge
                        variant="secondary"
                        key={option.value}
                        className="text-foreground rounded-sm px-1 font-normal"
                      >
                        {option.label}
                      </Badge>
                    ))
                )}
              </div>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn("w-[200px] p-0", contentClassName)} align="start">
        <Command>
          <CommandInput placeholder={title} />
          <CommandList>
            <CommandEmpty>{t("ui:faceted.noResults", "No results found.")}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selectedValues.has(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    onSelect={() => {
                      const newSelectedValues = new Set(selectedValues);
                      if (isSelected) {
                        newSelectedValues.delete(option.value);
                      } else {
                        newSelectedValues.add(option.value);
                      }
                      onFilterChange(newSelectedValues);
                    }}
                  >
                    <div
                      className={cn(
                        "border-primary mr-2 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                        isSelected ? "bg-primary text-primary-foreground" : "opacity-50 [&_svg]:invisible",
                      )}
                    >
                      <Icons.Check className={cn("h-4 w-4")} />
                    </div>
                    {option.icon && <option.icon className="text-muted-foreground mr-2 h-4 w-4 shrink-0" />}
                    <span className="min-w-0 truncate">{option.label}</span>
                    {option.count !== undefined && (
                      <span className="text-muted-foreground ml-auto shrink-0 text-xs">{option.count}</span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {selectedValues.size > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => onFilterChange(new Set())}
                    className="text-destructive hover:bg-destructive/10 justify-center text-center text-sm"
                  >
                    {t("ui:faceted.clearFilters", "Clear filters")}
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
