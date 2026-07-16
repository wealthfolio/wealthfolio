import { useState } from "react";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandSeparator,
} from "@wealthfolio/ui/components/ui/command";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { cn } from "@wealthfolio/ui/lib/utils";
import { useTranslation } from "react-i18next";
import type { ImportTemplateData } from "@/lib/types";

interface TemplatePickerProps {
  templates: ImportTemplateData[];
  selectedTemplateId: string | null;
  onSelect: (templateId: string) => void;
  /** Show an inline clear (X) button when a template is selected. */
  onClear?: () => void;
  placeholder?: string;
}

export function TemplatePicker({
  templates,
  selectedTemplateId,
  onSelect,
  onClear,
  placeholder,
}: TemplatePickerProps) {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t("activity:import.template.selectFormat");
  const [open, setOpen] = useState(false);
  const systemTemplates = templates.filter((t) => t.scope === "SYSTEM");
  const userTemplates = templates.filter((t) => t.scope === "USER");
  const selected = templates.find((t) => t.id === selectedTemplateId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between rounded-lg font-normal"
        >
          {selected ? (
            <span className="flex items-center gap-2 truncate">
              {selected.scope === "SYSTEM" ? (
                <Icons.Building className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              ) : (
                <Icons.User className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              )}
              {selected.name}
            </span>
          ) : (
            <span className="text-muted-foreground">{resolvedPlaceholder}</span>
          )}
          <div className="flex shrink-0 items-center gap-1">
            {selectedTemplateId && onClear && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onClear();
                  }
                }}
                className="text-muted-foreground hover:text-foreground rounded-sm p-0.5 transition-colors"
                aria-label={t("activity:import.template.clearFormat")}
              >
                <Icons.X className="h-3.5 w-3.5" />
              </span>
            )}
            <Icons.ChevronDown className="text-muted-foreground h-4 w-4" />
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder={t("activity:import.template.searchFormats")} className="h-9" />
          <CommandEmpty>
            <div className="text-muted-foreground py-2 text-center text-sm">
              {t("activity:import.template.noMatching")}
            </div>
          </CommandEmpty>
          {userTemplates.length > 0 && (
            <CommandGroup heading={t("activity:import.template.custom")}>
              {userTemplates.map((t) => (
                <CommandItem
                  key={t.id}
                  value={t.name}
                  onSelect={() => {
                    onSelect(t.id);
                    setOpen(false);
                  }}
                  className="flex items-center gap-2"
                >
                  <Icons.User className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">{t.name}</span>
                  <Icons.Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      selectedTemplateId === t.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {userTemplates.length > 0 && systemTemplates.length > 0 && <CommandSeparator />}
          {systemTemplates.length > 0 && (
            <CommandGroup heading={t("activity:import.template.builtIn")}>
              {systemTemplates.map((t) => (
                <CommandItem
                  key={t.id}
                  value={t.name}
                  onSelect={() => {
                    onSelect(t.id);
                    setOpen(false);
                  }}
                  className="flex items-center gap-2"
                >
                  <Icons.Building className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">{t.name}</span>
                  <Icons.Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      selectedTemplateId === t.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
