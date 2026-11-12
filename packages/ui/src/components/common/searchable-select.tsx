import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Icons } from "../ui/icons";
import { InputGroupAddon } from "../ui/input-group";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from "../ui/combobox";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../ui/command";
import { SheetScreen, useInSheetNavigation } from "../ui/sheet-navigation";

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
  "data-testid"?: string;
  /** Names the trigger when no visible label is tied to it. */
  "aria-label"?: string;
  /** Title of the list's screen in a phone form's sheet; defaults to the trigger's name or placeholder. */
  sheetTitle?: string;
}

// A select-style field whose list has a search box: shadcn's Combobox with the
// input inside the popup, filtering on the option labels.
export function SearchableSelect({
  options = [],
  value,
  onValueChange,
  placeholder,
  disabled = false,
  searchPlaceholder,
  emptyMessage,
  className = "",
  contentClassName = "",
  "data-testid": testId,
  "aria-label": ariaLabel,
  sheetTitle,
}: SearchableSelectProps) {
  const { t } = useTranslation();
  const selectedOption = options.find((option) => option.value === value) ?? null;
  const inSheetNavigation = useInSheetNavigation();
  const [screenOpen, setScreenOpen] = useState(false);
  const resolvedPlaceholder = placeholder ?? t("ui:select.placeholder", "Select an option");

  // In a phone form's sheet the list, with its search box, opens as a screen of
  // that sheet, like the form's other pickers.
  if (inSheetNavigation) {
    return (
      <>
        <Button
          type="button"
          variant="field"
          className={cn("w-full justify-between", className)}
          disabled={disabled}
          data-testid={testId}
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={screenOpen}
          onClick={() => setScreenOpen(true)}
        >
          <span className={cn("truncate", !selectedOption && "text-muted-foreground")}>
            {selectedOption?.label ?? resolvedPlaceholder}
          </span>
          <Icons.ChevronRight className="ms-2 h-4 w-4 shrink-0 opacity-50 rtl:rotate-180" aria-hidden="true" />
        </Button>
        <SheetScreen
          open={screenOpen}
          onOpenChange={setScreenOpen}
          title={sheetTitle ?? ariaLabel ?? resolvedPlaceholder}
        >
          <Command className="h-auto min-h-0 flex-1 rounded-none bg-transparent [&_[data-slot=command-input-wrapper]]:shrink-0">
            <CommandInput placeholder={searchPlaceholder ?? t("common:search_placeholder", "Search...")} />
            <CommandList className="max-h-none min-h-0 flex-1">
              <CommandEmpty>{emptyMessage ?? t("common:no_results_found", "No results found.")}</CommandEmpty>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label]}
                  onSelect={() => {
                    onValueChange(option.value);
                    setScreenOpen(false);
                  }}
                  className={cn("flex items-center gap-2", option.className)}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.value === value ? <Icons.Check className="text-muted-foreground h-4 w-4 shrink-0" /> : null}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </SheetScreen>
      </>
    );
  }

  return (
    <Combobox<Option>
      items={options}
      value={selectedOption}
      onValueChange={(option) => {
        if (option) onValueChange(option.value);
      }}
      itemToStringLabel={(option) => option.label}
      isItemEqualToValue={(item, selected) => item.value === selected.value}
      disabled={disabled}
    >
      <ComboboxTrigger
        render={
          <Button
            variant="field"
            className={cn("w-full justify-between", className)}
            disabled={disabled}
            data-testid={testId}
            aria-label={ariaLabel}
          />
        }
      >
        <span className={cn("truncate", !selectedOption && "text-muted-foreground")}>
          <ComboboxValue placeholder={resolvedPlaceholder} />
        </span>
      </ComboboxTrigger>
      <ComboboxContent className={cn("w-(--anchor-width)", contentClassName)}>
        <ComboboxInput
          showTrigger={false}
          placeholder={searchPlaceholder ?? t("common:search_placeholder", "Search...")}
          className="w-full"
        >
          <InputGroupAddon>
            <Icons.Search className="opacity-50" />
          </InputGroupAddon>
        </ComboboxInput>
        <ComboboxSeparator className="mx-0 my-0" />
        <ComboboxEmpty>{emptyMessage ?? t("common:no_results_found", "No results found.")}</ComboboxEmpty>
        <ComboboxList>
          {(option: Option) => (
            <ComboboxItem key={option.value} value={option} className={option.className}>
              {option.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
