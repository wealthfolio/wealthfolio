import { Command as CommandPrimitive } from "cmdk";
import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { CommandGroup, CommandItem, CommandList, CommandInput } from "./command";
import { Skeleton } from "./skeleton";
import { cn } from "../../lib/utils";
import { Icons } from "./icons";

export type Option = Record<"value" | "label", string> & Record<string, string>;

interface AutoCompleteProps {
  emptyMessage: string;
  value?: Option;
  onValueChange?: (value: Option) => void;
  isLoading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  search: (query: string) => Promise<{ items?: { symbol: string; name: string }[] }>;
}

export const AutoComplete = ({
  placeholder,
  emptyMessage,
  value,
  onValueChange,
  disabled,
  isLoading = false,
  search,
}: AutoCompleteProps) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const [isOpen, setOpen] = useState(false);
  const [selected, setSelected] = useState<Option | undefined>(value);
  const [inputValue, setInputValue] = useState<string>(value?.label ?? "");
  const [options, setOptions] = useState<Option[]>([]);

  // Function to fetch options from backend
  const fetchOptions = useCallback(
    async (searchValue: string) => {
      const response = await search(searchValue);
      const data = response?.items?.map((item) => ({
        label: item.symbol + " - " + item.name,
        value: item.symbol,
      }));

      setOptions(data ?? []);
    },
    [search],
  );

  useEffect(() => {
    if (inputValue) {
      void fetchOptions(inputValue);
    }
  }, [inputValue, fetchOptions]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.nativeEvent.isComposing) return;

      const input = inputRef.current;
      if (!input) {
        return;
      }

      // Keep the options displayed when the user is typing
      if (!isOpen) {
        setOpen(true);
      }

      // This is not a default behaviour of the <input /> field
      if (event.key === "Enter" && input.value !== "") {
        const optionToSelect = options.find((option) => option.label === input.value);
        if (optionToSelect) {
          setSelected(optionToSelect);
          onValueChange?.(optionToSelect);
        }
        input.blur();
        setOpen(false);
      }

      if (event.key === "Escape" || event.key === "Tab") {
        //input.blur();
        setOpen(false);
      }
    },
    [isOpen, options, onValueChange],
  );

  // const handleBlur = useCallback(() => {
  //   setOpen(false);
  //   setInputValue(selected?.label);
  // }, [selected]);

  const handleSelectOption = useCallback(
    (selectedOption: Option) => {
      setInputValue(selectedOption.label);

      setSelected(selectedOption);
      onValueChange?.(selectedOption);

      // This is a hack to prevent the input from being focused after the user selects an option
      // We can call this hack: "The next tick"
      setTimeout(() => {
        inputRef?.current?.blur();
      }, 0);
    },
    [onValueChange],
  );

  return (
    <CommandPrimitive onKeyDown={handleKeyDown}>
      <div className="border-input bg-input-bg dark:bg-input/30 ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring h-input-height flex w-full rounded-md border py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
        <CommandInput
          ref={inputRef}
          value={inputValue}
          onValueChange={isLoading ? undefined : setInputValue}
          //onBlur={handleBlur}
          //onFocus={() => setOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full border-0 border-transparent bg-transparent focus:outline-none focus:ring-0 focus:ring-transparent"
        />
      </div>
      <div className="relative mt-1">
        {isOpen ? (
          <div className="bg-background animate-in fade-in-0 zoom-in-95 absolute top-0 z-10 w-full rounded-xl outline-none">
            <CommandList className="rounded-lg ring-1 ring-slate-200">
              {isLoading ? (
                <CommandPrimitive.Loading>
                  <div className="p-1">
                    <Skeleton className="h-8 w-full" />
                  </div>
                </CommandPrimitive.Loading>
              ) : null}
              {options.length > 0 && !isLoading ? (
                <CommandGroup>
                  {options.map((option) => {
                    const isSelected = selected?.value === option.value;
                    return (
                      <CommandItem
                        key={option.value}
                        value={option.label}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onSelect={() => handleSelectOption(option)}
                        className={cn("flex w-full items-center gap-2", !isSelected ? "pl-8" : null)}
                      >
                        {isSelected ? <Icons.Check className="w-4" /> : null}
                        {option.label}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : null}
              {!isLoading ? (
                <CommandPrimitive.Empty className="select-none rounded-sm px-2 py-3 text-center text-sm">
                  {emptyMessage}
                </CommandPrimitive.Empty>
              ) : null}
            </CommandList>
          </div>
        ) : null}
      </div>
    </CommandPrimitive>
  );
};
