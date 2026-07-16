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
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "w-full justify-between truncate rounded-md font-normal",
            !selectedOption && "text-muted-foreground",
            triggerClassName,
          )}
          onClick={() => setOpen(true)}
        >
          <span className="truncate">{displayText}</span>
          <Icons.ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side={mobileSide} className="rounded-t-4xl mx-1 h-[80vh] p-0">
            <SheetHeader className="border-border border-b px-6 pb-4 pt-6">
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
                          "card-mobile flex w-full items-center justify-between gap-3 border border-transparent px-4 py-3 text-left transition-colors",
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
    <Select value={value} onValueChange={handleSelect} disabled={disabled}>
      <SelectTrigger className={cn("w-full", triggerClassName)}>
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
