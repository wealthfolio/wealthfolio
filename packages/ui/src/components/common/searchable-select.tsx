import * as React from "react";
import { Icons } from "../ui/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "../ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

interface Option {
  value: string;
  label: string;
  className?: string;
}

interface SearchableSelectProps {
  options: Option[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  contentClassName?: string;
}

export function SearchableSelect({
  options = [],
  value,
  onValueChange,
  placeholder = "Select an option",
  disabled = false,
  searchPlaceholder = "Search...",
  emptyMessage = "No results found.",
  className = "",
  contentClassName = "",
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);

  const selectedOption = options?.find((option) => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("min-w-0 max-w-full justify-between rounded-md font-normal", className)}
          disabled={disabled}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          <Icons.ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn("w-[var(--radix-popover-trigger-width)] p-0", contentClassName)}>
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-9" />
          <CommandEmpty>{emptyMessage}</CommandEmpty>
          <CommandGroup className="max-h-64 overflow-auto">
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={option.label}
                onSelect={() => {
                  onValueChange(option.value);
                  setOpen(false);
                }}
                className={option.className}
              >
                {option.label}
                <Icons.Check className={cn("ml-auto h-4 w-4", value === option.value ? "opacity-100" : "opacity-0")} />
              </CommandItem>
            ))}
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
