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
}: SearchableSelectProps) {
  const { t } = useTranslation();
  const selectedOption = options.find((option) => option.value === value) ?? null;

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
          <ComboboxValue placeholder={placeholder ?? t("ui:select.placeholder", "Select an option")} />
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
