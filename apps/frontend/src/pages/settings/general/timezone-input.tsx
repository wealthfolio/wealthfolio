import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@wealthfolio/ui/lib/utils";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@wealthfolio/ui/components/ui/command";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";

interface TimezoneInputProps {
  value?: string;
  onChange: (value: string) => void;
  timezones: string[];
  placeholder?: string;
}

export function TimezoneInput({ value, onChange, timezones, placeholder }: TimezoneInputProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const resolvedPlaceholder = placeholder ?? t("settings:tz_select_placeholder");

  const filteredTimezones = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length === 0) {
      return timezones;
    }

    return timezones.filter((timezone) => timezone.toLowerCase().includes(query));
  }, [searchQuery, timezones]);

  const buttonLabel = value || resolvedPlaceholder;

  const handleSelect = (timezone: string) => {
    onChange(timezone);
    setOpen(false);
    setSearchQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal={true}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "h-input-height w-full justify-between rounded-md",
            !value && "text-muted-foreground",
          )}
        >
          <span className="truncate">{buttonLabel}</span>
          <Icons.ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] max-w-[calc(100vw-2rem)] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("settings:tz_search_placeholder")}
            className="h-9"
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList>
            <CommandEmpty>{t("settings:tz_none_found")}</CommandEmpty>
            <CommandGroup>
              <ScrollArea className="max-h-72 overflow-y-auto">
                {filteredTimezones.map((timezone) => (
                  <CommandItem
                    key={timezone}
                    value={timezone}
                    onSelect={() => handleSelect(timezone)}
                  >
                    {timezone}
                    <Icons.Check
                      className={cn(
                        "ml-auto h-4 w-4",
                        timezone === value ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </CommandItem>
                ))}
              </ScrollArea>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
