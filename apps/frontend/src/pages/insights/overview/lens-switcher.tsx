import { cn } from "@/lib/utils";
import { AnimatedToggleGroup, Icons } from "@wealthfolio/ui";
import { animatedToggleItemVariants } from "@wealthfolio/ui/components/ui/animated-toggle-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface LensOption {
  key: string;
  label: string;
}

interface LensSwitcherProps {
  lenses: LensOption[];
  activeKey: string;
  onSelect: (key: string) => void;
  "aria-label": string;
  className?: string;
}

// Matches the group's `sm` spacing: p-0.5 on each side and gap-0.5 between items.
const GROUP_PADDING_PX = 4;
const ITEM_GAP_PX = 2;
const MORE_GAP_PX = 6;

/**
 * One row of views: as many as fit in a segmented control, the rest in a "More"
 * menu. The selected view always stays in the row.
 */
export function LensSwitcher({
  lenses,
  activeKey,
  onSelect,
  "aria-label": ariaLabel,
  className,
}: LensSwitcherProps) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const [fitCount, setFitCount] = useState(lenses.length);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const ruler = rulerRef.current;
    if (!row || !ruler) return;
    const measure = () => {
      const available = row.clientWidth;
      const widths = [...ruler.children].map((child) => (child as HTMLElement).offsetWidth);
      const moreWidth = widths.pop() ?? 0;
      // Without layout (tests, hidden tabs) every view stays in the row.
      if (!available || widths.some((width) => !width)) {
        setFitCount(lenses.length);
        return;
      }
      const rowWidth = (count: number) =>
        GROUP_PADDING_PX +
        widths.slice(0, count).reduce((sum, width) => sum + width, 0) +
        Math.max(0, count - 1) * ITEM_GAP_PX;
      let count = widths.length;
      if (rowWidth(count) > available) {
        while (count > 1 && rowWidth(count) + MORE_GAP_PX + moreWidth > available) count -= 1;
      }
      setFitCount(count);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(ruler);
    return () => observer.disconnect();
  }, [lenses]);

  const activeIndex = Math.max(
    0,
    lenses.findIndex((lens) => lens.key === activeKey),
  );
  const count = Math.min(fitCount, lenses.length);
  const visible = lenses.slice(0, count);
  if (activeIndex >= count) visible[count - 1] = lenses[activeIndex];
  const hidden = lenses.filter((lens) => !visible.includes(lens));
  const itemClass = animatedToggleItemVariants({ size: "sm" });

  return (
    <div
      ref={rowRef}
      className={cn("relative flex min-w-0 flex-1 items-center gap-1.5", className)}
    >
      <div
        ref={rulerRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute end-0 top-0 flex whitespace-nowrap"
      >
        {lenses.map((lens) => (
          <span key={lens.key} className={itemClass}>
            {lens.label}
          </span>
        ))}
        <span className={cn(itemClass, "flex items-center gap-1")}>
          {t("common:more")}
          <Icons.ChevronDown className="size-3.5" />
        </span>
      </div>
      <AnimatedToggleGroup
        // A new set of views remounts the group, so its highlight is measured against
        // the row as it is now (in RTL a narrower row moves every button).
        key={visible.map((lens) => lens.key).join("|")}
        items={visible.map((lens) => ({ value: lens.key, label: lens.label }))}
        value={lenses[activeIndex]?.key}
        onValueChange={onSelect}
        size="sm"
        aria-label={ariaLabel}
        className="min-w-0"
      />
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  itemClass,
                  "bg-muted text-muted-foreground hover:text-foreground flex h-9 items-center gap-1",
                )}
              />
            }
          >
            {t("common:more")}
            <Icons.ChevronDown className="size-3.5" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {hidden.map((lens) => (
              <DropdownMenuItem key={lens.key} onClick={() => onSelect(lens.key)}>
                {lens.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
