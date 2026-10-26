import * as React from "react";
import { useTranslation } from "react-i18next";
import { useIsMobile as defaultUseIsMobile } from "../../hooks/use-mobile";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Icons } from "./icons";
import { ScrollArea } from "./scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./sheet";

export interface ResponsiveSelectOption {
  value: string;
  label: string;
  description?: string;
}

interface ResponsiveSelectProps {
  "aria-label"?: string;
  id?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  options: ResponsiveSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
  sheetTitle?: string;
  sheetDescription?: string;
  mobileSide?: React.ComponentProps<typeof SheetContent>["side"];
  displayMode?: "auto" | "desktop" | "mobile";
  useIsMobile?: () => boolean;
}

export function ResponsiveSelect({
  "aria-label": ariaLabel,
  id,
  value,
  onValueChange,
  options,
  placeholder = "Select an option",
  disabled,
  triggerClassName,
  contentClassName,
  sheetTitle = "Select Option",
  sheetDescription,
  mobileSide = "bottom",
  displayMode = "auto",
  useIsMobile,
}: ResponsiveSelectProps) {
  const { t } = useTranslation();
  const useIsMobileHook = useIsMobile ?? defaultUseIsMobile;
  const isMobile = displayMode === "mobile" || (displayMode === "auto" && useIsMobileHook());
  const [open, setOpen] = React.useState(false);

  const selectedOption = React.useMemo(() => options.find((option) => option.value === value), [options, value]);

  const handleSelect = (nextValue: string) => {
    onValueChange?.(nextValue);
    if (isMobile) {
      setOpen(false);
    }
  };

  if (isMobile) {
    const displayText = selectedOption ? selectedOption.label : placeholder;

    return (
      <>
        <Button
          id={id}
          aria-label={ariaLabel}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="dialog"
          variant="field"
          disabled={disabled}
          className={cn(
            "w-full justify-between truncate",
            !selectedOption && "text-muted-foreground",
            triggerClassName,
          )}
          onClick={() => setOpen(true)}
        >
          <span className="truncate">{displayText}</span>
          <Icons.ChevronDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side={mobileSide} className="mx-1 h-[80vh] rounded-t-4xl p-0">
            <SheetHeader className="border-border border-b px-6 pt-6 pb-4">
              <SheetTitle>{sheetTitle}</SheetTitle>
              {sheetDescription ? <SheetDescription>{sheetDescription}</SheetDescription> : null}
            </SheetHeader>

            <div className="flex h-[calc(80vh-6.5rem)] flex-col">
              <ScrollArea className="flex-1 px-2">
                <div className="space-y-2 py-4">
                  {options.map((option) => {
                    const isSelected = option.value === value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => handleSelect(option.value)}
                        className={cn(
                          "card-mobile flex w-full items-center justify-between gap-3 border border-transparent px-4 py-3 text-start transition-colors",
                          isSelected
                            ? "border-primary bg-primary/10 text-primary"
                            : "hover:bg-accent active:bg-accent/80 focus:border-primary focus:outline-none",
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold">{option.label}</div>
                          {option.description ? (
                            <div className="text-muted-foreground mt-0.5 truncate text-sm">{option.description}</div>
                          ) : null}
                        </div>
                        {isSelected ? <Icons.Check className="h-5 w-5 shrink-0" /> : null}
                      </button>
                    );
                  })}

                  {options.length === 0 ? (
                    <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-12 text-sm">
                      <Icons.Search className="h-10 w-10 opacity-20" />
                      <span>{t("ui:search.noOptions", "No options available.")}</span>
                    </div>
                  ) : null}
                </div>
              </ScrollArea>
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Select
      value={value}
      items={options}
      onValueChange={(nextValue) => {
        if (nextValue !== null) handleSelect(nextValue);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn("w-full", triggerClassName)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <div className="flex flex-col">
              <span>{option.label}</span>
              {option.description ? <span className="text-muted-foreground text-xs">{option.description}</span> : null}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
