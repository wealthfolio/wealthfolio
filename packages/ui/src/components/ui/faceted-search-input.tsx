import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Icons } from "./icons";

export interface FacetedSearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
}

export function FacetedSearchInput({
  value,
  onChange,
  onClear,
  placeholder = "Search ...",
  className,
  ...props
}: FacetedSearchInputProps) {
  const { t } = useTranslation();
  const handleClear = () => {
    onChange("");
    onClear?.();
  };

  return (
    <div className={cn("relative", className)}>
      <Icons.Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "shadow-inner-xs bg-muted/90 hover:bg-muted/80 h-8 w-full rounded-md pl-8 pr-8 text-sm outline-none transition-colors",
          "placeholder:text-muted-foreground",
          "focus:ring-ring/50 focus:ring-2",
        )}
        {...props}
      />
      {value && (
        <button
          type="button"
          onClick={handleClear}
          className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
        >
          <Icons.Close className="h-4 w-4" />
          <span className="sr-only">{t("ui:search.clear", "Clear search")}</span>
        </button>
      )}
    </div>
  );
}
