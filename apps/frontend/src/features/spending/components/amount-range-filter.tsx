import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Badge,
  Button,
  Icons,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
} from "@wealthfolio/ui";
import { cn } from "@/lib/utils";

export interface AmountRange {
  min: number | null;
  max: number | null;
}

interface AmountRangeFilterProps {
  value: AmountRange;
  onChange: (next: AmountRange) => void;
}

export function AmountRangeFilter({ value, onChange }: AmountRangeFilterProps) {
  return (
    <AmountRangeFilterInner
      key={`${value.min ?? ""}:${value.max ?? ""}`}
      value={value}
      onChange={onChange}
    />
  );
}

function AmountRangeFilterInner({ value, onChange }: AmountRangeFilterProps) {
  const { t } = useTranslation();
  const [minStr, setMinStr] = useState(value.min == null ? "" : String(value.min));
  const [maxStr, setMaxStr] = useState(value.max == null ? "" : String(value.max));

  const isActive = value.min != null || value.max != null;

  const apply = () => {
    const min = minStr.trim() === "" ? null : Number(minStr);
    const max = maxStr.trim() === "" ? null : Number(maxStr);
    onChange({
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
    });
  };

  const clear = () => {
    setMinStr("");
    setMaxStr("");
    onChange({ min: null, max: null });
  };

  const summary =
    value.min != null && value.max != null
      ? `${value.min} – ${value.max}`
      : value.min != null
        ? `≥ ${value.min}`
        : value.max != null
          ? `≤ ${value.max}`
          : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 gap-1.5 rounded-md border-[1.5px] border-none px-3 py-1 text-sm font-medium",
            isActive ? "bg-muted/40" : "shadow-inner-xs bg-muted/90",
          )}
        >
          <Icons.PlusCircle className="mr-2 h-4 w-4" />
          {t("spending:common.amount")}
          {isActive && summary && (
            <>
              <Separator orientation="vertical" className="mx-2 h-4" />
              <Badge variant="secondary" className="text-foreground rounded-sm px-1 font-normal">
                {summary}
              </Badge>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-muted-foreground text-[11px]">
                {t("spending:common.min")}
              </label>
              <Input
                type="number"
                inputMode="decimal"
                placeholder="0"
                value={minStr}
                onChange={(e) => setMinStr(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apply()}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <label className="text-muted-foreground text-[11px]">
                {t("spending:common.max")}
              </label>
              <Input
                type="number"
                inputMode="decimal"
                placeholder="—"
                value={maxStr}
                onChange={(e) => setMaxStr(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apply()}
                className="h-8"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            {isActive ? (
              <Button variant="ghost" size="sm" onClick={clear} className="text-destructive">
                {t("common:clear")}
              </Button>
            ) : (
              <span />
            )}
            <Button size="sm" onClick={apply}>
              {t("common:apply")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
