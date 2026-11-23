import { Icons, type Icon } from "@wealthfolio/ui/components/ui/icons";
import { RadioGroupItem } from "@wealthfolio/ui/components/ui/radio-group";

import { cn } from "@/lib/utils";

interface TypeChoiceProps {
  id: string;
  value: string;
  label: string;
  /** Read by screen readers; the card shows the label only. */
  description: string;
  icon: Icon;
  selected: boolean;
}

/**
 * One card of a phone form's two-column type grid, inside a RadioGroup. Add Activity
 * and Add Transaction both use it, so their grids look and behave the same.
 */
export function TypeChoice({
  id,
  value,
  label,
  description,
  icon: Icon,
  selected,
}: TypeChoiceProps) {
  return (
    <div className="relative min-w-0">
      <RadioGroupItem
        value={value}
        id={id}
        aria-describedby={`${id}-description`}
        className="peer sr-only absolute"
      />
      <label
        htmlFor={id}
        className={cn(
          "relative flex h-full min-h-16 cursor-pointer items-center gap-2 rounded-xl border px-3 py-3 text-sm transition-colors",
          "hover:bg-muted/50",
          "peer-data-checked:border-primary peer-data-checked:bg-primary/5",
          "peer-focus-visible:outline-ring peer-focus-visible:outline-solid peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2",
        )}
      >
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="min-w-0 font-medium break-words whitespace-normal">{label}</span>
        {/* Inline at the end: in the card's corner the rounding clipped it. */}
        {selected && <Icons.Check className="text-primary ms-auto size-4 shrink-0" aria-hidden />}
      </label>
      <span id={`${id}-description`} className="sr-only">
        {description}
      </span>
    </div>
  );
}
